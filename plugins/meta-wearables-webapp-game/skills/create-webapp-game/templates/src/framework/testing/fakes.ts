/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Test doubles for the framework's own contracts — the payoff for writing gameplay against
 * `Renderer` / `InputManager` / `AudioPlayer` instead of Three.js, the DOM, and Web Audio.
 * With these, a whole game runs in a plain `node` test: no GPU, no browser, no AudioContext.
 * (`MemoryKeyValueStore` in `../storage/KeyValueStore.ts` is the matching persistence fake.)
 *
 * They live in the framework, not in game code, for two reasons: they implement framework
 * interfaces, so they are managed code that improves with the framework; and a class
 * implementing `InputManager` in game code trips the drag-opt-in and layer checks (it must
 * define `isPinchActive`, and the audio fake must name `AudioBuffer`) even though nothing
 * about it is gameplay.
 *
 * Import them from a test — never from shipped code:
 *
 *   import { FakeAudioPlayer, FakeInput, FakeRenderer } from '@/framework/testing/fakes';
 *
 * They record only what a typical assertion reads. If a test needs more (a scripted input
 * sequence, a renderer that tracks visibility), subclass one in the test file rather than
 * editing this file — like everything under `src/framework/`, it is overwritten by
 * `update-webapp-game-framework`.
 */

import type { AudioPlayer, PlayOptions, SoundHandle } from '@/framework/audio/AudioPlayer';
import type { AudioEventConfig } from '@/framework/audio/audioSettings';
import type {
  InputEventHandler,
  InputEventMap,
  InputEventName,
  InputManager,
  MovementDelta,
} from '@/framework/input/InputManager';
import type { Renderer, RenderHandle } from '@/framework/render/Renderer';
import type { Vector3 } from '@/framework/math/Vector3';

/**
 * Records the last value written on each per-instance channel, keyed by handle; everything else
 * is a no-op. Generic over the game's model-id union like the real contract, so the framework
 * stays free of game imports: `new FakeRenderer<ModelId>()`.
 *
 * `scales`, `opacities` and `frames` are what a test asserts a visual cue on — that a pickup
 * pulses, that a dying enemy fades, that a walk cycle advances — without a GPU. `scales` stores
 * the per-axis form even when the game passed a single factor, so an assertion reads the same
 * either way.
 *
 * `remove()` retires the handle, because `ThreeRenderer` does. Writing to a removed instance is
 * legal there — every channel returns silently once the handle is gone — so a fake that kept
 * validating would throw under test for something the device tolerates, and a fake that kept the
 * last value would answer "did the cue stop?" with the value written after it stopped.
 */
export class FakeRenderer<TModelId extends string = string> implements Renderer<TModelId> {
  public readonly positions = new Map<number, { x: number; y: number; z: number }>();
  public readonly scales = new Map<number, { x: number; y: number; z: number }>();
  public readonly opacities = new Map<number, number>();
  public readonly frames = new Map<number, number>();
  private readonly live = new Set<number>();
  private next = 1;

  addModel(_modelId: TModelId, _color?: number): RenderHandle {
    const handle = this.next++;
    this.live.add(handle);
    return handle as RenderHandle;
  }
  setTransform(handle: RenderHandle, position: Vector3): void {
    if (!this.live.has(handle)) {
      return;
    }
    this.positions.set(handle, { x: position.x, y: position.y, z: position.z });
  }
  setRotation(): void {}
  setScale(handle: RenderHandle, scale: number | Vector3): void {
    if (!this.live.has(handle)) {
      return;
    }
    // Matches `ThreeRenderer`: a non-finite factor vanishes the instance silently on device, so
    // recording it here would let a game test pass on a scale that breaks in the browser.
    const axes =
      typeof scale === 'number'
        ? { x: scale, y: scale, z: scale }
        : { x: scale.x, y: scale.y, z: scale.z };
    if (!Number.isFinite(axes.x) || !Number.isFinite(axes.y) || !Number.isFinite(axes.z)) {
      throw new Error(
        `FakeRenderer.setScale: scale must be finite, got ${axes.x}, ${axes.y}, ${axes.z}.`,
      );
    }
    this.scales.set(handle, axes);
  }
  setOpacity(handle: RenderHandle, opacity: number): void {
    // Dead-handle check first, exactly as in `ThreeRenderer`, which looks the instance up before
    // it validates: a game that legitimately pushes a last fade at an instance it just removed
    // must not fail here for something that is a no-op on device.
    if (!this.live.has(handle)) {
      return;
    }
    // Matches `ThreeRenderer`: a non-finite alpha is always a bug upstream and vanishes the
    // instance silently, while an overshoot past either end is a normal artifact of a dt-driven
    // fade. Recording the raw value would let a game test pass on a `NaN` that breaks on device.
    if (!Number.isFinite(opacity)) {
      throw new Error(
        `FakeRenderer.setOpacity: opacity must be a finite number 0..1, got ${opacity}.`,
      );
    }
    this.opacities.set(handle, Math.min(1, Math.max(0, opacity)));
  }
  setFrame(handle: RenderHandle, frame: number): void {
    if (!this.live.has(handle)) {
      return;
    }
    // `ThreeRenderer` throws for an index outside the model's declared frames. The fake has no
    // catalog to range-check against, so it rejects what it can see: an index that could not be
    // valid for any model. Without this a game test passes for a frame that throws at runtime.
    if (!Number.isInteger(frame) || frame < 0) {
      throw new Error(
        `FakeRenderer.setFrame: frame must be a non-negative integer, got ${frame}.`,
      );
    }
    this.frames.set(handle, frame);
  }
  setVisible(): void {}
  remove(handle: RenderHandle): void {
    this.live.delete(handle);
    this.positions.delete(handle);
    this.scales.delete(handle);
    this.opacities.delete(handle);
    this.frames.delete(handle);
  }
  resize(): void {}
  render(): void {}
}

