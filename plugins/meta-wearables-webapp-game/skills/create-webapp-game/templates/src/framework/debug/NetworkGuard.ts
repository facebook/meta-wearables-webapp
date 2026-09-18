/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Runtime guard that catches assets accidentally loaded over the network *after* preload. The
 * whole point of preloading (see `docs/loading-screen.md`) is that once the game loop is running
 * nothing touches the network — a mid-game fetch is a visible hitch on the glasses, where the
 * budget is "< 10 requests on load". This installs a lightweight interception over the network
 * asset paths (`fetch`, `XMLHttpRequest`, and `<img>` / `<audio>` / `<video>` `src`) and reports
 * any use of a *real* network URL after sealing.
 *
 * In-memory references — `blob:` / `data:` URLs, e.g. an object URL made from a preloaded `raw`
 * ArrayBuffer — are always allowed; that's how preloaded audio/images are meant to be used.
 *
 * Warn by default (safe to leave on in production); pass `strict: true` (wire it to `?strict`) to
 * throw instead, for aggressive dev/CI runs. Pass `allow` to permit intended runtime endpoints
 * (e.g. a leaderboard API). Complements the loader seal (`sealAssetLoaders` in
 * `render/AssetLoader.ts`, which guards the framework's own loaders) and the static
 * `validate-network-loads` check (which flags network calls in gameplay code at `npm run validate`).
 *
 * Known gaps: only `<img>` / `<audio>` / `<video>` `src` setters are intercepted — a JS-set
 * `src`/`href` on other elements (`<script>`, `<iframe>`, `<link>`, `<track>`) is not, the `srcset`
 * setter (`<img srcset>` / `<source srcset>`) is not, and neither are markup-driven loads
 * (`el.innerHTML = '<img src=...>'`, CSS `background-image`), which never go through the JS `src`
 * setter. The static check (which does scan `srcset` literals) and a CSP `connect-src` are the tools
 * for those.
 *
 * Strict-mode failure shape: a blocked `fetch` returns a **rejected Promise** (preserving fetch's
 * contract, so `.catch(...)` sees it), while a blocked `XMLHttpRequest.open` or `src` set **throws
 * synchronously** (those APIs are synchronous, so there's no promise to reject).
 */

/** True if `url` is an in-memory reference (a preloaded asset), not a network fetch. */
export function isInMemoryUrl(url: string): boolean {
  return url.startsWith('blob:') || url.startsWith('data:');
}

/**
 * Whether the `?strict` debug flag was requested via the URL query string — pass it as
 * `sealAssetNetwork`'s `strict` option to make a runtime network load throw instead of warn. Pass
 * `window.location.search`. Present with any value except `0` / `false` enables it (`?strict`,
 * `?strict=1` → true; `?strict=0`, `?strict=false`, absent → false) — the same convention as the
 * `?stats` and `?slowload` flags. DOM-free, so it's unit-testable.
 */
export function strictSealRequested(search: string): boolean {
  const value = new URLSearchParams(search).get('strict');
  if (value === null) {
    return false;
  }
  return value !== '0' && value.toLowerCase() !== 'false';
}

export interface AssetNetworkSealOptions {
  /** Throw on a runtime network load instead of warning. Wire to `?strict`. Default `false`. */
  strict?: boolean;
  /** Return `true` to permit a runtime request (e.g. an intended API endpoint). */
  allow?: (url: string) => boolean;
}

/** Best-effort URL extraction from the many shapes `fetch` accepts (string, URL, Request). */
function urlOf(input: unknown): string {
  if (typeof input === 'string') {
    return input;
  }
  if (input instanceof URL) {
    return input.href;
  }
  if (input !== null && typeof input === 'object' && 'url' in input) {
    return String((input as { url: unknown }).url);
  }
  return String(input);
}

/**
 * Seal the network against runtime asset loads. Returns an `unseal()` that restores the originals
 * (mainly for tests / teardown). No-ops if there's no DOM (e.g. a Node test environment).
 *
 * Call once after preload, before the loop starts:
 *
 * ```ts
 * loading.dispose();
 * sealAssetLoaders();
 * sealAssetNetwork({ strict: strictSealRequested(location.search) });
 * ```
 */
export function sealAssetNetwork(options: AssetNetworkSealOptions = {}): () => void {
  const { strict = false, allow } = options;
  if (typeof window === 'undefined') {
    return () => {};
  }

  const flag = (url: string): void => {
    if (!url || isInMemoryUrl(url) || allow?.(url)) {
      return;
    }
    const message =
      `[webapp-game] Runtime network load after preload: ${url}\n` +
      'Assets must be preloaded up front (see docs/loading-screen.md), not fetched during play — ' +
      'a runtime request hitches on the glasses. If this is an intended API call, pass ' +
      '`allow` to sealAssetNetwork.';
    if (strict) {
      throw new Error(message);
    }
    // eslint-disable-next-line no-console
    console.warn(message);
  };

  const restores: Array<() => void> = [];

  // fetch
  const originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      try {
        flag(urlOf(input));
      } catch (error) {
        // Preserve fetch's contract: surface a strict-mode block as a rejected Promise (not a
        // synchronous throw) so callers using only `.catch(...)` still observe it.
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      // Call with `window` as the receiver: a bare `originalFetch(...)` throws `Illegal
      // invocation` in engines that require `fetch`'s `this` to be the global object.
      return originalFetch.call(window, input, init);
    }) as typeof window.fetch;
    restores.push(() => {
      window.fetch = originalFetch;
    });
  }

  // XMLHttpRequest.open
  const XHR = window.XMLHttpRequest;
  if (typeof XHR === 'function') {
    const originalOpen = XHR.prototype.open;
    XHR.prototype.open = function patchedOpen(
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      flag(urlOf(url));
      // eslint-disable-next-line prefer-spread
      return (originalOpen as (...args: unknown[]) => void).apply(this, [method, url, ...rest]);
    } as typeof XHR.prototype.open;
    restores.push(() => {
      XHR.prototype.open = originalOpen;
    });
  }

  // Media element `src` setters: HTMLImageElement (covers `new Image()`) and HTMLMediaElement
  // (covers <audio>/<video>). A markup-driven `src` (innerHTML) bypasses these setters.
  const guardSrc = (ctor: { prototype: object } | undefined): void => {
    if (!ctor) {
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(ctor.prototype, 'src');
    const originalSet = descriptor?.set;
    if (!descriptor || typeof originalSet !== 'function') {
      return;
    }
    Object.defineProperty(ctor.prototype, 'src', {
      ...descriptor,
      set(this: object, value: string) {
        flag(String(value));
        originalSet.call(this, value);
      },
    });
    restores.push(() => {
      Object.defineProperty(ctor.prototype, 'src', descriptor);
    });
  };
  guardSrc(window.HTMLImageElement);
  guardSrc(window.HTMLMediaElement);

  return () => {
    for (const restore of restores) {
      restore();
    }
  };
}
