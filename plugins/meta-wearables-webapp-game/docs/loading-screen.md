# Preloading with a loading screen (progress bar)

A game that loads art or media usually wants to pull **everything into memory before play
starts** — no mid-game hitches — and show the player a **progress bar** while it happens. The
framework ships both halves so you don't hand-write a loading UI:

- **`preloadManifest`** (`src/framework/render/AssetLoader.ts`) — loads a declared manifest of
  assets into memory, reporting **size-weighted** progress.
- **`LoadingScreen`** (`src/framework/ui/LoadingScreen.ts`) — a display-only DOM overlay with a
  progress bar, shown on first load **before** the title screen.

This is **opt-in**: a procedural game (or one with no assets) needs none of it. It builds directly
on the preload-then-clone pattern in [`asset-loading.md`](asset-loading.md) — read that first if
you load textures or 3D models.

## Everything stays in memory (no cache reliance)

This system **downloads each asset once and keeps it in memory** for the game's lifetime; it does
**not** rely on the browser's HTTP cache. That means behavior is identical on the Vite dev server
and behind any host's cache policy.

> Still true, with one thing worth knowing: a built game ships a **service worker** that precaches
> the whole build, so from the second launch on those "downloads" are served off disk rather than
> the network. Nothing here changes — the manifest is loaded the same way, in the same order, with
> the same progress — it is just no longer network-bound. The worker never holds decoded assets;
> that is this layer's job. See [`offline-caching.md`](offline-caching.md). The trade-off: **size your manifest to fit the memory budget**
(< 128 MB — see [`performance-guidelines.md`](performance-guidelines.md)); nothing is freed until
you tear the game down. Dispose GPU resources on teardown as described in
[asset-loading.md § Disposal](asset-loading.md#disposal); `ArrayBuffer`s from `raw` entries are
garbage-collected once you drop references to them.

## The manifest

A manifest is a plain object; each entry declares a `type`, a `public/`-relative `path` (the same
path the individual loaders take — see [asset-loading.md § Where assets
live](asset-loading.md#where-assets-live-vite-conventions)), and an optional `bytes` size hint.

| `type` | Loaded via | Resolves to |
|--------|-----------|-------------|
| `texture` | `loadTexture` | `THREE.Texture` |
| `model` | `loadModel` | `THREE.Object3D` |
| `modelWithAnimations` | `loadModelWithAnimations` | `LoadedModel` (`{ object, animations }`) |
| `audio` (with `bank`) | the audio subsystem (pass the `AmpAudioPlayer`) | `Blob` — bytes held compressed; the named bank decodes them later. The normal case. See [audio-banks.md](audio-banks.md) |
| `audio` (no `bank`) | the audio subsystem | `AudioBuffer` — decoded eagerly. For a handful of always-needed clips |
| `raw` | `fetch(...).arrayBuffer()` | `ArrayBuffer` (bytes held in memory) |

Declare it with **`as const satisfies Record<string, AssetManifestEntry>`** so each entry's `type`
stays a literal — that's what makes the returned asset types precise (a `texture` key comes back
typed as `THREE.Texture`, not a union):

```ts
import type { AssetManifestEntry } from '@/framework/render/AssetLoader';

export const MANIFEST = {
  hero: { type: 'texture', path: 'sprites/hero.png', bytes: 24_500 },
  ship: { type: 'model', path: 'models/ship.glb', bytes: 512_000 },
  theme: { type: 'audio', path: 'audio/theme.mp3', bytes: 1_800_000 },
} as const satisfies Record<string, AssetManifestEntry>;
```

### Size-weighted progress

The bar advances **proportionally to each entry's `bytes`**, so a large asset moves it farther
than a small one. `bytes` is only a progress weight — an approximate file size is fine. Get exact
sizes from the files you ship:

```bash
# bytes per file under public/
find public -type f -printf '%s\t%p\n'   # GNU; or: stat -f '%z %N' public/**/*  (macOS)
```

`bytes` is **optional**: declare it on every entry for a size-proportional bar, omit it everywhere
for equal per-asset steps, or mix (an entry without `bytes` counts as one unit). Progress is
reported **per asset as it finishes** (not byte-streamed) — deterministic and reliable across all
loader types, unlike Three.js byte callbacks, which many responses and `<img>`-based texture loads
report poorly.

## Loading the manifest

`preloadManifest(manifest, onProgress?)` returns a record keyed exactly like the manifest, each
key holding its loaded asset. **That record is your in-memory asset store** — hold it for the
game's lifetime and read assets by key.

```ts
import { preloadManifest } from '@/framework/render/AssetLoader';

const assets = await preloadManifest(MANIFEST, (fraction) => {
  // fraction is 0..1; also receives (fraction, loaded, total) weighted byte totals.
});

assets.hero;   // THREE.Texture
assets.ship;   // THREE.Object3D
assets.theme;  // AudioBuffer (an `audio` entry decodes at preload — needs the decoder, see below)
```

Loads run concurrently; the promise **rejects if any asset fails** (surface it — see the wiring
below — so a failure isn't a silent black screen).

### Audio: fetch at preload, decode per bank

Audio is the one asset type where **what you preload and what you hold are different things**.
Decoded PCM is roughly 30× the size of the Ogg it came from, so a manifest entry normally carries a
`bank` and the loader keeps the *compressed* bytes; the named bank decodes them when the game loads
it and frees the PCM when it unloads it. Nothing is fetched at runtime either way.

Pass the `AmpAudioPlayer` itself as `preloadManifest`'s **fourth** argument — it is the audio sink
(a manifest with an `audio` entry and no sink throws):

```ts
const audio = new AmpAudioPlayer<SoundId>(AUDIO_SETTINGS, AUDIO);
const assets = await preloadManifest(
  MANIFEST,
  (fraction) => loading.setProgress(fraction),
  loadDelayFromSearch(window.location.search),
  audio,                                   // receives every { type: 'audio' } entry
);
await audio.init({ initialBanks: ['level_1'] });
audio.play('theme');
```

The clips are named in `src/audio/audioSettings.json`, not in code — a manifest entry's `path` must
match the key the settings resolve (`soundsBasePath` + the filename in `clips`), and
`audio.validate()` reports any clip nothing supplies.

Decoding runs on the still-suspended context (only playback needs a user gesture), so the progress
bar covers whatever the initial banks decode. Budget for it: the default ceiling on resident PCM is
24 MB (`AUDIO.maxResidentBytes`), and a `loadBank` past it is refused with a warning rather than
risking an out-of-memory kill. See [audio-banks.md](audio-banks.md) for the memory model and
[audio.md](audio.md) for buses, spatialization, and synthesis.

### Using `raw` bytes later

`raw` gives you an `ArrayBuffer` in memory — for JSON, binary level data, or an image blob. Turn it
into whatever the API at the point of use wants — no network, no cache dependence. (For audio,
prefer the first-class `audio` entry above; use `raw` only if you need the undecoded bytes.)

```ts
// Image via an object URL:
const url = URL.createObjectURL(new Blob([assets.icon]));
const image = new Image();
image.src = url;                 // later, when done: URL.revokeObjectURL(url);

// JSON:
const data = JSON.parse(new TextDecoder().decode(assets.levels));
```

## The `LoadingScreen`

```ts
new LoadingScreen(options?: {
  mount?: HTMLElement;   // where to append; defaults to document.body. Scaffold passes #game-root.
  label?: string;        // the "Loading…" caption, localized — pass t('loading'). Default 'Loading…'.
});
```

| Method | Semantics |
|--------|-----------|
| `setProgress(fraction)` | Set the bar fill from a `0..1` fraction (clamped). Feed it the `preloadManifest` progress. |
| `showError(message)` | Replace the bar with an error message (pass `t('loadError')`) so a failed load isn't a silent black screen. |
| `dispose()` | Remove the overlay from the DOM — call once assets are ready, which **reveals the title screen underneath**. |

It's a **display-only** overlay (like the HUD and the `?stats` `PerfOverlay`): it writes
`style` / `textContent` and adds **no** event listeners, so it satisfies the [no-input-through-DOM
rule](game-architecture.md#input-must-not-flow-through-the-dom-enforced). Its backdrop is opaque
black — it occludes the title screen / HUD in DOM compositing while loading, and reads as
transparent (real world) on the additive waveguide; only the bright label and bar emit light. It
mounts inside the 600x600 stage (`#game-root`) at a high z-index and styles itself **inline** so
the `update-webapp-game-framework` re-sync (which copies only `src/framework/`) carries
it whole.

The scaffold ships `loading` and `loadError` keys in `src/i18n/en.json`; add your own copy there.

## Wiring it in `main.ts`

Show the loading screen first, preload, dispose it (revealing the title), then wire the renderer
and input exactly as the starter does. Because input is attached **after** the preload, the game
can't be started mid-load.

```ts
import '@/i18n';

import { AUDIO_SETTINGS, type SoundId } from '@/audio/soundIds';
import { AUDIO, DISPLAY, INPUT, LOOP } from '@/config/gameplayConstants';
import { Game } from '@/core/Game';
import { AmpAudioPlayer } from '@/framework/audio/AmpAudioPlayer';
import { muteRequested } from '@/framework/audio/AudioEngine';
import { GameLoop } from '@/framework/core/GameLoop';
import { applyStaticTranslations } from '@/framework/i18n/i18n';
import { PointerKeyboardInput } from '@/framework/input/PointerKeyboardInput';
import { loadDelayFromSearch, preloadManifest, sealAssetLoaders } from '@/framework/render/AssetLoader';
import { sealAssetNetwork, strictSealRequested } from '@/framework/debug/NetworkGuard';
import { ThreeRenderer } from '@/framework/render/ThreeRenderer';
import { LoadingScreen } from '@/framework/ui/LoadingScreen';
import { Hud } from '@/hud/Hud';
import { t } from '@/i18n';
import { MANIFEST } from '@/manifest';    // your as-const manifest
import { buildModels } from '@/models';   // build the catalog from loaded assets

async function main(): Promise<void> {
  applyStaticTranslations();

  const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
  const gameRoot = document.querySelector<HTMLElement>('#game-root');
  if (!canvas || !gameRoot) {
    throw new Error('Missing #game-canvas / #game-root.');
  }

  // The audio player is needed during preload: it receives every { type: 'audio' } entry.
  // Construct it before the manifest loads, but `init()` it after, once the bytes are in.
  const audio = new AmpAudioPlayer<SoundId>(AUDIO_SETTINGS, {
    ...AUDIO,
    mutedByDefault: AUDIO.mutedByDefault || muteRequested(window.location.search),
  });

  const loading = new LoadingScreen({ mount: gameRoot, label: t('loading') });
  let assets;
  try {
    // 3rd arg is the ?slowload debug stagger (0 unless set); 4th receives `audio` entries.
    assets = await preloadManifest(
      MANIFEST,
      (fraction) => loading.setProgress(fraction),
      loadDelayFromSearch(window.location.search),
      audio,
    );
  } catch (err) {
    loading.showError(t('loadError'));   // leave the screen up showing the error
    throw err;
  }
  loading.dispose();                     // reveal the title screen underneath

  // Decode the always-resident banks plus this level's. Still behind the loading screen, so the
  // progress bar covers it; later levels swap banks at their own transitions.
  await audio.init({ initialBanks: ['level_1'] });

  // Preload is done — forbid any further asset/network loading at runtime (see below).
  sealAssetLoaders();
  sealAssetNetwork({ strict: strictSealRequested(window.location.search) });

  const renderer = new ThreeRenderer(canvas, buildModels(assets));
  renderer.resize(DISPLAY.width, DISPLAY.height);

  const input = new PointerKeyboardInput();   // tap-only; see the drag opt-in recipe in
  input.attach(window);                       // drag-channel.md if a drag drives gameplay

  const game = new Game(renderer, input, audio);
  const hud = new Hud(game);
  input.on('pinchTap', () => hud.hideTitle());
  input.on('pinchTap', () => audio.resume());   // unlock audio on first user gesture

  const loop = new GameLoop(
    { update: (dt) => game.update(dt), render: () => { game.render(); hud.update(); } },
    { maxFrameMs: LOOP.maxFrameMs },
  );
  loop.start();

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { loop.stop(); audio.suspend(); }
    else { loop.start(); audio.resume(); }
  });
}

main().catch((err) => console.error('Failed to start game:', err));
```

`buildModels(assets)` clones the preloaded assets per instance — see [asset-loading.md § The
preload-then-clone pattern](asset-loading.md#the-preload-then-clone-pattern) (and its skeletal-
animation and unlit-material notes). Keep the model/`three` code in `src/models.ts`; the manifest
itself is plain data and can live in its own `src/manifest.ts`.

## Previewing the loading screen (`?slowload`)

On a fast connection (or a dev server serving small files) the load finishes almost instantly, so
the screen barely flashes. To actually *see* it, load the game with **`?slowload`** — a debug
query string, off by default and zero-cost when absent, in the same spirit as the `?stats` overlay
(see [framework-api-debug.md § Performance overlay](framework-api-debug.md#performance-overlay-stats)):

| URL | Effect |
|-----|--------|
| `?slowload` | Stagger each asset's load by a default 800ms |
| `?slowload=1500` | …by 1500ms per asset |
| `?slowload=0` / absent | Off (no delay) |

`loadDelayFromSearch(window.location.search)` (re-exported from `AssetLoader.ts`) reads the value;
pass it as `preloadManifest`'s third argument (as the wiring above does). Each asset's load start
is staggered by `index × delay`, so the bar steps visibly. Because it's driven by the URL, it's
the **only** way to preview the loading screen **on the glasses**, where there's no DevTools to
throttle the network. On desktop you can instead use Chrome DevTools → Network → throttling (which
also applies to `localhost`); `?slowload` needs no tooling and works everywhere. `?slowload` is one
of the game's URL flags — see [query-parameters.md](query-parameters.md) for the full set.

More, larger, or slower-declared assets also give the bar more to show — remember `bytes` only
weights the bar, so you can make a small asset *appear* to take a big share by declaring a large
`bytes` (it won't change actual load time).

## Enforcing preload-only (no runtime loads)

Preloading only pays off if the game then *stays* off the network — a mid-game fetch is a visible
hitch on the glasses (the budget is "< 10 requests on load"). Three guards keep an accidental
runtime load from slipping in; they're independent, so use as many as you like:

1. **Static check — `npm run validate`.** The `network-loads` scanner flags asset/network calls in
   gameplay code (anything outside `src/framework/`): instantiating a Three.js/asset loader, or a
   media `src` set to a network URL, is a **violation**; `fetch` / `XMLHttpRequest` / `WebSocket` /
   `EventSource` are **ambiguous** (reported for review — they might be an intended API call). Runs
   in CI and locally; catches problems before the game even runs.

2. **Loader seal — `sealAssetLoaders()`.** After you call it, the framework loaders
   (`loadTexture` / `loadModel` / `loadModelWithAnimations` / `preloadManifest`) throw. Call it once
   after preload so a stray "load this now" during gameplay fails immediately with a clear message.

3. **Runtime network guard — `sealAssetNetwork(options?)`.** Intercepts `fetch`,
   `XMLHttpRequest`, and `<img>` / `<audio>` / `<video>` `src`, and on a real network URL **warns**
   (default — safe to leave on in production) or **throws** (`strict: true`; wire it to the
   `?strict` flag with `strictSealRequested(window.location.search)`, as the `main.ts` above does —
   see [query-parameters.md](query-parameters.md)).
   It always allows `blob:` / `data:` URLs, so playing a preloaded `raw` asset via
   `URL.createObjectURL(new Blob([bytes]))` is fine. If your game has an intended runtime endpoint
   (e.g. a leaderboard), permit it:

   ```ts
   sealAssetNetwork({ allow: (url) => url.startsWith('https://my-api.internal/') });
   ```

Both seals are wired in the `main.ts` above, right after `loading.dispose()` and before the loop
starts. A game that *intends* to load at runtime simply omits them. Known gaps (markup-driven
`innerHTML` `<img>`, CSS `background-image`) aren't caught by the runtime guard — the static check
and a CSP `connect-src` are the tools for those.
