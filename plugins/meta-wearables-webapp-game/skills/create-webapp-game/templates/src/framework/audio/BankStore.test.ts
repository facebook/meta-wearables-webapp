/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Tests for the byte store behind banks. Runs in plain Node: `BankStore` builds no Web Audio nodes,
 * it delegates decoding to an injected function, so a stub decoder is all it takes.
 *
 * The property worth guarding hardest is the second `loadBank` of the same clip — see the
 * "decodes the same clip twice" case.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { BankStore, pcmBytesOf } from '@/framework/audio/BankStore';

/** Stereo 48 kHz, one second: 2 x 48000 x 4 = 384000 bytes of PCM. */
const buffer = (): AudioBuffer =>
  ({ numberOfChannels: 2, length: 48_000, sampleRate: 48_000 }) as AudioBuffer;
const CLIP_BYTES = pcmBytesOf(buffer());

// Not a per-test `mockRestore()`: an assertion that fails before one would leak the spy — a muted
// `console.warn` or a stubbed `URL.createObjectURL` — into every later test in the file.
afterEach(() => {
  vi.restoreAllMocks();
});

function makeStore(maxResidentBytes = 10 * CLIP_BYTES) {
  const decoded: ArrayBuffer[] = [];
  const store = new BankStore(async (bytes) => {
    decoded.push(bytes);
    return buffer();
  }, maxResidentBytes);
  return { store, decoded };
}

function blob(size = 16): Blob {
  return new Blob([new Uint8Array(size)]);
}


/**
 * `expect(issues.some(match)).toBe(true)` fails with a bare "expected false to be true", which
 * says nothing about what was actually reported. Falling back to the whole list puts the issues
 * themselves in the failure message.
 */
function expectIssue(issues: readonly string[], match: (issue: string) => boolean): void {
  expect(issues.find(match) ?? issues).toEqual(expect.any(String));
}

/** Negative form of `expectIssue`: a failure shows which unexpected issues matched. */
function expectNoIssue(issues: readonly string[], match: (issue: string) => boolean): void {
  expect(issues.filter(match)).toEqual([]);
}

describe('pcmBytesOf', () => {
  it('is channels x frames x 4, the Float32 PCM footprint', () => {
    expect(CLIP_BYTES).toBe(2 * 48_000 * 4);
  });
});

describe('decode and release', () => {
  it('holds bytes without decoding until asked', async () => {
    const { store, decoded } = makeStore();
    store.put('a.ogg', blob(), { pcmBytes: CLIP_BYTES });

    expect(store.has('a.ogg')).toBe(true);
    expect(store.getBuffer('a.ogg')).toBeUndefined();
    expect(store.residentBytes).toBe(0);
    expect(decoded).toHaveLength(0);

    await store.decodeKeys(['a.ogg']);
    expect(store.getBuffer('a.ogg')).toBeDefined();
    expect(store.residentBytes).toBe(CLIP_BYTES);
  });

  it('frees PCM on release but keeps the compressed bytes', async () => {
    const { store } = makeStore();
    store.put('a.ogg', blob(), { pcmBytes: CLIP_BYTES });
    await store.decodeKeys(['a.ogg']);

    store.release(['a.ogg']);
    expect(store.getBuffer('a.ogg')).toBeUndefined();
    expect(store.residentBytes).toBe(0);
    // The whole point of the model: unloading a bank costs a re-decode, never a re-fetch.
    expect(store.has('a.ogg')).toBe(true);
  });

  it('decodes the same clip twice across an unload/reload cycle', async () => {
    // decodeAudioData DETACHES the ArrayBuffer it is handed, so a store that kept one raw
    // ArrayBuffer would work the first time and silently fail the second. Holding a Blob and
    // materializing fresh bytes per decode is what makes this pass.
    const { store, decoded } = makeStore();
    store.put('a.ogg', blob(), { pcmBytes: CLIP_BYTES });

    await store.decodeKeys(['a.ogg']);
    store.release(['a.ogg']);
    await store.decodeKeys(['a.ogg']);

    expect(store.getBuffer('a.ogg')).toBeDefined();
    expect(decoded).toHaveLength(2);
    expect(decoded[0]).not.toBe(decoded[1]);
    expect(decoded[1].byteLength).toBe(16);
  });

  it('shares one decode between concurrent requests for the same clip', async () => {
    const { store, decoded } = makeStore();
    store.put('a.ogg', blob(), { pcmBytes: CLIP_BYTES });

    await Promise.all([store.decodeKeys(['a.ogg']), store.decodeKeys(['a.ogg'])]);
    expect(decoded).toHaveLength(1);
    expect(store.residentBytes).toBe(CLIP_BYTES);
  });

  it('is a no-op for an already-decoded clip', async () => {
    const { store, decoded } = makeStore();
    store.put('a.ogg', blob(), { pcmBytes: CLIP_BYTES });
    await store.decodeKeys(['a.ogg']);
    await store.decodeKeys(['a.ogg']);
    expect(decoded).toHaveLength(1);
  });

  it('warns and stays silent for a clip no manifest entry supplied', async () => {
    const { store } = makeStore();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await store.decodeKeys(['missing.ogg']);
    expect(warn.mock.calls.flat().join(' ')).toContain('No preloaded bytes');
    expect(store.residentBytes).toBe(0);
  });

  it('survives a decoder that fails, without leaking byte accounting', async () => {
    const store = new BankStore(async () => null, 10 * CLIP_BYTES);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    store.put('a.ogg', blob(), { pcmBytes: CLIP_BYTES });
    await store.decodeKeys(['a.ogg']);
    expect(store.getBuffer('a.ogg')).toBeUndefined();
    expect(store.residentBytes).toBe(0);
  });
});

