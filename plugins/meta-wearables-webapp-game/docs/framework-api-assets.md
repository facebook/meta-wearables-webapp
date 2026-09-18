# Framework API — asset loading and the loading screen

The preload-time surface: windowing spritesheet frames, loading a whole manifest up front, the
progress overlay shown while it loads, and the guards that make a stray runtime load fail loudly.
Part of the [framework API reference](framework-api.md).

`AssetLoader.ts` wraps the Three.js loaders (one of the three files that import `three`); the
pure, `three`-free URL/format/manifest helpers live in `assetFormats.ts`. The per-asset loaders
(`loadTexture`, `loadModel`, `loadModelWithAnimations`, `cloneModel`, `createTexturedPlane`) and
the preload-then-clone pattern are documented in [`asset-loading.md`](asset-loading.md); the
spritesheet-windowing pair below is documented in [`spritesheets.md`](spritesheets.md), and the
manifest + progress API below is documented in full in [`loading-screen.md`](loading-screen.md).

## Spritesheet frames — `atlasFrameTexture` & `atlasSprite`

```ts
interface AtlasFrame {
  /** Left edge, in pixels from the sheet's left. */
  x: number;
  /** Top edge, in pixels from the sheet's top. */
  y: number;
  /** Frame width in pixels. */
  w: number;
  /** Frame height in pixels. */
  h: number;
}

atlasFrameTexture(sheet: THREE.Texture, frame: AtlasFrame): THREE.Texture;

atlasSprite(
  sheet: THREE.Texture,
  frame: AtlasFrame,
  options?: TexturedPlaneOptions,   // same { width, height, transparent } as createTexturedPlane
): THREE.Mesh;
```

Window one frame out of a packed sheet. `atlasFrameTexture` returns a **cloned** `THREE.Texture`
with `offset` / `repeat` set from the pixel rect — cloning is required because those live on the
texture, not the material, so sprites sharing one texture all show the frame set last.
`atlasSprite` is that plus `createTexturedPlane`. The rect is measured from the sheet's
**top-left**; the sheet's own size is read from `sheet.image`, never passed in. Both **throw** on
a sheet with no decoded image (an un-awaited load) or a rect that is not a finite rect inside it,
since a wrong window is invisible to every static check. Clones share the sheet's `Source`, so N frames cost one
GPU upload — reference-counted, so dispose the frames rather than only the sheet. Sizing the quad
to the art's measured silhouette (rather than its cell) is still the game's job: see
[`spritesheets.md`](spritesheets.md).

## `preloadManifest`

```ts
type AssetManifestEntry =
  | { type: 'texture'; path: string; bytes?: number }
  | { type: 'model'; path: string; bytes?: number }
  | { type: 'modelWithAnimations'; path: string; bytes?: number }
  | { type: 'audio'; path: string; bytes?: number }
  | { type: 'raw'; path: string; bytes?: number };

type LoadProgress = (fraction: number, loaded: number, total: number) => void;
interface AudioAssetSink {                    // AmpAudioPlayer implements this
  storeClip(key: string, blob: Blob, options?: { pcmBytes?: number; streamed?: boolean }): void;
  decode(bytes: ArrayBuffer): Promise<AudioBuffer | null>;
}

preloadManifest<M extends Record<string, AssetManifestEntry>>(
  manifest: M,
  onProgress?: LoadProgress,
  delayMs?: number,           // debug: stagger each load by index × delayMs (default 0)
  audio?: AudioAssetSink,     // receives { type: 'audio' } entries — pass the AmpAudioPlayer
): Promise<{ [K in keyof M]: LoadedAsset<M[K]> }>;

loadDelayFromSearch(search: string): number;   // parse ?slowload from window.location.search
```

Loads a whole manifest into memory up front and resolves to a record keyed like the manifest —
`texture` → `THREE.Texture`, `model` → `THREE.Object3D`, `modelWithAnimations` → `LoadedModel`,
`raw` → `ArrayBuffer`. An `audio` entry with a `bank` **or** `stream: true` → `Blob` (bytes held
compressed; a bank decodes them later, a stream never does); with neither → `AudioBuffer` (decoded
eagerly). Either way, pass the
`AmpAudioPlayer` as the `audio` argument — a manifest with an `audio` entry and no sink throws. See
[audio-banks.md](audio-banks.md). The returned record **is** the in-memory asset store (hold it for the
game's lifetime). Loads run concurrently; the promise rejects if any asset fails. Progress is
**size-weighted** by each entry's optional `bytes` and reported per asset as it finishes (reaching
exactly `1`); it does not rely on the browser cache. Declare the manifest with `as const satisfies
Record<string, AssetManifestEntry>` for precise return types. `AssetManifestEntry` and
`LoadProgress` are re-exported from `AssetLoader.ts`. The pure orchestration (`loadManifestWith`,
`entryWeight`) lives in `assetFormats.ts` and is unit-tested there.

