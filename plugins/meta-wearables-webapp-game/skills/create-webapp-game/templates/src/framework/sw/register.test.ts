/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  registerGameServiceWorker,
  resetServiceWorker,
  swResetRequested,
} from '@/framework/sw/register';

const HREF = 'https://game.example/play/index.html';

interface FakeWorld {
  register: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  unregister: ReturnType<typeof vi.fn>;
  replace: ReturnType<typeof vi.fn>;
  deleteCache: ReturnType<typeof vi.fn>;
  listeners: Map<string, () => void>;
}

/**
 * Stub the handful of globals `register.ts` touches. The module is deliberately thin, so the
 * interesting assertions are about *which* branch it takes rather than about DOM behaviour — no
 * jsdom needed.
 */
function stubWorld(options: { secure?: boolean; search?: string } = {}): FakeWorld {
  const { secure = true, search = '' } = options;
  const update = vi.fn(async () => {});
  const unregister = vi.fn(async () => true);
  const registration = { update, unregister };
  const register = vi.fn(async () => registration);
  const replace = vi.fn();
  const deleteCache = vi.fn(async () => true);
  const listeners = new Map<string, () => void>();

  vi.stubGlobal('window', {
    isSecureContext: secure,
    location: { href: `${HREF}${search}`, search, replace },
  });
  vi.stubGlobal('navigator', {
    serviceWorker: { register, getRegistrations: async () => [registration] },
  });
  vi.stubGlobal('document', {
    baseURI: HREF,
    visibilityState: 'visible',
    addEventListener: (type: string, listener: () => void) => listeners.set(type, listener),
  });
  vi.stubGlobal('caches', {
    keys: async () => ['webapp-game-precache-abc', 'other'],
    delete: deleteCache,
  });

  return { register, update, unregister, replace, deleteCache, listeners };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('swResetRequested', () => {
  it('is off when absent or explicitly disabled', () => {
    expect(swResetRequested('')).toBe(false);
    expect(swResetRequested('?stats')).toBe(false);
    expect(swResetRequested('?swreset=0')).toBe(false);
    expect(swResetRequested('?swreset=false')).toBe(false);
    expect(swResetRequested('?swreset=FALSE')).toBe(false);
  });

  it('is on when present with any other value', () => {
    expect(swResetRequested('?swreset')).toBe(true);
    expect(swResetRequested('?swreset=1')).toBe(true);
    expect(swResetRequested('?stats=1&swreset=on')).toBe(true);
  });
});

describe('resetServiceWorker', () => {
  it('unregisters every worker and drops every cache', async () => {
    const world = stubWorld();

    await expect(resetServiceWorker()).resolves.toEqual({ workers: 1, caches: 2 });

    expect(world.unregister).toHaveBeenCalledTimes(1);
    expect(world.deleteCache).toHaveBeenCalledTimes(2);
  });
});

describe('registerGameServiceWorker', () => {
  it('does nothing without a DOM', async () => {
    await expect(registerGameServiceWorker()).resolves.toBeNull();
  });

  it('is off by default in a dev build', async () => {
    const world = stubWorld();

    await expect(registerGameServiceWorker()).resolves.toBeNull();

    expect(import.meta.env.DEV).toBe(true);
    expect(world.register).not.toHaveBeenCalled();
  });

  it('is skipped outside a secure context', async () => {
    const world = stubWorld({ secure: false });

    await expect(registerGameServiceWorker({ enabled: true })).resolves.toBeNull();

    expect(world.register).not.toHaveBeenCalled();
  });

  it('registers next to the document with the http cache bypassed for update checks', async () => {
    const world = stubWorld();

    const registration = await registerGameServiceWorker({ enabled: true });

    expect(registration).not.toBeNull();
    expect(world.register).toHaveBeenCalledWith('https://game.example/play/sw.js', {
      updateViaCache: 'none',
    });
  });

  it('checks for a new build on launch and on every return to the foreground', async () => {
    const world = stubWorld();

    await registerGameServiceWorker({ enabled: true });
    expect(world.update).toHaveBeenCalledTimes(1);

    world.listeners.get('visibilitychange')?.();
    expect(world.update).toHaveBeenCalledTimes(2);
  });

  it('wipes everything and reloads without the flag when ?swreset is set', async () => {
    const world = stubWorld({ search: '?swreset=1' });

    await expect(registerGameServiceWorker({ enabled: true })).resolves.toBeNull();

    expect(world.unregister).toHaveBeenCalled();
    expect(world.deleteCache).toHaveBeenCalledTimes(2);
    // The flag is stripped so the reload cannot loop.
    expect(world.replace).toHaveBeenCalledWith(HREF);
    expect(world.register).not.toHaveBeenCalled();
  });

  it('reports failure as null rather than throwing', async () => {
    const world = stubWorld();
    world.register.mockRejectedValueOnce(new Error('no sw.js here'));

    await expect(registerGameServiceWorker({ enabled: true })).resolves.toBeNull();
  });
});
