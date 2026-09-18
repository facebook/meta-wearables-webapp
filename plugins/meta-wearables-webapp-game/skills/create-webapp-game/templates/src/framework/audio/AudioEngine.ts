/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * AudioEngine — the thin layer directly over the browser's Web Audio API.
 *
 * This is the **ONLY** file in the framework that touches Web Audio (the audio analogue of
 * `ThreeRenderer` for the render layer). It owns the `AudioContext`, the bus graph, the pooled
 * channel strips behind each voice, and the three ways a voice can be sourced. It knows nothing
 * about events, banks, randomization, or JSON — that is `AmpAudioPlayer`'s job — and it never
 * fetches anything: bytes arrive from the preload manifest via `BankStore`.
 *
 * Bus graph:
 *
 *     [strip] ─┐
 *     [strip] ─┼──► [sfx gain]   ─┐
 *     [strip] ─┘                  ├──► [master gain] ──► destination
 *     [strip] ────► [music gain] ─┘
 *
 * ## Three voice sources, one strip
 *
 * | source | used by | ends |
 * |---|---|---|
 * | `AudioBufferSourceNode` | decoded sample clips | `onended` |
 * | oscillator / noise stack | inline synth clips | last layer's `onended` |
 * | `MediaElementAudioSourceNode` | streamed music (a `blob:` URL) | element `ended`, or `stop()` |
 *
 * ## Allocation strategy (why there is a strip pool)
 *
 * Web Audio source nodes are **single-use by spec** — once started and stopped they cannot be
 * restarted — so a fresh source *must* be created per play. The spec makes that cheap. The real
 * hitch risks are JS-side garbage (per-play voice records, `onended` closures) and re-allocating
 * the nodes that *could* be reused. So everything reusable is pooled — a fixed set of channel
 * strips (`inputGain → stereoPanner → distanceGain`), their bookkeeping, and one shared white-noise
 * buffer — and only the spec-mandated source (and per-layer envelope) nodes are allocated per play.
 * Handles are generation-encoded integers, so `stop` / `setPosition` validate a handle with no
 * per-play `Map` churn, and each strip has one bound `onended` handler.
 *
 * ## Concurrency
 *
 * Which plays are admitted and what has to die first is **policy**, and it lives in `VoicePool` —
 * pure, no Web Audio, unit-testable in plain Node. This file only owns the nodes. Concurrency is
 * expressed as opaque *voice groups* on {@link EnginePlayParams}; the engine never interprets a
 * group id.
 *
 * ## Lifecycle
 *
 * The `AudioContext` is created **lazily** and starts suspended (browser autoplay policy): call
 * `resume()` from the first user gesture. `getContext()` deliberately does not construct one, so it
 * returns `null` until the first `play` / `createVoice` / `resume` / `decodeBytes`.
 */

import type { SoundHandle } from '@/framework/audio/AudioPlayer';
import type { AudioBus } from '@/framework/audio/audioSettings';
import type { OscLayer, SynthDefinition } from '@/framework/audio/soundDefinitions';
import { VoicePool, type VoiceConstraint } from '@/framework/audio/VoicePool';
import { Vector3, clamp } from '@/framework/math/Vector3';

/** Engine construction tunables, injected from the game's `AUDIO` config block. */
export interface AudioEngineOptions {
  /** Size of the strip pool = the hard ceiling on simultaneous voices. Default `16`. */
  maxVoices?: number;
  /** Runtime-tunable polyphony cap, clamped to `maxVoices`. Defaults to `maxVoices`. */
  globalVoiceLimit?: number;
  /** Initial master volume `0..1`. Default `0.8`. */
  masterVolume?: number;
  /** Initial sfx bus volume `0..1`. Default `1`. */
  sfxVolume?: number;
  /** Initial music bus volume `0..1`. Default `1`. */
  musicVolume?: number;
  /** World half-width mapped to full left/right stereo pan. Default `6`. */
  panRange?: number;
  /** Distance (world units) at/inside which there is no attenuation. Default `1`. */
  refDistance?: number;
  /** How sharply gain falls off beyond `refDistance` (inverse model). Default `1`. */
  rolloffFactor?: number;
  /** Distance (world units) at/beyond which a spatial voice is silent. Default `20`. */
  maxDistance?: number;
}

/** Everything a single play needs. `AmpAudioPlayer` resolves an event's tuning into one of these. */
export interface EnginePlayParams {
  /** Linear gain `0..1`. */
  volume: number;
  /** Playback rate — also pitches a sample up/down. */
  rate: number;
  /** Fine pitch offset in cents, on top of `rate`. */
  detune: number;
  /** Loop until explicitly stopped. */
  loop: boolean;
  /** Which bus to route through. */
  bus: AudioBus;
  /** Fade-in ramp in ms. `0` starts at full volume. */
  fadeInMs: number;
  /** World position. When present the voice is stereo-panned and distance-attenuated. */
  position?: Vector3;
  /** Budgets this play must satisfy, checked before the global cap. */
  voiceGroups?: readonly VoiceConstraint[];
}

