/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * The gameplay-facing persistence contract — how a game keeps a best score, a settings
 * object, or an unlock across sessions.
 *
 * Gameplay must not touch `localStorage` directly: it is a DOM global, so a `localStorage`
 * call in `src/core/` fails the layer-boundary check (`npm run validate`) for the same reason
 * a `document` call does — it makes gameplay untestable outside a browser. Gameplay takes a
 * `KeyValueStore` instead, `main.ts` injects the `BrowserKeyValueStore`, and tests inject
 * `MemoryKeyValueStore`. Same shape as the `Renderer` / `InputManager` / `AudioPlayer` ports.
 *
 * Values are strings, like the Web Storage API underneath. Persist a number as
 * `String(score)` and read it back with `Number(...)`; persist a settings object with
 * `JSON.stringify` / `JSON.parse`.
 */

/** Backend-agnostic string key/value persistence. */
export interface KeyValueStore {
  /** The stored value, or `null` if the key was never set. */
  get(key: string): string | null;

  /** Store a value. Silently does nothing if persistence is unavailable. */
  set(key: string, value: string): void;

  /** Forget a key. Removing a key that was never set is not an error. */
  remove(key: string): void;
}

/** In-memory store: the test fake, and the fallback when the browser has no usable storage. */
export class MemoryKeyValueStore implements KeyValueStore {
  private readonly entries = new Map<string, string>();

  get(key: string): string | null {
    return this.entries.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this.entries.set(key, value);
  }

  remove(key: string): void {
    this.entries.delete(key);
  }
}

export interface BrowserKeyValueStoreOptions {
  /**
   * Key prefix, so two games served from the same origin don't collide. They routinely are:
   * every game runs on `http://localhost:5173` under `npm run dev`. Use the game name.
   */
  namespace: string;

  /** Override the backing store (tests). Defaults to `globalThis.localStorage`. */
  storage?: Storage;
}

/**
 * `localStorage`-backed store, namespaced by game.
 *
 * Web Storage fails in ways a game must survive rather than crash on: reading
 * `window.localStorage` itself throws a `SecurityError` when storage is blocked for the
 * origin, and `setItem` throws `QuotaExceededError` when the quota is full (which is also how
 * Safari's private mode reports its zero-size quota). So the constructor probes with a real
 * write, and every operation is guarded on top of that in case storage breaks later. When the
 * backing store is unusable this degrades to an in-memory store that lasts the session — the
 * game keeps working, it just forgets. Call `isPersistent()` if the game wants to say so.
 */
export class BrowserKeyValueStore implements KeyValueStore {
  private readonly prefix: string;
  private readonly storage: Storage | null;
  private readonly fallback = new MemoryKeyValueStore();

  constructor(options: BrowserKeyValueStoreOptions) {
    this.prefix = `${options.namespace}:`;
    this.storage = usableStorage(options.storage);
  }

  /** Whether writes actually survive the session (false when storage was unavailable). */
  isPersistent(): boolean {
    return this.storage !== null;
  }

  get(key: string): string | null {
    if (!this.storage) {
      return this.fallback.get(key);
    }
    try {
      return this.storage.getItem(this.prefix + key);
    } catch {
      return null;
    }
  }

  set(key: string, value: string): void {
    if (!this.storage) {
      this.fallback.set(key, value);
      return;
    }
    try {
      this.storage.setItem(this.prefix + key, value);
    } catch {
      // Quota exceeded, or storage disabled after construction. A best score is not worth
      // taking the game down for.
    }
  }

  remove(key: string): void {
    if (!this.storage) {
      this.fallback.remove(key);
      return;
    }
    try {
      this.storage.removeItem(this.prefix + key);
    } catch {
      // See `set`.
    }
  }
}

/**
 * The given storage (or `globalThis.localStorage`) if it is usable, else `null`. Merely reading
 * the `localStorage` property can throw, and a storage can exist yet reject every write, so
 * this probes with a real write/remove round-trip rather than a presence check.
 */
function usableStorage(override?: Storage): Storage | null {
  try {
    const storage = override ?? globalThis.localStorage;
    const probeKey = '__webapp_game_probe__';
    storage.setItem(probeKey, '1');
    storage.removeItem(probeKey);
    return storage;
  } catch {
    return null;
  }
}
