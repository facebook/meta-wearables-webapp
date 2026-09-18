# webapp game — documentation index

The knowledge needed to build games on Meta Display Glasses, split into what the
**platform** does and how this plugin's **game framework** is organized. Open the specific
doc below that answers the question at hand — you don't need to read all of them.

## Start here

- [`core-contract.md`](core-contract.md) — **the Tier-0 digest**: display physics and the 600x600
  additive-display color rules, performance budgets, the EMG/D-pad input model and the
  no-input-through-the-DOM rule, the Three.js-vs-DOM split, the renderer/input/audio-agnostic
  layering and who may import `three`, logging, preload-only asset loading, and localization.
  `create-webapp-game` reads this for every game, and it is sufficient on its own for a
  procedural game with no art, sound, or preloader. Every section links to the full doc below —
  open those on demand.

## Platform knowledge

How the device itself behaves — the fixed constraints every game must respect.

- [`display-guidelines.md`](display-guidelines.md) — the 600x600 additive waveguide display:
  resolution and viewport, additive-display physics (black is transparent, white is
  brightest), color/contrast, the safe zone and layout rules, typography, the EMG/D-pad
  input model (pinch = activate, D-pad moves focus, opt-in continuous drag, no cursor, no
  pointer lock), interaction states, and animation curves.
- [`performance-guidelines.md`](performance-guidelines.md) — the mobile-grade CPU/GPU and
  battery budget: 30 fps target, < 128 MB memory, < 500 KB gzipped JS, < 10 network
  requests on load, sensor polling rates, and offline/network handling. Shared with the
  non-game webapp plugin, so its offline section is generic advice for an app with no service
  worker — a scaffolded **game already ships one**, and
  [`offline-caching.md`](offline-caching.md) is the answer for that. Read the budgets as
  describing a cold, uncached load.

## Framework knowledge

How a game scaffolded by `create-webapp-game` is structured.

- [`project-structure.md`](project-structure.md) — the opinionated project layout and
  tooling: fixed tech stack (Vite + TypeScript + Three.js + Vitest), folder layout,
  `package.json` scripts, TypeScript conventions, and where tunable numbers live.
- [`game-architecture.md`](game-architecture.md) — the renderer-, input-, and audio-agnostic
  layering (gameplay talks to `Renderer` / `InputManager` / `AudioPlayer` contracts, never imports
  `three`, the DOM, or the Web Audio API), the input model and known device considerations, the
  "no input through the DOM" rule (enforced by `npm run validate`), persisting state across
  sessions through the injected `KeyValueStore`, and the game loop.
- [`drag-channel.md`](drag-channel.md) — the recipe for opting into the EMG index
  pinch-and-move drag stream: the three coordinated edits (`touch-action: none`, the
  `{ pointerDrag: true }` flag, consuming the movement delta), the feel tunables, and what
  changes about the desktop controls once you do. Only for a game where a drag drives gameplay;
  the scaffold is tap-only.
- [`framework-api.md`](framework-api.md) — the index to the callable API surface of the managed
  `src/framework/` code: which of the five parts below documents which exported symbol. Start
  here when you know the name but not where it lives.
- [`framework-api-contracts.md`](framework-api-contracts.md) — the ports gameplay imports: the
  `Renderer`, `InputManager`, `AudioPlayer`, and `KeyValueStore` contracts, plus the
  framework-free value types `Vector3` / `clamp`.
- [`framework-api-implementations.md`](framework-api-implementations.md) — the concrete adapters
  `main.ts` constructs and the options each takes: `ThreeRenderer` (with the game's `ModelCatalog`
  / `ModelSpec`), `PointerKeyboardInput`, and `AmpAudioPlayer`.
- [`framework-api-assets.md`](framework-api-assets.md) — the load-time surface: the
  `atlasFrameTexture` / `atlasSprite` spritesheet pair, `preloadManifest` and its manifest types,
  the framework `LoadingScreen`, and the `sealAssetLoaders` / `sealAssetNetwork` runtime-load
  guards.
- [`framework-api-debug.md`](framework-api-debug.md) — the opt-in surfaces behind URL flags, each
  zero-cost when absent: the `?drive` harness, the `?stats` performance overlay, and the `?log` /
  `?logview` / `?logkey` logging surface (`Logger`, `LogOverlay`, `RemoteLogSink`, `ConsentGate`).
