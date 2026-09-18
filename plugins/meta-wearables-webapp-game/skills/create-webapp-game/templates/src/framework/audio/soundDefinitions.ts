/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * The declarative synth format the `AudioEngine` renders — and the builders for
 * writing it. A sound is **data**: either a stack of synthesized oscillator/noise layers (a retro
 * 8-bit "pew"/"boom"), a preloaded sample, or a group of variants played round-robin / at random.
 *
 * This file is **pure** — it holds only data types, tiny builders, and the variant-selection
 * math. It never touches the Web Audio API (it references the `AudioBuffer` *type* for sample
 * definitions but constructs nothing), so it stays node-unit-testable. `AudioEngine.ts` turns
 * these definitions into an audio graph. Tune the *sound* here; tune the *mix/spatialization* via
 * the `AUDIO` config block. See `docs/audio.md`.
 *
 * The framework ships this format and its interpreter but **no specific sounds** — designing a
 * game's `playerFire` / `pickup` / `explosion` is the game's job (see `docs/audio.md` for a worked
 * example set).
 */

/** Oscillator waveform, or band-limited white `noise` (rendered from a shared buffer). */
export type LayerType = 'sine' | 'square' | 'sawtooth' | 'triangle' | 'noise';

/**
 * One oscillator/noise layer with a pitch bend and an attack→decay envelope. The layer ramps
 * `0 → peak` over `attackSeconds`, then `peak → 0` over `decaySeconds`; `delaySeconds` offsets its
 * start within the sound (for sequences/arpeggios). `noise` layers ignore the frequencies.
 */
export interface OscLayer {
  readonly type: LayerType;
  readonly startFreq: number;
  readonly endFreq: number;
  readonly peak: number;
  readonly attackSeconds: number;
  readonly decaySeconds: number;
  readonly delaySeconds: number;
  /** Detune in cents (fattens a layer / makes chords shimmer). */
  readonly detune: number;
}

/** A synthesized sound: one or more oscillator/noise layers plus a per-sound pre-bus mix `gain`. */
export interface SynthDefinition {
  readonly kind: 'synth';
  readonly gain: number;
  readonly layers: readonly OscLayer[];
}

/** A sample-based sound: a preloaded `AudioBuffer` plus its mix/pitch/loop settings. */
export interface SampleDefinition {
  readonly kind: 'sample';
  readonly buffer: AudioBuffer;
  readonly gain: number;
  readonly rate: number;
  readonly detune: number;
  readonly loop: boolean;
}

/** A single playable sound (not a group). */
export type PlayableDefinition = SynthDefinition | SampleDefinition;

/** How a {@link VariantGroup} picks which variant to play. */
export type SelectMode = 'roundRobin' | 'random';

/**
 * A group of interchangeable variants for one sound id, to avoid the "same clip every time"
 * machine-gun effect. `roundRobin` cycles them in order; `random` picks one at random, never the
 * same as the immediately previous play. Variants don't nest (each is a synth or sample).
 */
export interface VariantGroup {
  readonly kind: 'variants';
  readonly variants: readonly PlayableDefinition[];
  readonly select: SelectMode;
}

/** Anything a sound id can map to. */
export type SoundDefinition = PlayableDefinition | VariantGroup;

/** Defaults shared by the layer builders. */
const DEFAULT_ATTACK_SECONDS = 0.005;

/**
 * Build a tone (oscillator or noise) layer with sensible defaults (no bend / no delay / no
 * detune / peak 1). For a flat-pitch tone pass the same value for `startFreq` and `endFreq`.
 */
export function tone(
  type: LayerType,
  startFreq: number,
  endFreq: number,
  decaySeconds: number,
  options: {
    peak?: number;
    attackSeconds?: number;
    delaySeconds?: number;
    detune?: number;
  } = {},
): OscLayer {
  return {
    type,
    startFreq,
    endFreq,
    peak: options.peak ?? 1,
    attackSeconds: options.attackSeconds ?? DEFAULT_ATTACK_SECONDS,
    decaySeconds,
    delaySeconds: options.delaySeconds ?? 0,
    detune: options.detune ?? 0,
  };
}

