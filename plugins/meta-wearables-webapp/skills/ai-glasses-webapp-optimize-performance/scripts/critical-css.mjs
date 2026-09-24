#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// critical-css.mjs — find the CSS that is actually used by the first screen, so you can inline
// it and stop blocking first paint on a stylesheet download.
//
// Uses CDP rule-usage tracking: load the page under the glasses profile, stop tracking once the
// first screen is up, and report which rules were matched. App-owned used rules can be written
// as an inline candidate; stylesheets containing Toolkit markers stay report-only.
//
// Point --url at a production preview, never a development/HMR server.
//   node critical-css.mjs --url http://127.0.0.1:5173 --clear-storage
//                         --oracle "<js true when the first screen is usable>"
//                         [--out critical.css --owned-style /assets/app.css]
//                         [--port 9222] [--grant-media]
//
// Node 22+. Chrome must be started with --remote-debugging-port=9222.
import {randomUUID} from 'node:crypto';
import {
  closeSync,
  linkSync,
  lstatSync,
  openSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import {basename, dirname, join, resolve} from 'node:path';
import {
  PROFILE,
  assertKnownArgs,
  clearOriginData,
  flagArg,
  httpUrlArg,
  isDevelopmentServerResource,
  numArg,
  openTab,
  parseArgs,
  readyExpression,
  sleep,
  strArg,
} from './lib/cdp.mjs';

/**
 * Locate every at-rule block in a stylesheet, so a used rule can be re-wrapped in the
 * conditions it was written under.
 *
 * Skips comments and quoted strings so a brace inside either does not shift the nesting.
 * `@import`-style statements end at `;` and open no block.
 */
function atRuleBlocks(text) {
  const blocks = [];
  const stack = [];
  let pendingAt = null;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end === -1 ? text.length : end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < text.length && text[i] !== quote) i += text[i] === '\\' ? 2 : 1;
      i += 1;
      continue;
    }
    if (ch === '@') { pendingAt = i; i += 1; continue; }
    if (ch === ';') { pendingAt = null; i += 1; continue; }
    if (ch === '{') {
      stack.push(pendingAt == null ? null : { prelude: text.slice(pendingAt, i).trim(), bodyStart: i + 1 });
      pendingAt = null;
      i += 1;
      continue;
    }
    if (ch === '}') {
      // Also clears any dangling `@`: a final declaration with an unquoted @ and no trailing
      // semicolon (`.a{background:url(logo@2x.png) no-repeat}`) would otherwise make the next
      // `{` look like an at-rule with a garbage prelude.
      pendingAt = null;
      const top = stack.pop();
      if (top) blocks.push({ ...top, bodyEnd: i });
      i += 1;
      continue;
    }
    i += 1;
  }
  return blocks;
}

const A = parseArgs(process.argv.slice(2));
assertKnownArgs(A, [
  'url', 'out', 'owned-style', 'oracle', 'clear-storage', 'port', 'grant-media',
]);
const URL_ARG = httpUrlArg(A);
const port = numArg(A, 'port', 9222, { max: 65535 });
const oracle = strArg(A, 'oracle');
const OUT = strArg(A, 'out');
const ownedStyle = strArg(A, 'owned-style');
const resetStorage = flagArg(A, 'clear-storage');
const grantMedia = flagArg(A, 'grant-media');
const outputPath = OUT ? resolve(OUT) : null;
if (outputPath && pathExistsNoFollow(outputPath)) {
  console.error(`refusing to overwrite existing --out path: ${outputPath}`);
  process.exit(2);
}
if (OUT && !ownedStyle) {
  console.error('--owned-style is required with --out; use the exact same-origin stylesheet shown in the report');
  process.exit(2);
}
if (ownedStyle && !OUT) {
  console.error('--owned-style is only valid with --out');
  process.exit(2);
}
if (!resetStorage) {
  console.error('--clear-storage is required; use a unique throwaway Chrome profile');
  process.exit(2);
}
if (!oracle) {
  console.error('--oracle is required and must identify usable first-screen content and exclude overlays');
  process.exit(2);
}
const ready = readyExpression(oracle);

