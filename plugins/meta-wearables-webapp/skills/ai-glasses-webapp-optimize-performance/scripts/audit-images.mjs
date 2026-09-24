#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// audit-images.mjs — find images with more pixels than their rendered uses require.
//
// The display is 600x600 at DPR 1. Safe targets still account for object-fit cropping; unknown
// background sizing is never guessed. At ~62500 bytes/s every wasted KB is ~16 ms.
//
// Point --url at a production preview, never a development/HMR server.
//   node audit-images.mjs --url http://127.0.0.1:5173 --clear-storage
//                         --oracle "<js true when the first screen is usable>"
//                         [--port 9222] [--grant-media]
//
// Reports, per image: bytes on the wire, intrinsic pixels, the box it is drawn into, and how
// much you would save by resizing to fit and re-encoding as WebP.
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
  requiredImageScale,
  sleep,
  strArg,
  waitForNetworkIdle,
} from './lib/cdp.mjs';

const A = parseArgs(process.argv.slice(2));
assertKnownArgs(A, ['url', 'oracle', 'clear-storage', 'port', 'grant-media']);
const URL_ARG = httpUrlArg(A);
const port = numArg(A, 'port', 9222, { max: 65535 });
const oracle = strArg(A, 'oracle', undefined, {required: true});
const ready = readyExpression(oracle);
const resetStorage = flagArg(A, 'clear-storage');
const grantMedia = flagArg(A, 'grant-media');
if (!resetStorage) {
  console.error('--clear-storage is required; use a unique throwaway Chrome profile');
  process.exit(2);
}

const tab = await openTab(port);
const { cdp } = tab;

