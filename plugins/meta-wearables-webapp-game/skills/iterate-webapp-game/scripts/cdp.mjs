#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * cdp.mjs — Zero-dependency Chrome DevTools Protocol driver for iterating on a
 * webapp game in a real browser.
 *
 * This is a CDP *client* only: it attaches to a Chrome already listening on a debugging port
 * (started via `npm run chrome`), drives one page, and reports results as JSON. It never
 * launches a browser — deliberately, because some agent sandboxes cannot launch Chromium at
 * all (Claude Code's macOS sandbox crashes it on a Mach bootstrap restriction → SIGSEGV) but
 * can still connect to one over localhost. Keeping launch out of this script means the same
 * driver works whether the agent or the user started the browser.
 *
 * Node 22+ (uses global WebSocket + fetch). No npm install required.
 *
 * The command surface, the port rules, the output contract and the exit codes are all in the
 * `USAGE` string below, which `cdp.mjs --help` prints verbatim.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Kept equal to the plugin's `version` in `.claude-plugin/plugin.json`, and asserted equal by
 * `tests/scripts/cdp.test.mjs`. It is a literal rather than a read of that file because this
 * script is run from copies where no plugin manifest sits above it, and a copy that cannot find
 * its version is exactly the stale copy `--version` exists to identify.
 */
const DRIVER_VERSION = '2.0.50';

const COMMANDS = ['status', 'open', 'shot', 'eval', 'step', 'click', 'drag', 'type', 'keys', 'logs', 'reload', 'foreground'];

const DEFAULT_PORT = 9222;

const USAGE = `cdp.mjs ${DRIVER_VERSION} — drive a webapp game in a Chrome that is already
listening on a CDP port (start one with \`npm run chrome\`).

Usage:
  node cdp.mjs status
  node cdp.mjs open    --url <url> [--timeout 30000]
  node cdp.mjs shot    [--out <path>] [--selector "<css>"] [--full]
  node cdp.mjs eval    --expr "<js expression>"
  node cdp.mjs step    [--frames <n>]
  node cdp.mjs click   --selector "<css>"
  node cdp.mjs drag    (--selector "<css>" | --from x,y) --dx <n> --dy <n> [--steps 12] [--drive]
  node cdp.mjs type    --selector "<css>" --text "<text>"
  node cdp.mjs keys    --keys "ArrowRight Space Enter"
  node cdp.mjs logs    [--clear]
  node cdp.mjs reload  [--timeout 30000]
  node cdp.mjs foreground [--no-frames]
  node cdp.mjs help | --help | -h
  node cdp.mjs version | --version

Port: --port <n> wins, else $CDP_PORT, else ${DEFAULT_PORT} — which warns on stderr, because one
Chrome per port is how parallel runs stay off each other's browser. A --port that isn't a usable
port number is a usage error (exit 2), never a fallback. \`npm run chrome\` reads $CDP_PORT too,
so exporting it once covers both ends.

Flags may go before or after the subcommand (\`cdp.mjs --port 9333 shot\`). A valueless flag
(--full, --clear, --drive, --no-frames) swallows the next token as its value, so keep those after it.

\`eval --expr\` takes an EXPRESSION, not a statement list: a \`;\` between two statements is a
syntax error. Wrap statements in an IIFE — --expr "(()=>{const n=1; return n})()".

\`step\` needs a page loaded with \`?drive\` (the loop is paused there and advances only when
asked). It reports how many frames the harness actually ran, and exits 1 if that is fewer than
--frames, because a diff across frames that never happened is not a result.

\`foreground\` raises the tab and asks Chrome to treat it as focused and active, then counts
\`requestAnimationFrame\` callbacks for ~1s. That count answers the question the command exists for —
can this tab render? Zero callbacks means the loop never ticks, so \`?stats\`, the game clock and
every FPS number read off the page are zeros rather than measurements. \`--no-frames\` skips the
second of counting.

It also reports \`document.visibilityState\` / \`document.hasFocus()\` / a derived \`occluded\`, from
before and after the three calls. Those corroborate; they do not decide. On macOS on 2026-08-28 a
covered window reported \`visible\`, \`hasFocus: true\` and \`occluded: false\` while delivering 0
callbacks in a second, so a clean visibility read does not clear a tab for measurement. Each of the
three calls is reported separately: one unsupported domain does not stop the others or hide the
resulting state.

Output: machine-readable JSON on stdout, a human summary on stderr; \`help\` and \`version\`
print plain text on stdout.
Exit codes: 0 ok; 1 operation failed; 2 bad usage; 3 Chrome not reachable (launch it).`;

const argv = process.argv.slice(2);
const { command, flags } = splitCommand(argv);
const args = parseArgs(flags);
const FLAG_PORT = portOrNull(args.port);
const ENV_PORT = portOrNull(process.env.CDP_PORT);
const PORT = FLAG_PORT ?? ENV_PORT ?? DEFAULT_PORT;
const CDP = `http://127.0.0.1:${PORT}`; // IPv4 — Node resolves `localhost` to ::1, which Chrome doesn't bind.

/** `MouseEvent.buttons` bit 0 — the primary button, held while a `click` or `drag` is pressed. */
const PRIMARY_BUTTON_MASK = 1;
/** Delay between a drag's interpolated moves; ~one frame at 60 Hz. */
const MOVE_STEP_MS = 16;
/**
 * Mirrors `DEFAULT_TAP_MAX_TRAVEL_PX` in the framework's `input/PointerKeyboardInput.ts`, which
 * this script cannot import (it ships in the scaffolding skill's templates, not here). Used only
 * to WARN that a drag is short enough to be classified as a tap — if the framework default
 * changes, the warning threshold goes stale but nothing breaks.
 */
const DEFAULT_TAP_MAX_TRAVEL_PX = 6;

// Injected into every page so short-lived driver invocations can read console output and
// uncaught errors that happened between commands (the buffer lives in the page, not here).
const CAPTURE_SHIM = `(() => {
  if (window.__cdpLog) return;
  const buf = [];
  window.__cdpLog = buf;
  const push = (level, args) => {
    try {
      buf.push({ level, text: args.map(a => {
        try {
          if (typeof a === 'string') return a;
          // Errors are the whole point of "capture errors", but JSON.stringify(err) is "{}"
          // (message/stack are non-enumerable). Serialize them explicitly; likewise fall back to
          // String() for DOM nodes / other objects that stringify to an empty/undefined value.
          if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
          const s = JSON.stringify(a);
          return s === undefined || s === '{}' ? String(a) : s;
        } catch { return String(a); }
      }).join(' ') });
      if (buf.length > 500) buf.splice(0, buf.length - 500);
    } catch (e) {}
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level];
    console[level] = (...a) => { push(level, a); try { orig.apply(console, a); } catch (e) {} };
  }
  window.addEventListener('error', e => push('uncaught', [((e && e.message) || 'error') + ' @ ' + ((e && e.filename) || '') + ':' + ((e && e.lineno) || '')]));
  window.addEventListener('unhandledrejection', e => push('unhandledrejection', [String(e && e.reason)]));
})();`;

async function main() {
  // `--help` / `--version` parse as flags, `help` / `version` / `-h` as the command token.
  if (command === 'help' || command === '-h' || flagOn(args.help)) return printText(USAGE);
  if (command === 'version' || flagOn(args.version)) {
    return printText(`cdp.mjs ${DRIVER_VERSION}\ncommands: ${COMMANDS.join(' ')}`);
  }
  // An unusable `--port` exits rather than falling back to $CDP_PORT or the default: silently
  // discarding the port the caller named would drive some other agent's Chrome, which is the
  // mix-up the whole port discipline exists to prevent.
  if (args.port !== undefined && FLAG_PORT == null) {
    return fail(2, `--port must be a port number 1-65535 (got ${JSON.stringify(args.port)}).`);
  }
  if (!COMMANDS.includes(command)) {
    const swallowed = command === undefined ? argv.find(t => COMMANDS.includes(t)) : undefined;
    const hint = swallowed
      ? ` \`${swallowed}\` was read as the value of the flag before it — a valueless flag (--full, --clear, --drive) swallows the next token, so put it after the subcommand.`
      : '';
    return fail(2, `Unknown command: ${command || '(none)'}. Run one of: ${COMMANDS.join(', ')}, help, version.${hint}`);
  }
  if (FLAG_PORT == null && ENV_PORT == null) {
    // A port nobody chose is a port that may belong to someone else's Chrome: the eval that
    // motivated this warning had five agents on five ports, and the one that omitted --port
    // screenshotted and read logs off another run's browser before noticing.
    //
    // "Unset" and "set to something unusable" are named apart because the remedy differs and the
    // second is invisible otherwise: `start-chrome-cdp.sh` takes `${CDP_PORT:-9222}` verbatim, so
    // a typo in the export puts the browser on the typo'd value while this driver falls back to
    // the default, and the two ends then disagree about which Chrome they are talking to.
    const envSet = process.env.CDP_PORT !== undefined && process.env.CDP_PORT !== '';
    const why = envSet
      ? `$CDP_PORT is set to ${JSON.stringify(process.env.CDP_PORT)}, which is not a port number 1-65535, and no usable --port`
      : 'no usable --port and no $CDP_PORT';
    emit(2, `Warning: using the default port ${DEFAULT_PORT} — ${why}. If your Chrome is on another port, pass --port <n> or export CDP_PORT=<n>.\n`);
  }
  switch (command) {
    case 'status': return cmdStatus();
    case 'open': return cmdOpen();
    case 'shot': return cmdShot();
    case 'eval': return cmdEval();
    case 'step': return cmdStep();
    case 'click': return cmdClick();
    case 'drag': return cmdDrag();
    case 'type': return cmdType();
    case 'keys': return cmdKeys();
    case 'logs': return cmdLogs();
    case 'reload': return cmdReload();
    case 'foreground': return cmdForeground();
    default:
      // Unreachable while COMMANDS and the cases above agree — a mismatch between them is a bug here.
      return fail(1, `\`${command}\` is listed in COMMANDS but has no implementation.`);
  }
}

// ============================ commands ============================

async function cmdStatus() {
  let version;
  try {
    version = await fetchJson(`${CDP}/json/version`);
  } catch {
    return done(3, {
      reachable: false, port: PORT,
      hint: `No Chrome with remote debugging on port ${PORT}. Start one with \`npm run chrome\` as a background task, then retry. If launching it crashes, your sandbox blocks Chromium — ask the user to run \`npm run chrome\` in a terminal outside the agent instead.`,
    }, `Chrome NOT reachable on ${CDP} — run \`npm run chrome\` (or ask the user to, if your sandbox can't launch it).`);
  }
  let pages = [];
  try {
    pages = (await listTargets()).filter(isPageTarget).map(t => ({ id: t.id, title: t.title, url: t.url }));
  } catch {}
  return done(0, { reachable: true, port: PORT, browser: version.Browser, pages },
    `Chrome reachable on ${CDP} (${version.Browser}); ${pages.length} page(s) open.`);
}

async function cmdOpen() {
  const url = str(args.url);
  if (!url) return fail(2, '`open` requires --url <url> (e.g. --url http://127.0.0.1:5173).');
  const timeout = num(args.timeout, 30000);
  await requireReachable();

  const target = await chooseOrCreateTarget();
  await withTarget(target, async (cdp) => {
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    // Runs the shim on every future document (survives in-page navigations/reloads).
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SHIM })
      .catch(e => emit(2, `Warning: console-capture shim failed to install; \`logs\` may be empty: ${e.message}\n`));
    const loadFired = cdp.waitEvent('Page.loadEventFired', timeout).catch(() => null);
    await cdp.send('Page.navigate', { url });
    const loaded = await loadFired;
    // Ensure the shim is present on the document we just loaded, too.
    await evaluate(cdp, CAPTURE_SHIM).catch(() => {});
    const title = await evalValue(cdp, 'document.title');
    saveTarget(target.id);
    // `loaded` is null when the load event never fired within `timeout` (bad URL, dev server down,
    // redirect stuck): report success but flag it so the caller doesn't trust a stale/blank title.
    if (!loaded) emit(2, `Warning: load event did not fire within ${timeout}ms; page may not be fully loaded.\n`);
    done(0, { ok: true, targetId: target.id, url, title, timedOut: !loaded },
      `Opened ${url} (title: ${JSON.stringify(title)})${loaded ? '' : ` — WARNING: load did not complete within ${timeout}ms`}.`);
  });
}

