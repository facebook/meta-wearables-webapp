# Game architecture — renderer- and input-agnostic layering

The core opinion: **gameplay logic must not import Three.js, the DOM, or the Web Audio API
directly.** It talks to a `Renderer` interface, an `InputManager` interface, and an `AudioPlayer`
interface; the concrete Three.js renderer, pointer/keyboard input, and Web Audio player are
injected at startup (`main.ts`). This keeps each backend swappable and — crucially — makes
gameplay **unit-testable** in a plain Node environment with stub implementations.

This doc is the *why*. For the callable API surface of these contracts (method signatures,
options, the `main.ts` wiring) see [`framework-api.md`](framework-api.md); for the
fake-driven test pattern see [`testing.md`](testing.md).

## Layers

```
main.ts                          entry: constructs ThreeRenderer (+ model catalog) +
                                 PointerKeyboardInput + Game + GameLoop, injects tunables,
                                 starts the loop
models.ts                        the game's model ids + Three.js geometry (MODELS catalog)
core/                            gameplay, orchestration, state machine, world clock
config/                          centralized tunables (game-owned; injected into framework)
hud/                             DOM HUD / menus (read state, write DOM)
framework/                       managed engine code — re-copyable, imports no game code:
  render/Renderer.ts             rendering CONTRACT, generic over the model-id union
                                 (framework-free types: positions are a plain Vector3,
                                 colors are 0xRRGGBB numbers, instances are opaque handles)
  render/ThreeRenderer.ts        builds geometry from the game's catalog; imports `three`.
                                 Selectable camera: perspective (3D) or orthographic (2D)
  render/AssetLoader.ts          loads textures (PNG/WebP/JPG) + models (GLB/GLTF/FBX/OBJ);
                                 imports `three`. Pure URL/format helpers: render/assetFormats.ts
  input/InputManager.ts          input CONTRACT (no DOM types appear here)
  input/PointerKeyboardInput.ts  the ONLY input file that touches DOM events
  audio/AudioPlayer.ts           audio CONTRACT (no Web Audio types; positions are Vector3)
  audio/soundDefinitions.ts      pure synth/sample/variant sound-definition format + builders
  audio/AudioEngine.ts           the ONLY file that touches the Web Audio API (pooled strips; see audio.md)
  audio/AmpAudioPlayer.ts        events, banks, concurrency — the AudioPlayer implementation
  audio/audioSettings.ts         the audioSettings.json schema, parser and validator (pure)
  audio/BankStore.ts             compressed bytes + decoded PCM, and the memory budget
  storage/KeyValueStore.ts       persistence CONTRACT + localStorage impl + in-memory fake
  i18n/i18n.ts                   i18next setup + locale detection (see localization.md)
  core/GameLoop.ts               variable-timestep game loop
  debug/PerfSampler.ts           pure perf timing/averaging + the `?stats` flag parser
  debug/PerfOverlay.ts           opt-in `?stats` DOM overlay (display-only; adds no listeners)
  debug/NetworkGuard.ts          opt-in runtime guard: warn/throw on network loads after preload
  testing/fakes.ts               FakeRenderer / FakeInput / FakeAudioPlayer for unit tests
  math/Vector3.ts                framework-free value types (easing, rng, … go here too)
```

Rule: **entities and systems go through `Renderer`, `InputManager`, and `AudioPlayer`. They never
import `three`, reference `document`/`window`, or touch the Web Audio API.** Only
`framework/render/ThreeRenderer.ts`, `framework/render/AssetLoader.ts`, and `src/models.ts` import
`three` (rendering and model/asset geometry are renderer-specific); the pure
`framework/render/assetFormats.ts` stays `three`-free so it's node-unit-testable. Only
`framework/audio/AudioEngine.ts` touches the Web Audio API (its contract
`framework/audio/AudioPlayer.ts` is Web-Audio-free, except the `createVoice` synthesis escape
hatch). Only the input implementation, `main.ts`, the HUD, and the display-only
`framework/debug/PerfOverlay.ts` touch the DOM (the overlay's logic lives in the `three`- and
DOM-free `framework/debug/PerfSampler.ts`, which is node-unit-tested).

