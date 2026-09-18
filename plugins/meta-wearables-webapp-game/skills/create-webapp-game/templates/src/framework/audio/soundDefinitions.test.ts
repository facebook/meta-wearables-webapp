/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Unit tests for the pure sound-definition builders and variant selection. These need no
 * `AudioContext` (the module constructs no Web Audio nodes), so they run in plain node.
 */

import { describe, expect, it } from 'vitest';

import {
  note,
  randomOf,
  roundRobin,
  sample,
  selectVariantIndex,
  synth,
  synthDuration,
  tone,
  variants,
} from '@/framework/audio/soundDefinitions';

/** A stand-in AudioBuffer for sample-definition tests (only the reference is stored). */
const fakeBuffer = {} as AudioBuffer;

describe('layer builders', () => {
  it('tone applies defaults and keeps a flat pitch when start == end', () => {
    const layer = tone('square', 440, 440, 0.1);
    expect(layer).toMatchObject({ type: 'square', startFreq: 440, endFreq: 440, decaySeconds: 0.1 });
    expect(layer.peak).toBe(1);
    expect(layer.delaySeconds).toBe(0);
    expect(layer.detune).toBe(0);
  });

  it('note is a flat square by default at the given delay', () => {
    const layer = note(523.25, 0.07, 0.1);
    expect(layer.type).toBe('square');
    expect(layer.startFreq).toBe(layer.endFreq);
    expect(layer.delaySeconds).toBe(0.07);
  });
});

describe('definition builders', () => {
  it('synth defaults gain and tags kind', () => {
    const def = synth({ layers: [tone('square', 900, 420, 0.08)] });
    expect(def.kind).toBe('synth');
    expect(def.gain).toBe(0.5);
    expect(def.layers).toHaveLength(1);
  });

  it('synth rejects an empty layer list', () => {
    expect(() => synth({ layers: [] })).toThrow(/at least one layer/);
  });

  it('sample wraps a buffer with defaults', () => {
    const def = sample(fakeBuffer, { gain: 0.6 });
    expect(def).toMatchObject({ kind: 'sample', gain: 0.6, rate: 1, detune: 0, loop: false });
    expect(def.buffer).toBe(fakeBuffer);
  });

  it('roundRobin / randomOf set the select mode', () => {
    expect(roundRobin([sample(fakeBuffer)]).select).toBe('roundRobin');
    expect(randomOf([sample(fakeBuffer)]).select).toBe('random');
    expect(variants([sample(fakeBuffer)]).select).toBe('roundRobin');
  });
});

describe('selectVariantIndex', () => {
  const never = (): number => {
    throw new Error('random should not be called for roundRobin');
  };

  it('cycles round-robin from lastIndex', () => {
    const group = roundRobin([sample(fakeBuffer), sample(fakeBuffer), sample(fakeBuffer)]);
    expect(selectVariantIndex(group, -1, never)).toBe(0);
    expect(selectVariantIndex(group, 0, never)).toBe(1);
    expect(selectVariantIndex(group, 1, never)).toBe(2);
    expect(selectVariantIndex(group, 2, never)).toBe(0);
  });

  it('always returns 0 for a single variant', () => {
    const group = roundRobin([sample(fakeBuffer)]);
    expect(selectVariantIndex(group, -1, never)).toBe(0);
    expect(selectVariantIndex(group, 0, never)).toBe(0);
  });

  it('random avoids an immediate repeat', () => {
    const group = randomOf([sample(fakeBuffer), sample(fakeBuffer), sample(fakeBuffer)]);
    // random() -> index 1, which equals lastIndex 1, so it must bump to 2.
    expect(selectVariantIndex(group, 1, () => 1 / 3)).toBe(2);
    // random() -> index 0, different from lastIndex 2, so it stands.
    expect(selectVariantIndex(group, 2, () => 0)).toBe(0);
  });
});

describe('synthDuration', () => {
  it('is the latest-ending layer (delay + attack + decay)', () => {
    const def = synth({
      layers: [tone('square', 900, 420, 0.08), tone('noise', 0, 0, 0.3, { delaySeconds: 0.1 })],
    });
    expect(synthDuration(def)).toBeCloseTo(0.1 + 0.005 + 0.3);
  });
});
