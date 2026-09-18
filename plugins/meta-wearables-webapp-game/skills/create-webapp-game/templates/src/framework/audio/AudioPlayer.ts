/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * The gameplay-facing audio contract. All gameplay code plays sound ONLY through this interface and
 * never touches the Web Audio API directly — the implementation lives in `AmpAudioPlayer.ts` (event
 * and bank logic) over `AudioEngine.ts` (the only Web Audio file). This mirrors the `Renderer` /
 * `InputManager` split: the backend stays swappable and gameplay stays unit-testable (the
 * `FakeAudioPlayer` in `src/framework/testing/fakes.ts` records `play` calls with no real
 * `AudioContext`). Types here are framework-free — positions use the project `Vector3`, handles are
 * opaque — except the `createVoice` / `getContext` escape hatch, which deliberately exposes raw Web
 * Audio nodes so a game can synthesize its own sound.
 *
 * The contract is generic over the game's sound-id union (`TSoundId`), exactly like
 * `Renderer<TModelId>`. The ids come from `src/audio/soundIds.ts`, a small hand-written union kept
 * beside the designer-owned `src/audio/audioSettings.json`; the framework cross-checks the two
 * (see `validate`) so drift fails a test rather than a `play()` call. That is what buys a
 * compile-checked `play('lazer')` error with no codegen step.
 *
 * ## Where sound is declared
 *
 * `src/audio/audioSettings.json` is the source of truth: named **events**, each owning one or more
 * **clips** (a sample filename, or an inline synth stack), plus tuning — volume, pitch, fades,
 * loop, `chanceToPlay`, retrigger `cooldown`, mixer `bus`, and the voice-concurrency model
 * (`voiceLimit`, `voiceLimitStrategy`, shared `voiceGroup` budgets). A sound designer edits that
 * file without touching TypeScript. See `docs/audio.md`.
 *
 * ## Memory
 *
 * Sample bytes arrive through the preload manifest before the game loop starts — **nothing is
 * fetched at runtime**. A **bank** is a memory group over those bytes: `loadBank` *decodes* its
 * clips into PCM and `unloadBank` *frees* that PCM, keeping the compressed bytes. Decoded audio is
 * roughly 30x the size of the Ogg it came from, so decoded PCM is the resource worth managing —
 * see `docs/audio-banks.md`.
 */

import type { AudioBus, AudioEventConfig } from '@/framework/audio/audioSettings';
import type { SoundDefinition } from '@/framework/audio/soundDefinitions';
import type { Vector3 } from '@/framework/math/Vector3';

export type { AudioBus };

/** Opaque reference to a playing (or scheduled) voice. The brand makes it distinct from a number. */
export type SoundHandle = number & { readonly __brand: 'SoundHandle' };

/** How `swapBanks` sequences the unload and the load. See {@link AudioPlayer.swapBanks}. */
export type BankSwapMode = 'sequential' | 'overlapped';

/** Per-play overrides. All optional; an unset field falls back to the event's own tuning. */
export interface PlayOptions {
  /** Override the event's bus. */
  bus?: AudioBus;
  /** Override the event's linear gain `0..1`. */
  volume?: number;
  /** Override the event's playback rate — also pitches a sample up/down. */
  rate?: number;
  /** Fine pitch offset in cents, on top of `rate`. Default `0`. */
  detune?: number;
  /** Override the event's `loop`. */
  loop?: boolean;
  /**
   * World position. When present the voice is spatialized (stereo-panned + distance-attenuated)
   * relative to the listener (see {@link AudioPlayer.setListener}); when absent it plays centered
   * (UI and listener-centric sounds).
   */
  position?: Vector3;
  /** Bypass the retrigger `cooldown` for this call (e.g. a deliberate rapid-fire burst). */
  ignoreCooldown?: boolean;
}

/**
 * A routed, bus-connected (and, with a `position`, spatialized) input node for CUSTOM sources —
 * the custom-graph escape hatch. Connect your own source node(s) to `input`, start them yourself,
 * then drive the voice with the returned `handle` (`setPosition` / `setVolume` / `stop`).
 */
export interface CustomVoice {
  /** The framework node to connect your source(s) into (already routed to a bus + master). */
  input: AudioNode;
  /** Handle for `setPosition` / `setVolume` / `stop` on this voice. */
  handle: SoundHandle;
}