const DEFAULT_MAX_VOICES = 16;
const DEFAULT_MASTER_VOLUME = 0.8;
const DEFAULT_PAN_RANGE = 6;
const DEFAULT_REF_DISTANCE = 1;
const DEFAULT_ROLLOFF_FACTOR = 1;
const DEFAULT_MAX_DISTANCE = 20;

/** Seconds over which a mixer gain change ramps — short, just enough to avoid a click. */
const GAIN_RAMP_SECONDS = 0.02;
/** Floor length (s) of the reusable white-noise buffer. Grows to cover the longest noise layer. */
const NOISE_BUFFER_SECONDS = 1;
/** Tail (s) added before stopping a synth source so its decay fully plays out. */
const STOP_TAIL_SECONDS = 0.02;

/**
 * Per-source generation stamp. A voice's strip is pooled and reused, and its single bound
 * `onended` reads live voice state (no per-play closure). Stamping each auto-release source with
 * the generation it started under lets that handler ignore a late `onended` — one that fires after
 * the slot was released and reacquired — so it never decrements the new play's pending count.
 */
const SOURCE_GENERATION = Symbol('voiceGeneration');
type StampedSource = AudioScheduledSourceNode & { [SOURCE_GENERATION]?: number };

/**
 * Whether the `?mute` debug flag was requested via the URL query string — pass it to `setMuted` at
 * startup to silence a session (handy for capturing/demoing on the glasses, where there is no
 * volume control). Present with any value except `0` / `false` enables it. DOM-free, so it is
 * unit-testable; pass `window.location.search`.
 */
export function muteRequested(search: string): boolean {
  const value = new URLSearchParams(search).get('mute');
  if (value === null) {
    return false;
  }
  return value !== '0' && value.toLowerCase() !== 'false';
}

/** The stereo-pan + distance model parameters, shared with the pooled strips. */
interface SpatialConfig {
  readonly panRange: number;
  readonly refDistance: number;
  readonly rolloffFactor: number;
  readonly maxDistance: number;
}

/**
 * A pooled channel strip: a persistent `inputGain → stereoPanner → distanceGain` subgraph created
 * once and reused across plays. Only `distanceGain → bus` is (re)connected per acquire; the source
 * node(s) a play creates connect into `input`. Never allocated per play.
 */
class ChannelStrip {
  public readonly input: GainNode;
  private readonly panner: StereoPannerNode;
  private readonly distanceGain: GainNode;
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly intermediates: AudioNode[] = [];
  private readonly onSourceEnded: (event: Event) => void;

  /** Current handle (generation-encoded), or `0` when free. */
  public handle: SoundHandle = 0 as SoundHandle;
  /** Bumped on every acquire so a stale handle for a reused slot is rejected. */
  public generation = 0;
  public active = false;
  public spatial = false;
  /** Fading out: no longer counts against its voice groups, still holds a global slot. */
  public stopping = false;
  public readonly position = new Vector3();

  private bus: GainNode | null = null;
  private element: HTMLAudioElement | null = null;
  private autoRelease = false;
  private pending = 0;
  /** Timer that releases a faded voice whose sources cannot be observed (streams, custom graphs). */
  private fadeTimer: ReturnType<typeof setTimeout> | null = null;

  public constructor(
    context: AudioContext,
    public readonly index: number,
    private readonly release: (strip: ChannelStrip) => void,
  ) {
    this.input = context.createGain();
    this.panner = context.createStereoPanner();
    this.distanceGain = context.createGain();
    this.input.connect(this.panner);
    this.panner.connect(this.distanceGain);
    // One bound handler per strip — no per-play closure allocation.
    this.onSourceEnded = (event: Event): void => {
      // Ignore a late `onended` that no longer belongs to the current play: either the voice was
      // already released (manual stop / stopAll -> `active` is false), or the source started under
      // a previous generation and the slot has since been reacquired. Either way, decrementing
      // `pending` here would corrupt another play.
      const source = (event?.target ?? null) as StampedSource | null;
      if (!this.active || (source !== null && source[SOURCE_GENERATION] !== this.generation)) {
        return;
      }
      this.pending -= 1;
      if (this.pending <= 0 && this.autoRelease) {
        this.release(this);
      }
    };
  }