async function cmdShot() {
  const selector = str(args.selector);
  const full = flagOn(args.full);
  if (selector && full) {
    return fail(2, '`shot` takes --selector or --full, not both: --selector clips to one element, --full captures beyond the viewport.');
  }
  await requireReachable();
  const out = str(args.out) || path.join(os.tmpdir(), `webapp-game-shot-${PORT}.png`);
  await withResolvedPage(async (cdp) => {
    await cdp.send('Page.enable').catch(() => {});
    let clip;
    if (selector) {
      await cdp.send('Runtime.enable').catch(() => {});
      const rect = await elementRect(cdp, selector);
      if (!rect) return done(1, { ok: false, selector, error: 'selector not found' }, `shot failed: no element matches ${selector}.`);
      if (rect.width <= 0 || rect.height <= 0) {
        return done(1, { ok: false, selector, error: 'element has zero size' }, `shot failed: ${selector} measures ${rect.width}x${rect.height} — nothing to capture.`);
      }
      clip = { x: rect.x, y: rect.y, width: rect.width, height: rect.height, scale: 1 };
    }
    const res = await cdp.send('Page.captureScreenshot', {
      format: 'png', captureBeyondViewport: full, ...(clip ? { clip } : {}),
    });
    fs.writeFileSync(out, Buffer.from(res.data, 'base64'));
    const scope = clip ? ` (clipped to ${selector}: ${clip.width}x${clip.height} at ${clip.x},${clip.y})` : '';
    done(0, { ok: true, path: out, selector: selector ?? null, clip: clip ?? null },
      `Screenshot written to ${out}${scope} — view it with the Read tool.`);
  });
}

