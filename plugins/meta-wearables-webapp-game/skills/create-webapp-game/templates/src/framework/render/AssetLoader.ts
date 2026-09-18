/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/// <reference types="vite/client" />
/**
 * Loads external art assets — 2D textures (PNG/WebP/JPG) and 3D models (GLB/GLTF/FBX/OBJ) — with
 * Three.js. One of only three files that import `three` (the others are `ThreeRenderer.ts` and the
 * game's `src/models.ts`); the pure URL/format helpers live in the `three`-free `assetFormats.ts`.
 *
 * Loading is async but the render contract is synchronous, so the intended pattern is
 * preload-then-clone: `await` these loaders once at startup (in `main.ts`), then have each
 * `ModelSpec.build()` clone the preloaded object per instance with {@link cloneModel}. See
 * `docs/asset-loading.md`.
 *
 * Skeletal animation has a documented recipe (see `docs/asset-loading.md`): {@link
 * loadModelWithAnimations} returns the clips, {@link cloneModel} clones a rigged model correctly,
 * and the game owns an `AnimationMixer` per instance ticked from the loop.
 *
 * Spritesheets are supported only as far as *windowing*: {@link atlasFrameTexture} and {@link
 * atlasSprite} cut one frame out of a packed sheet (see `docs/spritesheets.md`). There is no
 * atlas-packing or sprite-animation subsystem, and which pixels each frame covers stays game
 * code. Still out of scope: DRACO/KTX2/Meshopt-compressed assets and morph-target animation.
 *
 * For a whole set of assets, {@link preloadManifest} loads a declared manifest into memory up
 * front — pair it with the framework `LoadingScreen` for a progress bar. See
 * `docs/loading-screen.md`.
 */

import * as THREE from 'three';
import { clone as cloneSkeleton } from 'three/examples/jsm/utils/SkeletonUtils.js';

import {
  audioMimeFromUrl,
  loadManifestWith,
  modelFormatFromUrl,
  resolveAssetUrl,
} from '@/framework/render/assetFormats';
import type { AssetManifestEntry, LoadProgress } from '@/framework/render/assetFormats';

// Re-export the manifest surface so a game imports its whole asset-loading API from one module.
export type { AssetManifestEntry, LoadProgress } from '@/framework/render/assetFormats';
export { loadDelayFromSearch, withAudioSizes } from '@/framework/render/assetFormats';
export type { AudioSizeEntry } from '@/framework/render/assetFormats';

/** Resolve after `ms` milliseconds. Used only by `preloadManifest`'s `?slowload` debug stagger. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Once sealed, the loaders below throw — the game preloads all assets up front (before the loop
 * starts) and never loads at runtime. See {@link sealAssetLoaders}.
 */
let loadersSealed = false;

/**
 * Seal the asset loaders: after this, `loadTexture` / `loadModel` / `loadModelWithAnimations` /
 * `preloadManifest` throw. Call it once after preloading, before the game loop starts, to turn an
 * accidental runtime asset load into a loud error instead of a silent network fetch (which would
 * hitch on the glasses). This guards the framework's own loaders; the broader
 * `sealAssetNetwork` (`framework/debug/NetworkGuard.ts`) also catches raw `fetch` / `<img>` /
 * `<audio>` loads. See `docs/loading-screen.md`.
 *
 * Returns an `unseal` callback that re-enables the loaders. A game never needs it (the seal is
 * for the whole session), but it lets a test that seals restore the shared module state in its
 * teardown — mirroring `sealAssetNetwork`, which returns the same kind of restore callback.
 */
export function sealAssetLoaders(): () => void {
  loadersSealed = true;
  return () => {
    loadersSealed = false;
  };
}

function assertLoadersNotSealed(): void {
  if (loadersSealed) {
    throw new Error(
      'Asset loaders are sealed: load assets during preload (before the game loop), not at ' +
        'runtime. Add them to the preload manifest instead. See docs/loading-screen.md.',
    );
  }
}

/** Options for {@link createTexturedPlane}. */
export interface TexturedPlaneOptions {
  /** Plane width in world units. Default 1. */
  width?: number;
  /** Plane height in world units. Default 1. */
  height?: number;
  /** Whether the texture's alpha channel should show through. Default true. */
  transparent?: boolean;
}

