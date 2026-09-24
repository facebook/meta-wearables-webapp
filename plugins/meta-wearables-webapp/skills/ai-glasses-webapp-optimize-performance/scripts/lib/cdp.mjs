/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// cdp.mjs — the shared bits: the device profile, a minimal CDP client, one measured load, and
// a static server for comparing two build directories. Zero dependencies, Node 22+.

/**
 * The Meta Ray-Ban Display envelope.
 *
 * 500 Kbps down is 62500 bytes/s, which is where "1 KB costs about 16 ms" comes from. The
 * panel is 30 Hz, so the frame budget is 33 ms, not 16 ms.
 */
export const PROFILE = {
  down: 62500,
  up: 37500,
  latency: 150,
  cpu: 12,
  width: 600,
  height: 600,
  dpr: 1,
};

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    out[k] = i + 1 < argv.length && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

/** Reject misspelled or unsupported options before a run opens Chrome. */
export function assertKnownArgs(args, names) {
  const allowed = new Set(names);
  const unknown = Object.keys(args).filter((name) => !allowed.has(name));
  if (unknown.length) {
    console.error(`unknown option${unknown.length === 1 ? '' : 's'}: ${unknown.map((name) => `--${name}`).join(', ')}`);
    process.exit(2);
  }
}

/** Resource names injected by common development/HMR servers. */
export function isDevelopmentServerResource(url) {
  return [
    /\/@vite\/client(?:[?#]|$)/,
    /\/@react-refresh(?:[?#]|$)/,
    /\/__webpack_hmr(?:[/?#]|$)/,
    /\/webpack-dev-server(?:[/?#]|$)/,
    /\/webpack-hot-middleware(?:[/?#]|$)/,
    /\/sockjs-node(?:[/?#]|$)/,
    /\.hot-update\.(?:js|json)(?:[?#]|$)/,
  ].some((pattern) => pattern.test(url));
}

/**
 * Read a numeric flag, rejecting the shapes that silently produce a wrong run.
 *
 * `parseArgs` yields `true` for a valueless flag and `Number(true)` is 1, so `--timeout` with
 * no value would mean a 1 ms timeout and every run would report NEVER; `--port` would become
 * port 1 and fail with a confusing connection error.
 */
export function numArg(args, name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = args[name];
  if (raw === undefined) return fallback;
  const n = typeof raw === 'number' || typeof raw === 'string' ? Number(raw) : Number.NaN;
  if (!Number.isInteger(n) || n < min || n > max) {
    const range = max === Number.MAX_SAFE_INTEGER ? `>= ${min}` : `from ${min} to ${max}`;
    console.error(`--${name} must be an integer ${range} (got ${JSON.stringify(raw)})`);
    process.exit(2);
  }
  return n;
}

/**
 * Read a string flag, rejecting a valueless one.
 *
 * `--out` with no value becomes `true`, which is truthy, so the failure only surfaces at
 * `writeFileSync(true, ...)` — after the whole throttled run has completed and with the
 * result already thrown away.
 */
export function strArg(args, name, fallback = undefined, { required = false } = {}) {
  const raw = args[name];
  if (raw === undefined) {
    if (required) {
      console.error(`--${name} is required`);
      process.exit(2);
    }
    return fallback;
  }
  if (typeof raw !== 'string' || raw === '') {
    console.error(`--${name} needs a value (got ${JSON.stringify(raw)})`);
    process.exit(2);
  }
  return raw;
}

export function flagArg(args, name) {
  const raw = args[name];
  if (raw === undefined) return false;
  if (raw !== true) {
    console.error(`--${name} is a flag and takes no value (got ${JSON.stringify(raw)})`);
    process.exit(2);
  }
  return true;
}

export function httpUrlArg(args, name = 'url') {
  const raw = strArg(args, name, undefined, { required: true });
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('unsupported protocol');
    return parsed.href;
  } catch {
    console.error(`--${name} must be an absolute HTTP(S) URL (got ${JSON.stringify(raw)})`);
    process.exit(2);
  }
}

export function client(ws) {
  let id = 0;
  const pending = new Map();
  const handlers = new Map();
  const waiters = new Map();
  let dead = false;
  // If the socket drops, fail everything in flight now rather than letting each call wait out
  // its own timeout.
  const failAll = (why) => {
    if (dead) return;
    dead = true;
    for (const [, p] of pending) { clearTimeout(p.t); p.reject(new Error('socket ' + why)); }
    pending.clear();
    for (const [, w] of waiters) { clearTimeout(w.t); w.reject(new Error('socket ' + why)); }
    waiters.clear();
  };
  ws.addEventListener('close', () => failAll('closed'));
  ws.addEventListener('error', () => failAll('error'));
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id != null && pending.has(m.id)) {
      const { resolve, reject, t } = pending.get(m.id);
      pending.delete(m.id);
      clearTimeout(t);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      for (const h of handlers.get(m.method) || []) { try { h(m.params); } catch {} }
      const w = waiters.get(m.method);
      if (w) { waiters.delete(m.method); clearTimeout(w.t); w.resolve(m.params); }
    }
  });
  return {
    send(method, params = {}, timeout = 30000) {
      if (dead) return Promise.reject(new Error('socket closed'));
      const myId = ++id;
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { pending.delete(myId); reject(new Error('timeout ' + method)); }, timeout);
        pending.set(myId, { resolve, reject, t });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
    on(method, cb) {
      if (!handlers.has(method)) handlers.set(method, []);
      handlers.get(method).push(cb);
    },
    waitEvent(method, ms) {
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { waiters.delete(method); reject(new Error('event timeout ' + method)); }, ms);
        waiters.set(method, { resolve, reject, t });
      });
    },
  };
}

/** Open one disposable tab through a loopback-only Chrome DevTools endpoint. */
export async function openTab(port = 9222) {
  if (Number(process.versions.node.split('.')[0]) < 22 || typeof globalThis.WebSocket !== 'function') {
    throw new Error('performance scripts require Node.js 22 or newer (global WebSocket is unavailable)');
  }
  const endpoint = `http://127.0.0.1:${port}`;
  let tab;
  let ws;
  try {
    let response;
    try {
      response = await fetch(`${endpoint}/json/new?about:blank`, {
        method: 'PUT',
        redirect: 'error',
        signal: AbortSignal.timeout(5000),
      });
    } catch (cause) {
      throw new Error(
        `cannot reach Chrome on 127.0.0.1:${port}; start it with the documented remote-debugging flags`,
        {cause},
      );
    }
    if (!response.ok) throw new Error(`Chrome returned HTTP ${response.status}`);
    tab = await response.json();
    if (!tab?.id || !tab?.webSocketDebuggerUrl) throw new Error('Chrome returned an invalid tab descriptor');
    const socketUrl = new URL(tab.webSocketDebuggerUrl);
    const socketPort = Number(socketUrl.port || 80);
    if (
      socketUrl.protocol !== 'ws:' ||
      !['127.0.0.1', 'localhost', '[::1]'].includes(socketUrl.hostname) ||
      socketPort !== port
    ) {
      throw new Error(`Chrome returned a non-loopback debugger socket: ${socketUrl.origin}`);
    }
    ws = new WebSocket(socketUrl);
    await new Promise((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => finish(new Error(`cannot reach Chrome on 127.0.0.1:${port}`)), 5000);
      const onOpen = () => finish();
      const onError = () => finish(new Error(`Chrome debugger socket failed on 127.0.0.1:${port}`));
      const onClose = () => finish(new Error(`Chrome debugger socket closed on 127.0.0.1:${port}`));
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
      ws.addEventListener('close', onClose, { once: true });
      function finish(error) {
        clearTimeout(timer);
        ws.removeEventListener('open', onOpen);
        ws.removeEventListener('error', onError);
        ws.removeEventListener('close', onClose);
        if (error) rejectOpen(error);
        else resolveOpen();
      }
    });
  } catch (error) {
    try { ws?.close(); } catch {}
    if (tab?.id) await closeTab(endpoint, tab.id, {bestEffort: true});
    throw error;
  }

  let closed = false;
  return {
    cdp: client(ws),
    async close() {
      if (closed) return;
      closed = true;
      try {
        await closeTab(endpoint, tab.id);
      } finally {
        try { ws.close(); } catch {}
      }
    },
  };
}

async function closeTab(endpoint, id, {bestEffort = false} = {}) {
  try {
    const response = await fetch(`${endpoint}/json/close/${encodeURIComponent(id)}`, {
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error(`Chrome refused to close tab ${id}: HTTP ${response.status}`);
  } catch (error) {
    if (!bestEffort) throw error;
  }
}

/** Clear all app state for one origin plus the disposable profile's HTTP cache. */
export async function clearOriginData(cdp, url) {
  await cdp.send('Network.clearBrowserCache');
  await cdp.send('Storage.clearDataForOrigin', {
    origin: new URL(url).origin,
    storageTypes: 'all',
  });
}

/** Wait for a quiet network window; false means byte/request totals are incomplete. */
export async function waitForNetworkIdle(networkState, timeoutMs, idleMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (
      networkState.inFlight.size === 0 &&
      Date.now() - networkState.lastActivity >= idleMs
    ) return true;
    await sleep(100);
  }
  return false;
}

/** Conservative source-image scale needed to preserve the current rendered result. */
export function requiredImageScale({nw, nh, bw, bh, kind = 'img', fit = 'fill'}) {
  if (kind !== 'img' || !nw || !nh || !bw || !bh) return null;
  const widthScale = bw / nw;
  const heightScale = bh / nh;
  if (fit === 'none') return 1;
  if (fit === 'contain') return Math.min(widthScale, heightScale);
  if (fit === 'scale-down') return Math.min(1, widthScale, heightScale);
  // `cover` needs the larger dimension; `fill` is treated the same conservatively so a
  // width-only resize cannot under-resolve or accidentally change an existing distortion.
  return Math.max(widthScale, heightScale);
}

const DEFAULT_ORACLE =
  `(function(){var r=document.getElementById('root');
     return !!(r && r.children.length) && (document.body.innerText||'').trim().length > 0;})()`;

/** Wrap an app-specific predicate so a throwing expression reads as "not ready" rather than crashing. */
export function readyExpression(oracle) {
  return `(function(){
    try { return JSON.stringify({ ready: !!(${oracle || DEFAULT_ORACLE}) }); }
    catch (e) { return JSON.stringify({ ready: false }); }
  })()`;
}

/**
 * Page-side watcher that timestamps the first frame on which the oracle is true.
 *
 * Polling over CDP resolves to about the poll interval plus a round trip, which is coarser
 * than the differences this method asks you to act on. This records `performance.now()` on an
 * animation frame instead, so the number is frame-accurate and measured from navigation start
 * — the same origin as FCP.
 */
export function watcherScript(oracle) {
  return `(function(){
    var test = function(){ try { return !!(${oracle || DEFAULT_ORACLE}); } catch (e) { return false; } };
    var mark = function(){
      if (window.__visibleAt != null) return true;
      if (!test()) return false;
      window.__visibleAt = performance.now();
      return true;
    };
    // Three triggers, because no single one is reliable here. requestAnimationFrame is the
    // most precise but does not run in a background tab; a MutationObserver fires the moment
    // the DOM changes and does run there; the interval is a floor for an app that becomes
    // ready without mutating (a font landing, say). First one to see it wins.
    var raf = function(){ if (!mark()) requestAnimationFrame(raf); };
    requestAnimationFrame(raf);
    try {
      var mo = new MutationObserver(function(){ if (mark()) mo.disconnect(); });
      mo.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
    } catch (e) {}
    var iv = setInterval(function(){ if (mark()) clearInterval(iv); }, 50);
    mark();
  })();`;
}

/**
 * One measured load. `warm: true` loads once to populate the cache and any service worker,
 * then measures the reload and counts only the reload's bytes.
 */
export async function measureOnce({
  url,
  warm = false,
  oracle,
  port = 9222,
  timeoutMs = 60000,
  grantMedia = false,
  resetStorage = false,
}) {
  const watcher = watcherScript(oracle);
  const tab = await openTab(port);
  const { cdp } = tab;
  let wire = 0;
  let requests = 0;
  const byType = {};
  const developmentResources = new Set();
  const webSocketUrls = new Set();
  const failedRequests = [];
  const requestUrls = new Map();
  const networkState = {inFlight: new Set(), lastActivity: Date.now()};
  const {inFlight} = networkState;
  let warmPreloadComplete = true;
  let primaryError = null;
  try {
    // Type arrives with the response, the transferred size only with loadingFinished, so the
    // two have to be joined on requestId. Summing encodedDataLength at responseReceived time
    // counts header bytes and reports a few hundred bytes for a megabyte of JavaScript.
    const typeOf = new Map();
    cdp.on('Network.requestWillBeSent', (p) => {
      const requestUrl = p.request?.url || '';
      if (isDevelopmentServerResource(requestUrl)) developmentResources.add(requestUrl);
      if (p.redirectResponse) {
        const redirectBytes = p.redirectResponse.encodedDataLength || 0;
        wire += redirectBytes;
        const redirectType = p.type || 'Other';
        byType[redirectType] = (byType[redirectType] || 0) + redirectBytes;
      }
      if (p.requestId) {
        inFlight.add(p.requestId);
        requestUrls.set(p.requestId, requestUrl);
        requests += 1;
        networkState.lastActivity = Date.now();
      }
    });
    cdp.on('Network.webSocketCreated', (p) => {
      if (p.url) webSocketUrls.add(p.url);
    });
    cdp.on('Network.responseReceived', (p) => {
      typeOf.set(p.requestId, p.type || 'Other');
      if (p.response?.status >= 400) {
        failedRequests.push({
          url: p.response.url || requestUrls.get(p.requestId) || '(unknown request)',
          reason: `HTTP ${p.response.status}`,
          canceled: false,
        });
      }
    });
    cdp.on('Network.loadingFinished', (p) => {
      if (!inFlight.delete(p.requestId)) return;
      networkState.lastActivity = Date.now();
      const n = p.encodedDataLength || 0;
      wire += n;
      const t = typeOf.get(p.requestId) || 'Other';
      byType[t] = (byType[t] || 0) + n;
      requestUrls.delete(p.requestId);
      typeOf.delete(p.requestId);
    });
    cdp.on('Network.loadingFailed', (p) => {
      if (inFlight.delete(p.requestId)) {
        networkState.lastActivity = Date.now();
        failedRequests.push({
          url: requestUrls.get(p.requestId) || '(unknown request)',
          reason: p.errorText || 'loading failed',
          canceled: !!p.canceled,
        });
      }
      requestUrls.delete(p.requestId);
      typeOf.delete(p.requestId);
    });
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: !warm });
    if (resetStorage) {
      // This clears persistent app state and the profile cache, which is why every command
      // requires an explicitly authorized, unique throwaway profile.
      await clearOriginData(cdp, url);
    }
    if (grantMedia) {
      await cdp.send('Browser.grantPermissions', {
        origin: new URL(url).origin,
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
    await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: watcher });
    await cdp.send('Page.bringToFront');

    const runStarted = Date.now();
    const deadline = runStarted + timeoutMs;
    const remaining = () => Math.max(0, deadline - Date.now());
    let timeoutPhase = null;
    let finalUrl = null;
    let originMatches = false;
    const result = ({fcp = null, visible = null, networkComplete = false} = {}) => ({
      fcp,
      visible,
      waited: Date.now() - runStarted,
      wire,
      requests,
      byType: { ...byType },
      developmentResources: [...developmentResources],
      webSocketUrls: [...webSocketUrls],
      failedRequests: [...failedRequests],
      finalUrl,
      originMatches,
      networkComplete,
      timeoutPhase,
      inFlightRequests: inFlight.size,
    });

    if (warm) {
      const budget = remaining();
      if (!budget) { timeoutPhase = 'warm preload'; return result(); }
      const preload = cdp.waitEvent('Page.loadEventFired', budget).then(() => true, () => false);
      try {
        await cdp.send('Page.navigate', { url }, budget);
        if (!await preload) throw new Error('warm preload timed out');
      } catch {
        timeoutPhase = 'warm preload';
        return result();
      }
      warmPreloadComplete = await waitForNetworkIdle(networkState, remaining());
      if (!warmPreloadComplete) {
        timeoutPhase = 'warm preload network idle';
        return result();
      }
      wire = 0;
      requests = 0;
      inFlight.clear();
      requestUrls.clear();
      networkState.lastActivity = Date.now();
      typeOf.clear();
      for (const k of Object.keys(byType)) delete byType[k];
    }

    const loadBudget = remaining();
    if (!loadBudget) { timeoutPhase = 'page load'; return result(); }
    const loaded = cdp.waitEvent('Page.loadEventFired', loadBudget).then(() => true, () => false);
    try {
      if (warm) await cdp.send('Page.reload', {}, loadBudget);
      else await cdp.send('Page.navigate', { url }, loadBudget);
      if (!await loaded) throw new Error('page load timed out');
    } catch {
      timeoutPhase = 'page load';
      return result();
    }
    const evaluationBudget = Math.min(15000, remaining());
    if (!evaluationBudget) { timeoutPhase = 'final URL'; return result(); }
    const locationResult = await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: 'location.href',
    }, evaluationBudget).catch(() => null);
    finalUrl = locationResult?.result?.value;
    try { originMatches = new URL(finalUrl).origin === new URL(url).origin; } catch {}

    let visible = null;
    while (Date.now() < deadline) {
      await sleep(Math.min(150, remaining()));
      // The page timestamps itself on the frame the oracle first passes; this loop only asks
      // whether that has happened yet, so the poll interval does not bound the resolution.
      const budget = Math.min(15000, remaining());
      if (!budget) break;
      const r = await cdp
        .send('Runtime.evaluate', { returnByValue: true, expression: 'window.__visibleAt ?? null' }, budget)
        .catch(() => null);
      const at = r?.result?.value;
      if (typeof at === 'number') { visible = Math.round(at); break; }
    }
    if (visible == null && !remaining()) timeoutPhase = 'content oracle';
    // Late, non-blocking assets still count. A timeout marks the result invalid instead of
    // silently omitting unfinished transfers from the total.
    const measuredNetworkComplete = await waitForNetworkIdle(networkState, remaining());
    const networkComplete = warmPreloadComplete && measuredNetworkComplete;
    if (!networkComplete && !timeoutPhase) timeoutPhase = 'network idle';
    const fcpBudget = Math.min(15000, remaining());
    const fcpRes = fcpBudget ? await cdp.send('Runtime.evaluate', {
      returnByValue: true,
      expression: `(performance.getEntriesByName('first-contentful-paint')[0]||{}).startTime ?? null`,
    }, fcpBudget).catch(() => null) : null;
    // null, not 0: a page that never painted must stay distinguishable from one that painted
    // instantly, or the zeros quietly drag the median down.
    const raw = fcpRes?.result?.value;
    const fcp = typeof raw === 'number' ? Math.round(raw) : null;
    if (fcp == null && !timeoutPhase && !remaining()) timeoutPhase = 'FCP';

    return result({fcp, visible, networkComplete});
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError = null;
    if (grantMedia) {
      try { await cdp.send('Browser.resetPermissions'); } catch (error) { cleanupError = error; }
    }
    try { await tab.close(); } catch (error) { cleanupError ||= error; }
    if (cleanupError && !primaryError) throw cleanupError;
  }
}

/** Serve a build directory so two local directories can be compared without deploying either. */
export async function serveDir(root, port) {
  const http = await import('node:http');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const zlib = await import('node:zlib');
  const MIME = {
    '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
    '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml',
    '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.ico': 'image/x-icon', '.webp': 'image/webp', '.avif': 'image/avif',
    '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
    '.wasm': 'application/wasm', '.webmanifest': 'application/manifest+json',
    '.txt': 'text/plain', '.map': 'application/json',
  };
  // Already-compressed formats must not be gzipped again: it changes how the browser treats
  // them and inflates exactly the byte counts this server exists to report honestly.
  const PRECOMPRESSED = new Set([
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.ico', '.woff2', '.woff',
  ]);
  const MAX_FILE_BYTES = 64 * 1024 * 1024;
  const abs = fs.realpathSync(path.resolve(root));
  const srv = http.createServer((req, res) => {
    if (!['GET', 'HEAD'].includes(req.method || '')) {
      res.writeHead(405, {allow: 'GET, HEAD'});
      return res.end();
    }
    // A malformed percent escape (`/%zz`) makes decodeURIComponent throw synchronously inside
    // the listener, which Node turns into an uncaught exception — one stray request would
    // otherwise kill the whole measurement session mid-comparison.
    let rel;
    try {
      rel = decodeURIComponent(req.url.split('?')[0]);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    if (rel.endsWith('/')) rel += 'index.html';
    if (rel.split(/[\\/]/).some(part => part.startsWith('.') && part !== '.' && part !== '..')) {
      res.writeHead(404);
      return res.end();
    }
    const candidate = path.join(abs, rel);
    // `abs + sep`, not `abs`: with `--a ./dist-before --b ./dist-after`, a request for
    // `/../dist-after/app.js` still satisfies a bare startsWith(abs) and would be served by
    // arm A, quietly contaminating the comparison.
    if (
      (candidate !== abs && !candidate.startsWith(abs + path.sep)) ||
      !fs.existsSync(candidate)
    ) {
      res.writeHead(404);
      return res.end();
    }
    // Resolve every existing entry before reading it. A lexical containment check alone lets
    // a symlink inside the build directory expose a file elsewhere on the developer's machine.
    let file;
    let fileStats;
    try {
      file = fs.realpathSync(candidate);
      fileStats = fs.statSync(file);
    } catch {
      res.writeHead(404);
      return res.end();
    }
    if (
      (file !== abs && !file.startsWith(abs + path.sep)) ||
      !fileStats.isFile()
    ) {
      res.writeHead(404);
      return res.end();
    }
    if (fileStats.size > MAX_FILE_BYTES) {
      res.writeHead(413);
      return res.end();
    }
    const ext = path.extname(file);
    const body = fs.readFileSync(file);
    const headers = { 'content-type': MIME[ext] || 'application/octet-stream', 'cache-control': 'no-cache' };
    // Serve gzipped like a real host would, or the byte counts are meaningless.
    if (!PRECOMPRESSED.has(ext) && String(req.headers['accept-encoding'] || '').includes('gzip')) {
      const compressed = zlib.gzipSync(body, { level: 9 });
      res.writeHead(200, {
        ...headers,
        'content-encoding': 'gzip',
        'content-length': compressed.length,
      });
      return res.end(req.method === 'HEAD' ? undefined : compressed);
    }
    res.writeHead(200, {...headers, 'content-length': body.length});
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  await new Promise((resolve, reject) => {
    srv.once('error', reject);
    // Bind to loopback only. Without an explicit host Node listens on `::`, which would put
    // the contents of your build directory on every interface the machine has. The only
    // client is a Chrome on this machine.
    srv.listen(port, '127.0.0.1', resolve);
  });
  // With port 0 the OS assigns one, so the URL has to come from the socket, not the request.
  const actual = srv.address().port;
  return {
    url: `http://127.0.0.1:${actual}/`,
    port: actual,
    close: () => new Promise((resolve, reject) => {
      srv.close((error) => (error ? reject(error) : resolve()));
    }),
  };
}