async function cmdEval() {
  if (!args.expr) return fail(2, '`eval` requires --expr "<js expression>".');
  await requireReachable();
  await withResolvedPage(async (cdp) => {
    await cdp.send('Runtime.enable').catch(() => {});
    const { value, error } = await evaluateReturning(cdp, args.expr);
    if (error) {
      const hint = statementListHint(error);
      return done(1, { ok: false, error, hint }, `eval failed: ${error}` + (hint ? `\n${hint}` : ''));
    }
    done(0, { ok: true, value }, `eval → ${JSON.stringify(value)}`);
  });
}

/**
 * The one syntax error worth explaining, and the only one this classifies: `--expr` is
 * substituted into an expression position, so a `;`-separated statement list is rejected at its
 * first `;` with a message that never mentions the wrapping. Any other syntax error is in the
 * caller's own code, and guessing at those would send them after the wrong thing.
 */
function statementListHint(error) {
  return /SyntaxError/.test(error) && /Unexpected token ';'/.test(error)
    ? 'Hint: --expr takes an EXPRESSION, so `a; b` is a syntax error. Wrap statements in an IIFE — --expr "(()=>{const n=1; return n})()".'
    : null;
}

// Advance the paused `?drive` loop by an explicit number of frames — the operation every
// before/after comparison of a driven game runs between its two captures.
async function cmdStep() {
  // Not `num()`: its fallback-to-default would read `--frames abc` as one frame and step the
  // wrong distance silently, and a wrong frame count is invisible in the result.
  const frames = args.frames === undefined ? 1 : Number(str(args.frames, NaN));
  if (!Number.isInteger(frames) || frames < 1) {
    return fail(2, `\`step\` needs --frames <positive integer> (got ${JSON.stringify(args.frames)}). Omit it to advance one frame.`);
  }
  await requireReachable();
  await withResolvedPage(async (cdp) => {
    await cdp.send('Runtime.enable').catch(() => {});
    await requireDriveHarness(cdp, 'step');
    const call = `window.__webappGame.step(${frames})`;
    let advanced;
    try {
      // `evalValue`, not `evaluate`: only the former inspects `exceptionDetails`, and a step that
      // threw in the page must not be reported as frames that ran.
      advanced = await evalValue(cdp, call);
    } catch (err) {
      return done(1, { ok: false, requested: frames, advanced: null, error: `${call} threw in the page — ${err.message}` },
        `\`step\` failed: ${call} threw in the page — ${err.message}`);
    }
    if (advanced === frames) {
      return done(0, { ok: true, requested: frames, advanced }, `Advanced ${advanced} frame(s).`);
    }
    if (!Number.isInteger(advanced) || advanced < 0) {
      // Not a partial advance — this page's `step` is not the framework harness. Saying "stopped
      // accepting steps partway through" would assert a cause the return value cannot support,
      // and reporting a non-number as `advanced` drops the key from the JSON entirely when it is
      // `undefined`, so the machine consumer sees a report with no frame count at all.
      return done(1, { ok: false, requested: frames, advanced: null, error: 'the harness did not return a valid frame count' },
        `\`step\` failed: ${call} returned ${JSON.stringify(advanced) ?? 'undefined'}, which is not a frame count. This page's \`__webappGame.step\` is not the framework harness.`);
    }
    if (advanced > frames) {
      // A count above what was asked for is not a partial advance, so the "fewer frames" error
      // and its causes would contradict the numbers printed beside them. The framework harness
      // cannot do this; a page whose `step` over-reports is as untrustworthy as one that returns
      // a non-number, and is reported the same way.
      return done(1, { ok: false, requested: frames, advanced, error: 'the harness advanced more frames than requested' },
        `\`step\` failed: asked for ${frames} frame(s); the harness reported ${advanced}. A harness that overshoots is not the framework's — do not trust the frame count.`);
    }
    // Exit 1, not 0. The harness returns how many frames it ran, and runs fewer than asked only
    // when the loop is not actually paused — so the caller's next screenshot, diff or state read
    // describes a simulation that never advanced. Reported as success it is indistinguishable
    // from a game that ignores its input.
    const why = advanced === 0
      ? 'The loop is running, so the harness stepped nothing — a manual step and an rAF tick cannot be interleaved. Pause it (`eval --expr "window.__webappGame.pause()"`) or reload the game with `?drive`.'
      : 'The loop stopped accepting steps partway through.';
    done(1, { ok: false, requested: frames, advanced, error: 'fewer frames advanced than requested' },
      `Asked for ${frames} frame(s); the harness advanced ${JSON.stringify(advanced)}. ${why}`);
  });
}

/**
 * Confirm the page is running the `?drive` harness, or report which of the three ways it isn't
 * and exit 1. `label` names the invocation in the message; `extra` appends command-specific
 * advice. Each state needs a different fix, so none of them share a message.
 */
async function requireDriveHarness(cdp, label, extra = '') {
  let harness;
  try {
    // Probe the METHOD, not the object: `typeof window.__webappGame` is also `"object"` when it is
    // null, which would pass the guard and then throw in-page on the first step.
    harness = await evalValue(cdp,
      'window.__webappGame == null ? "missing" : (typeof window.__webappGame.step === "function" ? "ok" : "no-step")');
  } catch (err) {
    // A probe that never ran is not the same as a page without a harness. Collapsing the two
    // would blame the game for what is a CDP/evaluation failure.
    return done(1, { ok: false, error: `drive harness probe failed: ${err.message}` },
      `\`${label}\` could not probe the page for the \`?drive\` harness: ${err.message}`);
  }
  if (harness !== 'ok') {
    const detail = harness === 'missing'
      ? 'the page has no `window.__webappGame`. Reload the game with `?drive` (e.g. `open --url "http://127.0.0.1:5173/?drive"`).'
      : '`window.__webappGame` has no callable `step()` — the game predates `framework/debug/DriveHarness.ts`. Re-sync it with `/update-webapp-game-framework`.';
    return done(1, { ok: false, error: 'no drive harness', harness },
      `\`${label}\` needs the \`?drive\` harness: ${detail}${extra}`);
  }
}