const tab = await openTab(port);
const { cdp } = tab;
let exitCode = 0;
const developmentResources = new Set();
let primaryError = null;

class ReportedFailure extends Error {}

const sheets = new Map();
try {
  cdp.on('Network.requestWillBeSent', (p) => {
    const requestUrl = p.request?.url || '';
    if (isDevelopmentServerResource(requestUrl)) developmentResources.add(requestUrl);
  });
  cdp.on('CSS.styleSheetAdded', (p) => {
    sheets.set(p.header.styleSheetId, {
      url: p.header.sourceURL || '(inline)',
      len: p.header.length,
      origin: p.header.origin,
    });
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('DOM.enable');
  await cdp.send('CSS.enable');
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await clearOriginData(cdp, URL_ARG);
  if (grantMedia) {
    await cdp.send('Browser.grantPermissions', {
      origin: new URL(URL_ARG).origin,
      permissions: ['audioCapture', 'videoCapture'],
    });
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: PROFILE.width, height: PROFILE.height, deviceScaleFactor: PROFILE.dpr, mobile: true,
  });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false, latency: PROFILE.latency,
    downloadThroughput: PROFILE.down, uploadThroughput: PROFILE.up,
  });
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: PROFILE.cpu });
  await cdp.send('Page.bringToFront');
  await cdp.send('CSS.startRuleUsageTracking');

  const loaded = cdp.waitEvent('Page.loadEventFired', 60000).then(() => true, () => false);
  try {
    await cdp.send('Page.navigate', { url: URL_ARG }, 60000);
  } catch (error) {
    console.error(`  ERROR: navigation failed: ${error.message}`);
    throw new ReportedFailure();
  }
  if (!await loaded) {
    console.error('  ERROR: the production page did not finish loading within 60 seconds.');
    throw new ReportedFailure();
  }
  if (developmentResources.size) {
    console.error('  ERROR: a development/HMR resource was loaded; inspect production output instead:');
    for (const resource of developmentResources) console.error(`     ${resource}`);
    throw new ReportedFailure();
  }
  const originResult = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    expression: 'location.origin',
  });
  const pageOrigin = originResult?.result?.value;
  if (typeof pageOrigin !== 'string' || !/^https?:\/\//.test(pageOrigin)) {
    console.error('  ERROR: could not establish the final page origin; nothing was written.');
    throw new ReportedFailure();
  }
  if (pageOrigin !== new URL(URL_ARG).origin) {
    console.error('  ERROR: the page redirected to another origin; rerun with the final production URL.');
    throw new ReportedFailure();
  }

  // Stop as soon as the first screen is up. Waiting longer folds in rules that only later
  // screens need, which is exactly what you are trying to keep out of the critical set.
  const started = Date.now();
  const deadline = started + 60000;
  let fired = false;
  while (Date.now() < deadline) {
    await sleep(200);
    const r = await cdp.send('Runtime.evaluate', { returnByValue: true, expression: ready }, 15000).catch(() => null);
    const v = r?.result?.value ? JSON.parse(r.result.value) : null;
    if (v && v.ready) { fired = true; break; }
  }
  if (!fired) {
    console.error(
      `  ERROR: the oracle never became true in ${Math.round((Date.now() - started) / 1000)}s.\n` +
        '  Rule usage has been accumulating that whole time, so what follows would be the\n' +
        '  everything-so-far set, not the first-screen set — the opposite of useful. Fix\n' +
        '  --oracle (or the app) and re-run. Nothing was written.',
    );
    throw new ReportedFailure();
  }

  const { ruleUsage } = await cdp.send('CSS.stopRuleUsageTracking');
  if (developmentResources.size) {
    console.error('  ERROR: a development/HMR resource appeared during observation; nothing was written:');
    for (const resource of developmentResources) console.error(`     ${resource}`);
    throw new ReportedFailure();
  }
  const used = ruleUsage.filter((r) => r.used);

  const texts = new Map();
  for (const id of new Set(used.map((r) => r.styleSheetId))) {
    if (sheets.get(id)?.origin !== 'regular') continue;
    const t = await cdp.send('CSS.getStyleSheetText', { styleSheetId: id }).catch(() => null);
    if (t) texts.set(id, t.text);
  }

  // The denominator has to be the stylesheet's real size, not the sum of tracked rules:
  // Chrome reports only rules it tracked, so summing those makes every sheet look 100% used
  // and hides the very bytes you are trying to find.
  const perSheet = new Map();
  for (const [id, h] of sheets) {
    if (h.origin === 'regular') perSheet.set(id, { used: 0, total: h.len || 0 });
  }
  for (const r of ruleUsage) {
    if (!r.used) continue;
    const s = perSheet.get(r.styleSheetId);
    if (!s) continue;
    s.used += r.endOffset - r.startOffset;
    perSheet.set(r.styleSheetId, s);
  }

  console.log('  stylesheet                                     used source / total source   critical%');
  let grandUsed = 0, grandTotal = 0;
  for (const [id, s] of [...perSheet].sort((a, b) => b[1].total - a[1].total)) {
    if (!s.total && !s.used) continue;
    const name = (sheets.get(id)?.url || '(inline)').replace(/^https?:\/\/[^/]+/, '');
    grandUsed += s.used; grandTotal += s.total;
    console.log(
      `  ${name.slice(0, 50).padEnd(50)} ${String(s.used).padStart(6)} / ${String(s.total).padStart(7)}   ` +
        `${s.total ? Math.round((100 * s.used) / s.total) : 0}%`,
    );
  }
  console.log(
    `  TOTAL: ${grandUsed} of ${grandTotal} source characters matched the first screen ` +
      `(${grandTotal ? Math.round((100 * grandUsed) / grandTotal) : 0}%). ` +
      'Source characters are not compressed wire bytes; verify transfer savings with measure.mjs.',
  );

  // Emit app-owned used rules, in source order per sheet, as an inlinable block. Rules inside an
  // at-rule get their wrapper rebuilt: a rule lifted out of `@media (min-width: 900px)` and
  // inlined at top level applies unconditionally, which changes the very rendering the
  // critical set is supposed to preserve.
  const out = [];
  const skippedToolkitSheets = [];
  const skippedUnselectedSheets = [];
  const skippedRelativeUrlSheets = [];
  for (const [id, text] of texts) {
    const mine = used.filter((r) => r.styleSheetId === id).sort((a, b) => a.startOffset - b.startOffset);
    const sourceUrl = sheets.get(id)?.url || '(inline)';
    const name = sourceUrl.replace(/^https?:\/\/[^/]+/, '');
    // App-authored CSS is expected to consume --uit-* variables. Only Toolkit selectors
    // establish ownership; a sheet with both kinds of selector remains conservatively mixed.
    if (/(?:\[data-uit-|\.uit-)/.test(text)) {
      skippedToolkitSheets.push(name);
      continue;
    }
    // Empty source URLs are not uniquely addressable: multiple inline/constructed sheets can
    // share `(inline)`, so they remain report-only even when the caller supplies that label.
    let sameOrigin = false;
    if (sourceUrl !== '(inline)') {
      try { sameOrigin = new URL(sourceUrl, URL_ARG).origin === pageOrigin; } catch {}
    }
    if (!sameOrigin || !ownedStyle || ![sourceUrl, name].includes(ownedStyle)) {
      skippedUnselectedSheets.push(name);
      continue;
    }
    const blocks = atRuleBlocks(text);
    const sheetOut = [];
    let hasUnsafeRelativeUrl = false;
    for (const r of mine) {
      const raw = text.slice(r.startOffset, r.endOffset).trim();
      // CDP also reports the at-rule itself as a used "rule". Its range covers the prelude and
      // sometimes the opening brace, so testing for `{` alone is not enough — a fragment like
      // `(min-width: 1px){` slips through and unbalances the output. A real style rule always
      // carries a complete declaration block.
      if (!raw.includes('{') || !raw.includes('}')) continue;
      if (sourceUrl !== '(inline)' && containsRelativeCssUrl(raw)) {
        hasUnsafeRelativeUrl = true;
        break;
      }
      const wrappers = blocks
        .filter((b) => b.bodyStart <= r.startOffset && b.bodyEnd >= r.endOffset)
        .sort((a, b) => a.bodyStart - b.bodyStart);
      const body = raw;
      if (!wrappers.length) { sheetOut.push(body); continue; }
      sheetOut.push(wrappers.map((w) => `${w.prelude} {`).join('\n'));
      sheetOut.push(body);
      sheetOut.push(wrappers.map(() => '}').join('\n'));
    }
    if (hasUnsafeRelativeUrl) {
      skippedRelativeUrlSheets.push(name);
      continue;
    }
    if (sheetOut.length) out.push(`/* from ${name} */`, ...sheetOut);
  }
  const css = out.join('\n');
  if (skippedToolkitSheets.length) {
    console.log(
      `  kept ${skippedToolkitSheets.length} stylesheet(s) containing Toolkit markers report-only; ` +
        'do not extract or inline Toolkit-containing CSS',
    );
  }
  if (skippedUnselectedSheets.length) {
    console.log(
      `  kept ${skippedUnselectedSheets.length} unselected or cross-origin stylesheet(s) report-only; ` +
        'output requires an exact same-origin --owned-style assertion',
    );
  }
  if (skippedRelativeUrlSheets.length) {
    console.log(
      `  kept ${skippedRelativeUrlSheets.length} selected stylesheet(s) report-only because ` +
        'inlining would change relative url(...) resolution',
    );
  }
  if (outputPath && css) {
    writeNewFileAtomically(outputPath, css + '\n');
    console.log(`  wrote ${Buffer.byteLength(css)} UTF-8 source bytes of app-owned candidate CSS to ${outputPath}`);
  } else if (outputPath) {
    console.error('  no safely separable app-owned critical CSS was found; nothing was written');
    exitCode = 1;
  } else {
    console.log('  report only; to write a candidate, pass a new --out path and an exact app-owned --owned-style from above');
  }
  if (css) {
    console.log('  Inline that in <head>, then load the remaining app stylesheet non-blocking.');
    console.log('  It is a candidate, not an answer — verify with measure.mjs before keeping it.');
  }
} catch (error) {
  primaryError = error;
  if (error instanceof ReportedFailure) exitCode = 1;
  else throw error;
} finally {
  let cleanupError = null;
  if (grantMedia) {
    try { await cdp.send('Browser.resetPermissions'); } catch (error) { cleanupError = error; }
  }
  try { await tab.close(); } catch (error) { cleanupError ||= error; }
  if (cleanupError && !primaryError) throw cleanupError;
}
process.exitCode = exitCode;

function pathExistsNoFollow(path) {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

function writeNewFileAtomically(path, contents) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, 'wx', 0o644);
    writeFileSync(descriptor, contents);
    closeSync(descriptor);
    descriptor = undefined;
    linkSync(temporary, path);
  } catch (error) {
    if (error.code === 'EEXIST') {
      throw new Error(`refusing to overwrite existing --out path: ${path}`);
    }
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, {force: true});
  }
}

function containsRelativeCssUrl(css) {
  const urls = css.matchAll(/url\(\s*(?:(["'])(.*?)\1|([^)'"\s][^)]*))\s*\)/gi);
  for (const match of urls) {
    const value = String(match[2] ?? match[3] ?? '').trim();
    if (!/^(?:data:|https?:|\/\/|\/|#)/i.test(value)) return true;
  }
  return false;
}
