/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * The service-worker entry point — bundled by `scripts/vite-service-worker.mjs` into `dist/sw.js`
 * with this build's file list baked in. It is deliberately thin: every decision lives in
 * `precache.ts`, which takes its `CacheStorage` and `fetch` as arguments and is unit-tested in
 * plain Node. This file only binds that engine to the real worker globals.
 *
 * **Serving strategy.** Navigations go network-first with the precached `index.html` as the
 * fallback; everything else is cache-first. The entry HTML is about a kilobyte and is served
 * `no-cache` (see `vercel.json`), so the network-first trip is normally a 304 — cheap enough to be
 * worth paying for the guarantee that a freshly published build is picked up on the launch it ships
 * rather than the one after. When the device is offline that request fails immediately and the
 * cached shell answers instead, rather than the browser showing its own no-connection screen. A 5xx
 * is treated the same way — the host being down is no more a reason to lose a fully cached game than
 * the network being down (`shouldFallBackToShell`).
 *
 * `skipWaiting` + `clients.claim` are safe here because a game loads its whole asset set in one
 * pass at startup (see `docs/loading-screen.md`); there is no long-lived session that could end up
 * straddling two revisions.
 *
 * This file cannot use the framework `Logger`: it runs in the worker thread with no access to the
 * page's sinks, and its own failures need to be visible in the browser's worker console. `console`
 * here is deliberate, not an oversight.
 */

import {
  activatePrecache,
  buildPrecacheIndex,
  installPrecache,
  isCacheableRequest,
  isNavigationRequest,
  matchPrecached,
  shouldFallBackToShell,
  type PrecacheDeps,
  type PrecacheEntry,
} from './precache';

/**
 * Injected at build time by `scripts/vite-service-worker.mjs` (esbuild `define`). Declared, never
 * imported: the values are literals substituted into the bundle, which is what makes any content
 * change alter `sw.js`'s bytes and so trigger the browser's update check.
 */
declare const __GAME_PRECACHE__: PrecacheEntry[];
declare const __GAME_BUILD__: string;

// Minimal structural types for the service-worker globals. The project's `tsconfig.json` uses the
// `DOM` lib rather than `WebWorker` (the two conflict in one program, and the rest of `src/` is
// page code), so the handful of members used here are declared locally instead.
interface ExtendableEventLike {
  waitUntil(promise: Promise<unknown>): void;
}
interface FetchEventLike extends ExtendableEventLike {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
}
interface ServiceWorkerGlobalScopeLike {
  addEventListener(type: 'install' | 'activate', listener: (event: ExtendableEventLike) => void): void;
  addEventListener(type: 'fetch', listener: (event: FetchEventLike) => void): void;
  skipWaiting(): Promise<void>;
  readonly clients: { claim(): Promise<void> };
  readonly registration: { readonly scope: string };
}
declare const self: ServiceWorkerGlobalScopeLike;

const BUILD = __GAME_BUILD__;
const ENTRIES = __GAME_PRECACHE__;
const BASE_URL = self.registration.scope;

const deps: PrecacheDeps = {
  caches,
  fetch: (input, init) => fetch(input, init),
  onWarn: (message) => console.warn(message),
};

const index = buildPrecacheIndex(ENTRIES, BASE_URL);
const shellUrl = new URL('index.html', BASE_URL).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const result = await installPrecache(ENTRIES, BUILD, BASE_URL, deps);
      console.info(
        `[game-sw] build ${BUILD}: ${result.fetched} downloaded, ` +
          `${result.carriedOver} reused, ${result.failed.length} failed`,
      );
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await activatePrecache(BUILD, deps);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (!isCacheableRequest(request, BASE_URL)) {
    return;
  }

  if (isNavigationRequest(request)) {
    event.respondWith(
      (async () => {
        let response: Response | undefined;
        try {
          response = await fetch(request);
          if (!shouldFallBackToShell(response)) {
            return response;
          }
        } catch {
          // Offline: fall through to the cached shell.
        }
        const cached = await matchPrecached(shellUrl, index, BUILD, deps);
        if (cached) {
          return cached;
        }
        if (response) {
          return response;
        }
        throw new Error(`[game-sw] offline and no cached shell for ${request.url}`);
      })(),
    );
    return;
  }

  event.respondWith(
    (async () => (await matchPrecached(request.url, index, BUILD, deps)) ?? fetch(request))(),
  );
});