/** A loaded 3D model: its root object plus any animation clips the file carried. */
export interface LoadedModel {
  /** The model's root object (a GLTF scene, or the FBX/OBJ group). */
  object: THREE.Object3D;
  /** Animation clips bundled in the file (empty for formats/files without them, e.g. OBJ). */
  animations: THREE.AnimationClip[];
}

/** Resolve a `public/`-relative (or absolute) asset path to the URL a loader should fetch. */
function assetUrl(path: string): string {
  return resolveAssetUrl(path, import.meta.env.BASE_URL);
}

/**
 * Load a 2D image as a texture. Handles PNG, WebP, and JPG. The texture is tagged sRGB so its
 * colors render correctly; pair it with an unlit material (see {@link createTexturedPlane}).
 */
export async function loadTexture(path: string): Promise<THREE.Texture> {
  assertLoadersNotSealed();
  const texture = await new THREE.TextureLoader().loadAsync(assetUrl(path));
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Load a 3D model and return its root object plus its animation clips. The loader is chosen from
 * the file extension (`.glb`/`.gltf` -> GLTF, `.fbx` -> FBX, `.obj` -> OBJ) and imported
 * dynamically so a game that loads only textures never pays for the (large) model loaders in its
 * main bundle. Use this (over {@link loadModel}) when you need the clips for skeletal animation.
 */
export async function loadModelWithAnimations(path: string): Promise<LoadedModel> {
  assertLoadersNotSealed();
  const url = assetUrl(path);
  switch (modelFormatFromUrl(path)) {
    case 'gltf': {
      const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
      const gltf = await new GLTFLoader().loadAsync(url);
      return { object: gltf.scene, animations: gltf.animations };
    }
    case 'fbx': {
      const { FBXLoader } = await import('three/examples/jsm/loaders/FBXLoader.js');
      const object = await new FBXLoader().loadAsync(url);
      return { object, animations: object.animations };
    }
    case 'obj': {
      const { OBJLoader } = await import('three/examples/jsm/loaders/OBJLoader.js');
      const object = await new OBJLoader().loadAsync(url);
      return { object, animations: [] };
    }
  }
}

/**
 * Load a 3D model and return just its root object. Thin wrapper over
 * {@link loadModelWithAnimations} for the common case where you don't need the animation clips.
 */
export async function loadModel(path: string): Promise<THREE.Object3D> {
  return (await loadModelWithAnimations(path)).object;
}

/**
 * Clone a loaded model for a per-instance copy. Uses Three.js's `SkeletonUtils.clone`, which — 
 * unlike `Object3D.clone()` — rebinds any `SkinnedMesh` to a freshly cloned skeleton. A plain
 * `.clone()` leaves the clone's skinned meshes driven by the SOURCE skeleton, so the clone renders
 * at the source's location and **won't follow its own transform or animate independently**. This
 * helper works for static models too, so it's the right default for cloning in `build()`.
 *
 * Note: like `Object3D.clone()`, the clone SHARES geometry and materials with the source; that's
 * fine unless you dispose per-instance (see the disposal notes in `docs/asset-loading.md`).
 */
export function cloneModel(object: THREE.Object3D): THREE.Object3D {
  return cloneSkeleton(object);
}

/**
 * Build a flat, camera-facing quad textured with a loaded image — the basic 2D sprite primitive.
 * Uses an unlit `MeshBasicMaterial` (the additive-display scene has no lights) so the texture
 * shows at full brightness. Clone the returned mesh (and its material, if you tint per instance)
 * for each sprite; see the preload-then-clone pattern in `docs/asset-loading.md`.
 */
export function createTexturedPlane(
  texture: THREE.Texture,
  { width = 1, height = 1, transparent = true }: TexturedPlaneOptions = {},
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent });
  return new THREE.Mesh(geometry, material);
}

/**
 * A frame's rectangle inside a spritesheet, in pixels measured from the sheet's **top-left** —
 * the convention every image editor, sprite packer and `magick -crop` reports. Converting that
 * to Three.js's bottom-up texture space is {@link atlasFrameTexture}'s job.
 */
