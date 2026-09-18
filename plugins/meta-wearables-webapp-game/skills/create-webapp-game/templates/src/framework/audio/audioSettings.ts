/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * The `audioSettings.json` schema, its parser, and its validator — the **designer-owned** half of
 * the audio subsystem. A sound designer edits `src/audio/audioSettings.json`; nothing here is
 * game code and nothing here touches TypeScript-only constructs, so the file round-trips through
 * `JSON.parse` / `JSON.stringify` and a future GUI editor can read and write it.
 *
 * This file is **pure**: data types, a parser that resolves defaults, and a validator. It never
 * touches the Web Audio API or the DOM (it references the `AudioBuffer` *type* nowhere at all), so
 * it unit-tests in plain Node with no `AudioContext` mock. `AmpAudioPlayer.ts` owns the runtime
 * behaviour; `AudioEngine.ts` owns the nodes.
 *
 * ## The model
 *
 *   Event  — a named trigger the game fires (`play('UI_Click')`). Owns one or more *clips* plus
 *            the tuning that decides how they play.
 *   Clip   — either a **filename** (a sample, whose bytes come from the preload manifest and whose
 *            decoded PCM a bank owns) or an **inline synth stack** (oscillator/noise layers, zero
 *            asset bytes). Several clips form a variation pool.
 *   Bank   — a memory group. An event declares which bank(s) it belongs to; loading a bank
 *            *decodes* its clips and unloading *frees* the decoded PCM. Nothing is fetched at
 *            runtime — see `docs/audio-banks.md`.
 *   Group  — a concurrency budget shared by several events (`voiceGroups`).
 *   Bus    — `sfx` or `music`, under a master. See `docs/audio.md`.
 *
 * Event ids are cross-checked against the game's hand-written `SoundId` union by
 * {@link validateSettings} (pass `declaredIds`), so adding an event to the JSON without adding it
 * to `src/audio/soundIds.ts` — or vice versa — fails a test rather than failing silently at play
 * time. That is what buys a compile-checked `play()` with no codegen step.
 */

import {
  synth,
  tone,
  type LayerType,
  type SampleDefinition,
  type SoundDefinition,
  type SynthDefinition,
} from '@/framework/audio/soundDefinitions';
import type { VoiceLimitStrategy } from '@/framework/audio/VoicePool';

/** The mixer buses that sit under the master bus. Each has its own volume. */
export type AudioBus = 'sfx' | 'music';

/** A positive integer, or `'max'` meaning the global voice limit. */
export type VoiceLimit = number | 'max';

/** How a multi-clip event picks which clip to play. */
export type ClipSelect = 'random' | 'randomNonRepeating' | 'roundRobin';

/** Every legal `clipSelect`, for `validate()`. */
export const CLIP_SELECTS: readonly ClipSelect[] = ['random', 'randomNonRepeating', 'roundRobin'];

/** Every legal `voiceLimitStrategy`, for `validate()`. */
export const VOICE_LIMIT_STRATEGIES: readonly VoiceLimitStrategy[] = ['killOldest', 'preventNew'];

/**
 * One layer of an inline synth clip — the JSON spelling of {@link OscLayer}. Only `type` and
 * `decay` are required; everything else defaults exactly as the `tone()` builder does, so a JSON
 * layer stays short. `noise` layers ignore the frequencies.
 */
export interface SynthLayerSpec {
  type: LayerType;
  /** Flat pitch (Hz) — shorthand for `startFreq === endFreq`. Ignored when either is given. */
  freq?: number;
  /** Pitch at the start of the layer (Hz). Defaults to `freq`, else `0`. */
  startFreq?: number;
  /** Pitch at the end of the layer (Hz) — the bend target. Defaults to `startFreq`. */
  endFreq?: number;
  /** Envelope peak `0..1`. Default `1`. */
  peak?: number;
  /** Attack ramp in SECONDS. Default `0.005`. */
  attack?: number;
  /** Decay ramp in SECONDS. Required — a layer needs a length. */
  decay: number;
  /** Start offset in SECONDS, for sequences/arpeggios. Default `0`. */
  delay?: number;
  /** Detune in cents. Default `0`. */
  detune?: number;
}

