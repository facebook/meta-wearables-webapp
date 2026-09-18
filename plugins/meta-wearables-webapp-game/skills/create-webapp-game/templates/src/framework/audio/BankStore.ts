/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * The audio byte store — what a *bank* actually loads and unloads.
 *
 * ## Banks manage decode, not download
 *
 * For audio on the web, download is not the scarce resource:
 *
 * | | stereo 48 kHz |
 * |---|---|
 * | Decoded `AudioBuffer` (Float32: channels x frames x 4) | **~0.37 MB / second** |
 * | Ogg Vorbis @ ~96 kbps | ~0.012 MB / second |
 *
 * A ~30x ratio, measured on a Meta Ray-Ban Display device during bring-up: 33 clips whose
 * compressed payload is a couple of MB expanded to 10.28 MB of resident PCM. So compressed bytes
 * are cheap and stay resident for the whole session; **decoded PCM is what has to be managed**:
 *
 * - **load a bank** = decode its clips into `AudioBuffer`s.
 * - **unload a bank** = drop those `AudioBuffer`s and let GC reclaim them. The compressed bytes
 *   never leave memory and are never re-fetched.
 *
 * Two consequences worth stating. There is **zero network access at runtime** — every byte arrives
 * through the preload manifest before the game loop starts, so the project's preload rule keeps its
 * teeth (`npm run validate`). And a game's *total* audio may exceed the memory budget as long as no
 * simultaneously-resident set does, which was the actual goal.
 *
 * ## Why `Blob` and not `ArrayBuffer`
 *
 * `decodeAudioData` **detaches (neuters) the `ArrayBuffer` you hand it**, so the same buffer cannot
 * be decoded twice. Holding a `Blob` and materializing a fresh `ArrayBuffer` per decode avoids that
 * cleanly. Holding a raw `ArrayBuffer` and remembering to `.slice(0)` on every decode does not — it
 * is a latent bug that only fires on the *second* `loadBank` of the same clip.
 *
 * This file constructs no Web Audio nodes: it delegates decoding to `AudioEngine` through the
 * injected {@link DecodeBytes}, and owns only bytes, buffers, and the byte accounting.
 * `docs/audio-banks.md` has the authoring guide.
 */

/** Decode compressed bytes into PCM. Injected by `AmpAudioPlayer`; `AudioEngine` implements it. */
export type DecodeBytes = (bytes: ArrayBuffer) => Promise<AudioBuffer | null>;

/** How a clip's bytes are held, from its preload-manifest entry. */
export interface PutOptions {
  /** Approximate decoded size, so a bank can be costed before it is decoded. */
  pcmBytes?: number;
  /** Played from a `blob:` URL and never decoded. No bank owns it and it costs no PCM budget. */
  streamed?: boolean;
}

/** Bytes of PCM one `AudioBuffer` holds: `channels x frames x 4` (Float32). */
export function pcmBytesOf(buffer: AudioBuffer): number {
  return buffer.numberOfChannels * buffer.length * 4;
}

/** How far a `pcmBytes` hint may be off the measured size before `validate()` complains. */
const HINT_TOLERANCE = 0.1;

interface Clip {
  readonly blob: Blob;
  /** Played from a `blob:` URL rather than decoded, so it never costs PCM and needs no hint. */
  readonly streamed: boolean;
  /** Declared decoded size, from the manifest entry. Lets a swap be costed before decoding. */
  readonly hint: number | undefined;
  /** Decoded size measured on first decode. Authoritative once known. */
  measured: number | undefined;
  buffer: AudioBuffer | undefined;
  /** A `blob:` URL, created on demand for streamed (music) clips and revoked on release. */
  objectUrl: string | undefined;
}

export class BankStore {
  private readonly clips = new Map<string, Clip>();
  /** key -> in-flight decode, so two banks sharing a clip share one decode. */
  private readonly decoding = new Map<string, Promise<AudioBuffer | null>>();
  private resident = 0;

  public constructor(
    private readonly decodeBytes: DecodeBytes,
    /** Decoded-PCM budget for the whole subsystem. See `AUDIO.maxResidentBytes`. */
    public readonly maxResidentBytes: number,
  ) {}