async function cmdClick() {
  const selector = args.selector;
  if (!selector) return fail(2, '`click` requires --selector "<css>".');
  await requireReachable();
  await withResolvedPage(async (cdp) => {
    await cdp.send('Runtime.enable').catch(() => {});
    const center = await elementCenter(cdp, selector);
    if (!center) return done(1, { ok: false, selector, error: 'selector not found' }, `click failed: no element matches ${selector}.`);
    const { x, y } = center;
    // Move → press → brief hold → release. The hold keeps the press+release from reading as
    // an instantaneous event, which drag-threshold-sensitive UIs (e.g. Three.js controls) drop.
    // `buttons` reports the primary button as held for the duration of the hold and released
    // after it, which is the state PointerKeyboardInput's pointermove gate reads.
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, buttons: 0 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: PRIMARY_BUTTON_MASK, clickCount: 1 });
    await sleep(30);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
    done(0, { ok: true, selector, x: r1(x), y: r1(y) }, `Clicked ${selector} at (${r1(x)}, ${r1(y)}).`);
  });
}

// Press, MOVE, release — the one gesture `click` cannot produce. `click` presses and releases at a
// single point, so it always reads as zero-travel (a tap). A game that opted into the EMG index
// pinch-and-move channel (`{ pointerDrag: true }` + `touch-action: none`) builds its movement delta
// from `pointermove` movementX/Y while the primary button is held, and only this reaches it.
async function cmdDrag() {
  const selector = str(args.selector);
  const from = parsePoint(args.from, '--from');
  if (!selector && !from) {
    return fail(2, '`drag` requires --selector "<css>" (drag from its centre) or --from "x,y" (viewport coordinates).');
  }
  if (args.dx == null && args.dy == null) {
    return fail(2, '`drag` requires --dx and/or --dy (pixels to travel, may be negative).');
  }
  const dx = num(args.dx, 0);
  const dy = num(args.dy, 0);
  if (dx === 0 && dy === 0) {
    return fail(2, '`drag` needs a non-zero --dx or --dy. For a zero-travel press-and-release (a tap), use `click`.');
  }
  // One event per step; 12 across a typical gesture gives a rAF-driven game several samples of
  // intermediate positions rather than one teleport, which matters for anything that integrates
  // the delta per frame.
  const steps = Math.max(1, Math.round(num(args.steps, 12)));
  const stepFrames = flagOn(args.drive);
  await requireReachable();

  await withResolvedPage(async (cdp) => {
    await cdp.send('Runtime.enable').catch(() => {});
    if (stepFrames) {
      await requireDriveHarness(cdp, 'drag --drive', ' Without --drive the drag still works on a free-running loop.');
    }
    let start = from;
    if (!start) {
      start = await elementCenter(cdp, selector);
      if (!start) return done(1, { ok: false, selector, error: 'selector not found' }, `drag failed: no element matches ${selector}.`);
    }
    const end = { x: start.x + dx, y: start.y + dy };

    const release = () => cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: end.x, y: end.y, button: 'left', buttons: 0, clickCount: 1 });
    let buttonHeld = false;
    try {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: start.x, y: start.y, buttons: 0 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: start.x, y: start.y, button: 'left', buttons: PRIMARY_BUTTON_MASK, clickCount: 1 });
      buttonHeld = true;
      for (let step = 1; step <= steps; step++) {
        const progress = step / steps;
        await cdp.send('Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: start.x + dx * progress,
          y: start.y + dy * progress,
          // `buttons` is what makes this a DRAG rather than a hover: the page sees the primary
          // button held throughout, which is the gate PointerKeyboardInput accumulates movement behind.
          button: 'left',
          buttons: PRIMARY_BUTTON_MASK,
        });
        // Under `?drive` nothing runs between the moves unless we run it. The framework drops any
        // movement still unconsumed when the pinch ends, so a paused loop would reach pointerup
        // with the whole gesture's delta accumulated and then discard all of it. A frame after each
        // move drains it the way a real rAF tick would.
        if (stepFrames) await driveStep(cdp);
        else await sleep(MOVE_STEP_MS);
      }
      await release();
      buttonHeld = false;
      // One more frame so the game renders whatever `pinchEnd` changed.
      if (stepFrames) await driveStep(cdp);
    } catch (err) {
      // Never leave the page with the primary button down. Abandoning the gesture between the
      // press and the release holds the pinch open, and every later command then runs against a
      // pointer state no real user could produce.
      if (buttonHeld) await release().catch(() => {});
      fail(1, `\`drag${stepFrames ? ' --drive' : ''}\` failed mid-gesture (the drag was released): ${err.message}`);
    }

    // The framework classifies a pinch by RAW MANHATTAN travel (|movementX| + |movementY| summed
    // over the gesture) and calls anything at or under `tapMaxTravelPx` — 6 by default — a tap
    // instead. A tiny drag would therefore fire `pinchTap` and look like the drag silently failed.
    const travel = Math.abs(dx) + Math.abs(dy);
    const warning = travel <= DEFAULT_TAP_MAX_TRAVEL_PX
      ? `Travel is ${travel}px, at or under the framework's default ${DEFAULT_TAP_MAX_TRAVEL_PX}px tap threshold — the game will read this as a pinchTap, not a drag. Use a larger --dx/--dy.`
      : null;

    const target = selector ? `${selector} (centre ${r1(start.x)}, ${r1(start.y)})` : `(${r1(start.x)}, ${r1(start.y)})`;
    done(0, { ok: true, selector: selector ?? null, from: { x: r1(start.x), y: r1(start.y) }, to: { x: r1(end.x), y: r1(end.y) }, dx, dy, steps, stepped: stepFrames, travel, warning },
      `Dragged from ${target} by (${dx}, ${dy}) in ${steps} step(s)${stepFrames ? `, advancing ${steps + 1} driven frames` : ''}.` + (warning ? `\nWARNING: ${warning}` : ''));
  });
}

// Advance the `?drive` harness by one frame, via `evalValue` rather than `evaluate` because only
// the former inspects `exceptionDetails`. A step that throws in the page has to fail the command:
// reporting `stepped: true` and "advancing N driven frames" for frames that never ran turns a
// broken harness into a plausible-looking result. It THROWS rather than exiting, so the caller
// can release the pinch it is holding before the process ends.
async function driveStep(cdp) {
  try {
    await evalValue(cdp, 'window.__webappGame.step(1)');
  } catch (err) {
    throw new Error(`window.__webappGame.step(1) threw in the page — ${err.message}`);
  }
}

/**
 * An element's box in PAGE coordinates (scroll offset included), which is what
 * `Page.captureScreenshot`'s `clip` takes — `getBoundingClientRect()` alone is viewport-relative
 * and would capture the wrong band on a scrolled page.
 */
async function elementRect(cdp, selector) {
  return evalValue(cdp,
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;const r=el.getBoundingClientRect();return {x:r.left+scrollX,y:r.top+scrollY,width:r.width,height:r.height};})()`);
}

// Viewport-space centre of the first element matching `selector`, or null if nothing matches.
async function elementCenter(cdp, selector) {
  return evalValue(cdp,
    `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return null;el.scrollIntoView({block:'center',inline:'center'});const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
}

