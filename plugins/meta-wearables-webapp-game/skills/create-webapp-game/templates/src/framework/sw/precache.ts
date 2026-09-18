/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * The precache engine behind the generated `sw.js` — how a build's files get into `CacheStorage`,
 * how a *new* build reuses what the old one already downloaded, and how a request is answered from
 * disk. Every function here takes its `CacheStorage` and `fetch` as arguments rather than reaching
 * for the globals, so the whole engine is unit-testable in plain Node with fakes; the thin adapter
 * that binds it to the real service-worker globals is `service-worker.ts`.
 *
 * **Why a revisioned cache key.** A game's asset filenames are stable — `sprites/hero.png` stays
 * `sprites/hero.png` across builds — so the URL cannot carry the version. Each entry is therefore
 * stored under its URL *plus* a `__precache_rev` query parameter holding the sha256 of the bytes
 * (`precacheKey`). A lookup for a given revision hits only if those exact bytes are present, which
 * is what makes the carry-over below correct rather than merely optimistic. Requests coming off the
 * network are matched through `buildPrecacheIndex`, which maps the plain URL back to its key.
 *
 * **Why carry-over matters.** Installing a new build copies every unchanged file cache-to-cache and
 * fetches only the entries whose revision moved. Combined with the browser's byte-comparison of
 * `sw.js` (which changes whenever any revision changes), that gives per-asset invalidation with
 * stable filenames: publishing a build where one texture changed costs one texture, not the whole
 * payload. On a bandwidth-constrained device shared with other apps, that difference is the point.
 *
 * Fetches run through a small concurrency pool for the same reason — a first install of a
 * few hundred assets should not open a few hundred parallel connections on the glasses.
 */

/** One file in a build, as emitted into the generated `sw.js` by `scripts/vite-service-worker.mjs`. */
export interface PrecacheEntry {
  /** Build-output-relative URL, e.g. `index.html` or `_vite/index-A1b2C3.js`. */
  url: string;
  /** sha256 of the file's bytes at build time. Content is the only thing that changes it. */
  rev: string;
  /**
   * Part of the app shell (the entry HTML and the hashed bundle) rather than a game asset. The
   * shell is what the game cannot boot without, so a shell entry that fails to install fails the
   * whole install; a missing texture only warns, leaving the rest of the build cached.
   */
  shell?: boolean;
}

/** Everything the engine touches outside itself. Fakes for all three make it Node-testable. */
export interface PrecacheDeps {
  caches: CacheStorage;
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  /** Called with a human-readable reason for each non-fatal problem. */
  onWarn?: (message: string) => void;
}

export interface PrecacheResult {
  /** Entries already present locally — from this cache or a previous build's. No network. */
  carriedOver: number;
  /** Entries downloaded because no cache held those bytes. */
  fetched: number;
  /** URLs that could not be cached at all. Empty unless something 404'd or the network dropped. */
  failed: string[];
}

/**
 * Prefix for every cache this engine owns. Namespaced so `activatePrecache` only ever deletes its
 * own caches — a game is free to keep unrelated ones alongside.
 */
export const CACHE_PREFIX = 'webapp-game-precache-';

/** Query parameter carrying an entry's revision in its cache key. See the file header. */
export const REVISION_PARAM = '__precache_rev';

/** Default parallel downloads during install. */
export const DEFAULT_CONCURRENCY = 6;

export function cacheNameFor(build: string): string {
  return `${CACHE_PREFIX}${build}`;
}

export function isPrecacheName(name: string): boolean {
  return name.startsWith(CACHE_PREFIX);
}

/** Our caches that belong to some *other* build — i.e. everything `activatePrecache` evicts. */
export function staleCacheNames(names: readonly string[], build: string): string[] {
  const current = cacheNameFor(build);
  return names.filter((name) => isPrecacheName(name) && name !== current);
}

/** The absolute URL an entry is fetched from. */
export function entryUrl(entry: PrecacheEntry, baseUrl: string): string {
  return new URL(entry.url, baseUrl).href;
}

/** The absolute URL an entry is *stored* under: its URL plus the revision. See the file header. */
export function precacheKey(entry: PrecacheEntry, baseUrl: string): string {
  const url = new URL(entry.url, baseUrl);
  url.searchParams.set(REVISION_PARAM, entry.rev);
  return url.href;
}

/**
 * Canonical lookup form for a request URL: search and hash stripped. This is what lets a request
 * for `sprites/hero.png?v=3` still resolve to the cached `sprites/hero.png` — the equivalent of
 * `cache.match`'s `ignoreSearch`, but scoped to entries we actually precached rather than applied
 * blindly to every cached response.
 */
export function requestKey(url: string): string {
  const parsed = new URL(url);
  parsed.search = '';
  parsed.hash = '';
  return parsed.href;
}