/** An inline synthesized clip: a layer stack plus a per-clip pre-bus mix `gain` (default `0.5`). */
export interface SynthClipSpec {
  synth: {
    gain?: number;
    layers: SynthLayerSpec[];
  };
}

/**
 * One entry in an event's `clips`. A **string** is a sample filename resolved against
 * `soundsBasePath` (its bytes come from the preload manifest, its PCM from a bank); an **object**
 * is an inline synth stack that costs no asset bytes and belongs to no bank.
 */
export type ClipSpec = string | SynthClipSpec;

/** One entry in `audioSettings.json` → `events`. */
export interface AudioEventConfig {
  /** Unique id the game passes to `play()`. Must appear in `src/audio/soundIds.ts`. */
  name: string;
  /** Sample filenames and/or inline synth stacks. Several clips form a variation pool. */
  clips: ClipSpec[];
  /** Bank id, or several. Omitted means the always-resident default bank. Synth-only events ignore it. */
  bank?: string | string[];
  /** Linear gain `0..1`. Default `1`. */
  volume?: number;
  /** Playback rate; also shifts pitch. Default `1`. Synth clips read it as a detune-free rate. */
  pitch?: number;
  /** How a multi-clip event picks. Default `'random'`. */
  clipSelect?: ClipSelect;
  /**
   * Native-AMP spelling of `clipSelect: 'randomNonRepeating'`, accepted so a config written for
   * native AMP loads unchanged. Prefer `clipSelect`; setting both to conflicting values is a
   * `validate()` issue.
   */
  randomNonRepeating?: boolean;
  /** Fade-in ms. Default `0`. */
  fadeInDuration?: number;
  /** Fade-out ms applied by `stop()`. Default `0`. */
  fadeOutDuration?: number;
  /** Loop until `stop()`. Default `false`. Retriggering crossfades over `fadeOutDuration`. */
  loop?: boolean;
  /** Percent chance `0..100` the trigger actually sounds. Default `100`. */
  chanceToPlay?: number;
  /** Mixer bus. Default `'sfx'`. */
  bus?: AudioBus;
  /**
   * Stream this event's sample clips from a `blob:` URL instead of decoding them into PCM.
   * **Defaults to `true` on the `music` bus**, because a two-minute loop is ~44 MB decoded and
   * streaming holds almost none. Set it explicitly for a short music sting that should decode (for
   * lower start latency), or for a long sfx-bus ambience that should stream. A streamed clip has no
   * bank lifecycle: its compressed bytes are always resident and it costs no PCM budget.
   */
  stream?: boolean;
  /** Per-event retrigger guard in ms. Falls back to `global.defaultCooldown`. */
  cooldown?: number;
  /**
   * Max concurrent instances of THIS event. Default `1` (monophonic), or no private cap when
   * `voiceGroup` is set — declaring a group means "my budget is the group's budget".
   */
  voiceLimit?: VoiceLimit;
  /** What to do at this event's own limit. Default `'killOldest'`. */
  voiceLimitStrategy?: VoiceLimitStrategy;
  /** Shared budget(s) this event draws from, by id, exactly like `bank`. */
  voiceGroup?: string | string[];
}

/** One entry in `banks`. Optional: a bank an event names is registered implicitly. */
export interface BankConfig {
  id: string;
  /** Human note for the JSON editor / docs. Unused at runtime. */
  description?: string;
  /** Decode during `init()` and never unload. Default `false`. */
  persistent?: boolean;
  /**
   * Banks this one can transition to. Purely a **static assertion**: `validate()` fails any
   * declared pair whose combined decoded estimate exceeds `maxResidentBytes`, so an overlapped
   * swap that would blow the budget is caught at authoring time rather than on-device.
   */
  transitionsTo?: string[];
}