async function cmdType() {
  const selector = args.selector;
  const text = args.text;
  if (!selector || text == null) return fail(2, '`type` requires --selector "<css>" and --text "<text>".');
  await requireReachable();
  await withResolvedPage(async (cdp) => {
    await cdp.send('Runtime.enable').catch(() => {});
    const focused = await evalValue(cdp,
      `(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el)return false;el.focus();return true;})()`);
    if (!focused) return done(1, { ok: false, selector, error: 'selector not found' }, `type failed: no element matches ${selector}.`);
    await cdp.send('Input.insertText', { text: String(text) });
    done(0, { ok: true, selector, text: String(text) }, `Typed ${JSON.stringify(String(text))} into ${selector}.`);
  });
}

async function cmdKeys() {
  if (!args.keys) return fail(2, '`keys` requires --keys "<key> <key> ..." (e.g. "ArrowRight Space Enter").');
  const tokens = String(args.keys).trim().split(/\s+/).filter(Boolean);
  const defs = [];
  for (const tok of tokens) {
    const k = keyDef(tok);
    if (!k) {
      return fail(2, `Unsupported key token "${tok}". Use a single character or a named key (${Object.keys(NAMED_KEYS).join(', ')}). For arbitrary text, use \`type\` instead.`);
    }
    defs.push(k);
  }
  await requireReachable();
  await withResolvedPage(async (cdp) => {
    for (const k of defs) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk, text: k.text });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
      await sleep(30);
    }
    done(0, { ok: true, keys: tokens }, `Dispatched ${tokens.length} key(s): ${tokens.join(' ')}.`);
  });
}

async function cmdLogs() {
  await requireReachable();
  const clear = flagOn(args.clear);
  await withResolvedPage(async (cdp) => {
    await cdp.send('Runtime.enable').catch(() => {});
    const result = await evalValue(cdp,
      `(()=>{const b=window.__cdpLog;const c=b?b.slice():[];${clear ? 'if(b)b.length=0;' : ''}return {present:!!b,logs:c};})()`)
      || { present: false, logs: [] };
    const logs = result.logs || [];
    // Only report cleared when a real capture buffer existed to clear — otherwise `--clear` would
    // no-op on a missing shim (e.g. the tab was navigated manually) yet still claim success.
    const cleared = clear && result.present;
    const note = cleared
      ? ' (buffer cleared)'
      : clear ? ' (no capture buffer to clear — was the page opened via this tool?)' : '';
    done(0, { ok: true, count: logs.length, cleared, logs },
      `${logs.length} captured log line(s)${note}.`);
  });
}

async function cmdReload() {
  await requireReachable();
  const timeout = num(args.timeout, 30000);
  await withResolvedPage(async (cdp) => {
    await cdp.send('Page.enable');
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: CAPTURE_SHIM })
      .catch(e => emit(2, `Warning: console-capture shim failed to install; \`logs\` may be empty: ${e.message}\n`));
    const loadFired = cdp.waitEvent('Page.loadEventFired', timeout).catch(() => null);
    await cdp.send('Page.reload');
    const loaded = await loadFired;
    await cdp.send('Runtime.enable').catch(() => {});
    await evaluate(cdp, CAPTURE_SHIM).catch(() => {});
    if (!loaded) emit(2, `Warning: load event did not fire within ${timeout}ms; page may not be fully loaded.\n`);
    done(0, { ok: true, timedOut: !loaded },
      `Reloaded current page${loaded ? '' : ` — WARNING: load did not complete within ${timeout}ms`}.`);
  });
}

/**
 * The three ways to tell Chrome the driven tab is in the foreground, in escalating order: raise
 * the window, emulate focus, and force the document's lifecycle state back to `active`. They are
 * independent — `Emulation` is not enabled on every target, and `Page.setWebLifecycleState`
 * rejects a target it does not own — so each is attempted and reported on its own.
 */
const FOREGROUND_CALLS = [
  { name: 'bringToFront', method: 'Page.bringToFront', params: {} },
  { name: 'focusEmulation', method: 'Emulation.setFocusEmulationEnabled', params: { enabled: true } },
  { name: 'webLifecycle', method: 'Page.setWebLifecycleState', params: { state: 'active' } },
];

/** Window the in-page rAF counter runs for, and the margin its result is collected after. */
const FRAME_PROBE_MS = 1000;
const FRAME_PROBE_SETTLE_MS = 200;
/** How long to wait for the probe itself before calling the page unresponsive. */
const FRAME_PROBE_DEADLINE_MS = FRAME_PROBE_MS + FRAME_PROBE_SETTLE_MS + 2000;
// Below this many callbacks in the probe window the tab is being throttled rather than running,
// so nothing read off `?stats` is a measurement — the same conclusion as zero, reached sooner.
// This is a throttled/not-throttled split, NOT the game's 30fps target: the two runs actually
// measured were 0 and 61 (macOS, 2026-08-28), and 20 is placed in the gap between them rather
// than read off either. A count above it means the tab is measurable, and says nothing about
// whether the game is hitting 30fps — `?stats` answers that.
const LOW_FRAME_COUNT = 20;

/** Reads `document`'s own account of whether it is visible and focused. */
const VISIBILITY_PROBE = '({visibilityState: document.visibilityState, hasFocus: document.hasFocus()})';

/** Counts rAF callbacks for `FRAME_PROBE_MS`, then resolves with the total. */
const FRAME_PROBE = `(()=>{const t0=performance.now();let n=0;` +
  `const f=()=>{n++;if(performance.now()-t0<${FRAME_PROBE_MS})requestAnimationFrame(f)};requestAnimationFrame(f);` +
  `return new Promise(r=>setTimeout(()=>r({callbacks:n}),${FRAME_PROBE_MS + FRAME_PROBE_SETTLE_MS}))})()`;

/**
 * Ask Chrome to foreground the driven tab, then report whether it is actually delivering frames.
 *
 * The frame count is the authoritative half: zero rAF callbacks means a free-running loop does not
 * advance, so `?stats`, the game clock and every performance number read off the page are zeros
 * rather than measurements. The visibility fields corroborate only — on macOS on 2026-08-28 a
 * covered Chrome window reported `visibilityState: "visible"`, `hasFocus: true` and therefore
 * `occluded: false` while delivering 0 callbacks in a second, so a clean-looking visibility read
 * cannot clear a tab for measurement. Both readings are reported because the three calls below can
 * change the state the command then reports, and a failure of either one alone does not suppress
 * the other — only losing both is an error.
 */