export interface AtlasFrame {
  /** Left edge, in pixels from the sheet's left. */
  x: number;
  /** Top edge, in pixels from the sheet's top. */
  y: number;
  /** Frame width in pixels. */
  w: number;
  /** Frame height in pixels. */
  h: number;
}

/**
 * Window a loaded spritesheet down to one frame, returning a cloned `THREE.Texture` whose
 * `offset` / `repeat` select `frame`. The sheet's own size is read from `sheet.image`, so a frame
 * table only ever carries pixel rects — a hand-transcribed sheet dimension that is wrong by one
 * pixel shifts and rescales every frame on the sheet.
 *
 * Cloning is what makes per-frame windowing work at all: `offset` / `repeat` live on the
 * `THREE.Texture`, not the material, so sprites that share one texture share one window (the
 * whole sheet shows the frame set last). The clone is cheap — `Texture.copy` assigns
 * `this.source = source.source`, and the renderer keys its `WebGLTexture` cache on the `Source`
 * plus the sampler parameters, of which `offset` / `repeat` are not part
 * (`WebGLTextures.getTextureCacheKey`, three 0.184.0). Forty frames are forty small objects over
 * one upload of the image.
 *
 * Two consequences worth knowing at the call site:
 *
 * - **Never set `needsUpdate` to re-window.** `offset` / `repeat` feed `texture.matrix`, which the
 *   renderer refreshes every frame while `matrixAutoUpdate` is on (the default). Setting
 *   `needsUpdate` in a loop re-uploads the whole sheet each frame.
 * - **Dispose the frames, not just the sheet.** The shared upload is reference-counted per
 *   (`Source`, sampler-parameter) pair — `usedTimes` in `WebGLTextures.initTexture` /
 *   `deallocateTexture` — so disposing one frame does not pull the image out from under its
 *   siblings; the `WebGLTexture` is deleted only when the last frame using it goes. Conversely,
 *   disposing only the sheet frees nothing when the sheet itself was never rendered:
 *   `deallocateTexture` returns early for a texture the renderer never uploaded.
 *
 * Throws if `sheet` has no decoded image yet (`loadTexture` / `preloadManifest` not awaited), or if
 * `frame` is not a finite rect inside it — either would otherwise yield a silently wrong window,
 * which is the failure this helper exists to prevent. See `docs/spritesheets.md`.
 */
export function atlasFrameTexture(sheet: THREE.Texture, frame: AtlasFrame): THREE.Texture {
  const image = sheet.image as { width?: number; height?: number } | null | undefined;
  const sheetWidth = image?.width ?? 0;
  const sheetHeight = image?.height ?? 0;
  if (sheetWidth <= 0 || sheetHeight <= 0) {
    throw new Error(
      'atlasFrameTexture: the sheet texture has no decoded image, so its pixel size is unknown. ' +
        'Await loadTexture()/preloadManifest() and cut frames from the resolved texture.',
    );
  }
  const { x, y, w, h } = frame;
  // Non-finite values are rejected before the bounds test, not by it: every comparison with `NaN`
  // is false, so a frame computed from bad metadata (`sheetWidth / 0`, a missing JSON field) would
  // pass the bounds test and window the sprite to `NaN`.
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(w) || !Number.isFinite(h)) {
    throw new Error(
      `atlasFrameTexture: frame {x:${x}, y:${y}, w:${w}, h:${h}} is not a finite pixel rect. ` +
        'Check the arithmetic or the atlas metadata the rect came from.',
    );
  }
  if (w <= 0 || h <= 0 || x < 0 || y < 0 || x + w > sheetWidth || y + h > sheetHeight) {
    throw new Error(
      `atlasFrameTexture: frame {x:${x}, y:${y}, w:${w}, h:${h}} does not fit inside the ` +
        `${sheetWidth}x${sheetHeight} sheet. Rects are in pixels from the sheet's top-left; ` +
        "check the cell size against the sheet's real dimensions.",
    );
  }

  const texture = sheet.clone();
  // `1 - (y + h) / sheetHeight` turns the frame's bottom pixel row into a bottom-up V coordinate:
  // TextureLoader leaves `flipY` true, so V = 1 is the sheet's top row. U needs no flip.
  texture.offset.set(x / sheetWidth, 1 - (y + h) / sheetHeight);
  texture.repeat.set(w / sheetWidth, h / sheetHeight);
  return texture;
}