/** One entry in `voiceGroups` — a concurrency budget shared by several events. */
export interface VoiceGroupConfig {
  id: string;
  description?: string;
  /** Max concurrent voices across every event in the group. Default `'max'`. */
  voiceLimit?: VoiceLimit;
  /** What to do when the group is full. Default `'killOldest'`. */
  voiceLimitStrategy?: VoiceLimitStrategy;
}

/**
 * Soundbank-wide tuning. Anything passed to `AmpAudioPlayer.init()` overrides it, so a game can
 * retune per device tier without editing the designer's JSON.
 *
 * The bus mix (`masterVolume` / `sfxVolume` / `musicVolume`) is not here: it is an
 * `AudioEngineOptions` field, set once from the game's `AUDIO` config block when the player is
 * constructed, and changed at runtime through the player's `setBusVolume`.
 */
export interface GlobalConfig {
  /** Hard polyphony cap across all events. Default `24`, clamped to the engine's strip count. */
  globalVoiceLimit?: number;
  /** Default per-event retrigger guard in ms. Default `50`. */
  defaultCooldown?: number;
  /** Prefix joined to every sample filename to form its preload-manifest key. */
  soundsBasePath?: string;
}

/** The whole `audioSettings.json` document. */
export interface AudioSettings {
  global?: GlobalConfig;
  banks?: BankConfig[];
  voiceGroups?: VoiceGroupConfig[];
  events: AudioEventConfig[];
}

/** Bank id used by events that declare no bank. Always loaded, never unloaded. */
export const DEFAULT_BANK = 'default';

/**
 * Namespace for the voice group every event implicitly owns. Prefixed so an event called
 * `footsteps` cannot silently share a budget with a group called `footsteps`.
 */
export const EVENT_GROUP_PREFIX = '@event:';

/** The implicit per-event voice group id — what makes `stop()` / `isPlaying()` work per event. */
export function eventVoiceGroupId(eventName: string): string {
  return EVENT_GROUP_PREFIX + eventName;
}

export const DEFAULT_SOUNDS_BASE_PATH = 'assets/sounds/';
export const DEFAULT_COOLDOWN_MS = 50;
export const DEFAULT_GLOBAL_VOICE_LIMIT = 24;

/**
 * A clip resolved to exactly what the engine needs. The four kinds are the four ways a voice can be
 * sourced:
 *
 * - `sample` — a manifest key whose PCM a bank decodes and frees. The common case.
 * - `stream` — a manifest key played from a `blob:` URL, decoded incrementally. No PCM budget.
 * - `synth`  — an inline oscillator/noise stack. No bytes at all.
 * - `buffer` — an `AudioBuffer` the game decoded itself and registered programmatically.
 */
export type ResolvedClip =
  | { readonly kind: 'sample'; readonly key: string }
  | { readonly kind: 'stream'; readonly key: string }
  | { readonly kind: 'synth'; readonly definition: SynthDefinition }
  | { readonly kind: 'buffer'; readonly definition: SampleDefinition };

/** An event with every default applied — what `AmpAudioPlayer` actually plays from. */
export interface ResolvedEvent {
  readonly name: string;
  readonly clips: readonly ResolvedClip[];
  /**
   * Manifest keys a **bank decodes** for this event — its `sample` clips only. Empty for an event
   * built from synth, streams, or registered buffers, which is exactly what makes such an event
   * always playable regardless of which banks are loaded.
   */
  readonly sampleKeys: readonly string[];
  /** Manifest keys this event **streams**. Their bytes must be preloaded; their PCM is never held. */
  readonly streamKeys: readonly string[];
  readonly banks: readonly string[];
  readonly volume: number;
  readonly pitch: number;
  readonly clipSelect: ClipSelect;
  readonly fadeInDuration: number;
  readonly fadeOutDuration: number;
  readonly loop: boolean;
  readonly chanceToPlay: number;
  readonly bus: AudioBus;
  readonly cooldown: number;
  /** Effective cap on this event alone. Equals the global limit when uncapped. */
  readonly voiceLimit: number;
  readonly voiceLimitStrategy: VoiceLimitStrategy;
  /** Declared SHARED groups, for tooling. Excludes the implicit per-event group. */
  readonly voiceGroups: readonly string[];
  /** As written in JSON, kept only so `validate()` can flag a bad value. */
  readonly configured: AudioEventConfig;
}

