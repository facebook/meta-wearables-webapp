/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CACHE_PREFIX,
  REVISION_PARAM,
  activatePrecache,
  buildPrecacheIndex,
  cacheNameFor,
  entryUrl,
  installPrecache,
  isCacheableRequest,
  isNavigationRequest,
  isPrecacheName,
  matchPrecached,
  precacheKey,
  requestKey,
  shouldFallBackToShell,
  staleCacheNames,
} from '@/framework/sw/precache';
import type { PrecacheDeps, PrecacheEntry } from '@/framework/sw/precache';

const BASE = 'https://game.example/play/';

/**
 * Minimal in-memory stand-ins for `Cache` / `CacheStorage`. Keyed by the exact request URL, which
 * is all the engine relies on — it never uses `ignoreSearch`, precisely so the revision in the key
 * is meaningful.
 */
class FakeCache {
  readonly entries = new Map<string, Response>();

  async match(key: string): Promise<Response | undefined> {
    return this.entries.get(key);
  }

  async put(key: string, response: Response): Promise<void> {
    this.entries.set(key, response);
  }
}

class FakeCacheStorage {
  readonly caches = new Map<string, FakeCache>();

  async open(name: string): Promise<FakeCache> {
    let cache = this.caches.get(name);
    if (!cache) {
      cache = new FakeCache();
      this.caches.set(name, cache);
    }
    return cache;
  }

  async keys(): Promise<string[]> {
    return [...this.caches.keys()];
  }

  async delete(name: string): Promise<boolean> {
    return this.caches.delete(name);
  }
}

function makeDeps(
  storage: FakeCacheStorage,
  fetchImpl: PrecacheDeps['fetch'],
): PrecacheDeps & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    caches: storage as unknown as CacheStorage,
    fetch: fetchImpl,
    onWarn: (message) => warnings.push(message),
    warnings,
  };
}

/** A `fetch` that always succeeds, recording every URL it was asked for. */
function okFetch(seen: string[]): PrecacheDeps['fetch'] {
  return async (input) => {
    seen.push(input);
    return new Response(`body:${input}`, { status: 200 });
  };
}

const SHELL: PrecacheEntry = { url: 'index.html', rev: 'aaa', shell: true };
const BUNDLE: PrecacheEntry = { url: '_vite/index-A1.js', rev: 'bbb', shell: true };
const TEXTURE: PrecacheEntry = { url: 'sprites/hero.png', rev: 'ccc' };
const ENTRIES = [SHELL, BUNDLE, TEXTURE];

describe('cache naming', () => {
  it('namespaces its caches by build', () => {
    expect(cacheNameFor('abc')).toBe(`${CACHE_PREFIX}abc`);
    expect(isPrecacheName(cacheNameFor('abc'))).toBe(true);
    expect(isPrecacheName('some-other-app-cache')).toBe(false);
  });

  it('treats only its own caches from other builds as stale', () => {
    const names = [cacheNameFor('old'), cacheNameFor('new'), 'unrelated-cache'];
    expect(staleCacheNames(names, 'new')).toEqual([cacheNameFor('old')]);
  });
});

describe('keys', () => {
  it('stores an entry under its url plus its revision', () => {
    expect(precacheKey(TEXTURE, BASE)).toBe(
      `https://game.example/play/sprites/hero.png?${REVISION_PARAM}=ccc`,
    );
    expect(entryUrl(TEXTURE, BASE)).toBe('https://game.example/play/sprites/hero.png');
  });

  it('canonicalizes a request by dropping its search and hash', () => {
    expect(requestKey('https://game.example/play/sprites/hero.png?v=3#x')).toBe(
      'https://game.example/play/sprites/hero.png',
    );
  });

  it('indexes plain urls back to their revisioned keys', () => {
    const index = buildPrecacheIndex(ENTRIES, BASE);
    expect(index.get('https://game.example/play/index.html')).toBe(precacheKey(SHELL, BASE));
    expect(index.size).toBe(3);
  });
});