/**
 * Build a quad showing one frame of a spritesheet — {@link atlasFrameTexture} plus
 * {@link createTexturedPlane}. Cut each frame **once**, when the model catalog is built, not
 * inside a per-instance `build()`.
 *
 * `width` / `height` size the quad to the frame's **cell**, padding included. Where the frame's
 * art is smaller than its cell (most packed sheets), scale by the inverse of the fill ratio so the
 * silhouette lands at the size you asked for — see `docs/spritesheets.md`.
 */
export function atlasSprite(
  sheet: THREE.Texture,
  frame: AtlasFrame,
  options: TexturedPlaneOptions = {},
): THREE.Mesh {
  return createTexturedPlane(atlasFrameTexture(sheet, frame), options);
}

/**
 * The in-memory asset a manifest entry loads to, by its `type`. An `audio` entry **with a `bank`**
 * yields the raw `Blob` (the audio subsystem holds it and decodes on `loadBank`); without one it
 * yields a decoded `AudioBuffer`, as it always has.
 */
export type LoadedAsset<E extends AssetManifestEntry> = E extends { type: 'texture' }
  ? THREE.Texture
  : E extends { type: 'model' }
    ? THREE.Object3D
    : E extends { type: 'modelWithAnimations' }
      ? LoadedModel
      : E extends { type: 'audio'; bank: string }
        ? Blob
        : E extends { type: 'audio'; stream: true }
          ? Blob
          : E extends { type: 'audio' }
            ? AudioBuffer
            : E extends { type: 'raw' }
              ? ArrayBuffer
              : never;

/**
 * How `preloadManifest` hands audio to the audio subsystem. The framework's `AudioPlayer` does not
 * belong to the render layer, so the loader takes this narrow sink as an argument rather than
 * importing it — pass the `AmpAudioPlayer` itself (it implements both methods; see `main.ts` and
 * `docs/audio.md`).
 *
 * Both run during preload on a still-suspended `AudioContext`, so the loading-screen progress bar
 * covers them.
 */
export interface AudioAssetSink {
  /**
   * Register a clip's compressed bytes. Nothing is decoded here: a bank-backed clip decodes when
   * its bank loads, and a `streamed` one never does.
   */
  storeClip(key: string, blob: Blob, options?: { pcmBytes?: number; streamed?: boolean }): void;
  /** Decode a clip eagerly into an `AudioBuffer` the game holds itself. */
  decode(bytes: ArrayBuffer): Promise<AudioBuffer | null>;
}

/** Fetch a file's raw bytes into memory (used by both `raw` and `audio` entries). */
async function fetchBytes(path: string): Promise<ArrayBuffer> {
  const response = await fetch(assetUrl(path));
  if (!response.ok) {
    throw new Error(`Failed to fetch "${path}": ${response.status} ${response.statusText}`);
  }
  return response.arrayBuffer();
}