const bytes = new Map();
const typeOf = new Map();
const developmentResources = new Set();
const documentResponses = [];
const networkState = {inFlight: new Set(), lastActivity: Date.now()};
let exitCode = 0;
let primaryError = null;
class ReportedFailure extends Error {}
try {
  cdp.on('Network.requestWillBeSent', (p) => {
    const requestUrl = p.request?.url || '';
    if (isDevelopmentServerResource(requestUrl)) developmentResources.add(requestUrl);
    if (p.requestId) {
      networkState.inFlight.add(p.requestId);
      networkState.lastActivity = Date.now();
    }
  });
  cdp.on('Network.responseReceived', (p) => {
    typeOf.set(p.requestId, { type: p.type, url: p.response.url, mime: p.response.mimeType });
    if (p.type === 'Document') {
      documentResponses.push({frameId: p.frameId, status: p.response.status, url: p.response.url});
    }
  });
  cdp.on('Network.loadingFinished', (p) => {
    if (networkState.inFlight.delete(p.requestId)) networkState.lastActivity = Date.now();
    const m = typeOf.get(p.requestId);
    if (m) bytes.set(m.url, { n: p.encodedDataLength || 0, mime: m.mime, type: m.type });
  });
  cdp.on('Network.loadingFailed', (p) => {
    if (networkState.inFlight.delete(p.requestId)) networkState.lastActivity = Date.now();
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
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

  const loaded = cdp.waitEvent('Page.loadEventFired', 60000).then(() => true, () => false);
  let navigation;
  try {
    navigation = await cdp.send('Page.navigate', { url: URL_ARG }, 60000);
  } catch (error) {
    console.error(`  ERROR: navigation failed: ${error.message}`);
    throw new ReportedFailure();
  }
  if (navigation.errorText) {
    console.error(`  ERROR: navigation failed: ${navigation.errorText}`);
    throw new ReportedFailure();
  }
  if (!await loaded) {
    console.error('  ERROR: the production page did not finish loading within 60 seconds.');
    throw new ReportedFailure();
  }
  const mainDocument = [...documentResponses].reverse().find((response) =>
    !navigation.frameId || response.frameId === navigation.frameId);
  if (!mainDocument || mainDocument.status < 200 || mainDocument.status >= 400) {
    console.error(
      `  ERROR: production page returned ${mainDocument?.status ?? 'no document response'}; ` +
        'image results would not describe the app.',
    );
    throw new ReportedFailure();
  }
  if (new URL(mainDocument.url).origin !== new URL(URL_ARG).origin) {
    console.error('  ERROR: the page redirected to another origin; rerun with the final production URL.');
    throw new ReportedFailure();
  }
  const deadline = Date.now() + 60000;
  let fired = false;
  while (Date.now() < deadline) {
    await sleep(200);
    const result = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: ready,
    }, 15000).catch(() => null);
    const value = result?.result?.value ? JSON.parse(result.result.value) : null;
    if (value?.ready) { fired = true; break; }
  }
  if (!fired) {
    console.error('  ERROR: the first-screen oracle never became true; no image claim was produced.');
    throw new ReportedFailure();
  }
  if (!await waitForNetworkIdle(networkState, 60000)) {
    console.error('  ERROR: the page did not reach network idle; image byte totals are incomplete.');
    throw new ReportedFailure();
  }
  if (developmentResources.size) {
    console.error('  ERROR: a development/HMR resource was loaded; audit production output instead:');
    for (const resource of developmentResources) console.error(`     ${resource}`);
    throw new ReportedFailure();
  }

  const r = await cdp.send('Runtime.evaluate', {
    returnByValue: true,
    awaitPromise: true,
    expression: `(async () => {
      const imageElements = [...document.querySelectorAll('img')];
      await Promise.all(imageElements.map((image) => image.decode().catch(() => {})));
      const out = imageElements.map((i) => {
        const b = i.getBoundingClientRect();
        const style = getComputedStyle(i);
        return { src: i.currentSrc || i.src, nw: i.naturalWidth, nh: i.naturalHeight,
                 bw: Math.round(b.width), bh: Math.round(b.height),
                 kind: 'img', fit: style.objectFit || 'fill' };
      });
      // Every url() in the value, not just the first: a multi-layer background stacks several
      // and all but the first would otherwise be missed.
      const bgs = [];
      for (const el of document.querySelectorAll('*')) {
        const bg = getComputedStyle(el).backgroundImage || '';
        const b = el.getBoundingClientRect();
        for (const m of bg.matchAll(/url\\(["']?([^"')]+)["']?\\)/g)) {
          if (m[1].startsWith('data:')) continue;
          bgs.push({ src: new URL(m[1], location.href).href, bw: Math.round(b.width),
                     bh: Math.round(b.height), kind: 'background', fit: getComputedStyle(el).backgroundSize });
        }
      }
      // getComputedStyle cannot give the intrinsic size, so the image has to be loaded. Load
      // each distinct URL once and all of them together: serially, on a 500 Kbps link with the
      // cache disabled, a handful of large backgrounds would outrun the evaluate timeout.
      const sizes = new Map();
      await Promise.all([...new Set(bgs.map((x) => x.src))].map(async (src) => {
        try {
          const img = new Image();
          img.src = src;
          await img.decode();
          sizes.set(src, [img.naturalWidth, img.naturalHeight]);
        } catch (e) { sizes.set(src, null); }   // unmeasurable, not zero-waste
      }));
      for (const x of bgs) {
        const size = sizes.get(x.src);
        out.push({ src: x.src, nw: size ? size[0] : null, nh: size ? size[1] : null,
                   bw: x.bw, bh: x.bh, kind: x.kind, fit: x.fit });
      }
      return JSON.stringify(out);
    })()`,
  }, 120000).catch((e) => {
    console.error(`  could not collect images: ${e.message}`);
    console.error('  (a page with very large background images can outrun the evaluate budget)');
    return null;
  });
  if (!r) throw new ReportedFailure();
  if (!await waitForNetworkIdle(networkState, 60000)) {
    console.error('  ERROR: image inspection did not reach network idle; byte totals are incomplete.');
    throw new ReportedFailure();
  }
  let imgs;
  try {
    imgs = JSON.parse(r.result.value || '[]');
  } catch {
    console.error('  could not parse the image audit result; no image claim was produced');
    throw new ReportedFailure();
  }

  if (!imgs.length) {
    console.log('  no <img> or CSS background images found on the first screen');
  } else {
    console.log('  bytes   intrinsic     drawn      target      waste  image');
    // One source used in several boxes must retain enough pixels for every use. Any use whose
    // crop/size cannot be inferred makes the source report-only rather than risking blur.
    const requirements = new Map();
    for (const i of imgs) {
      const scale = requiredImageScale(i);
      const cur = requirements.get(i.src) || {scale: 0, safe: true, nw: i.nw, nh: i.nh};
      if (scale == null) cur.safe = false;
      else cur.scale = Math.max(cur.scale, scale);
      requirements.set(i.src, cur);
    }
    let waste = 0;
    const counted = new Set();
    for (const i of imgs) {
      const b = bytes.get(i.src);
      const n = b?.n || 0;
      const measured = i.nw != null && i.nh != null;
      const requirement = requirements.get(i.src);
      const safeScale = requirement?.safe ? Math.min(1, requirement.scale) : null;
      const est = measured && safeScale != null && safeScale < 0.91
        ? Math.round(n * (1 - safeScale ** 2))
        : 0;
      const target = measured && safeScale != null
        ? `${Math.ceil(i.nw * safeScale)}x${Math.ceil(i.nh * safeScale)}`
        : '?';
      if (!counted.has(i.src)) {
        waste += est;
        counted.add(i.src);
      }
      const name = i.src.replace(/^https?:\/\/[^/]+/, '').slice(-42);
      const intrinsic = measured ? `${i.nw}x${i.nh}` : '?';
      const wasteCell = !measured || safeScale == null ? '?' : est ? `~${est} B` : '-';
      console.log(
        `  ${String(n).padStart(7)} ${intrinsic.padStart(11)} ` +
          `${String(i.bw + 'x' + i.bh).padStart(9)} ${target.padStart(11)} ` +
          `${wasteCell.padStart(10)}  ${name}`,
      );
    }
    if (imgs.some((i) => i.nw == null || !requirements.get(i.src)?.safe)) {
      console.log('  `?` means sizing is unsafe to infer (CORS, a failed load, or CSS background sizing);');
      console.log('  those sources are unmeasured, not zero-waste.');
    }
    console.log(
      `  Safe reported targets would save ~${waste} B (~${Math.round(waste / 62.5)} ms of link time).`,
    );
    const nonWebpSrcs = [
      ...new Set(
        imgs
          .map((i) => i.src)
          .filter((src) => /png|jpeg|jpg/.test(bytes.get(src)?.mime || '')),
      ),
    ];
    if (nonWebpSrcs.length) {
      const n = nonWebpSrcs.reduce((sum, src) => sum + (bytes.get(src)?.n || 0), 0);
      console.log(
        `  ${nonWebpSrcs.length} image(s) are PNG/JPEG totalling ${n} B. WebP at quality 75-80 is\n` +
          `  typically 25-35% smaller, so re-encoding would save roughly ${Math.round(n * 0.3)} B ` +
          `(~${Math.round((n * 0.3) / 62.5)} ms).`,
      );
    }
  }
  console.log('  Resize only to a reported target (preserving crop/aspect behavior), then encode at WebP q78.');
  console.log('  Then re-measure — an estimate is not a result.');
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