Everything under `src/framework/` is managed engine code — re-copyable and free of game
imports (tunables are injected via constructors, not imported). Add game content outside it:
models in `src/models.ts`, gameplay in `src/core/`, tunables in `src/config/`.

## Why this matters

- **Testability**: a `Game` constructed with a fake `Renderer` and a scripted
  `InputManager` can be driven through `update(dt)` and asserted on — no DOM, no GPU. Write
  Vitest tests for all non-trivial logic (movement, collisions, scoring, timers, spawn
  rules). Rendering/DOM need not be unit-tested, but the logic behind them must be. See
  [`testing.md`](testing.md) for the pattern; the fakes themselves ship in
  `src/framework/testing/fakes.ts`.
- **Swappability**: the reference renderer can be Canvas2D/DOM while a Three.js renderer is
  built behind the same interface.
- **Reproducibility**: because input is injected, a scripted `InputManager` driven through
  `update(dt)` replays the same run — so logic is reproducible in tests regardless of the
  loop's timestep.

## The input model (read this before changing input)

On the glasses, input is **two EMG gesture families**, each on its own channel (a desktop
mouse + keyboard reproduce both, so one code path serves development and device):

- **Index pinch** (thumb→index **pad**): a quick pinch is a SELECT — the device emits an
  `Enter` key event, which the input maps to a discrete `pinchTap`. A pinch-and-move is a
  drag, but the drag stream is **opt-in**: only once `<body>` sets `touch-action: none` and
  the input is constructed `{ pointerDrag: true }` does the device deliver a cursor-less
  relative pointer drag (`pointerdown` → `pointermove` with `movementX/movementY` →
  `pointerup`, `pointerType="mouse"`), which the input maps to `pinchBegin`/`pinchEnd` plus a
  movement delta. A desktop **left-mouse drag produces the identical pointer stream**. A
  tap-only game — the scaffold's default — omits both and gets the index select straight from
  the `Enter` → `pinchTap`. Recipe: [`drag-channel.md`](drag-channel.md).
- **D-pad** (thumb→index **side**): a directional swipe → arrow-key events, mapped to
  `dpadSwipe(direction)`. There is **no** discrete center ("thumb") tap — see the device note
  below.

The discrete select is the index pinch (`pinchTap`) — never wire `Enter` to the D-pad. This
is why the scaffold's input layer is **pointer- and event-based**, not "mouse = head tilt".
The correct mapping of a drag to gameplay (aim, move, look, pinch-and-drag a thing) is
**game-dependent** — decide it per game; the contract just delivers a movement delta plus the
discrete `pinchTap` / `dpadSwipe` events.

### Driving the game in a desktop browser

The arrow keys are the D-pad in every game. **How you fire the index pinch depends on the drag
mode**, because the mode decides which channel the tap comes from:

| Mode | Index pinch on the desktop | Why |
|---|---|---|
| **Tap-only** (the scaffold's default) | `Enter` | No pointer listeners are wired, so a mouse click does nothing — correct, there is no cursor on the glasses. |
| **Drag opted in** | a left-mouse **click** (press+release without moving) | The pointer stream becomes the tap source, and the redundant `Enter` is ignored so the device's two channels can't double-fire. |

So in a tap-only game a click is dead, and in a drag game `Enter` is dead. Neither is a bug.

> **Anti-pattern: do not enable `pointerDrag` so that a desktop mouse click selects.** It reads
> like a harmless dev convenience and it is not one — the flag opts into the device's EMG
> pinch-and-move pointer stream and moves the tap source off `Enter` onto that stream
> (`PointerKeyboardInput.ts`). You end up shipping a different input contract to the glasses to
> save yourself one keystroke in Chrome. Press `Enter`. `npm run validate` fails a project that
> turns the flag on without consuming the drag.

### Opting into the drag channel

A drag that drives gameplay needs three coordinated edits — `touch-action: none`, the
`{ pointerDrag: true }` flag, and game code that consumes the movement delta. The recipe is its
own doc: [`drag-channel.md`](drag-channel.md). A tap-only game (the scaffold's default) makes
none of them.

### Known device considerations (not in the starter; add if you hit them)

- **The index pinch fires on TWO channels.** It ALWAYS emits an `Enter` (the select) and,
  when opted in via `touch-action: none`, ALSO the pointer drag. In a drag game treat the
  pointer stream as the tap source and ignore the redundant `Enter`; in a tap-only game the
  `Enter` IS the tap. Either way `Enter` is an INDEX gesture (`pinchTap`). (Confirmed by
  toggling `touch-action`: with it off, an index pinch emits ONLY `Enter`, no pointer stream.)
- **There is no D-pad center ("thumb") tap.** The device emits `key="Unidentified"` for BOTH
  D-pad swipes and side taps, so a center tap can't be distinguished from a swipe. The input
  layer ignores `Unidentified` entirely; don't build on it — use `pinchTap` for a discrete
  select.
- **Pointer Lock fails** on the Meta Display Glasses WebView (`requestPointerLock` →
  `UnknownError`), so movement is edge-clamped unless you keep the drag within the viewport.
  On desktop it works, giving unbounded deltas.
- **Recenter snap**: on the device WebView the native EMG pointer recenters its absolute
  coordinate to screen-centre, and on some builds that jump leaks into `movementX/Y`. If you
  see input "snapping", drop a per-axis delta that is both a large jump and lands on
  screen-centre. This is a browser-side bug workaround — gate it to the device and remove it
  once the platform reports the true relative delta.
- **Sensitivity** differs by feel between a mouse and the EMG drag — keep it a constant in
  `config/` and pick the device value when running on glasses (detect via the WebView UA
  `wv` token).

## Input must not flow through the DOM (enforced)

The UI is HTML/DOM, but **input is not**: every gesture flows through the `InputManager` and
is consumed from the game loop. The only sanctioned place that touches DOM *input* events is
the input layer (`src/framework/input/`), which attaches to `window`. Everywhere else —
including on `window`/`document` — the following are violations:

- inline `on*=` handler attributes in HTML (`onclick=`, `onkeydown=`, …),
- `addEventListener('<input event>', …)` for a user-input event, and
- `el.on<event> =` handler-property assignments.

"Input events" are the interaction ones — `click`, `pointer*`, `mouse*`, `key*`, `touch*`,
`wheel`, `input`/`change`/`submit`, `focus`/`blur`, `drag*`. Lifecycle/network events
(`visibilitychange`, `resize`, `load`, `online`/`offline`, `message`, …) are **not** input, so
`main.ts` wiring `visibilitychange` is fine.

DOM **output** is fine — the rule only forbids reading input through the DOM. The HUD, the
`?stats` [`PerfOverlay`](framework-api-debug.md#performance-overlay-stats), and the localization applier
(`applyStaticTranslations`, see [`localization.md`](localization.md)) all write DOM
(`textContent`/`style`) and attach **no** listeners, so they pass the check.

`npm run validate` (the `validate-webapp-game` skill) runs three dependency-free scanners
(under `scripts/`): the input-handler check fails on any DOM input handler outside the
`framework/input/` allowlist (and flags a non-literal event name as *ambiguous*), the
localized-string check fails on hardcoded user-facing text (see
[`localization.md`](localization.md#enforcement)), and the network-load check fails on assets
loaded over the network at runtime (see below). Run it before considering a change done.

## Persisting state across sessions

A best score, settings, unlocks. `localStorage` is a DOM global, so calling it from `src/core/`
fails the layer-boundary check for the same reason `document` does — and for the same underlying
reason: it makes gameplay untestable outside a browser. Persistence is therefore a **port**, like
the renderer and the input:

```ts
// src/core/Game.ts — gameplay depends on the contract, never on the browser
import type { KeyValueStore } from '@/framework/storage/KeyValueStore';

export class Game {
  private best: number;

  constructor(
    private readonly renderer: Renderer<ModelId>,
    private readonly input: InputManager,
    private readonly audio: AudioPlayer,
    private readonly store: KeyValueStore,
  ) {
    this.best = Number(store.get('bestScore') ?? '0');
  }

  private endRound(score: number): void {
    if (score > this.best) {
      this.best = score;
      this.store.set('bestScore', String(score));
    }
  }
}
```

```ts
// src/main.ts — the composition root picks the real implementation
import { BrowserKeyValueStore } from '@/framework/storage/KeyValueStore';

const game = new Game(renderer, input, audio, new BrowserKeyValueStore({ namespace: 'my-game' }));
```

```ts
// a test — no browser, no leaking state between cases
import { MemoryKeyValueStore } from '@/framework/storage/KeyValueStore';

const game = new Game(new FakeRenderer(), input, audio, new MemoryKeyValueStore());
```

The `namespace` matters more than it looks: under `npm run dev` every game on the machine is
served from `http://localhost:5173`, so unprefixed keys collide between projects. Values are
strings — `String(n)` / `Number(...)` for a number, `JSON.stringify` / `JSON.parse` for an
object. Signatures and the failure behavior (it never throws; it degrades to session memory) are
in [`framework-api-contracts.md`](framework-api-contracts.md#keyvaluestore--persistence-contract).

## Assets load only at preload (enforced)

Everything a game needs is loaded **once, up front** (the manifest + `preloadManifest`, behind the
`LoadingScreen`); once the loop is running the game is effectively offline. A runtime asset fetch
is a visible hitch on the glasses — the budget is "< 10 network requests on load" (see
[`performance-guidelines.md`](performance-guidelines.md)). So gameplay/UI/config code must not load
assets or open network connections; only the preload layer (`src/framework/`) may. This is guarded
three ways (see [`loading-screen.md`](loading-screen.md#enforcing-preload-only-no-runtime-loads)):

- **Static check** (`npm run validate` → `network-loads`): flags a Three.js/asset loader
  instantiated, or a media `src` set to a network URL, outside `src/framework/`; reports
  `fetch`/`XMLHttpRequest`/`WebSocket`/`EventSource` as *ambiguous* for review (they may be an
  intended API call).
- **Loader seal** (`sealAssetLoaders()`): after preload, the framework loaders throw if called.
- **Runtime network guard** (`sealAssetNetwork()`): after preload, warns (or, under `?strict`,
  throws) on a real network load, while allowing in-memory `blob:` / `data:` URLs (preloaded
  assets) and any endpoint you `allow`.

`blob:` / `data:` URLs are always fine — that's how a preloaded `raw` asset (e.g. audio) is played
back. Wire both seals in `main.ts` right after the loading screen disposes, before the loop starts.

## Logging goes through the logger, not `console` (enforced)

Game code logs with the shared `Logger` (`import { log } from '@/log'`), never `console.*`. A raw
console call is invisible where it matters most — the glasses have no console and cannot be
tethered — and it bypasses the level filter, the buffer the `?logview` on-screen overlay and the
remote sink read from, secret redaction, and the rate limit that stops a call in `update()` from
becoming 60 messages a second.

- **Static check** (`npm run validate` → `console-logging`): flags any `console.<method>(` outside
  `src/framework/`. No ambiguous category — a console call is decidable on sight.
- `src/framework/` is exempt: it *implements* the logger and its console sink, and its low-level
  guards (e.g. `NetworkGuard`) must warn without depending on game wiring.

See [`logging.md`](logging.md) for levels, the on-glasses overlay, and the opt-in remote sink.

## Game loop

Use a variable-timestep update — one `update(dt)` per animation frame with the real
elapsed delta, rendering right after. This keeps gameplay smooth across varying framerates
and forward-compatible with devices that refresh at different rates. Clamp the delta so a
long pause doesn't produce a huge jump:

```ts
// pseudocode
function frame(now) {
  const dt = Math.min(now - last, MAX_FRAME_MS) / 1000; last = now;
  game.update(dt);
  game.render();
  requestAnimationFrame(frame);
}
```

Projects that need deterministic physics can instead opt into a fixed-timestep accumulator
(simulate in fixed steps, render once per frame).

Stop the loop when the app is backgrounded / the screen is left, per the performance
guidelines (no continuous work when idle).

`GameLoop` also exposes `step(dt)`, which runs exactly one `update` + `render` off the
animation-frame clock entirely. Nothing in a game should call it — it exists so an external
driver can advance the simulation a known number of frames under `?drive`, which is what makes a
screenshot correspond to a specific state instead of to whenever the frame clock got there. See
[query-parameters.md § Drive mode](query-parameters.md#drive-mode-drive).
