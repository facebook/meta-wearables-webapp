/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Pure, `three`-free asset helpers used by `AssetLoader`. Kept free of any `three` import (and of
 * `import.meta`) so it stays unit-testable in a plain Node environment — the model-format
 * dispatch, URL resolution, and manifest-load orchestration are the parts worth testing, and they
 * need neither a GPU nor the DOM. `AssetLoader.ts` layers the actual Three.js loaders on top of
 * these (binding the real per-type loaders into `loadManifestWith`).
 */

/** A 3D model file format this framework can load. GLB and GLTF share one loader. */
export type ModelFormat = 'gltf' | 'fbx' | 'obj';

/** File extensions this framework loads as textures (2D images). */
const TEXTURE_EXTENSIONS = ['png', 'webp', 'jpg', 'jpeg'] as const;

/** Extract the lowercased file extension from a URL, ignoring any `?query` or `#hash`. */
function extensionOf(url: string): string {
  const pathOnly = url.split(/[?#]/, 1)[0];
  const lastDot = pathOnly.lastIndexOf('.');
  return lastDot === -1 ? '' : pathOnly.slice(lastDot + 1).toLowerCase();
}

/**
 * Pick the model loader to use from a URL's extension. `.glb`/`.gltf` -> `gltf`, `.fbx` -> `fbx`,
 * `.obj` -> `obj`. Throws on anything else so an unsupported asset fails loudly at load time
 * rather than silently producing an empty scene.
 */
export function modelFormatFromUrl(url: string): ModelFormat {
  switch (extensionOf(url)) {
    case 'glb':
    case 'gltf':
      return 'gltf';
    case 'fbx':
      return 'fbx';
    case 'obj':
      return 'obj';
    default:
      throw new Error(
        `Unsupported model format for "${url}". Supported: .glb, .gltf, .fbx, .obj.`,
      );
  }
}

/** True if the URL looks like a texture (2D image) this framework can load. */
export function isTextureUrl(url: string): boolean {
  return (TEXTURE_EXTENSIONS as readonly string[]).includes(extensionOf(url));
}

/** Container extension -> MIME type, for the audio formats a browser can decode. */
const AUDIO_MIME_TYPES: Readonly<Record<string, string>> = {
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg; codecs=opus',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  flac: 'audio/flac',
  weba: 'audio/webm',
  webm: 'audio/webm',
};

/**
 * The MIME type to stamp on an audio clip's `Blob`, or `''` when the extension is unrecognized.
 *
 * `decodeAudioData` sniffs the container and ignores this, so the bank path works either way. The
 * **streaming** path does not: a `<audio>` element playing a `blob:` URL picks its decoder from the
 * Blob's `type`, and a typeless Blob can fail to play. An empty string is the correct fallback —
 * it leaves the browser to sniff, which is no worse than not setting a type at all.
 */
export function audioMimeFromUrl(url: string): string {
  return AUDIO_MIME_TYPES[extensionOf(url)] ?? '';
}

/** An absolute or remote reference: resolved as-is, and never a key in the measured sidecar. */
function isExternalAssetPath(path: string): boolean {
  return /^(https?:)?\/\//.test(path) || path.startsWith('data:') || path.startsWith('/');
}

/**
 * Resolve an asset path to the URL a loader should fetch. Absolute references (`http(s)://`,
 * `data:`, protocol-relative `//`, or a leading `/`) are returned unchanged; everything else is
 * treated as a path relative to the app's public base and joined onto `baseUrl`.
 *
 * `baseUrl` is a parameter (not read from `import.meta.env` here) so this module stays pure and
 * node-testable — callers pass `import.meta.env.BASE_URL`. With Vite's `base: './'`, that base is
 * what makes `public/` assets resolve correctly when the app is served from a sub-path rather
 * than the server root.
 */
export function resolveAssetUrl(path: string, baseUrl: string): string {
  if (isExternalAssetPath(path)) {
    return path;
  }
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}${path.replace(/^\.?\//, '')}`;
}

/**
 * One entry in a preload manifest, discriminated by `type`. `path` is a `public/`-relative (or
 * absolute) asset path — the same thing the individual loaders take. `bytes` is the asset's
 * approximate file size, used **only** to weight the loading progress bar so a bigger asset
 * advances it farther (get it from `ls -l`). It is optional: declare it on every entry for a
 * size-proportional bar, or omit it everywhere for equal per-asset steps (a mix works too — an
 * entry without `bytes` counts as one unit). See `AssetLoader.preloadManifest` and
 * `docs/loading-screen.md`.
 */
export type AssetManifestEntry =
  | { type: 'texture'; path: string; bytes?: number }
  | { type: 'model'; path: string; bytes?: number }
  | { type: 'modelWithAnimations'; path: string; bytes?: number }
  | AudioManifestEntry
  | { type: 'raw'; path: string; bytes?: number };

/**
 * An audio asset. Three shapes, one per way a clip can be held — pick by how the sound is used:
 *
 * | declare | bytes held as | decoded | for |
 * |---|---|---|---|
 * | `bank: 'level_1'` | `Blob` | when that bank loads, freed when it unloads | the normal case for recorded sound |
 * | `stream: true` | `Blob` | never — played from a `blob:` URL | music and long ambiences |
 * | neither | — | eagerly, during preload | a handful of always-needed clips |
 *
 * `path` must match the key the settings resolve for that clip, i.e. `soundsBasePath` + the
 * filename in `clips` — `audio.validate()` reports any clip no manifest entry supplies, and any
 * disagreement between `stream` here and the event's `bus` / `stream` in `audioSettings.json`.
 *
 * `pcmBytes` is the clip's approximate **decoded** size (`channels x frames x 4`, so ~0.37 MB per
 * second of stereo 48 kHz). It is what lets a bank be costed *before* it is decoded, which is what
 * makes the overlapped-swap budget check possible; `validate()` warns when it is missing or more
 * than 10% off the size actually measured. A streamed clip never becomes PCM, so it needs no hint.
 * Distinct from `bytes`, which is the compressed file size and only weights the progress bar.
 * See `docs/audio-banks.md`.
 */
export type AudioManifestEntry = {
  type: 'audio';
  path: string;
  bytes?: number;
  bank?: string;
  /** Hold the bytes for streaming instead of decoding them. Mutually exclusive with `bank`. */
  stream?: boolean;
  pcmBytes?: number;
};

/** One measured audio file, as recorded in the generated `src/audio/audioSizes.json`. */
export interface AudioSizeEntry {
  sha256: string;
  bytes: number;
  /** Absent when the container's duration could not be read; the subsystem treats that as unknown. */
  pcmBytes?: number;
}

/**
 * Fill in `bytes` and `pcmBytes` on every `audio` entry from the generated sidecar.
 *
 * Those two numbers are measurements, not decisions, so they are the one part of a manifest not
 * worth writing by hand — `scripts/audio-sizes.mjs` reads them out of the files and a Vite plugin
 * keeps them current. A measured value **overrides** anything hand-written, because a hand-written
 * one is stale by definition — including the case where the file's format is readable enough for
 * `bytes` but not for `pcmBytes` (MP3, M4A), where a leftover hand-written `pcmBytes` is dropped
 * rather than kept. Trusting the stale one there is the worse failure: it is the number bank
 * costing budgets against, and unknown is handled safely while wrong is not.
 *
 * An entry the sidecar does not cover keeps whatever it was given, and warns in dev — the sidecar
 * is keyed by `public/`-relative path, so a `path` with a typo looks exactly like an unsupported
 * format and would otherwise degrade silently. Absolute and remote paths are exempt: they resolve
 * as-is and are never sidecar keys, so their absence is expected rather than a mistake. See
 * `docs/audio-banks.md`.
 */
export function withAudioSizes<M extends Record<string, AssetManifestEntry>>(
  manifest: M,
  sizes: Readonly<Record<string, AudioSizeEntry>>,
): M {
  const merged: Record<string, AssetManifestEntry> = {};
  for (const [key, entry] of Object.entries(manifest)) {
    if (entry.type !== 'audio') {
      merged[key] = entry;
      continue;
    }
    const measured = sizes[entry.path];
    if (!measured) {
      if (import.meta.env?.DEV && !isExternalAssetPath(entry.path)) {
        console.warn(
          `withAudioSizes: no measurement for audio "${entry.path}". Its sizes stay as declared. ` +
            'The sidecar is keyed by public/-relative path — check for a typo, ' +
            'and re-run `npm run audio-sizes`.',
        );
      }
      merged[key] = entry;
      continue;
    }
    // Within the non-streamed case pcmBytes is assigned unconditionally, so an unreadable
    // duration clears a hand-written one instead of leaving a stale number for bank costing to
    // trust. A `stream: true` clip is played from a blob URL and never decoded, so it has no PCM
    // footprint to hint at — `validate()` treats a bank demanding one as a mismatch, and handing
    // the subsystem a number the contract says the entry should not carry invites that.
    const next = {
      ...entry,
      bytes: measured.bytes,
      pcmBytes: entry.stream ? undefined : measured.pcmBytes,
    };
    // Deleted, not conditionally spread: the assignment above must still overwrite a hand-written
    // `pcmBytes` (that is what stops bank costing trusting a stale number), but leaving the key
    // present holding `undefined` gives the entry a different shape from one that never declared
    // it — visible to `'pcmBytes' in entry`, `Object.keys` and `JSON.stringify`.
    if (next.pcmBytes === undefined) {
      delete next.pcmBytes;
    }
    merged[key] = next;
  }
  return merged as M;
}

/**
 * Progress callback for a manifest load. `fraction` is `0..1` (the weighted share of the manifest
 * that has finished loading); `loaded` / `total` are the underlying weighted byte totals. Fires
 * once after each asset resolves and reaches exactly `1` when every asset is loaded.
 */
export type LoadProgress = (fraction: number, loaded: number, total: number) => void;

/** The progress weight an entry contributes: its declared `bytes`, or `1` when none is given. */
export function entryWeight(entry: AssetManifestEntry): number {
  return entry.bytes ?? 1;
}

/** Default per-asset delay (ms) for a bare `?slowload` with no value. */
const DEFAULT_SLOWLOAD_MS = 800;

/**
 * Parse a `?slowload` debug delay (in ms) from a URL query string, for previewing the loading
 * screen — especially on the glasses, where there's no DevTools to throttle the network (the same
 * on-device rationale as the `?stats` overlay). Returns the per-asset stagger `preloadManifest`
 * should apply, or `0` when off. `?slowload` -> a default delay; `?slowload=1500` -> 1500ms;
 * `?slowload=0` / absent / invalid -> `0`. DOM-free, so it's unit-testable; pass
 * `window.location.search`.
 */
export function loadDelayFromSearch(search: string): number {
  const value = new URLSearchParams(search).get('slowload');
  if (value === null) {
    return 0;
  }
  const ms = value === '' ? DEFAULT_SLOWLOAD_MS : Number(value);
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
}

/**
 * Load every entry in `manifest` via the injected `loadOne`, reporting size-weighted completion
 * progress, and resolve to a record keyed like the manifest. Pure orchestration — no `three` and
 * no DOM — so it stays node-testable; `AssetLoader.preloadManifest` binds the real per-type
 * loaders on top. Loads run concurrently; `onProgress` fires after each entry resolves with the
 * running weighted fraction (`1` once all resolve, or immediately for an empty manifest). If any
 * entry rejects, the returned promise rejects (via `Promise.all`).
 */
export async function loadManifestWith<M extends Record<string, AssetManifestEntry>, R>(
  manifest: M,
  loadOne: (entry: M[keyof M], key: keyof M) => Promise<R>,
  onProgress?: LoadProgress,
): Promise<Record<keyof M, R>> {
  const keys = Object.keys(manifest) as (keyof M)[];
  const total = keys.reduce((sum, key) => sum + entryWeight(manifest[key]), 0);
  const result = {} as Record<keyof M, R>;
  let loaded = 0;
  if (keys.length === 0) {
    onProgress?.(1, 0, 0);
    return result;
  }
  await Promise.all(
    keys.map(async (key) => {
      result[key] = await loadOne(manifest[key], key);
      loaded += entryWeight(manifest[key]);
      onProgress?.(loaded / total, loaded, total);
    }),
  );
  return result;
}