/** Load one manifest entry into memory, dispatching on its `type`. */
async function loadManifestEntry(
  entry: AssetManifestEntry,
  audio?: AudioAssetSink,
): Promise<unknown> {
  switch (entry.type) {
    case 'texture':
      return loadTexture(entry.path);
    case 'model':
      return loadModel(entry.path);
    case 'modelWithAnimations':
      return loadModelWithAnimations(entry.path);
    case 'audio': {
      if (!audio) {
        throw new Error(
          `Manifest has an "audio" entry ("${entry.path}") but no audio sink was provided. Pass ` +
            'the AmpAudioPlayer as the 4th argument to preloadManifest. See docs/audio.md.',
        );
      }
      const bytes = await fetchBytes(entry.path);
      if (entry.bank === undefined && entry.stream !== true) {
        // Decode now into an AudioBuffer the game holds. Right for a handful of always-needed
        // clips; a game with real audio uses banks instead.
        return audio.decode(bytes);
      }
      // Keep the COMPRESSED bytes. Decoded PCM is ~30x the size of the Ogg, so a bank decoding on
      // demand is the difference between holding a level's audio and holding the whole game's, and
      // a streamed clip never pays that cost at all. See `docs/audio-banks.md`.
      //
      // The MIME type matters for the streamed path: a <audio> element playing a blob: URL picks
      // its decoder from the Blob's type. `decodeAudioData` sniffs the bytes and ignores it.
      const blob = new Blob([bytes], { type: audioMimeFromUrl(entry.path) });
      audio.storeClip(entry.path, blob, {
        pcmBytes: entry.pcmBytes,
        streamed: entry.stream === true,
      });
      return blob;
    }
    case 'raw': {
      // Download the whole file into memory and hand back its bytes — no reliance on the browser
      // cache. The game keeps the ArrayBuffer and uses it later (e.g. `new Blob([buf])` +
      // `URL.createObjectURL` for <img>, or `TextDecoder`+`JSON.parse`). For audio, prefer the
      // first-class `audio` entry above (decodes to an AudioBuffer). See `docs/loading-screen.md`.
      return fetchBytes(entry.path);
    }
  }
}

/**
 * Load every asset in `manifest` into memory up front, reporting size-weighted progress, and
 * resolve to a record keyed like the manifest — each key holding its loaded asset (`texture` ->
 * `THREE.Texture`, `model` -> `THREE.Object3D`, `modelWithAnimations` -> {@link LoadedModel},
 * `raw` -> `ArrayBuffer`). That returned record IS the game's in-memory asset store: hold it for
 * the game's lifetime and read assets by key; dispose GPU resources on teardown (see
 * `docs/asset-loading.md` § Disposal).
 *
 * Progress is weighted by each entry's declared `bytes` (a bigger asset advances the bar farther);
 * see {@link AssetManifestEntry}. Loads run concurrently and the promise rejects if any asset
 * fails. Pair with the framework `LoadingScreen`:
 *
 * ```ts
 * const loading = new LoadingScreen({ mount: gameRoot, label: t('loading') });
 * const assets = await preloadManifest(MANIFEST, (fraction) => loading.setProgress(fraction));
 * loading.dispose();
 * ```
 *
 * Declare the manifest with `as const satisfies Record<string, AssetManifestEntry>` so each
 * entry's `type` stays a literal and the returned asset types are precise. See
 * `docs/loading-screen.md`.
 *
 * `delayMs` (default `0`) staggers each asset's load start by `index * delayMs` so the progress
 * bar visibly steps — a debug aid for previewing the loading screen (including on the glasses,
 * where DevTools can't throttle). Wire it from `loadDelayFromSearch(window.location.search)` so a
 * `?slowload` query string turns it on; it's `0` (no effect) otherwise. See `docs/loading-screen.md`.
 *
 * `audio` receives any `{ type: 'audio' }` entries — pass the `AmpAudioPlayer` (see
 * `docs/audio.md`). It's optional: omit it for a manifest with no `audio` entries.
 */
export async function preloadManifest<M extends Record<string, AssetManifestEntry>>(
  manifest: M,
  onProgress?: LoadProgress,
  delayMs = 0,
  audio?: AudioAssetSink,
): Promise<{ [K in keyof M]: LoadedAsset<M[K]> }> {
  assertLoadersNotSealed();
  // Assign each asset an index in manifest order (synchronous in `loadManifestWith`'s map, before
  // its first await) and stagger the load start by index * delayMs — spacing out the concurrent
  // loads so the bar steps visibly. `delayMs === 0` skips the sleep entirely (zero cost).
  let index = 0;
  const load = async (entry: AssetManifestEntry): Promise<unknown> => {
    const wait = index++ * delayMs;
    if (wait > 0) {
      await sleep(wait);
    }
    return loadManifestEntry(entry, audio);
  };
  return loadManifestWith(manifest, load, onProgress) as Promise<{
    [K in keyof M]: LoadedAsset<M[K]>;
  }>;
}
