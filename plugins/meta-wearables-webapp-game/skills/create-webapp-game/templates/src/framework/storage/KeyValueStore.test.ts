/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

import { describe, expect, it } from 'vitest';

import {
  BrowserKeyValueStore,
  MemoryKeyValueStore,
} from '@/framework/storage/KeyValueStore';

/** A minimal in-memory `Storage`, so the browser store can be driven without a DOM. */
function fakeStorage(overrides: Partial<Storage> = {}): Storage {
  const entries = new Map<string, string>();
  return {
    get length(): number {
      return entries.size;
    },
    clear: (): void => entries.clear(),
    getItem: (key: string): string | null => entries.get(key) ?? null,
    key: (index: number): string | null => [...entries.keys()][index] ?? null,
    removeItem: (key: string): void => void entries.delete(key),
    setItem: (key: string, value: string): void => void entries.set(key, value),
    ...overrides,
  } as Storage;
}

describe('MemoryKeyValueStore', () => {
  it('returns null for a key that was never set', () => {
    expect(new MemoryKeyValueStore().get('best')).toBeNull();
  });

  it('round-trips a value', () => {
    const store = new MemoryKeyValueStore();
    store.set('best', '4200');
    expect(store.get('best')).toBe('4200');
  });

  it('forgets a removed key, and tolerates removing an absent one', () => {
    const store = new MemoryKeyValueStore();
    store.set('best', '1');
    store.remove('best');
    store.remove('never-set');
    expect(store.get('best')).toBeNull();
  });

  it('distinguishes an empty string from an absent key', () => {
    const store = new MemoryKeyValueStore();
    store.set('name', '');
    expect(store.get('name')).toBe('');
  });
});

describe('BrowserKeyValueStore', () => {
  it('namespaces keys so two games on one origin do not collide', () => {
    const storage = fakeStorage();
    new BrowserKeyValueStore({ namespace: 'loot-rain', storage }).set('best', '10');
    new BrowserKeyValueStore({ namespace: 'neon-runner', storage }).set('best', '20');

    expect(storage.getItem('loot-rain:best')).toBe('10');
    expect(storage.getItem('neon-runner:best')).toBe('20');
  });

  it('reads back only its own namespace', () => {
    const storage = fakeStorage();
    storage.setItem('other-game:best', '999');
    const store = new BrowserKeyValueStore({ namespace: 'loot-rain', storage });

    expect(store.get('best')).toBeNull();
  });

  it('round-trips and removes through the backing storage', () => {
    const storage = fakeStorage();
    const store = new BrowserKeyValueStore({ namespace: 'g', storage });

    store.set('best', '7');
    expect(store.get('best')).toBe('7');

    store.remove('best');
    expect(store.get('best')).toBeNull();
    expect(storage.getItem('g:best')).toBeNull();
  });

  it('reports itself persistent when the backing storage works', () => {
    const store = new BrowserKeyValueStore({ namespace: 'g', storage: fakeStorage() });
    expect(store.isPersistent()).toBe(true);
  });

  it('degrades to session memory when the storage rejects writes (quota / private mode)', () => {
    const store = new BrowserKeyValueStore({
      namespace: 'g',
      storage: fakeStorage({
        setItem: (): never => {
          throw new Error('QuotaExceededError');
        },
      }),
    });

    // The constructor's probe write fails, so the store never crashes the game — it just
    // stops being persistent, and says so.
    expect(store.isPersistent()).toBe(false);
    expect(() => store.set('best', '7')).not.toThrow();
    expect(store.get('best')).toBe('7');
  });

  it('survives a storage that starts rejecting writes after construction', () => {
    let failing = false;
    const store = new BrowserKeyValueStore({
      namespace: 'g',
      storage: fakeStorage({
        setItem: (): void => {
          if (failing) {
            throw new Error('QuotaExceededError');
          }
        },
      }),
    });
    failing = true;

    expect(store.isPersistent()).toBe(true);
    expect(() => store.set('best', '7')).not.toThrow();
  });

  it('survives a storage that throws on read', () => {
    const store = new BrowserKeyValueStore({
      namespace: 'g',
      storage: fakeStorage({
        getItem: (): never => {
          throw new Error('SecurityError');
        },
      }),
    });

    expect(store.get('best')).toBeNull();
  });

  it('survives a storage that throws on remove', () => {
    const store = new BrowserKeyValueStore({
      namespace: 'g',
      storage: fakeStorage({
        removeItem: (): never => {
          throw new Error('SecurityError');
        },
      }),
    });

    expect(() => store.remove('best')).not.toThrow();
  });

  it('constructs and works with no `storage` option outside a browser', () => {
    // The default path probes `globalThis.localStorage`, which the node test environment
    // either lacks or rejects. Either way construction must not throw and the store must
    // still function — degraded to session lifetime. (Whether it ends up persistent depends
    // on the host, so that is deliberately not asserted here.)
    const store = new BrowserKeyValueStore({ namespace: 'g' });

    store.set('best', '7');
    expect(store.get('best')).toBe('7');
    store.remove('best');
    expect(store.get('best')).toBeNull();
  });
});