- [`framework-api-runtime.md`](framework-api-runtime.md) — how a game ticks and boots: `GameLoop`,
  the i18next setup (`initI18n` / `t` / `applyStaticTranslations`), and the `main.ts` composition
  root.
- [`threejs-vs-dom.md`](threejs-vs-dom.md) — what renders where: the WebGL canvas (Three.js)
  for the game world (2D or 3D) vs. the HTML/DOM overlay for HUD, menus, and all text, and why.
- [`localization.md`](localization.md) — localizing user-facing text with i18next: where strings
  live (`src/i18n/en.json`), the `t()` / `data-i18n` patterns, locale detection and how to test a
  locale with `?lng=`, English-only-by-default, and the enforced no-hardcoded-strings check.
- [`asset-loading.md`](asset-loading.md) — loading art assets with Three.js: 2D textures
  (PNG/WebP/JPG) and 3D models (GLB/GLTF/FBX/OBJ), why art has to emit light on the additive
  display (a near-black sprite is invisible on device), the `public/` + Vite conventions, the 2D
  (orthographic) vs 3D (perspective) camera, the preload-then-clone pattern, and disposal.
- [`spritesheets.md`](spritesheets.md) — cutting frames out of a packed 2D sheet with
  `atlasFrameTexture` / `atlasSprite`, and animating a sprite by declaring a model's `sheet` +
  `frames` and calling `setFrame`: how a frame is windowed with a **cloned** `THREE.Texture`'s
  `offset`/`repeat` (sharing one texture collapses every sprite to the last frame set), reading
  the sheet's size off the texture instead of hard-coding it, and sizing the quad from the art's
  measured silhouette rather than its padded cell.
- [`offline-caching.md`](offline-caching.md) — the service worker every scaffolded game ships:
  what it precaches and why that list is scanned out of the build rather than read from the asset
  manifest, how a republish re-downloads only the files that changed despite stable filenames,
  network-first navigation vs cache-first assets, the `?swreset=1` escape hatch (the only way to
  clear a bad cache on the glasses), why it is off in `npm run dev`, and how to verify it.
- [`loading-screen.md`](loading-screen.md) — the opt-in asset manifest + framework `LoadingScreen`:
  preload a whole manifest into memory with a size-weighted progress bar shown before the title
  screen, load audio (`audio` entries) and arbitrary files (JSON/binary via `raw`), and the
  `main.ts` wiring.
- [`audio.md`](audio.md) — the audio subsystem: the designer-owned `audioSettings.json` event format
  (sample and inline-synth clips, variation, fades, `chanceToPlay`, per-event `cooldown`), how
  `play()` stays compile-checked with no codegen, voice concurrency (per-event limits, shared voice
  groups, `killOldest` vs `preventNew`), the `sfx`/`music` bus mixer + mute (`?mute`), stereo-pan +
  distance spatialization, the pooled-voice engine, autoplay unlock / suspend, the `createVoice`
  custom-graph escape hatch, `validate()`, and testing with `FakeAudioPlayer`.
- [`audio-banks.md`](audio-banks.md) — audio **memory**: why a bank manages decode rather than
  download (PCM is ~30x the compressed size), preloading clip bytes through the manifest,
  `loadBank` / `unloadBank` / `swapBanks` and the sequential-vs-overlapped trade-off, the
  `maxResidentBytes` budget and its refusal behaviour, and why music streams instead of decoding.
  Only needed once a game has recorded audio — a synth-only game has no banks.
- [`logging.md`](logging.md) — seeing what the game is doing when there is no console: the leveled
  `Logger` that replaces `console.*` (enforced), the `?logview` on-glasses log overlay, and the
  opt-in remote sink + `/logs` portal (consent gate, `LOG_TOKEN` auth, storage backends, and the
  QR deep-link encoding rule) for reading device logs on a laptop.
- [`testing.md`](testing.md) — unit-testing game logic in a plain Node environment (no GPU, no
  DOM) with the fakes the framework ships in `src/framework/testing/fakes.ts`: what to test,
  how to run Vitest, and why a game's own test count is reported apart from the inherited
  framework one.
- [`query-parameters.md`](query-parameters.md) — every URL query-string option in one place
  (`?lng`, `?stats`, `?slowload`, `?strict`): what each does, its value convention, and where the
  full details live.

---

This index is extensible: as more platform or framework documentation is written (e.g. a
dedicated input-latency doc, GPU capability details), add the new `.md` file to `docs/` and
list it here under the appropriate section.