  /** Reset and route this strip for a new play. */
  public begin(handle: SoundHandle, generation: number, bus: GainNode, spatial: boolean): void {
    this.handle = handle;
    this.generation = generation;
    this.active = true;
    this.spatial = spatial;
    this.stopping = false;
    this.autoRelease = false;
    this.pending = 0;
    this.bus = bus;
    this.input.gain.cancelScheduledValues(0);
    this.input.gain.value = 1;
    this.panner.pan.value = 0;
    this.distanceGain.gain.value = 1;
    this.distanceGain.connect(bus);
  }

  /**
   * Set this voice's linear output gain immediately (no ramp). Called at voice start to set the
   * initial level — ramping here would fade in every sound and soften percussive SFX attacks. Live
   * changes ramp instead, via `AudioEngine.setVoiceVolume`.
   */
  public setVolume(volume: number): void {
    this.input.gain.value = volume;
  }

  /**
   * Connect a scheduled source into the strip; `autoRelease` returns the voice to the pool when it
   * ends. Pass `intermediate` when the source feeds the strip through a per-play node (a synth
   * envelope): the caller wires `source → intermediate`, and this connects `intermediate → input`
   * and disconnects it in `end()` so per-play nodes do not accumulate on the reused strip.
   */
  public attachSource(
    source: AudioScheduledSourceNode,
    autoRelease: boolean,
    intermediate?: AudioNode,
  ): void {
    if (intermediate) {
      intermediate.connect(this.input);
      this.intermediates.push(intermediate);
    } else {
      source.connect(this.input);
    }
    this.sources.push(source);
    if (autoRelease) {
      this.autoRelease = true;
      this.pending += 1;
      (source as StampedSource)[SOURCE_GENERATION] = this.generation;
      source.onended = this.onSourceEnded;
    }
  }

  /**
   * Attach a streaming `<audio>` element source (the music path). A media element is not an
   * `AudioScheduledSourceNode` — it has no `start`/`stop` and its node cannot be reused — so it is
   * tracked separately and torn down in `end()`.
   */
  public attachStream(element: HTMLAudioElement, node: MediaElementAudioSourceNode): void {
    node.connect(this.input);
    this.intermediates.push(node);
    this.element = element;
    if (!element.loop) {
      // A non-looping stream ends on its own; release the slot when it does.
      this.autoRelease = true;
      this.pending += 1;
      const generation = this.generation;
      element.onended = (): void => {
        if (this.active && this.generation === generation) {
          this.pending -= 1;
          if (this.pending <= 0) {
            this.release(this);
          }
        }
      };
    }
  }

  /**
   * Fade out over `fadeMs`, then release. The strip is marked `stopping` so the caller can drop it
   * from its voice-group counts immediately (a retriggered loop then crossfades with its own tail
   * instead of being blocked by it) while it keeps its global slot until the nodes actually end.
   *
   * Scheduled sources are stopped at the end of the ramp and release through `onended`. A stream or
   * a `createVoice` graph has no source the strip can observe, so a timer releases those — without
   * it, a faded custom voice would hold its slot forever.
   */
  public beginFade(context: AudioContext, fadeMs: number): void {
    if (this.stopping) {
      return;
    }
    this.stopping = true;
    const now = context.currentTime;
    const endAt = now + fadeMs / 1000;
    const gain = this.input.gain;
    gain.cancelScheduledValues(now);
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(0, endAt);

    let observed = false;
    for (const source of this.sources) {
      try {
        source.stop(endAt);
        observed ||= source.onended !== null;
      } catch {
        // Already stopped; `onended` still fires and disposes it.
      }
    }
    if (!observed) {
      this.fadeTimer = setTimeout(() => {
        this.fadeTimer = null;
        if (this.active) {
          this.release(this);
        }
      }, fadeMs);
    }
  }

  /** Recompute pan + distance attenuation from this voice's position vs. the listener. */
  public updateSpatial(listener: Vector3, cfg: SpatialConfig): void {
    if (!this.spatial) {
      return;
    }
    const p = this.position;
    const dx = p.x - listener.x;
    const dy = p.y - listener.y;
    const dz = p.z - listener.z;
    this.panner.pan.value = clamp(dx / cfg.panRange, -1, 1);
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    this.distanceGain.gain.value =
      dist >= cfg.maxDistance
        ? 0
        : cfg.refDistance /
          (cfg.refDistance + cfg.rolloffFactor * Math.max(0, dist - cfg.refDistance));
  }