async function cmdForeground() {
  const measureFrames = !flagOn(args['no-frames']);
  await requireReachable();
  await withResolvedPage(async (cdp) => {
    await cdp.send('Runtime.enable').catch(() => {});
    // Before the calls, so the report distinguishes the state the tab was found in from the state
    // the calls left it in. A throw goes into `beforeError` rather than being swallowed,
    // symmetrically with the post-call probe, so `before: null` with no `beforeError` means the
    // page answered nothing rather than that the read failed.
    let before = null;
    let beforeError = null;
    try {
      before = await evalValue(cdp, VISIBILITY_PROBE);
    } catch (err) {
      beforeError = `visibility probe failed: ${err.message}`;
    }

    const applied = [];
    for (const call of FOREGROUND_CALLS) {
      try {
        await cdp.send(call.method, call.params);
        applied.push({ name: call.name, method: call.method, ok: true, error: null });
      } catch (err) {
        // A domain that is unavailable or refuses the call is not a reason to abandon the other
        // two, nor to skip the state probe — a partial application still changes what the tab
        // reports, and that report is the useful part.
        applied.push({ name: call.name, method: call.method, ok: false, error: err.message });
      }
    }
    const okNames = applied.filter(a => a.ok).map(a => a.name);
    const summary = applied.map(a => (a.ok ? `${a.name} ok` : `${a.name} FAILED (${a.error})`)).join(', ');

    let after = null;
    let afterError = null;
    try {
      after = await evalValue(cdp, VISIBILITY_PROBE);
    } catch (err) {
      // Corroborating only, and tolerated exactly like the `before` probe: losing it must not
      // discard the frame count below, which is the measurement this command exists for.
      afterError = `visibility probe failed: ${err.message}`;
    }
    const visibilityState = after?.visibilityState ?? null;
    const hasFocus = after?.hasFocus ?? null;
    // `null`, not `false`, when the probe never answered: a machine consumer cannot otherwise
    // tell "read, and not occluded" from "never read", and the second is not evidence of anything.
    const occluded = after === null ? null : visibilityState === 'hidden' && hasFocus === true;

    let frames = null;
    let frameError = null;
    if (measureFrames) {
      try {
        // Raced on the Node side because the probe resolves from an in-page `setTimeout`, and a
        // tab throttled hard enough to stop delivering frames throttles its timers too — the very
        // case this measures. Without the race that lands on `send`'s 30s ceiling: half a minute
        // of silence, then a generic CDP timeout instead of a verdict about the tab.
        const counted = await Promise.race([
          evalValue(cdp, FRAME_PROBE),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('in-page timers did not fire')), FRAME_PROBE_DEADLINE_MS)),
        ]);
        // A page that answers the probe with anything but a number counted nothing: report the
        // absence rather than a `frames` field a caller would read as a measurement.
        frames = Number.isFinite(counted?.callbacks) ? counted.callbacks : null;
        if (frames === null) frameError = `frame probe returned ${JSON.stringify(counted)} instead of a callback count`;
      } catch (err) {
        frameError = `frame probe failed: ${err.message}`;
      }
    }

    // `null`, not `false`, when there is no count — under `--no-frames`, or when the probe threw
    // or answered with a non-number. `false` would tell a machine consumer "measured, and not
    // throttled" about a tab that was never measured. Same reason `occluded` is null when the
    // visibility read failed. Zero is `false` too, and deliberately: a dead tab is not a slow one,
    // and `frames === 0` is the field that says so — read `frames` first.
    const throttled =
      frames === null ? null : frames > 0 && frames < LOW_FRAME_COUNT;
    const frameLine = frames === 0
      ? `0 rAF callbacks in ~${FRAME_PROBE_MS}ms — this tab is delivering NO frames.`
      : throttled
      ? `${frames} rAF callback(s) in ~${FRAME_PROBE_MS}ms — under the ${LOW_FRAME_COUNT}-callback floor: this tab is throttled, not merely slow.`
      : frames !== null ? `${frames} rAF callback(s) in ~${FRAME_PROBE_MS}ms — frames are being delivered. This says the tab is measurable, not that the game hits its 30fps target; read that off \`?stats\`.`
      : measureFrames ? `Frame delivery UNKNOWN (${frameError}).`
      : 'Frame delivery not measured (--no-frames).';

    const hints = [];
    if (frames === 0) {
      hints.push('No frames means no free-running number on this page is a measurement: the loop does not tick, so `?stats`, the game clock and any FPS reading are zeros. Uncover the Chrome window (or relaunch it via `npm run chrome`, whose flags target this), or measure CPU work per frame under `?drive`, which does not use rAF at all.');
    }
    if (throttled) {
      hints.push(`A tab delivering ${frames} frame(s) a second is throttled, not healthy-but-idle, so \`?stats\` and any FPS reading here understate the game rather than measure it. Treat it like the zero case — uncover the Chrome window (or relaunch it via \`npm run chrome\`) and re-measure — or measure CPU work per frame under \`?drive\`, which does not use rAF at all.`);
    }
    if (occluded) {
      hints.push('The tab also reports hidden while focused. Corroborating only — the frame count above is what decides whether anything here is measurable.');
    }
    if (afterError) {
      hints.push(`The post-call visibility read failed (${afterError}), so the visibility fields are null. Corroborating only — the frame count above stands on its own.`);
    }
    if (beforeError) {
      hints.push(`The pre-call visibility read failed (${beforeError}), so \`before\` is null. It only says what state the tab was found in; nothing else depends on it.`);
    }
    if (frames === null && measureFrames) {
      hints.push('Without a frame count, the visibility fields cannot stand in for one: a tab reporting `visible` and `occluded: false` was measured delivering zero frames (macOS, 2026-08-28). Retry the probe, or measure under `?drive`, which does not use rAF at all.');
    }
    const hint = hints.length ? hints.join('\n') : null;

    // Nothing could be read off the page at all — neither reading survived, so there is no report
    // to make. A failure of either one alone still leaves a usable report.
    // One key set on both exit paths, so a consumer parses one shape: the failure path fills the
    // measurements it could not take with null rather than omitting them.
    const report = { frames, framesMeasured: measureFrames, frameProbeMs: FRAME_PROBE_MS, frameError, throttled, lowFrameCount: LOW_FRAME_COUNT, applied, appliedCount: okNames.length, before, beforeError, after, afterError, visibilityState, hasFocus, occluded, hint };

    if (after === null && frames === null) {
      // Neither `afterError` nor `frameError` is guaranteed: the visibility probe can resolve to
      // null without throwing, and `--no-frames` leaves `frameError` null by design, so the two
      // together would report `error: null` on a failure. A consumer keying on `report.error`
      // must get something.
      const error =
        afterError ?? frameError ?? 'nothing could be read back from the page';
      return done(1, { ok: false, ...report, error },
        `\`foreground\` applied ${okNames.length}/${FOREGROUND_CALLS.length} (${summary}), but came back with no post-call reading and no frame count: ${afterError ?? 'visibility probe returned nothing'}; ${frameError ?? 'frames not measured'}.` +
        // The hints computed above are the actionable half of this failure; the success path
        // appends them and a human reading only stderr would otherwise never see them.
        (hint ? `\n${hint}` : ''));
    }

    done(0, { ok: true, ...report },
      `\`foreground\`: ${frameLine} ` +
      `Applied ${okNames.length}/${FOREGROUND_CALLS.length} (${summary}); the tab now reports ` +
      `visibilityState=${JSON.stringify(visibilityState)}, hasFocus=${JSON.stringify(hasFocus)} ` +
      `(before: ${JSON.stringify(before?.visibilityState ?? null)}, ${JSON.stringify(before?.hasFocus ?? null)}).` +
      (hint ? `\n${hint}` : ''));
  });
}