/** Options for {@link AudioPlayer.init}. Anything set here overrides the JSON's `global` block. */
export interface AudioInitOptions {
  /** Hard polyphony cap, clamped to the engine's preallocated strip count. */
  globalVoiceLimit?: number;
  /** Default per-event retrigger guard in ms. */
  defaultCooldown?: number;
  /** Prefix joined to every sample filename to form its preload-manifest key. */
  soundsBasePath?: string;
  /** Decode these banks during `init()`. The default bank and `persistent` banks always load. */
  initialBanks?: string[];
}

export interface AudioPlayer<TSoundId extends string = string> {
  // ---- Lifecycle ---------------------------------------------------------

  /**
   * Parse the settings the player was constructed with, then decode the default bank plus every
   * `persistent` bank and any `initialBanks`. Resolves once those banks are resident. Safe to call
   * once; later calls no-op. Every method below is a cheap no-op before `init` and when Web Audio
   * is unavailable — a game never has to branch on it.
   */
  init(options?: AudioInitOptions): Promise<void>;

  /**
   * Resume/unlock the audio backend after a user gesture. Browsers start the `AudioContext`
   * suspended until the first interaction; call this from the first input event (e.g. `pinchTap`)
   * so subsequent `play` calls are audible.
   */
  resume(): void;

  /** Suspend the backend to save battery (e.g. when the app is backgrounded). */
  suspend(): void;

  /** Stop everything, free all decoded PCM, and close the backend. */
  destroy(): Promise<void>;

  // ---- Declaring sounds --------------------------------------------------

  /**
   * Merge extra events into the config at runtime — the programmatic escape hatch for sounds a
   * designer cannot author ahead of time (procedural content, a debug tool). `audioSettings.json`
   * remains the source of truth; an event registered here under an existing name replaces it.
   */
  registerEvents(events: readonly AudioEventConfig[]): void;

  /**
   * Register full sound definitions — synth, sample, or variant groups — by id, as single-clip
   * events with default tuning. Sugar over {@link AudioPlayer.registerEvents} for a sound built in
   * TypeScript with the `soundDefinitions.ts` builders rather than declared in JSON.
   */
  registerSoundDefinitions(defs: Partial<Record<TSoundId, SoundDefinition>>): void;

  /**
   * Convenience for "just play this `AudioBuffer` I decoded myself": registers each as a default
   * single-clip sample event. Most games do not need it — sample clips normally come from the
   * preload manifest and a bank. Sugar over {@link AudioPlayer.registerSoundDefinitions}.
   */
  registerSounds(buffers: Partial<Record<TSoundId, AudioBuffer>>): void;

  // ---- Playing -----------------------------------------------------------

  /**
   * Fire an audio event, spatialized when `options.position` is set. Returns a handle (for `stop` /
   * `setVolume` / `setPosition`), or `null` when the play was skipped — unknown event, retrigger
   * cooldown, a `chanceToPlay` roll, muted, bank not loaded, or a `preventNew` voice group at its
   * limit. Never throws: audio must not be able to break gameplay.
   */
  play(sound: TSoundId, options?: PlayOptions): SoundHandle | null;

  /** Stop one voice now and release its nodes. Safe to call on an already-finished handle. */
  stop(handle: SoundHandle): void;

  /**
   * Stop every instance of an event, honouring its `fadeOutDuration` unless overridden. Works for
   * one-shots as well as loops. Events sharing a voice group are unaffected — only this event's own
   * voices stop.
   */
  stopSound(sound: TSoundId, fadeMs?: number): void;

  /** Stop every active voice. */
  stopAll(fadeMs?: number): void;

  /** Set a live voice's linear gain (`0..1`). No-op on a finished handle. */
  setVolume(handle: SoundHandle, volume: number): void;

  /**
   * Update a live voice's world position — for moving or looping spatialized sources. Recomputes
   * its pan and distance attenuation. No-op on a non-spatial or finished handle.
   */
  setPosition(handle: SoundHandle, position: Vector3): void;

  /**
   * Set the listener's world position — the reference point spatialized voices are panned and
   * attenuated against. For a fixed-camera game, call once; recomputes all active spatial voices.
   */
  setListener(position: Vector3): void;

  // ---- Mix ---------------------------------------------------------------

  /** Set a bus's (or the master's) linear volume (`0..1`). */
  setBusVolume(bus: AudioBus | 'master', volume: number): void;

  /** Mute or unmute the master bus. */
  setMuted(muted: boolean): void;

  /** Toggle master mute, returning the new muted state. */
  toggleMute(): boolean;

  /** Whether the master bus is currently muted. */
  isMuted(): boolean;