/** Everything `parseSettings` resolves, ready for the player and the validator. */
export interface ParsedSettings {
  readonly events: ReadonlyMap<string, ResolvedEvent>;
  readonly banks: ReadonlyMap<string, BankConfig>;
  readonly voiceGroups: ReadonlyMap<string, VoiceGroupConfig>;
  readonly globalVoiceLimit: number;
  readonly defaultCooldown: number;
  readonly soundsBasePath: string;
}

/** Overrides applied on top of the JSON's `global` block. */
export interface ParseOptions {
  globalVoiceLimit?: number;
  defaultCooldown?: number;
  soundsBasePath?: string;
}

/**
 * Turn a raw settings document into resolved events, banks and groups. Pure and total: it never
 * throws on bad input, because a hand-authored JSON typo must surface through {@link
 * validateSettings} as a readable issue rather than as a crash at startup. Unknown values fall
 * back to their defaults and are preserved in `ResolvedEvent.configured` for the validator.
 */
export function parseSettings(
  settings: AudioSettings,
  options: ParseOptions = {},
): ParsedSettings {
  const global = settings.global ?? {};
  const soundsBasePath =
    options.soundsBasePath ?? global.soundsBasePath ?? DEFAULT_SOUNDS_BASE_PATH;
  const defaultCooldown = options.defaultCooldown ?? global.defaultCooldown ?? DEFAULT_COOLDOWN_MS;
  const globalVoiceLimit = Math.max(
    1,
    Math.floor(options.globalVoiceLimit ?? global.globalVoiceLimit ?? DEFAULT_GLOBAL_VOICE_LIMIT),
  );

  const banks = new Map<string, BankConfig>();
  banks.set(DEFAULT_BANK, { id: DEFAULT_BANK, persistent: true });
  for (const bank of settings.banks ?? []) {
    banks.set(bank.id, bank);
  }

  const voiceGroups = new Map<string, VoiceGroupConfig>();
  for (const group of settings.voiceGroups ?? []) {
    voiceGroups.set(group.id, group);
  }

  const events = new Map<string, ResolvedEvent>();
  for (const cfg of settings.events ?? []) {
    // A layerless synth clip cannot be built at all, so it is dropped here and reported by
    // validateSettings — parsing stays total so one bad clip never crashes startup.
    const streams = cfg.stream ?? (cfg.bus ?? 'sfx') === 'music';
    const clips = (cfg.clips ?? [])
      .map((clip) => resolveClip(clip, soundsBasePath, streams))
      .filter((clip): clip is ResolvedClip => clip !== null);
    const sampleKeys = clips.flatMap((clip) => (clip.kind === 'sample' ? [clip.key] : []));
    const streamKeys = clips.flatMap((clip) => (clip.kind === 'stream' ? [clip.key] : []));
    // A synth-only event costs no asset bytes, so it belongs to no bank and is always playable.
    // Giving it the default bank (rather than the declared one) is what makes that true without
    // a special case in the play path.
    const banksForEvent = sampleKeys.length === 0 ? [DEFAULT_BANK] : normalizeIds(cfg.bank, [DEFAULT_BANK]);
    const sharedGroups = normalizeIds(cfg.voiceGroup, []);

    // A bank an event names but never declares is registered implicitly, so a minimal config can
    // omit the `banks` block entirely.
    for (const bank of banksForEvent) {
      if (!banks.has(bank)) {
        banks.set(bank, { id: bank });
      }
    }

    const privateLimit =
      cfg.voiceLimit !== undefined
        ? resolveVoiceLimit(cfg.voiceLimit, 1, globalVoiceLimit)
        : sharedGroups.length === 0
          ? 1
          : globalVoiceLimit;

    events.set(cfg.name, {
      name: cfg.name,
      clips,
      sampleKeys,
      streamKeys,
      banks: banksForEvent,
      volume: cfg.volume ?? 1,
      pitch: cfg.pitch ?? 1,
      clipSelect: resolveClipSelect(cfg),
      fadeInDuration: cfg.fadeInDuration ?? 0,
      fadeOutDuration: cfg.fadeOutDuration ?? 0,
      loop: cfg.loop ?? false,
      chanceToPlay: cfg.chanceToPlay ?? 100,
      bus: cfg.bus ?? 'sfx',
      cooldown: cfg.cooldown ?? defaultCooldown,
      voiceLimit: privateLimit,
      voiceLimitStrategy: cfg.voiceLimitStrategy ?? 'killOldest',
      voiceGroups: sharedGroups,
      configured: cfg,
    });
  }

  return { events, banks, voiceGroups, globalVoiceLimit, defaultCooldown, soundsBasePath };
}