  /**
   * Register a clip's compressed bytes. Called once per `{ type: 'audio', bank }` manifest entry
   * during preload; nothing is decoded here. `pcmBytes` is the optional decoded-size hint from the
   * manifest entry — without it, {@link estimateBytes} can only cost clips that have been decoded
   * at least once.
   */
  public put(key: string, blob: Blob, options: PutOptions = {}): void {
    if (this.clips.has(key)) {
      // Re-registering the same key would orphan the old buffer's byte accounting.
      this.release([key]);
    }
    this.clips.set(key, {
      blob,
      streamed: options.streamed === true,
      hint: options.pcmBytes,
      measured: undefined,
      buffer: undefined,
      objectUrl: undefined,
    });
  }

  /** Keys registered for streaming — cross-checked against the events by `validate()`. */
  public get streamedKeys(): string[] {
    return [...this.clips].filter(([, clip]) => clip.streamed).map(([key]) => key);
  }

  public has(key: string): boolean {
    return this.clips.has(key);
  }

  /** Every registered key, decoded or not. */
  public get keys(): string[] {
    return [...this.clips.keys()];
  }

  /** The decoded buffer for a key, or `undefined` when its bank is not loaded. */
  public getBuffer(key: string): AudioBuffer | undefined {
    return this.clips.get(key)?.buffer;
  }

  /**
   * Decode every given key that is not already decoded, in parallel. Resolves once they are all
   * resident. A key with no registered bytes is skipped with a warning — that means a manifest
   * entry is missing, which `validate()` also reports statically.
   *
   * Refuses to start when the request would take the store over {@link maxResidentBytes}, so an
   * oversized bank degrades to "some clips silent" rather than to an OOM kill of the WebView.
   */
  public async decodeKeys(keys: readonly string[]): Promise<void> {
    const pending = [...new Set(keys)].filter((key) => {
      const clip = this.clips.get(key);
      if (!clip) {
        console.warn(`[audio] No preloaded bytes for clip '${key}'; it will be silent.`);
        return false;
      }
      return clip.buffer === undefined;
    });
    if (pending.length === 0) {
      return;
    }

    const projected = this.resident + this.estimateBytes(pending);
    if (projected > this.maxResidentBytes) {
      console.warn(
        `[audio] Decoding ${pending.length} clip(s) would take resident PCM to ` +
          `~${mb(projected)} MB, over the ${mb(this.maxResidentBytes)} MB budget. Unload a bank ` +
          'first, or raise AUDIO.maxResidentBytes.',
      );
      return;
    }

    await Promise.all(pending.map((key) => this.decodeOne(key)));
  }

  /**
   * Drop the decoded PCM for these keys. The compressed bytes stay, so re-loading the bank costs a
   * decode and no network. Voices already playing a released buffer hold their own reference and
   * finish normally — this only drops *our* reference.
   */
  public release(keys: readonly string[]): void {
    for (const key of keys) {
      const clip = this.clips.get(key);
      if (!clip) {
        continue;
      }
      if (clip.buffer) {
        this.resident -= clip.measured ?? pcmBytesOf(clip.buffer);
        clip.buffer = undefined;
      }
      if (clip.objectUrl) {
        URL.revokeObjectURL(clip.objectUrl);
        clip.objectUrl = undefined;
      }
      this.decoding.delete(key);
    }
    // Float drift and an unmeasured release can only ever push this slightly negative.
    this.resident = Math.max(0, this.resident);
  }

  /**
   * A `blob:` URL for a clip's compressed bytes, for the **streaming** (music) path — a
   * `MediaElementAudioSourceNode` decodes incrementally instead of holding whole-file PCM, which is
   * what keeps a two-minute music loop (~44 MB decoded) off the budget. The URL is cached and
   * revoked by {@link release}. `null` when the clip has no registered bytes.
   */
  public objectUrlFor(key: string): string | null {
    const clip = this.clips.get(key);
    if (!clip) {
      return null;
    }
    clip.objectUrl ??= URL.createObjectURL(clip.blob);
    return clip.objectUrl;
  }