  // ---- Banks -------------------------------------------------------------

  /**
   * Decode every sample clip the bank's events reference. Idempotent. Nothing is fetched — the
   * bytes are already in memory from the preload manifest — so this costs a decode, not a round
   * trip. Refuses (with a warning, not an exception) when it would take resident PCM over
   * {@link AudioPlayer.maxResidentBytes}.
   */
  loadBank(bankId: string): Promise<void>;

  /** Decode several banks in parallel. */
  loadBanks(bankIds: readonly string[]): Promise<void>;

  /**
   * Free the bank's decoded PCM. A clip another loaded bank also references is kept, so unloading
   * `level_1` will not silence a clip `shared` uses. The default bank cannot be unloaded. Voices
   * whose backing clips are freed are stopped.
   */
  unloadBank(bankId: string): void;

  /**
   * Level-transition convenience: unload everything outside `keep` plus `load`, then load `load`.
   *
   * `'sequential'` (**default, safe**) unloads first, so peak residency is `max(outgoing, incoming)`
   * — at the cost of a gap at the switch. `'overlapped'` decodes the incoming banks while the
   * outgoing ones are still playing, hiding the gap, but peaks at `outgoing + incoming`; when that
   * would exceed {@link AudioPlayer.maxResidentBytes} it **falls back to sequential with a
   * warning** rather than risking an out-of-memory kill of the WebView.
   */
  swapBanks(keep: readonly string[], load: readonly string[], mode?: BankSwapMode): Promise<void>;

  /** Banks whose clips are currently decoded. */
  readonly loadedBanks: string[];

  /** Approximate decoded bytes this bank would cost, from `pcmBytes` hints and measured sizes. */
  estimateBankBytes(bankId: string): number;

  // ---- Memory ------------------------------------------------------------

  /** Decoded PCM currently resident, in bytes. Surfaced by the `?stats` overlay. */
  readonly residentBytes: number;

  /** The decoded-PCM budget for the whole subsystem (`AUDIO.maxResidentBytes`). */
  readonly maxResidentBytes: number;

  // ---- Concurrency / introspection ---------------------------------------

  /** True when any instance of the event is sounding. Fading tails do not count. */
  isPlaying(sound: TSoundId): boolean;

  /** Live instances of one event right now. */
  activeVoices(sound: TSoundId): number;

  /** Live voices in a shared voice group right now. */
  voiceGroupCount(groupId: string): number;

  /** Total live voices across every event, fading tails included. */
  readonly activeVoiceCount: number;

  /**
   * The hard polyphony cap. Settable at runtime for on-device profiling: lower it under a burst
   * until voice stealing becomes audible. Clamped to the engine's preallocated strip count.
   */
  globalVoiceLimit: number;

  // ---- Dev ---------------------------------------------------------------

  /**
   * Every problem in the loaded config, as readable strings — empty clips, undeclared banks or
   * voice groups, a misspelled `voiceLimitStrategy`, out-of-range `chanceToPlay`, stacked loops
   * that will comb-filter, missing or stale `pcmBytes` hints, a declared bank transition that
   * cannot fit in the budget, and any drift between the events and the `SoundId` union. Hand-
   * authored JSON is not type-checked, so this is what stands between a typo and a silently wrong
   * mix. Call it from a test (the scaffold does) and from a dev overlay.
   */
  validate(): string[];

  /**
   * Escape hatch for a fully custom audio graph beyond the event format (a live-modulated engine
   * drone, a custom `PannerNode`, an `AudioWorklet`). Returns a routed input node (already
   * connected to the chosen bus + master, and spatialized when `options.position` is set) plus a
   * handle from the same voice pool as `play`. `null` if the pool is full or audio is unavailable.
   *
   * You OWN cleanup: unlike `play`, a custom voice has no framework source to watch, so it never
   * auto-releases — it holds a slot against the voice cap until you call `stop(handle)` (typically
   * from your source's `onended`). You must also `disconnect()` your source(s) from `input`, or a
   * still-connected node re-mixes into the next play that reuses the slot.
   */
  createVoice(options?: PlayOptions): CustomVoice | null;

  /**
   * The live `AudioContext`, for advanced synthesis that needs to build its own nodes. `null` on a
   * fake / when unavailable. It does NOT construct a context: the context is created lazily by the
   * first `play` / `createVoice` / `resume`, so this returns `null` until then. When building your
   * own nodes, call `createVoice` FIRST (it forces lazy init) and then `getContext`.
   */
  getContext(): AudioContext | null;
}