/**
 * Build a {@link ResolvedEvent} from a {@link SoundDefinition} the game constructed in TypeScript,
 * rather than from JSON — the programmatic path behind `registerSoundDefinitions` /
 * `registerSounds`. A variant group becomes a multi-clip event; everything else becomes a
 * single-clip one. The event references no bank (its content is either synthesized or an
 * `AudioBuffer` the game already holds), so it is always playable.
 *
 * Tuning is the default set: monophonic, no fades, no cooldown beyond the global default. A sound
 * that needs a voice group, a cooldown, or a bank belongs in `audioSettings.json`.
 */
export function directEvent(
  name: string,
  definition: SoundDefinition,
  defaults: { cooldown: number; globalVoiceLimit: number },
): ResolvedEvent {
  const playables = definition.kind === 'variants' ? definition.variants : [definition];
  const clips = playables.map(
    (playable): ResolvedClip =>
      playable.kind === 'synth'
        ? { kind: 'synth', definition: playable }
        : { kind: 'buffer', definition: playable },
  );
  const looping = playables.some((playable) => playable.kind === 'sample' && playable.loop);
  return {
    name,
    clips,
    sampleKeys: [],
    streamKeys: [],
    banks: [DEFAULT_BANK],
    volume: 1,
    pitch: 1,
    // The plugin's `random` select mode means "never the same variant twice running", which is
    // exactly `randomNonRepeating`.
    clipSelect:
      definition.kind === 'variants'
        ? definition.select === 'roundRobin'
          ? 'roundRobin'
          : 'randomNonRepeating'
        : 'random',
    fadeInDuration: 0,
    fadeOutDuration: 0,
    loop: looping,
    chanceToPlay: 100,
    bus: 'sfx',
    cooldown: defaults.cooldown,
    voiceLimit: resolveVoiceLimit(undefined, 1, defaults.globalVoiceLimit),
    voiceLimitStrategy: 'killOldest',
    voiceGroups: [],
    configured: { name, clips: [] },
  };
}

/** Resolve a configured limit to a concrete count within the global cap. */
export function resolveVoiceLimit(
  limit: VoiceLimit | undefined,
  fallback: number,
  globalVoiceLimit: number,
): number {
  if (limit === undefined) {
    return fallback;
  }
  if (limit === 'max') {
    return globalVoiceLimit;
  }
  if (typeof limit !== 'number' || !Number.isFinite(limit)) {
    return fallback;
  }
  return Math.max(1, Math.min(Math.floor(limit), globalVoiceLimit));
}