  /**
   * Tear down: stop and disconnect the sources this strip tracked, disconnect the per-play
   * intermediate nodes, tear down any stream element, and unwire the strip from the bus. Leaves the
   * persistent `input → panner → distanceGain` chain ready to reacquire.
   *
   * It does NOT disconnect nodes a game connected directly to `input` through `createVoice` — the
   * strip has no reference to them, and they are the caller's to own. A `createVoice` user must
   * `disconnect()` its own source(s) when it calls `stop(handle)`; otherwise a still-connected
   * source can re-mix into the next play that reuses this slot.
   */
  public end(): void {
    if (this.fadeTimer !== null) {
      clearTimeout(this.fadeTimer);
      this.fadeTimer = null;
    }
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // Already stopped/ended — fine.
      }
      source.disconnect();
    }
    this.sources.length = 0;
    for (const node of this.intermediates) {
      node.disconnect();
    }
    this.intermediates.length = 0;
    if (this.element) {
      this.element.onended = null;
      this.element.pause();
      // Dropping the src lets the media pipeline release its decoder and buffers.
      this.element.removeAttribute('src');
      this.element.load();
      this.element = null;
    }
    if (this.bus) {
      this.distanceGain.disconnect(this.bus);
    }
    this.bus = null;
    this.active = false;
    this.stopping = false;
    this.autoRelease = false;
    this.pending = 0;
    this.spatial = false;
    this.handle = 0 as SoundHandle;
  }
}

/**
 * A fixed pool of {@link ChannelStrip}s. Handles are `generation * size + index`, so a handle for a
 * slot that has since been reused fails validation with no per-play `Map`.
 *
 * Distinct from `VoicePool`, which is *policy* (who may play, who gets evicted) and holds no nodes.
 * This one is *nodes*.
 */
class StripPool {
  private readonly strips: ChannelStrip[] = [];
  private readonly free: number[] = [];
  private readonly listener = new Vector3();

  public constructor(
    context: AudioContext,
    size: number,
    private readonly cfg: SpatialConfig,
    private readonly onRelease: (handle: SoundHandle) => void,
  ) {
    const release = (strip: ChannelStrip): void => this.releaseStrip(strip);
    for (let i = 0; i < size; i++) {
      this.strips.push(new ChannelStrip(context, i, release));
      this.free.push(i);
    }
  }

  public get size(): number {
    return this.strips.length;
  }

  public acquire(
    generation: number,
    bus: GainNode,
    spatial: boolean,
    position?: Vector3,
  ): ChannelStrip | null {
    const index = this.free.pop();
    if (index === undefined) {
      return null;
    }
    const strip = this.strips[index];
    const handle = (generation * this.strips.length + index) as SoundHandle;
    if (spatial && position) {
      strip.position.set(position.x, position.y, position.z);
    }
    strip.begin(handle, generation, bus, spatial);
    if (spatial) {
      strip.updateSpatial(this.listener, this.cfg);
    }
    return strip;
  }

  /** Resolve a handle to its live strip, or `null` if it is stale/free. */
  public get(handle: SoundHandle): ChannelStrip | null {
    const size = this.strips.length;
    const value = handle as number;
    const index = value % size;
    const generation = Math.floor(value / size);
    const strip = this.strips[index];
    return strip && strip.active && strip.generation === generation ? strip : null;
  }

  public releaseByHandle(handle: SoundHandle): void {
    const strip = this.get(handle);
    if (strip) {
      this.releaseStrip(strip);
    }
  }

  public releaseAll(): void {
    for (const strip of this.strips) {
      if (strip.active) {
        this.releaseStrip(strip);
      }
    }
  }

  public setListener(position: Vector3): void {
    this.listener.set(position.x, position.y, position.z);
    for (const strip of this.strips) {
      if (strip.active) {
        strip.updateSpatial(this.listener, this.cfg);
      }
    }
  }

  public setPosition(handle: SoundHandle, position: Vector3): void {
    const strip = this.get(handle);
    if (strip && strip.spatial) {
      strip.position.set(position.x, position.y, position.z);
      strip.updateSpatial(this.listener, this.cfg);
    }
  }

  private releaseStrip(strip: ChannelStrip): void {
    // Idempotent: an already-released strip must not be pushed onto `free` twice, or the same slot
    // could be handed to two concurrent plays.
    if (!strip.active) {
      return;
    }
    const handle = strip.handle;
    strip.end();
    this.free.push(strip.index);
    this.onRelease(handle);
  }
}

export class AudioEngine {
  private context: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private sfxGain: GainNode | null = null;
  private musicGain: GainNode | null = null;
  private strips: StripPool | null = null;
  private noiseBuffer: AudioBuffer | null = null;
  private maxNoiseSeconds = NOISE_BUFFER_SECONDS;

  /** Admission + eviction policy. Pure; holds no nodes. */
  private readonly pool = new VoicePool();
  private generationCounter = 1;

  private options: Required<Omit<AudioEngineOptions, 'globalVoiceLimit'>> & {
    globalVoiceLimit: number;
  };
  private readonly spatial: SpatialConfig;
  private muted = false;
  /** `null` until first probed; then whether Web Audio exists at all. */
  private available: boolean | null = null;