/** A short flat-pitch note in a sequence: a `square` (by default) at `freq`, starting at `delaySeconds`. */
export function note(
  freq: number,
  delaySeconds: number,
  decaySeconds: number,
  options: { type?: LayerType; peak?: number } = {},
): OscLayer {
  return tone(options.type ?? 'square', freq, freq, decaySeconds, {
    peak: options.peak ?? 1,
    attackSeconds: 0.004,
    delaySeconds,
  });
}

/** Build a synthesized sound from its layers and a per-sound mix `gain` (default `0.5`). */
export function synth(spec: {
  layers: readonly OscLayer[];
  gain?: number;
}): SynthDefinition {
  if (spec.layers.length === 0) {
    // Fail loudly at registration (like `variants([])`): a layerless synth would attach no source,
    // so it plays nothing and — in a variant group — would silently consume a rotation slot.
    throw new Error('synth() requires at least one layer');
  }
  return { kind: 'synth', gain: spec.gain ?? 0.5, layers: spec.layers };
}

/** Build a sample-based sound from a preloaded `AudioBuffer`. */
export function sample(
  buffer: AudioBuffer,
  options: { gain?: number; rate?: number; detune?: number; loop?: boolean } = {},
): SampleDefinition {
  return {
    kind: 'sample',
    buffer,
    gain: options.gain ?? 1,
    rate: options.rate ?? 1,
    detune: options.detune ?? 0,
    loop: options.loop ?? false,
  };
}

/** Group variants of a sound with an explicit selection mode. */
export function variants(
  defs: readonly PlayableDefinition[],
  select: SelectMode = 'roundRobin',
): VariantGroup {
  if (defs.length === 0) {
    // Fail loudly at registration: an empty group would resolve to `variants[0]` (undefined) and
    // crash at play time, far from the offending definition.
    throw new Error('variants() requires at least one variant');
  }
  return { kind: 'variants', variants: defs, select };
}

/** Variants played in rotation (0, 1, 2, 0, …). */
export function roundRobin(defs: readonly PlayableDefinition[]): VariantGroup {
  return variants(defs, 'roundRobin');
}

/** Variants played at random, never repeating the immediately previous one. */
export function randomOf(defs: readonly PlayableDefinition[]): VariantGroup {
  return variants(defs, 'random');
}

/**
 * Pick the next variant index for a group given the previously played index (`-1` if none yet).
 * Pure — the caller stores the returned index as the new `lastIndex` and injects `random` (so
 * tests are deterministic). `roundRobin` advances sequentially; `random` avoids an immediate
 * repeat. A single-variant group always returns `0`.
 */
export function selectVariantIndex(
  group: VariantGroup,
  lastIndex: number,
  random: () => number,
): number {
  const n = group.variants.length;
  if (n <= 1) {
    return 0;
  }
  if (group.select === 'roundRobin') {
    return (lastIndex + 1) % n;
  }
  // `random()` is [0, 1) so `floor(random() * n)` is already in [0, n-1]; the min only guards a
  // misbehaving injected RNG that returns exactly 1 (avoids an out-of-range index) without the
  // misleading `% n` that implies the value could wrap.
  const pick = Math.min(Math.floor(random() * n), n - 1);
  return pick === lastIndex ? (pick + 1) % n : pick;
}

/** Total wall-clock length (s) of a synth sound — its latest-ending layer — for scheduling/cleanup. */
export function synthDuration(definition: SynthDefinition): number {
  let end = 0;
  for (const layer of definition.layers) {
    end = Math.max(end, layer.delaySeconds + layer.attackSeconds + layer.decaySeconds);
  }
  return end;
}