/** Build the {@link SynthDefinition} an inline synth clip describes, filling `tone()`'s defaults. */
export function toSynthDefinition(spec: SynthClipSpec): SynthDefinition {
  const layers = spec.synth.layers.map((layer) => {
    const start = layer.startFreq ?? layer.freq ?? 0;
    const end = layer.endFreq ?? start;
    return tone(layer.type, start, end, layer.decay, {
      peak: layer.peak,
      attackSeconds: layer.attack,
      delaySeconds: layer.delay,
      detune: layer.detune,
    });
  });
  return synth({ layers, gain: spec.synth.gain });
}

/**
 * Extra context {@link validateSettings} needs from outside the pure config: what the game
 * declares as sound ids, and what the byte store knows about clip sizes. All optional — the
 * config-only issues are reported either way.
 */
export interface ValidateContext {
  /**
   * The game's hand-written `SoundId` union, as a list. When given, an event with no matching id
   * (and an id with no matching event) is reported — the drift guard that replaces codegen.
   */
  declaredIds?: readonly string[];
  /**
   * Approximate decoded bytes for a bank's clips, or `null` when they cannot be known yet (nothing
   * decoded, no `pcmBytes` hints). Omit the callback entirely to skip the memory assertions.
   */
  estimateBankBytes?: (bankId: string) => number | null;
  /** The subsystem's decoded-PCM budget, for the `transitionsTo` adjacency check. */
  maxResidentBytes?: number;
  /** Manifest keys the preload actually supplied, to catch a clip nothing loads. */
  availableKeys?: ReadonlySet<string>;
  /**
   * Manifest keys registered with `stream: true`. Cross-checked against the events, because the
   * two declarations have to agree: the manifest decides how the bytes are held, the event decides
   * how they are played, and a mismatch is silent otherwise.
   */
  streamedKeys?: ReadonlySet<string>;
}

/**
 * Report every problem in a parsed config as a human-readable string. Hand-authored JSON is not
 * type-checked, so this is the only thing standing between a typo and a silently wrong mix —
 * a misspelled `voiceLimitStrategy` would otherwise `??` its way to `killOldest`, and an unknown
 * voice group would resolve to *uncapped*, which is the dangerous direction.
 *
 * Call it from a test (the scaffold does) and from a dev overlay. Returns `[]` for a clean config.
 */