  public constructor(options: AudioEngineOptions = {}) {
    const maxVoices = Math.max(1, Math.floor(options.maxVoices ?? DEFAULT_MAX_VOICES));
    this.options = {
      maxVoices,
      globalVoiceLimit: clampInt(options.globalVoiceLimit ?? maxVoices, 1, maxVoices),
      masterVolume: options.masterVolume ?? DEFAULT_MASTER_VOLUME,
      sfxVolume: options.sfxVolume ?? 1,
      musicVolume: options.musicVolume ?? 1,
      panRange: options.panRange ?? DEFAULT_PAN_RANGE,
      refDistance: options.refDistance ?? DEFAULT_REF_DISTANCE,
      rolloffFactor: options.rolloffFactor ?? DEFAULT_ROLLOFF_FACTOR,
      maxDistance: options.maxDistance ?? DEFAULT_MAX_DISTANCE,
    };
    this.spatial = {
      panRange: this.options.panRange,
      refDistance: this.options.refDistance,
      rolloffFactor: this.options.rolloffFactor,
      maxDistance: this.options.maxDistance,
    };
  }

  // ---- Lifecycle -----------------------------------------------------------

  /**
   * Whether Web Audio is usable at all. Deliberately does **not** construct an `AudioContext`:
   * building one outside a user gesture trips the browser autoplay policy, and `AmpAudioPlayer`
   * calls this during `init()`, long before the first tap. When this is `false` every other method
   * degrades to a silent no-op, so a game never has to branch on it.
   */
  public get ready(): boolean {
    if (this.available === null) {
      this.available = typeof AudioContext !== 'undefined';
      if (!this.available) {
        // Warn once at the point of discovery, not on every dropped play.
        console.warn('[audio] Web Audio API unavailable; audio disabled.');
      }
    }
    return this.available;
  }

  /** Resume/unlock the context after a user gesture. Cheap to call repeatedly. */
  public resume(): void {
    const context = this.ensureContext();
    if (context && context.state === 'suspended') {
      // Rejects harmlessly when called without a gesture (e.g. the visibilitychange handler).
      void context.resume().catch(() => {});
    }
  }

  /** Suspend the context to draw no audio-thread power while the app is backgrounded. */
  public suspend(): void {
    if (this.context && this.context.state === 'running') {
      void this.context.suspend().catch(() => {});
    }
  }

  /** Stop everything and close the context. */
  public async close(): Promise<void> {
    this.stopAll(0);
    this.pool.clear();
    if (this.context) {
      await this.context.close().catch(() => {});
    }
    this.context = null;
    this.masterGain = null;
    this.sfxGain = null;
    this.musicGain = null;
    this.strips = null;
    this.noiseBuffer = null;
  }

  /**
   * The live `AudioContext`, for advanced synthesis that builds its own nodes. Does NOT construct
   * one — the context is created lazily by the first `play` / `createVoice` / `resume`, so this
   * returns `null` until then.
   */
  public getContext(): AudioContext | null {
    return this.context;
  }

  /** Live voices, fading ones included. */
  public get activeVoiceCount(): number {
    return this.pool.size;
  }

  /** Group ids with at least one live voice. For dev overlays. */
  public get activeVoiceGroupIds(): string[] {
    return this.pool.activeGroupIds;
  }

  /** Hard ceiling on simultaneous voices: the number of preallocated strips. */
  public get maxVoices(): number {
    return this.options.maxVoices;
  }

  public get globalVoiceLimit(): number {
    return this.options.globalVoiceLimit;
  }

  /**
   * Retune the polyphony cap at runtime. Existing voices are left alone; the new cap applies from
   * the next play. **Lowering** it is how you profile a device — raising it past the preallocated
   * strip count would allocate at runtime, so it clamps to `maxVoices` instead.
   */
  public set globalVoiceLimit(value: number) {
    this.options.globalVoiceLimit = clampInt(value, 1, this.options.maxVoices);
  }

  /**
   * Grow the shared white-noise buffer to cover a noise layer this long. Called once per synth clip
   * during `init()` so the buffer is sized before anything plays — a noise source then stops before
   * it reaches the buffer end, and the fallback `loop` never fires mid-layer (looping random content
   * would click at the seam).
   */
  public reserveNoiseSeconds(seconds: number): void {
    if (seconds > this.maxNoiseSeconds) {
      this.maxNoiseSeconds = seconds;
      // Drop a now-undersized buffer so the next noise play rebuilds it.
      if (this.noiseBuffer && this.context) {
        const needed = Math.floor(this.context.sampleRate * seconds);
        if (this.noiseBuffer.length < needed) {
          this.noiseBuffer = null;
        }
      }
    }
  }

  // ---- Decoding ------------------------------------------------------------

