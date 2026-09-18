/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { isInMemoryUrl, sealAssetNetwork, strictSealRequested } from '@/framework/debug/NetworkGuard';

describe('isInMemoryUrl', () => {
  it('treats blob: and data: URLs as in-memory (preloaded) references', () => {
    expect(isInMemoryUrl('blob:https://example.com/uuid')).toBe(true);
    expect(isInMemoryUrl('data:audio/mpeg;base64,AAAA')).toBe(true);
  });

  it('treats real network URLs as not in-memory', () => {
    expect(isInMemoryUrl('https://cdn.example.com/a.png')).toBe(false);
    expect(isInMemoryUrl('/sprites/hero.png')).toBe(false);
    expect(isInMemoryUrl('models/ship.glb')).toBe(false);
    expect(isInMemoryUrl('')).toBe(false);
  });
});

describe('strictSealRequested', () => {
  it('is off when absent or explicitly disabled', () => {
    expect(strictSealRequested('')).toBe(false);
    expect(strictSealRequested('?stats')).toBe(false);
    expect(strictSealRequested('?strict=0')).toBe(false);
    expect(strictSealRequested('?strict=false')).toBe(false);
    expect(strictSealRequested('?strict=FALSE')).toBe(false);
  });

  it('is on when present with any other value (matching ?stats / ?slowload)', () => {
    expect(strictSealRequested('?strict')).toBe(true);
    expect(strictSealRequested('?strict=1')).toBe(true);
    expect(strictSealRequested('?foo=1&strict=on')).toBe(true);
  });
});

describe('sealAssetNetwork (fetch path, via a fake window)', () => {
  // The seal reads the global `window`; a fake with just `fetch` exercises the fetch interception
  // in the Node test environment (XHR / media-element setters are absent, so they're skipped).
  const withFakeWindow = <T>(fn: (win: { fetch: (input: unknown) => Promise<unknown> }) => T): T => {
    const calls: unknown[] = [];
    const win = { fetch: (input: unknown): Promise<unknown> => (calls.push(input), Promise.resolve('ok')) };
    const original = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = win;
    try {
      return fn(win);
    } finally {
      (globalThis as { window?: unknown }).window = original;
    }
  };

  afterEach(() => vi.restoreAllMocks());

  it('warns on a real network URL, allows blob:/data:, and still calls through', () => {
    withFakeWindow((win) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const unseal = sealAssetNetwork();
      const lateUrl = 'https://cdn.example.com/late-load.png';
      void win.fetch(lateUrl);
      void win.fetch('blob:abc');
      void win.fetch('data:text/plain,hi');
      const warned = warn.mock.calls.map((c) => String(c[0]));
      // Assert on the distinctive path (not a bare-domain substring) so the warning is confirmed to
      // name the offending URL without a domain-`includes` check.
      expect(warned.some((m) => m.includes('/late-load.png'))).toBe(true);
      expect(warned.some((m) => m.includes('blob:') || m.includes('data:'))).toBe(false);
      unseal();
    });
  });

  it('permits a URL accepted by the allow predicate', () => {
    withFakeWindow((win) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const unseal = sealAssetNetwork({ allow: (url) => url.includes('/api/') });
      void win.fetch('https://example.com/api/score');
      expect(warn).not.toHaveBeenCalled();
      unseal();
    });
  });

  it('rejects (not sync-throws) in strict mode and restores the original fetch on unseal', async () => {
    // Everything touching `window` happens synchronously inside `withFakeWindow`; the returned
    // promises are awaited afterwards (they no longer need `window`).
    const { rejected, afterUnseal } = withFakeWindow((win) => {
      const unseal = sealAssetNetwork({ strict: true });
      const rejected = win.fetch('https://cdn.example.com/a.png');
      unseal();
      // Restored: the original fetch resolves normally again.
      const afterUnseal = win.fetch('https://cdn.example.com/a.png');
      return { rejected, afterUnseal };
    });
    await expect(rejected).rejects.toThrow(/Runtime network load/);
    await expect(afterUnseal).resolves.toBe('ok');
  });
});