describe('the budget', () => {
  it('refuses a decode that would exceed it rather than OOMing', async () => {
    const { store, decoded } = makeStore(2 * CLIP_BYTES);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const key of ['a.ogg', 'b.ogg', 'c.ogg']) {
      store.put(key, blob(), { pcmBytes: CLIP_BYTES });
    }

    await store.decodeKeys(['a.ogg', 'b.ogg', 'c.ogg']);
    expect(decoded).toHaveLength(0);
    expect(store.residentBytes).toBe(0);
    expect(warn.mock.calls.flat().join(' ')).toContain('over the');
  });

  it('allows a request that exactly fills the budget', async () => {
    const { store } = makeStore(2 * CLIP_BYTES);
    store.put('a.ogg', blob(), { pcmBytes: CLIP_BYTES });
    store.put('b.ogg', blob(), { pcmBytes: CLIP_BYTES });
    await store.decodeKeys(['a.ogg', 'b.ogg']);
    expect(store.residentBytes).toBe(2 * CLIP_BYTES);
  });

  it('frees room so a later bank fits — the whole point of unloading', async () => {
    const { store } = makeStore(2 * CLIP_BYTES);
    store.put('a.ogg', blob(), { pcmBytes: CLIP_BYTES });
    store.put('b.ogg', blob(), { pcmBytes: CLIP_BYTES });
    store.put('c.ogg', blob(), { pcmBytes: CLIP_BYTES });

    await store.decodeKeys(['a.ogg', 'b.ogg']);
    store.release(['a.ogg', 'b.ogg']);
    await store.decodeKeys(['c.ogg']);
    expect(store.residentBytes).toBe(CLIP_BYTES);
  });
});

describe('estimates and hints', () => {
  it('costs a bank from its hints before anything is decoded', () => {
    const { store } = makeStore();
    store.put('a.ogg', blob(), { pcmBytes: 1000 });
    store.put('b.ogg', blob(), { pcmBytes: 2000 });
    expect(store.estimateBytes(['a.ogg', 'b.ogg'])).toBe(3000);
    // De-duplicated: a clip two banks share is counted once.
    expect(store.estimateBytes(['a.ogg', 'a.ogg'])).toBe(1000);
  });

  it('prefers the measured size over the hint once a clip has decoded', async () => {
    const { store } = makeStore();
    store.put('a.ogg', blob(), { pcmBytes: 1000 }); // a deliberately wrong hint
    await store.decodeKeys(['a.ogg']);
    expect(store.estimateBytes(['a.ogg'])).toBe(CLIP_BYTES);
  });

  it('flags missing hints once for the whole set, not once per clip', () => {
    const { store } = makeStore();
    for (const key of ['a.ogg', 'b.ogg', 'c.ogg']) {
      store.put(key, blob());
    }
    const missing = store.hintIssues().filter((i) => i.includes('no pcmBytes hint'));
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('3 clip(s)');
  });

  it('reports an unknown size as unknown, not as zero', () => {
    // The distinction the budget check rests on: estimateBytes can only ever be a lower bound, so
    // a caller about to risk memory has to ask hasUnknownSize first.
    const { store } = makeStore();
    store.put('known.ogg', blob(), { pcmBytes: 1000 });
    store.put('unknown.ogg', blob());

    expect(store.hasUnknownSize(['known.ogg'])).toBe(false);
    expect(store.hasUnknownSize(['known.ogg', 'unknown.ogg'])).toBe(true);
    expect(store.estimateBytes(['known.ogg', 'unknown.ogg'])).toBe(1000); // a lower bound
  });

  it('stops calling a size unknown once the clip has been decoded', async () => {
    const { store } = makeStore();
    store.put('a.ogg', blob());
    expect(store.hasUnknownSize(['a.ogg'])).toBe(true);
    await store.decodeKeys(['a.ogg']);
    expect(store.hasUnknownSize(['a.ogg'])).toBe(false);
    expect(store.estimateBytes(['a.ogg'])).toBe(CLIP_BYTES);
  });

  it('never calls a streamed clip unknown — it has no decoded size to know', () => {
    const { store } = makeStore();
    store.put('theme.ogg', blob(), { streamed: true });
    expect(store.hasUnknownSize(['theme.ogg'])).toBe(false);
  });

  it('flags a hint more than 10% off, and accepts one within it', async () => {
    const { store } = makeStore();
    store.put('close.ogg', blob(), { pcmBytes: Math.round(CLIP_BYTES * 1.05) });
    store.put('wrong.ogg', blob(), { pcmBytes: Math.round(CLIP_BYTES * 0.5) });
    await store.decodeKeys(['close.ogg', 'wrong.ogg']);

    const issues = store.hintIssues();
    expectNoIssue(issues, (i) => i.includes('close.ogg'));
    expectIssue(issues, (i) => i.includes('wrong.ogg') && i.includes('50% off'));
  });
});

describe('object URLs (the streaming path)', () => {
  it('creates one per clip and reuses it', () => {
    const create = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const { store } = makeStore();
    store.put('theme.ogg', blob());

    expect(store.objectUrlFor('theme.ogg')).toBe('blob:x');
    expect(store.objectUrlFor('theme.ogg')).toBe('blob:x');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('revokes it on release, so the bytes can be reclaimed', () => {
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:x');
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { store } = makeStore();
    store.put('theme.ogg', blob());
    store.objectUrlFor('theme.ogg');

    store.release(['theme.ogg']);
    expect(revoke).toHaveBeenCalledWith('blob:x');
  });

  it('is null for a clip with no registered bytes', () => {
    const { store } = makeStore();
    expect(store.objectUrlFor('nope.ogg')).toBeNull();
  });
});