  /**
   * Decode compressed bytes into an `AudioBuffer` using this engine's context, so sample rates
   * match the graph. Works while the context is suspended, which is what lets a bank decode behind
   * the loading screen before the first gesture. Resolves to `null` rather than throwing: a clip
   * that fails to decode degrades to silence.
   *
   * Note that `decodeAudioData` **detaches** the `ArrayBuffer` it is given — `BankStore` hands over
   * a fresh one per call for exactly that reason.
   */
  public async decodeBytes(bytes: ArrayBuffer): Promise<AudioBuffer | null> {
    const context = this.ensureContext();
    if (!context) {
      return null;
    }
    try {
      return await context.decodeAudioData(bytes);
    } catch (error) {
      console.warn('[audio] decodeAudioData failed:', error);
      return null;
    }
  }

  // ---- Playback ------------------------------------------------------------

  /** Start a decoded sample on a bus. `null` when the engine is unavailable or a group refused. */
  public playBuffer(buffer: AudioBuffer, params: EnginePlayParams): SoundHandle | null {
    const acquired = this.acquire(params);
    if (!acquired) {
      return null;
    }
    const { context, strip } = acquired;

    strip.setVolume(params.volume);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = params.rate;
    source.detune.value = params.detune;
    source.loop = params.loop;
    source.start();
    // A looping sample never ends on its own — the game stops it via its handle — so it does not
    // auto-release.
    strip.attachSource(source, !params.loop);

    this.applyFadeIn(context, strip, params);
    return this.admit(strip, params);
  }

  /**
   * Render an inline synth clip: one oscillator/noise source per layer, each through its own
   * attack→decay envelope, all into one strip. The whole stack is **one voice**, so an event's
   * `voiceLimit` means what a designer expects however many layers the sound has.
   */
  public playSynth(definition: SynthDefinition, params: EnginePlayParams): SoundHandle | null {
    if (definition.layers.length === 0) {
      return null;
    }
    const acquired = this.acquire(params);
    if (!acquired) {
      return null;
    }
    const { context, strip } = acquired;

    strip.setVolume(params.volume * definition.gain);
    const now = context.currentTime;
    for (const layer of definition.layers) {
      const start = now + layer.delaySeconds;
      const attackEnd = start + layer.attackSeconds;
      const end = attackEnd + layer.decaySeconds;

      const env = context.createGain();
      env.gain.setValueAtTime(0, start);
      env.gain.linearRampToValueAtTime(layer.peak, attackEnd);
      env.gain.linearRampToValueAtTime(0, end);

      const source = this.createLayerSource(context, layer, params, start, end);
      source.connect(env);
      source.start(start);
      source.stop(end + STOP_TAIL_SECONDS);
      // Route through the envelope (source -> env -> input); without the intermediate the raw
      // signal would also reach the strip.
      strip.attachSource(source, true, env);
    }

    this.applyFadeIn(context, strip, params);
    return this.admit(strip, params);
  }

  /**
   * Stream a clip from a `blob:` URL through a `MediaElementAudioSourceNode` instead of decoding it
   * whole. This is the **music** path: a two-minute loop is ~44 MB of PCM if decoded, but streaming
   * decodes incrementally and holds almost none. It routes into the same bus graph, so mixing,
   * ducking and mute are unchanged.
   *
   * The URL must be a `blob:` (or `data:`) reference to bytes the preload manifest already fetched
   * — never a network URL. See `docs/audio-banks.md`.
   */
  public playStream(url: string, params: EnginePlayParams): SoundHandle | null {
    const acquired = this.acquire(params);
    if (!acquired) {
      return null;
    }
    const { context, strip } = acquired;

    strip.setVolume(params.volume);
    const element = new Audio();
    element.src = url;
    element.loop = params.loop;
    element.playbackRate = params.rate;
    element.preload = 'auto';
    const node = context.createMediaElementSource(element);
    strip.attachStream(element, node);
    // Rejects when the context is still locked; the next resume() + retrigger recovers.
    void element.play().catch(() => {});

    this.applyFadeIn(context, strip, params);
    return this.admit(strip, params);
  }

  /**
   * Escape hatch for a fully custom graph: a routed, bus-connected (and, with a `position`,
   * spatialized) input node plus a handle from the same pool as `play`. The caller connects and
   * starts its own source(s) and **must** `stop(handle)` — there is no framework source to watch,
   * so the voice never auto-releases and holds a slot against the cap until then.
   */
  public createVoice(params: EnginePlayParams): { input: AudioNode; handle: SoundHandle } | null {
    const acquired = this.acquire(params);
    if (!acquired) {
      return null;
    }
    const { strip } = acquired;
    // No definition gain to fold in: a custom voice's level is entirely the caller's `volume` plus
    // whatever its own graph applies.
    strip.setVolume(params.volume);
    return { input: strip.input, handle: this.admit(strip, params) };
  }