/** Lets tests fire discrete input events manually; the drag delta stays zero (tap-only game). */
export class FakeInput implements InputManager {
  private readonly handlers = new Map<InputEventName, Set<(p: never) => void>>();
  public constructor(private delta: MovementDelta = { x: 0, y: 0 }) {}

  setDelta(delta: MovementDelta): void {
    this.delta = delta;
  }
  on<E extends InputEventName>(event: E, handler: InputEventHandler<E>): void {
    let set = this.handlers.get(event);
    if (!set) {
      set = new Set();
      this.handlers.set(event, set);
    }
    set.add(handler as (p: never) => void);
  }
  off<E extends InputEventName>(event: E, handler: InputEventHandler<E>): void {
    this.handlers.get(event)?.delete(handler as (p: never) => void);
  }
  isPinchActive(): boolean {
    return false;
  }
  consumeMovementDelta(): MovementDelta {
    return this.delta;
  }
  /** Test helper: fire a discrete event (with its payload) into the game. */
  fire<E extends InputEventName>(event: E, payload: InputEventMap[E]): void {
    for (const handler of this.handlers.get(event) ?? []) {
      (handler as (p: InputEventMap[E]) => void)(payload);
    }
  }
}

/**
 * Records `play` calls (and options) so tests can assert which sounds gameplay emits, with no real
 * `AudioContext`. Mirrors the `FakeRenderer` / `FakeInput` pattern.
 *
 * The bank surface is deliberately trivial — banks resolve immediately, nothing is ever resident,
 * and `validate()` is clean — because a *gameplay* test asserts which sounds fire, not how memory
 * is managed. The real bank behaviour is covered in `framework/audio/AmpAudioPlayer.test.ts`
 * against a fake engine. `loadedBanks` still tracks calls, so a test can assert that a level
 * transition asked for the right bank.
 */
export class FakeAudioPlayer implements AudioPlayer {
  public readonly played: { id: string; options: PlayOptions | undefined }[] = [];
  public readonly registered = new Set<string>();
  /** Every `loadBank` / `loadBanks` / `swapBanks` request, in order. */
  public readonly bankRequests: string[] = [];
  public globalVoiceLimit = 16;
  private readonly banks = new Set<string>();
  private readonly live = new Map<string, number>();
  private muted = false;
  private next = 1;

  // ---- Lifecycle ----
  async init(): Promise<void> {}
  resume(): void {}
  suspend(): void {}
  async destroy(): Promise<void> {}

  // ---- Declaring sounds ----
  registerEvents(events: readonly AudioEventConfig[]): void {
    for (const event of events) {
      this.registered.add(event.name);
    }
  }
  registerSoundDefinitions(defs: Partial<Record<string, unknown>>): void {
    for (const id of Object.keys(defs)) {
      this.registered.add(id);
    }
  }
  registerSounds(buffers: Partial<Record<string, AudioBuffer>>): void {
    for (const id of Object.keys(buffers)) {
      this.registered.add(id);
    }
  }

  // ---- Playing ----
  play(sound: string, options?: PlayOptions): SoundHandle | null {
    this.played.push({ id: sound, options });
    this.live.set(sound, (this.live.get(sound) ?? 0) + 1);
    return this.next++ as SoundHandle;
  }
  stop(): void {}
  stopSound(sound: string): void {
    this.live.delete(sound);
  }
  stopAll(): void {
    this.live.clear();
  }
  setVolume(): void {}
  setPosition(): void {}
  setListener(): void {}

  // ---- Mix ----
  setBusVolume(): void {}
  setMuted(muted: boolean): void {
    this.muted = muted;
  }
  toggleMute(): boolean {
    this.muted = !this.muted;
    return this.muted;
  }
  isMuted(): boolean {
    return this.muted;
  }

  // ---- Banks ----
  async loadBank(bankId: string): Promise<void> {
    this.bankRequests.push(bankId);
    this.banks.add(bankId);
  }
  async loadBanks(bankIds: readonly string[]): Promise<void> {
    for (const bankId of bankIds) {
      await this.loadBank(bankId);
    }
  }
  unloadBank(bankId: string): void {
    this.banks.delete(bankId);
  }
  async swapBanks(keep: readonly string[], load: readonly string[]): Promise<void> {
    for (const bankId of [...this.banks]) {
      if (!keep.includes(bankId) && !load.includes(bankId)) {
        this.banks.delete(bankId);
      }
    }
    await this.loadBanks(load);
  }
  get loadedBanks(): string[] {
    return [...this.banks];
  }
  estimateBankBytes(): number {
    return 0;
  }

  // ---- Memory ----
  readonly residentBytes = 0;
  readonly maxResidentBytes = 0;

  // ---- Concurrency / introspection ----
  isPlaying(sound: string): boolean {
    return (this.live.get(sound) ?? 0) > 0;
  }
  activeVoices(sound: string): number {
    return this.live.get(sound) ?? 0;
  }
  voiceGroupCount(): number {
    return 0;
  }
  get activeVoiceCount(): number {
    let total = 0;
    for (const count of this.live.values()) {
      total += count;
    }
    return total;
  }

  // ---- Dev ----
  validate(): string[] {
    return [];
  }
  createVoice(): null {
    return null;
  }
  getContext(): null {
    return null;
  }

  /** The ordered list of sound ids played so far. */
  ids(): string[] {
    return this.played.map((entry) => entry.id);
  }
  /** How many times `id` was played. */
  count(id: string): number {
    return this.played.filter((entry) => entry.id === id).length;
  }
}