describe('installPrecache', () => {
  let storage: FakeCacheStorage;

  beforeEach(() => {
    storage = new FakeCacheStorage();
  });

  it('downloads every entry on a first install', async () => {
    const seen: string[] = [];
    const deps = makeDeps(storage, okFetch(seen));

    const result = await installPrecache(ENTRIES, 'build1', BASE, deps);

    expect(result).toEqual({ carriedOver: 0, fetched: 3, failed: [] });
    expect(seen).toHaveLength(3);
    const cache = await storage.open(cacheNameFor('build1'));
    expect(cache.entries.has(precacheKey(TEXTURE, BASE))).toBe(true);
  });

  it('bypasses the http cache so the bytes match the revision they are stored under', async () => {
    const fetchImpl = vi.fn(async () => new Response('x', { status: 200 }));
    await installPrecache([TEXTURE], 'build1', BASE, makeDeps(storage, fetchImpl));

    expect(fetchImpl).toHaveBeenCalledWith(entryUrl(TEXTURE, BASE), { cache: 'reload' });
  });

  it('carries unchanged entries over from the previous build without touching the network', async () => {
    await installPrecache(ENTRIES, 'build1', BASE, makeDeps(storage, okFetch([])));

    // Only the texture's content changed; the shell and bundle are byte-identical.
    const next = [SHELL, BUNDLE, { ...TEXTURE, rev: 'ddd' }];
    const seen: string[] = [];
    const result = await installPrecache(next, 'build2', BASE, makeDeps(storage, okFetch(seen)));

    expect(result).toEqual({ carriedOver: 2, fetched: 1, failed: [] });
    expect(seen).toEqual([entryUrl(TEXTURE, BASE)]);
  });

  it('re-downloads nothing when re-installing the same build', async () => {
    await installPrecache(ENTRIES, 'build1', BASE, makeDeps(storage, okFetch([])));

    const seen: string[] = [];
    const result = await installPrecache(ENTRIES, 'build1', BASE, makeDeps(storage, okFetch(seen)));

    expect(result).toEqual({ carriedOver: 3, fetched: 0, failed: [] });
    expect(seen).toEqual([]);
  });

  it('survives a failed game asset, caching the rest', async () => {
    const deps = makeDeps(storage, async (input) => {
      if (input.endsWith('hero.png')) {
        return new Response('missing', { status: 404 });
      }
      return new Response('ok', { status: 200 });
    });

    const result = await installPrecache(ENTRIES, 'build1', BASE, deps);

    expect(result.fetched).toBe(2);
    expect(result.failed).toEqual(['sprites/hero.png']);
    expect(deps.warnings.join('\n')).toContain('sprites/hero.png');
  });

  it('rejects when an app shell entry cannot be cached', async () => {
    const deps = makeDeps(storage, async (input) =>
      input.endsWith('index.html')
        ? new Response('nope', { status: 500 })
        : new Response('ok', { status: 200 }),
    );

    await expect(installPrecache(ENTRIES, 'build1', BASE, deps)).rejects.toThrow(
      /app shell failed to precache/,
    );
  });

  it('never opens more connections than the concurrency limit', async () => {
    let inFlight = 0;
    let peak = 0;
    const deps = makeDeps(storage, async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight--;
      return new Response('ok', { status: 200 });
    });
    const many = Array.from({ length: 20 }, (_, i) => ({ url: `a/${i}.png`, rev: `r${i}` }));

    await installPrecache(many, 'build1', BASE, deps, 3);

    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('activatePrecache', () => {
  it('deletes other builds’ caches and leaves unrelated ones alone', async () => {
    const storage = new FakeCacheStorage();
    await storage.open(cacheNameFor('old'));
    await storage.open(cacheNameFor('current'));
    await storage.open('game-highscores');

    const removed = await activatePrecache('current', makeDeps(storage, okFetch([])));

    expect(removed).toEqual([cacheNameFor('old')]);
    expect(await storage.keys()).toEqual([cacheNameFor('current'), 'game-highscores']);
  });
});

describe('request classification', () => {
  it('recognizes navigations by mode or destination', () => {
    expect(isNavigationRequest({ mode: 'navigate', destination: '' })).toBe(true);
    expect(isNavigationRequest({ mode: 'cors', destination: 'document' })).toBe(true);
    expect(isNavigationRequest({ mode: 'cors', destination: 'image' })).toBe(false);
  });

  it('handles same-origin GETs only', () => {
    expect(isCacheableRequest({ method: 'GET', url: `${BASE}a.png` }, BASE)).toBe(true);
    expect(isCacheableRequest({ method: 'POST', url: `${BASE}a.png` }, BASE)).toBe(false);
    expect(isCacheableRequest({ method: 'GET', url: 'https://cdn.example/a.png' }, BASE)).toBe(false);
    expect(isCacheableRequest({ method: 'GET', url: 'not a url' }, BASE)).toBe(false);
  });

  it('falls back to the shell on a server error, but not on 4xx or 304', () => {
    expect(shouldFallBackToShell({ status: 500 })).toBe(true);
    expect(shouldFallBackToShell({ status: 503 })).toBe(true);
    expect(shouldFallBackToShell({ status: 404 })).toBe(false);
    expect(shouldFallBackToShell({ status: 304 })).toBe(false);
    expect(shouldFallBackToShell({ status: 200 })).toBe(false);
  });
});

describe('matchPrecached', () => {
  it('serves a precached entry, ignoring a query string on the request', async () => {
    const storage = new FakeCacheStorage();
    const deps = makeDeps(storage, okFetch([]));
    await installPrecache(ENTRIES, 'build1', BASE, deps);
    const index = buildPrecacheIndex(ENTRIES, BASE);

    const hit = await matchPrecached(`${BASE}sprites/hero.png?v=3`, index, 'build1', deps);

    expect(hit).toBeDefined();
    expect(await hit!.text()).toBe(`body:${entryUrl(TEXTURE, BASE)}`);
  });

  it('returns undefined for something this build never precached', async () => {
    const storage = new FakeCacheStorage();
    const deps = makeDeps(storage, okFetch([]));
    await installPrecache(ENTRIES, 'build1', BASE, deps);

    const miss = await matchPrecached(`${BASE}api/scores`, buildPrecacheIndex(ENTRIES, BASE), 'build1', deps);

    expect(miss).toBeUndefined();
  });
});