The optional `delayMs` staggers each asset's load start by `index × delayMs` so the progress bar
steps visibly — a debug aid, `0` (no effect) by default. Drive it from `loadDelayFromSearch(
window.location.search)` (re-exported from `AssetLoader.ts`; also in `assetFormats.ts`) so a
`?slowload` query string turns it on — the on-device way to preview the loading screen, since the
glasses browser can't be throttled via DevTools. See
[loading-screen.md § Previewing](loading-screen.md#previewing-the-loading-screen-slowload).

## `LoadingScreen`

`framework/ui/LoadingScreen.ts` — a framework-provided, **display-only** DOM overlay (progress
bar) shown on first load before the title screen, so games don't write their own. Like the HUD and
`PerfOverlay`, it writes `style` / `textContent` and adds **no** listeners (satisfies the
no-input-through-DOM rule) and styles itself inline (so the framework re-sync carries it whole).
Its opaque-black backdrop occludes the title/HUD while loading and reads as transparent on the
additive display; disposing it reveals the title screen.

```ts
new LoadingScreen(options?: { mount?: HTMLElement; label?: string });
// mount defaults to document.body (scaffold passes #game-root);
// label is the localized caption, injected via t('loading') (default 'Loading…').
```

| Member | Semantics |
|--------|-----------|
| `setProgress(fraction)` | Set the bar fill from a `0..1` fraction (clamped). Feed it the `preloadManifest` progress. |
| `showError(message)` | Swap the bar for an error message (pass `t('loadError')`) so a failed load isn't a silent black screen. |
| `dispose()` | Remove the overlay — reveals the title screen underneath. |

## Enforcing preload-only loading — `sealAssetLoaders` & `sealAssetNetwork`

Two opt-in guards that make an accidental **runtime** asset load fail loudly instead of hitching
the game (see [loading-screen.md § Enforcing](loading-screen.md#enforcing-preload-only-no-runtime-loads)).
Call both in `main.ts` right after the loading screen disposes, before the loop starts.

```ts
// AssetLoader.ts — after this, loadTexture/loadModel/loadModelWithAnimations/preloadManifest throw.
sealAssetLoaders(): () => void;   // returns unseal() (mainly for tests/teardown), like sealAssetNetwork

// framework/debug/NetworkGuard.ts — patch fetch / XMLHttpRequest / <img> & media `src`.
sealAssetNetwork(options?: {
  strict?: boolean;                 // throw instead of warn. Default false.
  allow?: (url: string) => boolean; // permit an intended runtime endpoint (e.g. an API)
}): () => void;                     // returns unseal() (mainly for tests/teardown)

strictSealRequested(search: string): boolean; // parse ?strict (like statsOverlayRequested)
isInMemoryUrl(url: string): boolean;          // true for blob:/data: — a preloaded asset, never flagged
```

`sealAssetNetwork` always permits `blob:` / `data:` URLs (in-memory preloaded assets, e.g. audio
played from a `raw` ArrayBuffer), warns by default (safe in production), and no-ops when there's no
DOM. Drive `strict` from `strictSealRequested(window.location.search)` so the `?strict` flag toggles
it (same convention as `?stats` / `?slowload` — see [query-parameters.md](query-parameters.md)).
`sealAssetLoaders` guards the framework's own loaders; the static `network-loads` check
(`npm run validate`) covers gameplay source. A game that legitimately loads at runtime simply
doesn't call these.

## The service worker — `registerGameServiceWorker` & friends

`framework/sw/` precaches the build so a second launch reads it off disk and the game runs offline.
It is wired in the scaffold already; the only call a game makes is the first one below. The full
feature — what gets precached, how a republish invalidates, the serving strategy — is
[`offline-caching.md`](offline-caching.md).

```ts
// framework/sw/register.ts — runs in the page.
registerGameServiceWorker(options?: {
  scriptUrl?: string;   // resolved against the document. Default 'sw.js'.
  search?: string;      // default window.location.search
  enabled?: boolean;    // default: on unless this is a Vite dev build
}): Promise<ServiceWorkerRegistration | null>;

swResetRequested(search: string): boolean;                        // parse ?swreset (like ?strict)
resetServiceWorker(): Promise<{ workers: number; caches: number }>;
```

**Never `await` `registerGameServiceWorker`** — precaching benefits the *next* launch, so blocking
startup on it worsens the metric it exists to improve. `main.ts` calls it as
`void registerGameServiceWorker({ search })`. It resolves to `null` rather than throwing whenever it
is skipped or fails (no `serviceWorker`, a dev build, an insecure context such as the single-file
artifact, or a missing `sw.js`), because a game must behave identically with no worker at all. When
`?swreset` is set it wipes every worker and cache, then reloads with the flag stripped.

```ts
// framework/sw/precache.ts — the engine, running inside the worker.
interface PrecacheEntry { url: string; rev: string; shell?: boolean }
interface PrecacheDeps { caches: CacheStorage; fetch: …; onWarn?: (m: string) => void }

installPrecache(entries, build, baseUrl, deps, concurrency?): Promise<PrecacheResult>;
activatePrecache(build, deps): Promise<string[]>;   // returns the evicted cache names
matchPrecached(url, index, build, deps): Promise<Response | undefined>;
buildPrecacheIndex(entries, baseUrl): Map<string, string>;
```

`PrecacheDeps` is why every function takes its `CacheStorage` and `fetch` instead of reading the
globals: the engine is unit-tested in plain Node with fakes. `entries` and `build` are injected into
`dist/sw.js` at build time by `scripts/vite-service-worker.mjs`, which scans the finished build —
game code never constructs them. `installPrecache` carries entries whose `rev` is unchanged across
from the previous build's cache instead of refetching them, and **rejects** only if a `shell` entry
failed.