export function validateSettings(parsed: ParsedSettings, context: ValidateContext = {}): string[] {
  const issues: string[] = [];

  const checkStrategy = (owner: string, value: unknown): void => {
    if (value !== undefined && !VOICE_LIMIT_STRATEGIES.includes(value as VoiceLimitStrategy)) {
      issues.push(
        `${owner} has voiceLimitStrategy '${String(value)}'; expected one of ` +
          `${VOICE_LIMIT_STRATEGIES.map((s) => `'${s}'`).join(' | ')}.`,
      );
    }
  };

  for (const event of parsed.events.values()) {
    const cfg = event.configured;
    const owner = `Event '${event.name}'`;
    checkStrategy(owner, cfg.voiceLimitStrategy);

    if (event.clips.length === 0) {
      issues.push(`${owner} has no clips.`);
    }
    for (const clip of cfg.clips ?? []) {
      if (typeof clip !== 'string' && (clip.synth?.layers ?? []).length === 0) {
        issues.push(`${owner} has a synth clip with no layers; it was dropped.`);
      }
    }
    if (cfg.clipSelect !== undefined && !CLIP_SELECTS.includes(cfg.clipSelect)) {
      issues.push(
        `${owner} has clipSelect '${String(cfg.clipSelect)}'; expected one of ` +
          `${CLIP_SELECTS.map((s) => `'${s}'`).join(' | ')}.`,
      );
    }
    if (
      cfg.randomNonRepeating !== undefined &&
      cfg.clipSelect !== undefined &&
      (cfg.clipSelect === 'randomNonRepeating') !== cfg.randomNonRepeating
    ) {
      issues.push(
        `${owner} sets clipSelect '${cfg.clipSelect}' and randomNonRepeating ` +
          `${String(cfg.randomNonRepeating)}; they disagree. Prefer clipSelect alone.`,
      );
    }
    if (event.clipSelect !== 'random' && event.clips.length < 2) {
      issues.push(
        `${owner} sets clipSelect '${event.clipSelect}' but has ${event.clips.length} clip(s).`,
      );
    }
    if (event.chanceToPlay < 0 || event.chanceToPlay > 100) {
      issues.push(`${owner} has chanceToPlay outside 0..100.`);
    }
    if (event.sampleKeys.length > 0) {
      for (const bank of event.banks) {
        if (!parsed.banks.has(bank)) {
          issues.push(`${owner} references undeclared bank '${bank}'.`);
        }
      }
    }
    if (cfg.bank !== undefined && event.sampleKeys.length === 0) {
      issues.push(
        `${owner} declares a bank but has no clips a bank can free — synth costs no memory and a ` +
          'streamed clip is never decoded. The bank is ignored; remove it.',
      );
    }
    for (const groupId of event.voiceGroups) {
      if (!parsed.voiceGroups.has(groupId)) {
        issues.push(`${owner} references undeclared voice group '${groupId}'.`);
      }
    }
    const configuredLimit = cfg.voiceLimit;
    if (
      typeof configuredLimit === 'number' &&
      (!Number.isInteger(configuredLimit) || configuredLimit < 1)
    ) {
      issues.push(`${owner} has voiceLimit ${configuredLimit}; expected an integer >= 1 or 'max'.`);
    }
    if (typeof configuredLimit === 'number' && configuredLimit > parsed.globalVoiceLimit) {
      issues.push(
        `${owner} has voiceLimit ${configuredLimit} above the global limit ` +
          `${parsed.globalVoiceLimit}; it will be clamped.`,
      );
    }
    if (event.loop && event.voiceLimit > 1 && event.voiceGroups.length === 0) {
      issues.push(
        `${owner} loops with voiceLimit ${event.voiceLimit}; stacked copies of one loop will ` +
          'comb-filter.',
      );
    }
    if (context.availableKeys) {
      for (const key of [...event.sampleKeys, ...event.streamKeys]) {
        if (!context.availableKeys.has(key)) {
          issues.push(
            `${owner} references clip '${key}', which no preload-manifest entry supplies. Add ` +
              "an { type: 'audio', bank: … } entry for it.",
          );
        }
      }
    }
    if (context.streamedKeys) {
      for (const key of event.streamKeys) {
        if (!context.streamedKeys.has(key)) {
          issues.push(
            `${owner} streams clip '${key}', but its manifest entry does not set stream: true, ` +
              'so its bytes are held for decoding instead.',
          );
        }
      }
      for (const key of event.sampleKeys) {
        if (context.streamedKeys.has(key)) {
          issues.push(
            `${owner} decodes clip '${key}', but its manifest entry sets stream: true, so no bank ` +
              'holds it and the event will be silent.',
          );
        }
      }
    }
  }

  for (const [id, group] of parsed.voiceGroups) {
    checkStrategy(`Voice group '${id}'`, group.voiceLimitStrategy);
    if (id.startsWith(EVENT_GROUP_PREFIX)) {
      issues.push(`Voice group '${id}' uses the reserved '${EVENT_GROUP_PREFIX}' prefix.`);
    }
    const limit = group.voiceLimit;
    if (typeof limit === 'number' && (!Number.isInteger(limit) || limit < 1)) {
      issues.push(`Voice group '${id}' has voiceLimit ${limit}; expected an integer >= 1.`);
    }
    if (typeof limit === 'number' && limit > parsed.globalVoiceLimit) {
      issues.push(
        `Voice group '${id}' has voiceLimit ${limit} above the global limit ` +
          `${parsed.globalVoiceLimit}; it will be clamped.`,
      );
    }
  }

  issues.push(...validateBankAdjacency(parsed, context));
  issues.push(...validateDeclaredIds(parsed, context.declaredIds));
  return issues;
}