  /** Whether a handle still refers to a live voice. */
  public isAlive(handle: SoundHandle): boolean {
    return (this.strips?.get(handle) ?? null) !== null;
  }

  /**
   * Stop a voice, optionally fading out first. A fading voice stops counting against its voice
   * groups immediately (so a retrigger crossfades with it rather than being blocked), keeps its
   * global slot until its nodes end, and is the first thing the global cap reclaims.
   */
  public stop(handle: SoundHandle, fadeOutMs = 0): void {
    const strip = this.strips?.get(handle);
    if (!strip || !this.context) {
      return;
    }
    if (fadeOutMs <= 0) {
      this.strips?.releaseByHandle(handle);
      return;
    }
    if (strip.stopping) {
      return;
    }
    strip.beginFade(this.context, fadeOutMs);
    this.pool.markStopping(handle);
  }

  /** Stop every live voice. */
  public stopAll(fadeOutMs = 0): void {
    if (fadeOutMs <= 0) {
      this.strips?.releaseAll();
      return;
    }
    for (const handle of this.pool.handles()) {
      this.stop(handle as SoundHandle, fadeOutMs);
    }
  }

  /** Stop every voice in a group. Voices of other groups are untouched. */
  public stopVoiceGroup(groupId: string, fadeOutMs = 0): void {
    for (const handle of this.pool.handlesInGroup(groupId)) {
      this.stop(handle as SoundHandle, fadeOutMs);
    }
  }

  /** Voices in a group that are still sounding, i.e. excluding fading tails. */
  public voiceGroupCount(groupId: string): number {
    return this.pool.countInGroup(groupId);
  }

  /** Change a live voice's volume, ramped so it does not click (e.g. ducking an ambience). */
  public setVoiceVolume(handle: SoundHandle, volume: number, rampMs = 0): void {
    const strip = this.strips?.get(handle);
    if (!strip || !this.context || strip.stopping) {
      return;
    }
    rampGain(this.context, strip.input.gain, volume, Math.max(rampMs / 1000, GAIN_RAMP_SECONDS));
  }

  /** Update a live spatial voice's world position. No-op on a non-spatial or stale handle. */
  public setVoicePosition(handle: SoundHandle, position: Vector3): void {
    this.strips?.setPosition(handle, position);
  }

  /** Set the listener position spatial voices are panned and attenuated against. */
  public setListener(position: Vector3): void {
    this.strips?.setListener(position);
  }

  // ---- Mix -----------------------------------------------------------------

  public setMasterVolume(volume: number): void {
    this.options.masterVolume = volume;
    // While muted, masterGain sits at 0 — writing `volume` here would silently unmute.
    if (this.masterGain && !this.muted && this.context) {
      rampGain(this.context, this.masterGain.gain, volume, GAIN_RAMP_SECONDS);
    }
  }

  public setBusVolume(bus: AudioBus, volume: number): void {
    // Cache the value so a call made before the nodes exist is still applied by ensureContext().
    if (bus === 'sfx') {
      this.options.sfxVolume = volume;
    } else {
      this.options.musicVolume = volume;
    }
    const gain = bus === 'sfx' ? this.sfxGain : this.musicGain;
    if (gain && this.context) {
      rampGain(this.context, gain.gain, volume, GAIN_RAMP_SECONDS);
    }
  }

  public setMuted(muted: boolean): void {
    this.muted = muted;
    if (this.masterGain && this.context) {
      rampGain(
        this.context,
        this.masterGain.gain,
        muted ? 0 : this.options.masterVolume,
        GAIN_RAMP_SECONDS,
      );
    }
  }

  public get isMuted(): boolean {
    return this.muted;
  }

  // ---- Internals -----------------------------------------------------------

  /**
   * Run the concurrency policy, evict whatever has to die, and take a strip. Returns `null` when a
   * `preventNew` group refused the play or audio is unavailable.
   *
   * Group budgets are enforced **before** the global cap, so an unrelated voice is never stolen to
   * make room for a play a `preventNew` group is about to refuse. An eviction here can end a voice
   * belonging to a *different* event when the two share a group — that is the point of a shared
   * budget.
   */
  private acquire(params: EnginePlayParams): { context: AudioContext; strip: ChannelStrip } | null {
    const context = this.ensureContext();
    if (!context || !this.strips) {
      return null;
    }

    const plan = this.pool.plan(params.voiceGroups ?? [], this.options.globalVoiceLimit);
    if (!plan.admitted) {
      return null;
    }
    for (const victim of plan.evict) {
      this.strips.releaseByHandle(victim as SoundHandle);
    }

    const strip = this.strips.acquire(
      this.generationCounter++,
      this.busFor(params.bus),
      params.position !== undefined,
      params.position,
    );
    if (!strip) {
      // Unreachable in practice: `plan` evicts until occupancy is under globalVoiceLimit, which is
      // clamped to the strip count, so a strip is always free by here. Guard rather than assert —
      // audio must never be able to throw into the game loop.
      console.warn('[audio] Strip pool exhausted despite an admitted plan; dropping the play.');
      return null;
    }
    return { context, strip };
  }