// ============================ target selection ============================

async function requireReachable() {
  try {
    await fetchJson(`${CDP}/json/version`);
  } catch {
    fail(3, `Chrome not reachable on ${CDP}. Run \`npm run chrome\` as a background task (or, if your sandbox can't launch Chromium, ask the user to run it in a terminal outside the agent), then retry.`);
  }
}

async function listTargets() {
  return fetchJson(`${CDP}/json`);
}

function isPageTarget(t) {
  return t && t.type === 'page' && typeof t.url === 'string' && !t.url.startsWith('devtools://');
}

// For `open`: reuse the saved tab if it still exists, else the first page tab, else make one.
async function chooseOrCreateTarget() {
  const targets = await listTargets();
  const pages = targets.filter(isPageTarget);
  const savedId = loadTarget();
  const saved = savedId && pages.find(t => t.id === savedId);
  if (saved) return saved;
  if (pages.length) return pages[0];
  // No page tab open — create a blank one to navigate.
  let created;
  try {
    created = await fetchJson(`${CDP}/json/new?about:blank`, { method: 'PUT' });
  } catch {
    created = await fetchJson(`${CDP}/json/new?about:blank`);
  }
  return created;
}

// For every command except `open`: resolve the tab we're driving (saved, else first page tab).
async function withResolvedPage(fn) {
  const targets = await listTargets();
  const pages = targets.filter(isPageTarget);
  if (!pages.length) return fail(1, 'No open page in Chrome. Run `cdp.mjs open --url <url>` first.');
  const savedId = loadTarget();
  const target = (savedId && pages.find(t => t.id === savedId)) || pages[0];
  saveTarget(target.id);
  return withTarget(target, fn);
}

