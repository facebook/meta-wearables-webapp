/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Page-side half of the service worker: registering it, keeping it up to date, and the escape
 * hatch for wiping it. The worker itself is `service-worker.ts`, bundled to `dist/sw.js` at build
 * time; this module runs in the game's own bundle and is called from `main.ts`.
 *
 * **Never await this.** Registration is pure background work — the first launch gets no benefit
 * from it at all (the cache is being filled, not read), and blocking first paint on it would make
 * the very metric this feature exists to improve worse.
 *
 * **Off in dev.** A service worker plus Vite's HMR produces stale-module bugs that read as build
 * failures, so `npm run dev` never registers one. It is also skipped outside a secure context,
 * which covers the `file://` and single-file-artifact cases where there is no `sw.js` to fetch.
 *
 * **`?swreset=1`.** The glasses have no reachable DevTools "Clear storage" button, so without an
 * in-app way to unregister the worker and drop its caches a bad cache is unrecoverable on device
 * short of clearing the whole browser. `resetServiceWorker` is that button; the flag is stripped
 * from the URL before reloading so it cannot loop.
 */

/**
 * Whether the `?swreset` flag was requested via the URL query string. Present with any value except
 * `0` / `false` enables it — the same convention as `?stats`, `?strict` and `?slowload`. DOM-free,
 * so it's unit-testable.
 */
export function swResetRequested(search: string): boolean {
  const value = new URLSearchParams(search).get('swreset');
  if (value === null) {
    return false;
  }
  return value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Unregister every service worker for this origin and delete every cache. Returns the number of
 * registrations and caches removed. Safe to call when there are none.
 */
export async function resetServiceWorker(): Promise<{ workers: number; caches: number }> {
  let workers = 0;
  if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    workers = registrations.length;
  }
  let removed = 0;
  if (typeof caches !== 'undefined') {
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
    removed = names.length;
  }
  return { workers, caches: removed };
}

export interface ServiceWorkerRegisterOptions {
  /**
   * Worker script URL, resolved against the document. The default matches where
   * `scripts/vite-service-worker.mjs` emits it, next to `index.html`, which also makes the worker's
   * scope the game's own directory — correct under Vite's `base: './'` even on a sub-path host.
   */
  scriptUrl?: string;
  /** Defaults to `window.location.search`. */
  search?: string;
  /** Force on or off. Defaults to "on unless this is a Vite dev build". */
  enabled?: boolean;
}

/**
 * Register the game's service worker and start an update check. Resolves to `null` when
 * registration was skipped or failed — a game must work identically with no worker at all, so
 * every failure here is non-fatal by design.
 *
 * Call it from `main.ts` without awaiting:
 *
 * ```ts
 * void registerGameServiceWorker();
 * ```
 */
export async function registerGameServiceWorker(
  options: ServiceWorkerRegisterOptions = {},
): Promise<ServiceWorkerRegistration | null> {
  const {
    scriptUrl = 'sw.js',
    search = typeof window === 'undefined' ? '' : window.location.search,
    enabled = !import.meta.env?.DEV,
  } = options;

  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return null;
  }

  if (swResetRequested(search)) {
    await resetServiceWorker();
    const url = new URL(window.location.href);
    url.searchParams.delete('swreset');
    window.location.replace(url.href);
    return null;
  }

  if (!enabled || !('serviceWorker' in navigator) || !window.isSecureContext) {
    return null;
  }

  try {
    const registration = await navigator.serviceWorker.register(
      new URL(scriptUrl, document.baseURI).href,
      // `none` stops the HTTP cache from answering the browser's update check with a stale `sw.js`,
      // which would pin an old worker and therefore an old build. The `no-cache` header on `sw.js`
      // in `vercel.json` covers clients that registered before this option existed; both are wanted.
      { updateViaCache: 'none' },
    );

    // The browser checks for a new worker on navigation, but a game is often resumed rather than
    // navigated to. Checking on launch and on every return to the foreground means a published
    // build is picked up promptly instead of whenever the page next happens to reload.
    void registration.update().catch(() => {});
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') {
        void registration.update().catch(() => {});
      }
    });

    return registration;
  } catch {
    return null;
  }
}
