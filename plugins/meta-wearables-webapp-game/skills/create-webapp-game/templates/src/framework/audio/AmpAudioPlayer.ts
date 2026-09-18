/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * AmpAudioPlayer — the config + policy layer, and the implementation of {@link AudioPlayer}.
 *
 * This owns every "sound designer" concern: named events, clip pools with round-robin / random /
 * random-without-repeat selection, per-event volume, pitch, fades and looping, probabilistic
 * playback, retrigger cooldown, and the bank load/unload lifecycle. It performs **no Web Audio
 * calls** — every playback request is delegated to `AudioEngine` and every byte to `BankStore` —
 * which is what lets the whole thing unit-test in plain Node with no `AudioContext` mock.
 *
 * Concept model (FMOD's Event/Bank split, simplified for mobile-scale games):
 *
 *   Event — a named trigger the game fires (`play('Player_Jump')`). Owns one or more clips plus
 *           the tuning that decides how they play.
 *   Bank  — a memory group over the *decoded* PCM of sample clips. Events declare which bank(s)
 *           they belong to, so one event can belong to several and a bank is a query over events
 *           rather than a container that owns them.
 *   Bus   — `sfx` or `music`, each with its own volume under a master.
 *
 * Usage (see `src/main.ts`):
 *
 *   const audio = new AmpAudioPlayer<SoundId>(settings, AUDIO);
 *   // …preload manifest hands sample bytes to audio.storeClip()…
 *   await audio.init({ initialBanks: ['level_1'] });
 *   audio.play('UI_Click');
 *
 * Every public method is a safe no-op before `init()` and when Web Audio is unavailable, and
 * `play()` never throws: audio must not be able to break gameplay.
 */

import type {
  AudioBus,
  AudioInitOptions,
  AudioPlayer,
  BankSwapMode,
  CustomVoice,
  PlayOptions,
  SoundHandle,
} from '@/framework/audio/AudioPlayer';
import {
  DEFAULT_BANK,
  directEvent,
  eventVoiceGroupId,
  parseSettings,
  validateSettings,
  type AudioEventConfig,
  type AudioSettings,
  type BankConfig,
  type ParsedSettings,
  type ResolvedClip,
  type ResolvedEvent,
  type VoiceGroupConfig,
} from '@/framework/audio/audioSettings';
import { AudioEngine, type AudioEngineOptions, type EnginePlayParams } from '@/framework/audio/AudioEngine';
import { BankStore, type PutOptions } from '@/framework/audio/BankStore';
import { sample, type SoundDefinition } from '@/framework/audio/soundDefinitions';
import type { VoiceConstraint } from '@/framework/audio/VoicePool';
import type { Vector3 } from '@/framework/math/Vector3';

/** Tunables from the game's `AUDIO` config block. Extends the engine's with the PCM budget. */
export interface AmpAudioPlayerOptions extends AudioEngineOptions {
  /** Decoded-PCM budget for the whole subsystem, in bytes. Default 24 MB. */
  maxResidentBytes?: number;
  /** Start muted. The `?mute` query flag also forces this — see `muteRequested`. */
  mutedByDefault?: boolean;
}

/** 24 MB of decoded PCM — roughly 65 seconds of stereo 48 kHz audio resident at once. */
const DEFAULT_MAX_RESIDENT_BYTES = 24 * 1024 * 1024;

/** Fade (ms) applied when muting, so the cut is not a click. */
const MUTE_FADE_MS = 60;

/** Per-event mutable playback state, kept out of the immutable {@link ResolvedEvent}. */
interface EventState {
  lastClipIndex: number;
  lastPlayedAt: number;
}

export class AmpAudioPlayer<TSoundId extends string = string> implements AudioPlayer<TSoundId> {
  private readonly engine: AudioEngine;
  private readonly banks: BankStore;

  private parsed: ParsedSettings | null = null;
  /** Resolved events, JSON-declared and programmatically registered alike. */
  private readonly events = new Map<string, ResolvedEvent>();
  private readonly state = new Map<string, EventState>();
  private readonly bankConfigs = new Map<string, BankConfig>();
  private readonly voiceGroups = new Map<string, VoiceGroupConfig>();
  private readonly loaded = new Set<string>();

  private defaultCooldown = 0;
  private muted: boolean;
  private initialized = false;
  /** RNG for clip selection and `chanceToPlay`; overridable so tests are deterministic. */
  private random: () => number = Math.random;

  public constructor(
    private readonly settings: AudioSettings,
    options: AmpAudioPlayerOptions = {},
  ) {
    this.engine = new AudioEngine(options);
    this.banks = new BankStore(
      (bytes) => this.engine.decodeBytes(bytes),
      options.maxResidentBytes ?? DEFAULT_MAX_RESIDENT_BYTES,
    );
    this.muted = options.mutedByDefault ?? false;
    if (this.muted) {
      this.engine.setMuted(true);
    }
  }

  // ---- Lifecycle -----------------------------------------------------------

  public async init(options: AudioInitOptions = {}): Promise<void> {
    if (this.initialized) {
      return;
    }
    this.initialized = true;

    const parsed = parseSettings(this.settings, {
      globalVoiceLimit: options.globalVoiceLimit,
      defaultCooldown: options.defaultCooldown,
      soundsBasePath: options.soundsBasePath,
    });
    this.parsed = parsed;
    this.defaultCooldown = parsed.defaultCooldown;
    this.engine.globalVoiceLimit = parsed.globalVoiceLimit;

    for (const [id, bank] of parsed.banks) {
      this.bankConfigs.set(id, bank);
    }
    for (const [id, group] of parsed.voiceGroups) {
      this.voiceGroups.set(id, group);
    }
    for (const event of parsed.events.values()) {
      this.addEvent(event);
    }

    if (!this.engine.ready) {
      // No Web Audio. Events are still resolved so validate() and the dev overlay work; every
      // play() is a cheap no-op from here.
      return;
    }

    const toLoad = new Set<string>([DEFAULT_BANK, ...(options.initialBanks ?? [])]);
    for (const bank of this.bankConfigs.values()) {
      if (bank.persistent) {
        toLoad.add(bank.id);
      }
    }
    await this.loadBanks([...toLoad]);
  }

  public resume(): void {
    this.engine.resume();
  }

  public suspend(): void {
    this.engine.suspend();
  }

  public async destroy(): Promise<void> {
    this.loaded.clear();
    this.events.clear();
    this.state.clear();
    this.bankConfigs.clear();
    this.voiceGroups.clear();
    this.banks.clear();
    await this.engine.close();
    this.initialized = false;
  }

  /**
   * Hand this player a clip's compressed bytes. Called by `preloadManifest` for every
   * `{ type: 'audio' }` entry that declares a `bank` or `stream` — **not** on the
   * {@link AudioPlayer} contract, because a game never calls it directly.
   */
  public storeClip(key: string, blob: Blob, options: PutOptions = {}): void {
    this.banks.put(key, blob, options);
  }

  /**
   * Decode compressed bytes to an `AudioBuffer` on this player's context, so sample rates match the
   * graph. Off-contract like {@link storeClip}: `preloadManifest` uses it for bank-less
   * `{ type: 'audio' }` entries, which decode eagerly during preload as they always have.
   */
  public decode(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
    return this.engine.decodeBytes(bytes);
  }

  /** Replace the RNG behind clip selection and `chanceToPlay`. For deterministic tests. */
  public setRandom(random: () => number): void {
    this.random = random;
  }

  // ---- Declaring sounds ----------------------------------------------------

  public registerEvents(events: readonly AudioEventConfig[]): void {
    if (!this.parsed) {
      console.warn('[audio] registerEvents() before init(); the events were ignored.');
      return;
    }
    // Re-parse against the live globals so a runtime event resolves its defaults exactly as a
    // JSON-declared one would.
    const parsed = parseSettings(
      { global: this.settings.global, banks: this.settings.banks, voiceGroups: this.settings.voiceGroups, events: [...events] },
      {
        globalVoiceLimit: this.parsed.globalVoiceLimit,
        defaultCooldown: this.parsed.defaultCooldown,
        soundsBasePath: this.parsed.soundsBasePath,
      },
    );
    for (const [id, bank] of parsed.banks) {
      if (!this.bankConfigs.has(id)) {
        this.bankConfigs.set(id, bank);
      }
    }
    for (const event of parsed.events.values()) {
      this.addEvent(event);
    }
  }

  public registerSoundDefinitions(defs: Partial<Record<TSoundId, SoundDefinition>>): void {
    for (const [id, definition] of Object.entries(defs) as [TSoundId, SoundDefinition][]) {
      if (definition) {
        this.addEvent(
          directEvent(id, definition, {
            cooldown: this.defaultCooldown,
            globalVoiceLimit: this.engine.globalVoiceLimit,
          }),
        );
      }
    }
  }

  public registerSounds(buffers: Partial<Record<TSoundId, AudioBuffer>>): void {
    const defs: Partial<Record<TSoundId, SoundDefinition>> = {};
    for (const [id, buffer] of Object.entries(buffers) as [TSoundId, AudioBuffer][]) {
      if (buffer) {
        defs[id] = sample(buffer);
      }
    }
    this.registerSoundDefinitions(defs);
  }

  // ---- Playing -------------------------------------------------------------

  public play(sound: TSoundId, options: PlayOptions = {}): SoundHandle | null {
    if (!this.initialized || this.muted) {
      return null;
    }
    const event = this.events.get(sound);
    if (!event) {
      console.warn(`[audio] Unknown sound '${sound}'.`);
      return null;
    }
    if (event.clips.length === 0) {
      return null;
    }
    if (!this.isEventLoaded(event)) {
      console.warn(
        `[audio] '${sound}' skipped: bank(s) [${event.banks.join(', ')}] not loaded. Call ` +
          'loadBank() during a loading screen — see docs/audio-banks.md.',
      );
      return null;
    }

    const state = this.stateFor(sound);
    const now = performance.now();
    if (!options.ignoreCooldown && now - state.lastPlayedAt < event.cooldown) {
      return null;
    }
    if (event.chanceToPlay < 100 && this.random() * 100 > event.chanceToPlay) {
      return null;
    }

    const loop = options.loop ?? event.loop;
    if (loop) {
      // Retriggering a loop crossfades rather than cutting. Marking the outgoing voice as fading
      // drops it from the concurrency count straight away, so the incoming one is admitted even at
      // a limit of 1.
      this.engine.stopVoiceGroup(eventVoiceGroupId(event.name), event.fadeOutDuration);
    }
    this.engine.resume();

    // Resolve the clip only once the gates are passed: resolving advances the round-robin/random
    // state, and a dropped play must not consume a rotation slot.
    const priorIndex = state.lastClipIndex;
    const clip = this.selectClip(event, state);
    const params = this.playParams(event, options, loop);
    const handle = this.startClip(clip, params);
    if (handle === null) {
      state.lastClipIndex = priorIndex;
      return null;
    }
    state.lastPlayedAt = now;
    return handle;
  }

  public stop(handle: SoundHandle): void {
    this.engine.stop(handle, 0);
  }

  public stopSound(sound: TSoundId, fadeMs?: number): void {
    const event = this.events.get(sound);
    this.engine.stopVoiceGroup(eventVoiceGroupId(sound), fadeMs ?? event?.fadeOutDuration ?? 0);
  }

  public stopAll(fadeMs = 0): void {
    this.engine.stopAll(fadeMs);
  }

  public setVolume(handle: SoundHandle, volume: number): void {
    this.engine.setVoiceVolume(handle, volume);
  }

  public setPosition(handle: SoundHandle, position: Vector3): void {
    this.engine.setVoicePosition(handle, position);
  }

  public setListener(position: Vector3): void {
    this.engine.setListener(position);
  }

  // ---- Mix -----------------------------------------------------------------

  public setBusVolume(bus: AudioBus | 'master', volume: number): void {
    if (bus === 'master') {
      this.engine.setMasterVolume(volume);
    } else {
      this.engine.setBusVolume(bus, volume);
    }
  }

  public setMuted(muted: boolean): void {
    if (this.muted === muted) {
      return;
    }
    this.muted = muted;
    this.engine.setMuted(muted);
    if (muted) {
      // Gate new plays AND fade out anything already sounding, so mute is immediate rather than
      // "no new sounds, but the ambience keeps going".
      this.engine.stopAll(MUTE_FADE_MS);
    }
  }

  public toggleMute(): boolean {
    this.setMuted(!this.muted);
    return this.muted;
  }

  public isMuted(): boolean {
    return this.muted;
  }

  // ---- Banks ---------------------------------------------------------------

  public async loadBank(bankId: string): Promise<void> {
    await this.loadBanks([bankId]);
  }

  public async loadBanks(bankIds: readonly string[]): Promise<void> {
    if (!this.engine.ready) {
      return;
    }
    const keys = new Set<string>();
    for (const bankId of bankIds) {
      if (!this.bankConfigs.has(bankId)) {
        console.warn(`[audio] Unknown bank '${bankId}'.`);
        continue;
      }
      this.loaded.add(bankId);
      for (const key of this.keysForBank(bankId)) {
        keys.add(key);
      }
    }
    await this.banks.decodeKeys([...keys]);
  }

  public unloadBank(bankId: string): void {
    if (bankId === DEFAULT_BANK) {
      console.warn('[audio] The default bank cannot be unloaded.');
      return;
    }
    if (this.isPersistent(bankId)) {
      console.warn(`[audio] Bank '${bankId}' is persistent and cannot be unloaded.`);
      return;
    }
    if (!this.loaded.has(bankId)) {
      return;
    }
    this.loaded.delete(bankId);

    // Silence anything still sounding whose backing clips are about to be freed.
    for (const event of this.events.values()) {
      if (!this.isEventLoaded(event)) {
        this.engine.stopVoiceGroup(eventVoiceGroupId(event.name), event.fadeOutDuration);
      }
    }

    // Set difference computed fresh, so a clip a still-loaded bank also references survives. No
    // reference counting to get wrong.
    const keep = new Set<string>();
    for (const loaded of this.loaded) {
      for (const key of this.keysForBank(loaded)) {
        keep.add(key);
      }
    }
    this.banks.release(this.keysForBank(bankId).filter((key) => !keep.has(key)));
  }

  public async swapBanks(
    keep: readonly string[],
    load: readonly string[],
    mode: BankSwapMode = 'sequential',
  ): Promise<void> {
    const keepSet = new Set([DEFAULT_BANK, ...keep, ...load]);
    // A persistent bank is never swept out, whether or not the caller names it in `keep` — that is
    // what the flag means. Silent rather than warned, because sweeping is the expected path.
    const outgoing = [...this.loaded].filter(
      (bank) => !keepSet.has(bank) && !this.isPersistent(bank),
    );

    let overlapped = mode === 'overlapped';
    if (overlapped) {
      // An overlapped swap holds both sets at once. Refusing here — rather than discovering it via
      // an out-of-memory kill of the WebView — is the whole point of the budget.
      //
      // An unknown cost is refused too. A clip that has never been decoded and carries no pcmBytes
      // hint contributes 0 to the estimate, so trusting the number here would wave through exactly
      // the case the check exists for: the first swap into a bank nothing has measured yet.
      const unknown = load.some((bank) => this.banks.hasUnknownSize(this.keysForBank(bank)));
      const projected =
        this.residentBytes + load.reduce((sum, bank) => sum + this.estimateBankBytes(bank), 0);
      if (unknown) {
        console.warn(
          `[audio] Overlapped swap into [${load.join(', ')}] cannot be costed: some clips have no ` +
            'pcmBytes hint and have never been decoded. Falling back to a sequential swap. Add ' +
            'pcmBytes to their manifest entries, or ignore this — the next swap can use the sizes ' +
            'measured on this decode.',
        );
        overlapped = false;
      } else if (projected > this.maxResidentBytes) {
        console.warn(
          `[audio] Overlapped swap would peak at ~${mb(projected)} MB, over the ` +
            `${mb(this.maxResidentBytes)} MB budget; falling back to a sequential swap (expect a ` +
            'gap at the switch). Shrink a bank or raise AUDIO.maxResidentBytes.',
        );
        overlapped = false;
      }
    }

    if (overlapped) {
      await this.loadBanks(load);
      for (const bank of outgoing) {
        this.unloadBank(bank);
      }
      return;
    }
    for (const bank of outgoing) {
      this.unloadBank(bank);
    }
    await this.loadBanks(load);
  }

  public get loadedBanks(): string[] {
    return [...this.loaded];
  }

  public estimateBankBytes(bankId: string): number {
    return this.banks.estimateBytes(this.keysForBank(bankId));
  }

  /** Every declared bank id, loaded or not. For dev overlays and tests. */
  public get bankIds(): string[] {
    return [...this.bankConfigs.keys()];
  }

  // ---- Memory --------------------------------------------------------------

  public get residentBytes(): number {
    return this.banks.residentBytes;
  }

  public get maxResidentBytes(): number {
    return this.banks.maxResidentBytes;
  }

  // ---- Concurrency / introspection ----------------------------------------

  public isPlaying(sound: TSoundId): boolean {
    return this.engine.voiceGroupCount(eventVoiceGroupId(sound)) > 0;
  }

  public activeVoices(sound: TSoundId): number {
    return this.engine.voiceGroupCount(eventVoiceGroupId(sound));
  }

  public voiceGroupCount(groupId: string): number {
    return this.engine.voiceGroupCount(groupId);
  }

  public get activeVoiceCount(): number {
    return this.engine.activeVoiceCount;
  }

  public get globalVoiceLimit(): number {
    return this.engine.globalVoiceLimit;
  }

  public set globalVoiceLimit(value: number) {
    this.engine.globalVoiceLimit = value;
  }

  /** Every event name, for dev overlays and a future JSON editor. */
  public get soundIds(): string[] {
    return [...this.events.keys()];
  }

  /** Read-only view of an event's resolved tuning. */
  public describeEvent(sound: string): Readonly<ResolvedEvent> | undefined {
    return this.events.get(sound);
  }

  /** Declared shared voice groups, for dev overlays. */
  public get voiceGroupIds(): string[] {
    return [...this.voiceGroups.keys()];
  }

  public describeVoiceGroup(groupId: string): Readonly<VoiceGroupConfig> | undefined {
    return this.voiceGroups.get(groupId);
  }

  // ---- Dev -----------------------------------------------------------------

  /**
   * Config problems, as readable strings. Combines the pure schema checks in `audioSettings.ts`
   * with the ones that need the byte store: missing or stale `pcmBytes` hints, and declared bank
   * transitions that cannot both fit in the budget.
   *
   * `declaredIds` cross-checks the events against the game's hand-written `SoundId` union — pass
   * it from a test (the scaffold does) so adding an event to the JSON without adding it to
   * `src/audio/soundIds.ts` fails there rather than at play time.
   */
  public validate(declaredIds?: readonly string[]): string[] {
    if (!this.parsed) {
      return ['Audio settings have not been parsed yet; call init() first.'];
    }
    return [
      ...validateSettings(this.parsed, {
        declaredIds,
        estimateBankBytes: (bankId) => this.bankBytesOrUnknown(bankId),
        maxResidentBytes: this.maxResidentBytes,
        availableKeys: new Set(this.banks.keys),
        streamedKeys: new Set(this.banks.streamedKeys),
      }),
      ...this.banks.hintIssues(),
    ];
  }

  public createVoice(options: PlayOptions = {}): CustomVoice | null {
    return this.engine.createVoice({
      volume: options.volume ?? 1,
      rate: options.rate ?? 1,
      detune: options.detune ?? 0,
      loop: options.loop ?? false,
      bus: options.bus ?? 'sfx',
      fadeInMs: 0,
      position: options.position,
    });
  }

  public getContext(): AudioContext | null {
    return this.engine.getContext();
  }

  // ---- Internals -----------------------------------------------------------

  private addEvent(event: ResolvedEvent): void {
    this.events.set(event.name, event);
    // Drop any variant/cooldown state from a previous definition under the same name; inheriting a
    // stale variant index that no longer matches the new clip list would skip or repeat a clip.
    this.state.set(event.name, { lastClipIndex: -1, lastPlayedAt: -Infinity });
    for (const clip of event.clips) {
      if (clip.kind === 'synth') {
        // Size the shared noise buffer up front so no noise layer ever loops mid-sound.
        for (const layer of clip.definition.layers) {
          if (layer.type === 'noise') {
            this.engine.reserveNoiseSeconds(layer.attackSeconds + layer.decaySeconds + 0.05);
          }
        }
      }
    }
  }

  private stateFor(name: string): EventState {
    let state = this.state.get(name);
    if (!state) {
      state = { lastClipIndex: -1, lastPlayedAt: -Infinity };
      this.state.set(name, state);
    }
    return state;
  }

  /**
   * A bank's decoded cost, or `null` when any of its clips has never been decoded and carries no
   * hint. `validate()` needs the distinction: summing lower bounds would let a `transitionsTo`
   * assertion pass vacuously for a game that declares no hints at all.
   */
  private bankBytesOrUnknown(bankId: string): number | null {
    const keys = this.keysForBank(bankId);
    return this.banks.hasUnknownSize(keys) ? null : this.banks.estimateBytes(keys);
  }

  /** Declared `persistent`: decoded at `init()` and never freed, by `swapBanks` or otherwise. */
  private isPersistent(bankId: string): boolean {
    return this.bankConfigs.get(bankId)?.persistent === true;
  }

  /**
   * An event is playable when any of its banks is loaded — or when it has no bank-decoded clips at
   * all, which is the case for synth, streamed and programmatically-registered sounds. Without that
   * second branch every synth sound would be silently dropped.
   */
  private isEventLoaded(event: ResolvedEvent): boolean {
    if (event.sampleKeys.length === 0) {
      return true;
    }
    return event.banks.some((bank) => this.loaded.has(bank));
  }

  /** The manifest keys a bank decodes: the `sample` clips of every event that names it. */
  private keysForBank(bankId: string): string[] {
    const keys: string[] = [];
    for (const event of this.events.values()) {
      if (event.sampleKeys.length > 0 && event.banks.includes(bankId)) {
        keys.push(...event.sampleKeys);
      }
    }
    return keys;
  }

  private selectClip(event: ResolvedEvent, state: EventState): ResolvedClip {
    const count = event.clips.length;
    if (count === 1) {
      state.lastClipIndex = 0;
      return event.clips[0];
    }
    let index: number;
    if (event.clipSelect === 'roundRobin') {
      index = (state.lastClipIndex + 1) % count;
    } else {
      index = Math.min(Math.floor(this.random() * count), count - 1);
      if (event.clipSelect === 'randomNonRepeating' && index === state.lastClipIndex) {
        // One deterministic step avoids an unbounded retry loop.
        index = (index + 1) % count;
      }
    }
    state.lastClipIndex = index;
    return event.clips[index];
  }

  private playParams(
    event: ResolvedEvent,
    options: PlayOptions,
    loop: boolean,
  ): EnginePlayParams {
    return {
      volume: clamp01(options.volume ?? event.volume),
      rate: options.rate ?? event.pitch,
      detune: options.detune ?? 0,
      loop,
      bus: options.bus ?? event.bus,
      fadeInMs: event.fadeInDuration,
      position: options.position,
      voiceGroups: this.constraintsFor(event),
    };
  }

  private startClip(clip: ResolvedClip, params: EnginePlayParams): SoundHandle | null {
    switch (clip.kind) {
      case 'synth':
        return this.engine.playSynth(clip.definition, params);
      case 'buffer':
        return this.engine.playBuffer(clip.definition.buffer, {
          ...params,
          volume: params.volume * clip.definition.gain,
          rate: params.rate * clip.definition.rate,
          detune: params.detune + clip.definition.detune,
        });
      case 'stream': {
        const url = this.banks.objectUrlFor(clip.key);
        return url === null ? null : this.engine.playStream(url, params);
      }
      case 'sample': {
        const buffer = this.banks.getBuffer(clip.key);
        // The bank is loaded but this clip failed to decode. Stay silent.
        return buffer ? this.engine.playBuffer(buffer, params) : null;
      }
    }
  }

  /**
   * The concurrency budgets a play must satisfy. Every event always gets its own implicit group,
   * which is what makes `stopSound()` / `isPlaying()` work per event even inside a shared budget —
   * and works for one-shots, not just loops. Whether that group is actually *capped* is the
   * interesting part, and `parseSettings` has already resolved it:
   *
   *   no voiceGroup, no voiceLimit  -> capped at 1 (monophonic default)
   *   voiceLimit only               -> capped at voiceLimit
   *   voiceGroup only               -> uncapped privately; the group governs
   *   both                          -> both caps apply
   */
  private constraintsFor(event: ResolvedEvent): VoiceConstraint[] {
    const constraints: VoiceConstraint[] = [
      {
        groupId: eventVoiceGroupId(event.name),
        limit: event.voiceLimit,
        strategy: event.voiceLimitStrategy,
      },
    ];
    for (const groupId of event.voiceGroups) {
      // An undeclared group resolves to "uncapped" rather than throwing; validate() surfaces the
      // typo, since silently-unlimited is the dangerous direction.
      const group = this.voiceGroups.get(groupId);
      const limit = group?.voiceLimit;
      constraints.push({
        groupId,
        limit:
          typeof limit === 'number'
            ? Math.max(1, Math.min(Math.floor(limit), this.engine.globalVoiceLimit))
            : this.engine.globalVoiceLimit,
        strategy: group?.voiceLimitStrategy ?? 'killOldest',
      });
    }
    return constraints;
  }
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
