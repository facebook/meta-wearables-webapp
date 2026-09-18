# Framework API — the loop, localization, and the composition root

How a game ticks and how it boots: the `GameLoop`, the i18next setup every string is rendered
through, and the `main.ts` wiring that constructs each implementation and injects it into
gameplay. Part of the [framework API reference](framework-api.md).

## `GameLoop` — the game loop

`framework/core/GameLoop.ts`. A variable-timestep loop: one `update(dt)` per animation frame
with the real elapsed delta, then `render()`. See
[game-architecture.md § Game loop](game-architecture.md#game-loop) for the rationale and the
fixed-timestep alternative.

```ts
interface Updatable {
  update(dt: number): void; // dt is in SECONDS
  render(): void;
}

new GameLoop(game: Updatable, options?: { maxFrameMs?: number; stepSeconds?: number });
```

| Member | Semantics |
|--------|-----------|
| `start()` | Begin the `requestAnimationFrame` loop. Idempotent, and re-stamps the frame clock so resuming never produces a huge catch-up delta. |
| `stop()` | Cancel the loop. Call it when the app is backgrounded (no work while idle). |
| `isRunning(): boolean` | Whether the rAF loop is currently scheduled. |
| `step(dtSeconds?: number): boolean` | Advance exactly one frame of `dtSeconds` (default `stepSeconds`), off the animation-frame clock entirely. Returns `false` and does nothing while the loop is running. |
| `getStepSeconds(): number` | The default per-`step()` delta. |

`dt` is **seconds** (the loop divides the ms delta by 1000). Each frame's delta is clamped to
`maxFrameMs` (default `250`) so a long pause doesn't teleport objects across the world.
`stepSeconds` (default `1/60`) is the manual-step delta; like `maxFrameMs` it is passed in from
`src/config/gameplayConstants.ts` rather than imported, so the framework stays config-free.

`step()` is what `?drive` is built on — see [DriveHarness](framework-api-debug.md#driveharness-drive).

## Localization (`src/framework/i18n/`)

`framework/i18n/i18n.ts` — the i18next setup. It owns the locale-detection *policy*; the game
injects its *strings* (from `src/i18n/`). Imports only `i18next` + `i18next-browser-languagedetector`
(no game code). The *why*, the `?lng=` testing recipe, and how to add a language are in
[`localization.md`](localization.md).

```ts
initI18n(options: {
  resources: Resource;      // e.g. { en: { translation: {...} } }
  fallbackLng?: string;     // default 'en'
}): i18n;

t(key: string, options?: Record<string, unknown>): string;

applyStaticTranslations(root?: ParentNode): void;   // default root = document
```

| Member | Semantics |
|--------|-----------|
| `initI18n` | Initialize the shared i18next singleton with **bundled** resources. Detection order: `?lng=` querystring → `localStorage` → `navigator` → `<html lang>`; caches the choice in `localStorage`. Runs synchronously (`initImmediate: false`), so `t()` works before first paint; throws if init has not completed synchronously by the time it returns. Call once at boot. |
| `t` | Translate a key in the active language (thin wrapper over the singleton, so it always reads the current locale). Re-exported from `src/i18n/index.ts` for game code. |
| `applyStaticTranslations` | Fill every `[data-i18n]` element's `textContent` from its key (a `<title data-i18n>` updates the document title too). **Display-only** — attaches no listeners, so it satisfies the [no-input-through-DOM rule](game-architecture.md#input-must-not-flow-through-the-dom-enforced), like the HUD and `PerfOverlay`. Call after `initI18n()`, before first paint. |

The game's `src/i18n/index.ts` calls `initI18n({ resources: { en: { translation: en } } })` at import
time and re-exports `t`; `main.ts` triggers it with a side-effect `import '@/i18n'` and then calls
`applyStaticTranslations()`.

## Composition root (`main.ts`)

`src/main.ts` is the one place that constructs the implementations, injects the `config/`
tunables, and starts the loop. The wiring order (distilled from the starter):

```ts
// Side-effect import: initializes i18next with the game's bundled strings before rendering.
import '@/i18n';

function main(): void {
  applyStaticTranslations();   // fill [data-i18n] DOM text from the active locale

  const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
  if (!canvas) throw new Error('Could not find #game-canvas element.');

  const renderer = new ThreeRenderer(canvas, MODELS);   // catalog from src/models.ts
  renderer.resize(DISPLAY.width, DISPLAY.height);

  // Tap-only (the default): Enter -> pinchTap, arrows -> dpadSwipe, nothing to tune. For the
  // opt-in drag channel see drag-channel.md.
  const input = new PointerKeyboardInput();
  input.attach(window);

  // Audio: the catalog is audioSettings.json, the device tunables come from AUDIO, and the
  // context is lazy + suspended (unlocked on the first pinch below).
  const audio = new AmpAudioPlayer<SoundId>(AUDIO_SETTINGS, {
    ...AUDIO,
    mutedByDefault: AUDIO.mutedByDefault || muteRequested(window.location.search),
  });
  await audio.init();

  const game = new Game(renderer, input, audio);   // gameplay talks only to the contracts
  const hud = new Hud(game);
  if (import.meta.env.DEV) (window as unknown as { __game?: Game }).__game = game;   // dev-only debug handle
  input.on('pinchTap', () => hud.hideTitle());
  input.on('pinchTap', () => audio.resume());       // unlock audio on first user gesture

  // Opt-in perf HUD: null unless the URL carries `?stats`. begin/endFrame bracket the frame.
  const perf = statsOverlayRequested(window.location.search)
    ? new PerfOverlay(renderer, { mount: document.querySelector('#game-root') ?? undefined })
    : null;

  const loop = new GameLoop(
    {
      update: (dt) => { perf?.beginFrame(); game.update(dt); },
      render: () => { game.render(); perf?.endFrame(); hud.update(); },   // endFrame before the HUD write, so CPU-ms excludes it
    },
    { maxFrameMs: LOOP.maxFrameMs, stepSeconds: LOOP.stepSeconds },
  );

  // `?drive`: don't start the loop; frames come from window.__webappGame.step(n) instead.
  const driven = driveModeRequested(window.location.search);
  if (driven) installDriveHarness(loop);
  else loop.start();

  // Stop the loop (and suspend audio) while backgrounded so no work runs when not visible.
  // Restart on the loop's own state, not on `driven` — a paused driven game stays paused, but one
  // handed back to rAF by window.__webappGame.resume() survives a background/refocus cycle.
  let wasRunning = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { wasRunning = loop.isRunning(); loop.stop(); audio.suspend(); }
    else { if (wasRunning) loop.start(); audio.resume(); }
  });
}
```

Notes:

- **No input options** in a tap-only game — there is no pointer stream to tune. A drag game
  passes `sensitivity` / `tapMaxTravelPx` / `pointerDrag` and picks the device-vs-mouse feel
  with an `isRunningOnGlasses()` UA check; the whole recipe is in
  [drag-channel.md](drag-channel.md).
- **Async assets:** a game that loads art makes `main` async and awaits a one-time preload
  before wiring the renderer — see
  [asset-loading.md § The preload-then-clone pattern](asset-loading.md#the-preload-then-clone-pattern).
- **`visibilitychange` is not input** — it's a lifecycle event, so it's allowed outside the
  input layer (see [game-architecture.md § Input must not flow through the DOM](game-architecture.md#input-must-not-flow-through-the-dom-enforced)).