  /**
   * Whether any of these keys has **no known decoded size** — never decoded, and no manifest hint.
   * Callers that are about to risk memory on an estimate must check this: {@link estimateBytes}
   * can only return a lower bound, and treating an unknown clip as free is how a budget check
   * silently passes at exactly the moment it matters most.
   */
  public hasUnknownSize(keys: readonly string[]): boolean {
    for (const key of new Set(keys)) {
      const clip = this.clips.get(key);
      if (clip && !clip.streamed && clip.measured === undefined && clip.hint === undefined) {
        return true;
      }
    }
    return false;
  }

  /**
   * Approximate decoded bytes these keys would cost, from the measured size where known and the
   * manifest hint otherwise. A key with neither contributes `0`, so this is a **lower bound** —
   * pair it with {@link hasUnknownSize} before using it to authorize anything.
   */
  public estimateBytes(keys: readonly string[]): number {
    let total = 0;
    for (const key of new Set(keys)) {
      const clip = this.clips.get(key);
      if (clip) {
        total += clip.measured ?? clip.hint ?? 0;
      }
    }
    return total;
  }

  /** Decoded PCM currently resident, in bytes. */
  public get residentBytes(): number {
    return this.resident;
  }

  /**
   * Problems with the `pcmBytes` hints, as readable issues.
   *
   * A missing hint is reported once for the whole set rather than per clip, and is a **soft**
   * finding: without it an overlapped swap into that bank falls back to sequential and a declared
   * `transitionsTo` pair cannot be verified, but nothing is unsafe. A hint that disagrees with
   * reality is reported per clip, because that one is a mistake worth fixing.
   *
   * Only clips decoded at least once can be checked against reality, so this sharpens as a session
   * runs — which is why the scaffold surfaces it in a dev overlay and not only in a test.
   */
  public hintIssues(): string[] {
    const issues: string[] = [];
    const missing: string[] = [];
    for (const [key, clip] of this.clips) {
      if (clip.streamed) {
        // Never becomes PCM, so a decoded-size hint would be meaningless.
        continue;
      }
      if (clip.hint === undefined) {
        missing.push(key);
        continue;
      }
      if (clip.measured === undefined) {
        continue;
      }
      const drift = Math.abs(clip.measured - clip.hint) / Math.max(1, clip.measured);
      if (drift > HINT_TOLERANCE) {
        issues.push(
          `Clip '${key}' declares pcmBytes ${clip.hint} but decodes to ${clip.measured} ` +
            `(${Math.round(drift * 100)}% off). Update its manifest entry.`,
        );
      }
    }
    if (missing.length > 0) {
      issues.push(
        `${missing.length} clip(s) have no pcmBytes hint (${missing.slice(0, 5).join(', ')}` +
          `${missing.length > 5 ? ', …' : ''}). An overlapped swap into a bank holding them falls ` +
          'back to sequential, and a declared transitionsTo pair involving them cannot be ' +
          'verified. Harmless otherwise.',
      );
    }
    return issues;
  }

  /** Drop everything, including the compressed bytes. For teardown. */
  public clear(): void {
    this.release(this.keys);
    this.clips.clear();
    this.decoding.clear();
    this.resident = 0;
  }

  private decodeOne(key: string): Promise<AudioBuffer | null> {
    const inflight = this.decoding.get(key);
    if (inflight) {
      return inflight;
    }
    const clip = this.clips.get(key);
    if (!clip) {
      return Promise.resolve(null);
    }

    const promise = clip.blob
      // A fresh ArrayBuffer per decode: decodeAudioData detaches the one it is given.
      .arrayBuffer()
      .then((bytes) => this.decodeBytes(bytes))
      .then((buffer) => {
        this.decoding.delete(key);
        if (!buffer) {
          return null;
        }
        clip.buffer = buffer;
        clip.measured = pcmBytesOf(buffer);
        this.resident += clip.measured;
        return buffer;
      })
      .catch((error: unknown) => {
        // Never throw: a clip that fails to decode degrades to silence, it does not break the game.
        console.warn(`[audio] Failed to decode clip '${key}':`, error);
        this.decoding.delete(key);
        return null;
      });

    this.decoding.set(key, promise);
    return promise;
  }
}

function mb(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(1);
}