  /** Register a started voice with the policy pool and hand back its handle. */
  private admit(strip: ChannelStrip, params: EnginePlayParams): SoundHandle {
    this.pool.add(
      strip.handle,
      (params.voiceGroups ?? []).map((constraint) => constraint.groupId),
      params.loop,
    );
    return strip.handle;
  }

  /** Ramp the strip in from silence when the event asks for a fade-in. */
  private applyFadeIn(context: AudioContext, strip: ChannelStrip, params: EnginePlayParams): void {
    if (params.fadeInMs <= 0) {
      return;
    }
    const target = strip.input.gain.value;
    const now = context.currentTime;
    strip.input.gain.setValueAtTime(0, now);
    strip.input.gain.linearRampToValueAtTime(target, now + params.fadeInMs / 1000);
  }

  /** A looping noise source, or a pitch-bending oscillator, per the layer type. */
  private createLayerSource(
    context: AudioContext,
    layer: OscLayer,
    params: EnginePlayParams,
    start: number,
    end: number,
  ): AudioScheduledSourceNode {
    if (layer.type === 'noise') {
      const source = context.createBufferSource();
      source.buffer = this.ensureNoiseBuffer(context);
      source.loop = true;
      return source;
    }
    const oscillator = context.createOscillator();
    oscillator.type = layer.type;
    oscillator.detune.value = layer.detune + params.detune;
    oscillator.frequency.setValueAtTime(layer.startFreq * params.rate, start);
    if (layer.endFreq !== layer.startFreq) {
      // Exponential ramps need a strictly positive target. The `tone`/`note` builders only produce
      // positive freqs; the clamp is a defensive floor so a hand-authored layer with a
      // non-positive `endFreq` cannot throw — at the cost of ending that slide early at 1 Hz.
      oscillator.frequency.exponentialRampToValueAtTime(
        Math.max(layer.endFreq * params.rate, 1),
        end,
      );
    }
    return oscillator;
  }

  private busFor(bus: AudioBus): GainNode {
    // ensureContext (called before every acquire) guarantees these are set.
    return bus === 'music' ? this.musicGain! : this.sfxGain!;
  }

  /**
   * Lazily create the context, the master / sfx / music bus graph, and the strip pool. Returns
   * `null` when an `AudioContext` cannot be constructed (no Web Audio, e.g. SSR or a Node test), so
   * the methods documented to yield `null` when audio is unavailable honour that contract instead
   * of throwing.
   */
  private ensureContext(): AudioContext | null {
    if (this.context && this.strips) {
      return this.context;
    }
    if (!this.ready) {
      return null;
    }
    let context: AudioContext;
    try {
      context = new AudioContext();
    } catch {
      this.available = false;
      return null;
    }

    const masterGain = context.createGain();
    masterGain.gain.value = this.muted ? 0 : this.options.masterVolume;
    masterGain.connect(context.destination);

    const sfxGain = context.createGain();
    sfxGain.gain.value = this.options.sfxVolume;
    sfxGain.connect(masterGain);

    const musicGain = context.createGain();
    musicGain.gain.value = this.options.musicVolume;
    musicGain.connect(masterGain);

    this.context = context;
    this.masterGain = masterGain;
    this.sfxGain = sfxGain;
    this.musicGain = musicGain;
    this.strips = new StripPool(context, this.options.maxVoices, this.spatial, (handle) =>
      this.pool.remove(handle),
    );
    return context;
  }

  private ensureNoiseBuffer(context: AudioContext): AudioBuffer {
    const length = Math.floor(context.sampleRate * this.maxNoiseSeconds);
    if (this.noiseBuffer && this.noiseBuffer.length >= length) {
      return this.noiseBuffer;
    }
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < length; i++) {
      data[i] = Math.random() * 2 - 1;
    }
    this.noiseBuffer = buffer;
    return buffer;
  }
}

/**
 * Ramp a gain param instead of assigning `.value` — a step change on an audible node clicks.
 * Anchors the ramp at the param's current value (cancel in-flight ramps, pin the start to `now`) so
 * a rapid change glides from where the gain actually is rather than a stale scheduled value.
 */
function rampGain(
  context: AudioContext,
  param: AudioParam,
  value: number,
  seconds: number,
): void {
  const now = context.currentTime;
  param.cancelScheduledValues(now);
  param.setValueAtTime(param.value, now);
  param.linearRampToValueAtTime(Math.max(0, Math.min(1, value)), now + seconds);
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.floor(value)));
}