/** Map of canonical request URL to cache key, built once at worker startup. */
export function buildPrecacheIndex(
  entries: readonly PrecacheEntry[],
  baseUrl: string,
): Map<string, string> {
  const index = new Map<string, string>();
  for (const entry of entries) {
    index.set(requestKey(entryUrl(entry, baseUrl)), precacheKey(entry, baseUrl));
  }
  return index;
}

/** Run `task` over `items`, at most `limit` at a time. */
async function pooled<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (let i = next++; i < items.length; i = next++) {
      await task(items[i]!);
    }
  });
  await Promise.all(workers);
}

/**
 * Populate this build's cache, reusing whatever earlier builds already downloaded.
 *
 * Resolves once every entry has been settled. **Rejects** only if an entry marked `shell` could not
 * be cached — a game whose HTML or bundle is missing would boot to a black screen offline, so it is
 * better to leave the old worker in place. A failed game asset is reported through `onWarn` and in
 * `failed`, and the install still succeeds.
 */
export async function installPrecache(
  entries: readonly PrecacheEntry[],
  build: string,
  baseUrl: string,
  deps: PrecacheDeps,
  concurrency: number = DEFAULT_CONCURRENCY,
): Promise<PrecacheResult> {
  const currentName = cacheNameFor(build);
  const target = await deps.caches.open(currentName);
  const previousNames = staleCacheNames(await deps.caches.keys(), build);
  const previous = await Promise.all(previousNames.map((name) => deps.caches.open(name)));

  const result: PrecacheResult = { carriedOver: 0, fetched: 0, failed: [] };
  const shellFailures: string[] = [];

  await pooled(entries, concurrency, async (entry) => {
    const key = precacheKey(entry, baseUrl);

    // Already ours — a re-install after an interrupted one, so there is nothing to do.
    if (await target.match(key)) {
      result.carriedOver++;
      return;
    }

    for (const cache of previous) {
      const hit = await cache.match(key);
      if (hit) {
        await target.put(key, hit);
        result.carriedOver++;
        return;
      }
    }

    try {
      // `reload` bypasses the HTTP cache, which could otherwise answer with bytes that no longer
      // match the revision we are about to store them under.
      const response = await deps.fetch(entryUrl(entry, baseUrl), { cache: 'reload' });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      await target.put(key, response);
      result.fetched++;
    } catch (error) {
      result.failed.push(entry.url);
      if (entry.shell) {
        shellFailures.push(entry.url);
      }
      deps.onWarn?.(`[game-sw] could not precache ${entry.url}: ${String(error)}`);
    }
  });

  if (shellFailures.length > 0) {
    throw new Error(
      `[game-sw] app shell failed to precache (${shellFailures.join(', ')}); ` +
        'keeping the previous worker rather than installing one that cannot boot offline.',
    );
  }
  return result;
}

/** Delete every cache belonging to another build. Returns the names removed. */
export async function activatePrecache(build: string, deps: PrecacheDeps): Promise<string[]> {
  const stale = staleCacheNames(await deps.caches.keys(), build);
  await Promise.all(stale.map((name) => deps.caches.delete(name)));
  return stale;
}

/** Whether this request is a page navigation (served network-first — see `service-worker.ts`). */
export function isNavigationRequest(request: Pick<Request, 'mode' | 'destination'>): boolean {
  return request.mode === 'navigate' || request.destination === 'document';
}

/**
 * Whether a navigation's network response should be discarded in favour of the cached shell.
 *
 * Only 5xx qualifies. A 4xx is a real answer *about that URL* — serving the game in its place would
 * turn every typo into a stale-looking game — and a 304 is the normal outcome of the network-first
 * trip for the `no-cache` entry HTML, so treating "not `ok`" as failure would route every ordinary
 * launch to the cache and defeat the point of going to the network at all.
 */
export function shouldFallBackToShell(response: Pick<Response, 'status'>): boolean {
  return response.status >= 500;
}

/** Whether the worker should answer this request at all: same-origin GETs only. */
export function isCacheableRequest(
  request: Pick<Request, 'method' | 'url'>,
  baseUrl: string,
): boolean {
  if (request.method !== 'GET') {
    return false;
  }
  try {
    return new URL(request.url).origin === new URL(baseUrl).origin;
  } catch {
    return false;
  }
}

/** The precached response for `url`, or `undefined` if it was never part of this build. */
export async function matchPrecached(
  url: string,
  index: ReadonlyMap<string, string>,
  build: string,
  deps: PrecacheDeps,
): Promise<Response | undefined> {
  let key: string | undefined;
  try {
    key = index.get(requestKey(url));
  } catch {
    return undefined;
  }
  if (key === undefined) {
    return undefined;
  }
  const cache = await deps.caches.open(cacheNameFor(build));
  return (await cache.match(key)) ?? undefined;
}