/**
 * Fail a declared bank transition whose two banks cannot both be resident. This is the
 * authoring-time counterpart to the runtime overlap refusal: an `'overlapped'` swap holds the
 * outgoing and incoming banks at once, so `A + B` has to fit under the budget.
 */
function validateBankAdjacency(parsed: ParsedSettings, context: ValidateContext): string[] {
  const { estimateBankBytes, maxResidentBytes } = context;
  if (!estimateBankBytes || maxResidentBytes === undefined) {
    return [];
  }
  const issues: string[] = [];
  for (const bank of parsed.banks.values()) {
    for (const target of bank.transitionsTo ?? []) {
      if (!parsed.banks.has(target)) {
        issues.push(`Bank '${bank.id}' declares transitionsTo '${target}', which is not a bank.`);
        continue;
      }
      const from = estimateBankBytes(bank.id);
      const to = estimateBankBytes(target);
      if (from === null || to === null) {
        // Reported rather than skipped: declaring `transitionsTo` is asking for this assertion, so
        // silently not running it would be the vacuous pass the flag exists to prevent.
        issues.push(
          `Banks '${bank.id}' -> '${target}' cannot be checked against the ${mb(maxResidentBytes)} ` +
            'MB budget: some of their clips have no pcmBytes hint and have never been decoded. Add ' +
            'the hints, or drop transitionsTo and accept a sequential swap.',
        );
        continue;
      }
      const combined = from + to;
      if (combined > maxResidentBytes) {
        issues.push(
          `Banks '${bank.id}' -> '${target}' need ~${mb(combined)} MB resident together, over the ` +
            `${mb(maxResidentBytes)} MB budget. An overlapped swap between them will fall back to ` +
            'sequential.',
        );
      }
    }
  }
  return issues;
}

/**
 * Cross-check the event names against the game's hand-written `SoundId` union. This is what keeps
 * `play()` compile-checked without a codegen step: the union is authored by hand, and drift in
 * either direction is caught here (the scaffold asserts on it in `audioSettings.test.ts`).
 */
function validateDeclaredIds(
  parsed: ParsedSettings,
  declaredIds: readonly string[] | undefined,
): string[] {
  if (!declaredIds) {
    return [];
  }
  const issues: string[] = [];
  const declared = new Set(declaredIds);
  for (const name of parsed.events.keys()) {
    if (!declared.has(name)) {
      issues.push(`Event '${name}' is missing from the SoundId union in src/audio/soundIds.ts.`);
    }
  }
  for (const id of declared) {
    if (!parsed.events.has(id)) {
      issues.push(`SoundId '${id}' has no event in audioSettings.json.`);
    }
  }
  return issues;
}

/** `'a'` / `['a','b']` / `undefined` -> a de-duplicated id list. */
function normalizeIds(value: string | string[] | undefined, fallback: string[]): string[] {
  if (value === undefined) {
    return [...fallback];
  }
  return [...new Set(Array.isArray(value) ? value : [value])];
}

/** `clipSelect` wins; `randomNonRepeating: true` is the native-AMP spelling of one of its values. */
function resolveClipSelect(cfg: AudioEventConfig): ClipSelect {
  if (cfg.clipSelect !== undefined && CLIP_SELECTS.includes(cfg.clipSelect)) {
    return cfg.clipSelect;
  }
  return cfg.randomNonRepeating ? 'randomNonRepeating' : 'random';
}

/** `null` for a synth clip with no layers — there is nothing to build. `validate()` reports it. */
function resolveClip(clip: ClipSpec, soundsBasePath: string, streams: boolean): ResolvedClip | null {
  if (typeof clip === 'string') {
    const key = soundsBasePath + clip;
    return streams ? { kind: 'stream', key } : { kind: 'sample', key };
  }
  if (!clip.synth || (clip.synth.layers ?? []).length === 0) {
    return null;
  }
  return { kind: 'synth', definition: toSynthDefinition(clip) };
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