async function withTarget(target, fn) {
  if (!target.webSocketDebuggerUrl) {
    return fail(1, `Target ${target.id} has no webSocketDebuggerUrl (DevTools may be attached to it). Close DevTools for that tab and retry.`);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await once(ws, 'open', 5000);
  const cdp = makeClient(ws);
  try {
    return await fn(cdp);
  } finally {
    try { ws.close(); } catch {}
  }
}

// ============================ evaluate helpers ============================

// Run a statement/side-effecting snippet; ignore the value.
async function evaluate(cdp, expression) {
  return cdp.send('Runtime.evaluate', { expression, awaitPromise: true });
}

// Evaluate an expression and return its JSON-serializable value (awaits promises).
// Throws on a JS evaluation error so callers don't mistake a genuine failure for a
// legitimate null (e.g. `click` reporting "selector not found" when the snippet threw).
async function evalValue(cdp, expr) {
  const { value, error } = await evaluateReturning(cdp, expr);
  if (error) throw new Error(error);
  return value;
}

async function evaluateReturning(cdp, expr) {
  const wrapped = `(async()=>{const v=await (${expr});try{return JSON.parse(JSON.stringify(v===undefined?null:v));}catch(e){return String(v);}})()`;
  const r = await cdp.send('Runtime.evaluate', { expression: wrapped, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails;
    return { error: (ex.exception && (ex.exception.description || ex.exception.value)) || ex.text || 'evaluation error' };
  }
  return { value: r.result ? r.result.value : null };
}

// ============================ key mapping ============================

const NAMED_KEYS = {
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  up: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  down: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  left: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  right: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
};

// Returns a CDP key descriptor, or null for a token we can't map faithfully.
// A multi-character token that isn't a known named key (e.g. Shift, Home, F1) is NOT
// silently truncated to its first character — the caller rejects it instead.
function keyDef(token) {
  const named = NAMED_KEYS[token.toLowerCase()];
  if (named) return named;
  if (token.length !== 1) return null;
  const ch = token;
  const upper = ch.toUpperCase();
  // Normalize a letter to a realistic UNSHIFTED keypress (key/text lowercase, code `Key<UPPER>`).
  // Dispatching `key: 'A'` without a Shift modifier is a state a real keyboard can't produce
  // (`event.key === 'A'` yet `shiftKey === false`); `keys` is for game control, not text — use
  // `type` for literal uppercase input.
  if (upper >= 'A' && upper <= 'Z') {
    const lower = upper.toLowerCase();
    return { key: lower, code: 'Key' + upper, vk: upper.charCodeAt(0), text: lower };
  }
  if (ch >= '0' && ch <= '9') return { key: ch, code: 'Digit' + ch, vk: ch.charCodeAt(0), text: ch };
  // Punctuation/symbol: dispatch the character via `text`, but leave windowsVirtualKeyCode
  // as 0 — an ASCII code is not a valid VK (e.g. '!' is 33 = VK_PAGE_UP), so claiming one
  // gives games a wrong keyCode/which. For arbitrary text prefer the `type` command.
  return { key: ch, code: '', vk: 0, text: ch };
}

// ============================ CDP client ============================

function makeClient(ws) {
  let id = 0;
  const pending = new Map();
  const waiters = new Map();
  ws.addEventListener('message', ev => {
    const m = JSON.parse(ev.data);
    if (m.id != null && pending.has(m.id)) {
      const { resolve, reject, method, t } = pending.get(m.id);
      pending.delete(m.id); clearTimeout(t);
      m.error ? reject(new Error((method || 'cdp') + ': ' + m.error.message)) : resolve(m.result);
    } else if (m.method) {
      const w = waiters.get(m.method);
      if (w) { waiters.delete(m.method); clearTimeout(w.t); w.resolve(m.params); }
    }
  });
  let socketFailed = false;
  const failPending = (why) => {
    if (socketFailed) return;
    socketFailed = true;
    for (const [, { reject, method, t }] of pending) { clearTimeout(t); reject(new Error((method || 'cdp') + ': WebSocket ' + why)); }
    pending.clear();
    for (const [, w] of waiters) { clearTimeout(w.t); w.reject(new Error('WebSocket ' + why)); }
    waiters.clear();
  };
  ws.addEventListener('close', () => failPending('closed'));
  ws.addEventListener('error', () => failPending('error'));
  return {
    send(method, params = {}) {
      if (socketFailed) return Promise.reject(new Error((method || 'cdp') + ': WebSocket closed'));
      const myId = ++id;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { if (pending.has(myId)) { pending.delete(myId); reject(new Error('timeout ' + method)); } }, 30000);
        pending.set(myId, { resolve, reject, method, t });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
    waitEvent(method, ms) {
      return new Promise((resolve, reject) => {
        // Only one waiter per method is tracked. If one is already pending, reject it now rather
        // than silently overwriting it (which would leave it to hang forever) before taking its slot.
        const prev = waiters.get(method);
        if (prev) { clearTimeout(prev.t); prev.reject(new Error('superseded by a newer wait for ' + method)); }
        const t = setTimeout(() => { waiters.delete(method); reject(new Error('event timeout ' + method)); }, ms);
        waiters.set(method, { resolve, reject, t });
      });
    },
  };
}

// ============================ target persistence ============================

function stateFile() {
  return path.join(os.tmpdir(), `webapp-game-cdp-${PORT}.target`);
}
function saveTarget(targetId) {
  try { fs.writeFileSync(stateFile(), String(targetId)); } catch {}
}
function loadTarget() {
  try { return fs.readFileSync(stateFile(), 'utf8').trim() || null; } catch { return null; }
}

// ============================ utils ============================

/**
 * Split the subcommand out of `argv` so flags can precede it. The scan skips exactly what
 * `parseArgs` consumes — including the token a valueless `--flag` takes as its value — so the two
 * never disagree about which token is the command (`shot --out x.png` must not read `x.png` as one).
 */
function splitCommand(a) {
  for (let i = 0; i < a.length; i++) {
    if (a[i].startsWith('--')) {
      if (a[i].indexOf('=') === -1 && i + 1 < a.length && !a[i + 1].startsWith('--')) i++;
      continue;
    }
    return { command: a[i], flags: a.slice(0, i).concat(a.slice(i + 1)) };
  }
  return { command: undefined, flags: a };
}

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) continue;
    // `--key=value` binds the value unambiguously — the only way to pass a value that
    // itself starts with `--` (e.g. --text=--foo), since a following `--…` token is
    // otherwise read as the next flag.
    const eq = a[i].indexOf('=');
    if (eq !== -1) { o[a[i].slice(2, eq)] = a[i].slice(eq + 1); continue; }
    const k = a[i].slice(2);
    const v = (i + 1 < a.length && !a[i + 1].startsWith('--')) ? a[++i] : true;
    o[k] = v;
  }
  return o;
}
// A bare flag (e.g. `--port` with no value) is `true`, not a number — fall back to the
// default rather than coercing `Number(true)` to 1.
function num(v, d) { if (typeof v === 'boolean' || v == null) return d; const n = Number(v); return Number.isFinite(n) ? n : d; }
// A TCP port, or null for anything that isn't one — a bare `--port`, an empty `CDP_PORT=`, a
// typo. Null means "this source said nothing", which is what the default-port warning reports on.
function portOrNull(v) {
  const n = num(v, null);
  return Number.isInteger(n) && n > 0 && n < 65536 ? n : null;
}
// A `--flag` is on when bare (`--flag`, parsed as `true`) or set to a truthy string; explicit
// `--flag=false` / `--flag=0` / `--flag=` turn it off. Without this, `!!args.flag` treats the
// string `"false"` as truthy — so `--full=false` would wrongly enable it. Matches the ?strict/?mute convention.
function flagOn(v) {
  return v === true || (typeof v === 'string' && v !== '' && v !== '0' && v.toLowerCase() !== 'false');
}
function r1(x) { return (x == null || !Number.isFinite(+x)) ? null : Math.round(+x * 10) / 10; }
// A value-expecting flag passed bare (`--out` with no value) parses as `true`, not a string. Treat
// that as absent (return the default) so the caller fails with a clear usage error rather than a
// downstream TypeError (e.g. `fs.writeFileSync(true, …)`) or a navigation to the literal `true`.
function str(v, d) { return typeof v === 'string' ? v : d; }
// Parse an "x,y" viewport coordinate. Returns null when the flag is absent; exits 2 on a
// malformed value rather than falling back to a default, since a silently wrong drag origin
// produces a plausible-looking result that never touched the intended element.
function parsePoint(v, flag) {
  if (typeof v !== 'string' || v === '') return null;
  const parts = v.split(',').map(p => Number(p.trim()));
  if (parts.length !== 2 || parts.some(p => !Number.isFinite(p))) {
    fail(2, `${flag} must be two numbers "x,y" (got ${JSON.stringify(v)}).`);
  }
  return { x: parts[0], y: parts[1] };
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
async function fetchJson(u, opt) {
  const r = await fetch(u, opt);
  // A non-2xx (e.g. a 404 HTML error page) would make `r.json()` throw an opaque SyntaxError;
  // surface the HTTP status instead so the failure is legible.
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText} from ${u}`);
  return r.json();
}
function once(ws, ev, ms) {
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`WebSocket ${ev} timeout — is Chrome still running?`)), ms);
    const cleanup = () => {
      clearTimeout(t);
      ws.removeEventListener(ev, onEvent);
      ws.removeEventListener('error', onError);
      ws.removeEventListener('close', onClose);
    };
    // Surface a socket error/close that happens *before* the awaited event (e.g. the CDP port is
    // reachable over HTTP but the WS handshake fails) right away, instead of stalling until `ms`.
    const onEvent = () => { cleanup(); res(); };
    const onError = (e) => { cleanup(); rej(new Error(`WebSocket error before ${ev}: ${e?.message || 'connection failed'}`)); };
    const onClose = () => { cleanup(); rej(new Error(`WebSocket closed before ${ev} — is Chrome reachable on the CDP port?`)); };
    ws.addEventListener(ev, onEvent, { once: true });
    ws.addEventListener('error', onError, { once: true });
    ws.addEventListener('close', onClose, { once: true });
  });
}

// `fs.writeSync`, not `process.std{out,err}.write`: writes to a PIPE are asynchronous in Node, and
// every path out of this script ends in `process.exit()`, which discards whatever is still queued.
// Truncating the JSON report is exactly the failure mode that matters here, because being captured
// by another process is the normal way this driver is run. Applies to the mid-run warnings too —
// they are queued long before the `done()` that exits.
function emit(fd, text) { fs.writeSync(fd, text); }
// `help` and `version` answer a human or a capability check (`--version | grep drag`), so they
// print plain text on stdout rather than the JSON report the driver commands produce.
function printText(text) {
  emit(1, text + '\n');
  process.exit(0);
}
// Print JSON result to stdout + a human summary to stderr, then exit.
function done(code, obj, summary) {
  emit(1, JSON.stringify(obj, null, 2) + '\n');
  if (summary) emit(2, summary + '\n');
  process.exit(code);
}
function fail(code, message) {
  emit(1, JSON.stringify({ ok: false, error: message }, null, 2) + '\n');
  emit(2, message + '\n');
  process.exit(code);
}

// Invoked last, after every module-level declaration is initialized — a command's
// synchronous prelude (e.g. `keys` validating tokens) may touch consts like NAMED_KEYS
// before its first await.
main().catch(err => fail(1, String((err && err.stack) || err)));
