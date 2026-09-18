# Core contract — the non-negotiables, in one read

The minimum a game must respect on Meta Display Glasses: display physics, performance budgets,
the input model, the Three.js-vs-DOM split, the renderer/input-agnostic layering, and
localization. **This is the Tier-0 doc** — `create-webapp-game` reads it for every
game, and it is enough on its own for a procedural game with no art, no sound, and no preloader.

It is a digest, not a replacement. Each section links to the full doc; open one when the game
actually needs that area:

| Need | Doc |
|---|---|
| Real art files (textures, 3D models) | [`asset-loading.md`](asset-loading.md) |
| Sound | [`audio.md`](audio.md) |
| A preload progress bar | [`loading-screen.md`](loading-screen.md) |
| Offline / why a second launch is fast | [`offline-caching.md`](offline-caching.md) |
| Reading logs off the device | [`logging.md`](logging.md) |
| Writing tests | [`testing.md`](testing.md) |
| An exact framework signature | [`framework-api.md`](framework-api.md) |
| Layout patterns, focus states, animation curves | [`display-guidelines.md`](display-guidelines.md) |

---

## 1. The display is additive — black is transparent

600x600dp, 30fps, additive waveguide: emitted light **adds** to the real world. `#000000` emits
nothing and is therefore fully **transparent**; `#FFFFFF` is maximum brightness.

The one rule people get wrong: the **page background** must be `#000000` (so the wearer sees
through it), but a **bounded** UI surface must never be — a card, panel, or modal at `#000000` is
invisible. Use a dark gray (`#0a0a0f` – `#1C1E21`) so it reads as opaque.

**Bounded is the operative word, and it excludes the HUD.** A bounded surface appears over the
game and goes away; a HUD is on screen for the whole round. Fill a full-width strip behind one and
it is a backdrop by another name — a permanently lit band across the wearer's field of view, the
same defect as the opaque full-bleed backdrop below. **An always-on HUD is bright text on the
black page, with no background fill.** If it needs separating from the playfield, use a hairline
rule or a short gradient, not a filled band. The verification pass in
`iterate-webapp-game` measures the HUD strip's median luminance and near-black share —
not the `fractionLit` slab threshold it applies to a sky band, which a dark gray is too dim to
trip — so a filled one shows up in those two numbers.

| Surface | Color |
|---|---|
| Page background (`html`, `body`) | `#000000` |
| Bounded UI surfaces (cards, panels, modals) | `#0a0a0f` – `#1C1E21` |
| Always-on HUD | no fill — text over the page background |
| Primary text / icons | `#FFFFFF` |
| Secondary / muted text | `#E4E6EB` / `#B0B3B8` |

Required in `src/index.html`:

```html
<meta name="viewport" content="width=600, height=600, initial-scale=1.0">
<meta name="description" content="<brief, game-specific description>">
<!-- Without this the device will not route D-pad / EMG input to the page. Keep it verbatim. -->
<meta name="mrbd-web-app-capable" content="yes">
<!-- Attribution: which skill and version built this game. Written by the create skill and
     re-stamped by the framework-update skill — don't hand-edit it, and don't remove it. -->
<meta name="generator" content="create-webapp-game <x.y.z> (https://github.com/facebook/meta-wearables-webapp)">
```

All four are checked by `npm run validate`.

Text is **>= 16px** (body 16dp; headings 22–28dp) and must scale to 200% without breaking. Apply
an 8dp safe margin — elements at the very edge get clipped by rubberbanding.

**This governs art too, not just CSS.** A near-black sprite emits nothing, so it is invisible on
device — fatal when it is the thing the player has to dodge. Whatever the player must react to
must be among the brightest things drawn, and an opaque backdrop tile lights up the wearer's
whole view instead of receding. Check source art's brightness *before* building around it; no
static check can see it. Detail:
[`asset-loading.md` § Art has to emit light](asset-loading.md#art-has-to-emit-light-the-additive-display-applied-to-sprites).

Layout, safe zone, typography, focus states and animation curves:
[`display-guidelines.md`](display-guidelines.md). The surface-color rule above is the one that
governs a game.

## 2. Performance budgets

| Metric | Target |
|---|---|
| Frame rate | 30 fps |
| JS bundle | < 500 KB gzipped |
| Memory | < 128 MB |
| Network requests on load | < 10 |
| Initial load | < 3 s on 4G |

**Stop all work when idle** — no `requestAnimationFrame` loop, animation, or sensor polling while
the game is backgrounded or the screen is left. This is a battery requirement, not a nicety.

Full detail: [`performance-guidelines.md`](performance-guidelines.md).

## 3. Input: two EMG gesture families, never through the DOM

There is no touchscreen, mouse, or cursor. Input is two channels, both reproducible on a desktop:

- **Index pinch** (thumb→index *pad*) — the discrete SELECT. The device emits `Enter`, which the
  input layer maps to **`pinchTap`**. A pinch-and-move is a drag, but the drag stream is
  **opt-in and off by default**: you get `pinchBegin`/`pinchEnd` plus a movement delta only if
  `<body>` sets `touch-action: none` *in the initial CSS* and the input is constructed
  `{ pointerDrag: true }`. A desktop left-mouse drag produces an identical stream. Tap-only
  games — the scaffold's default — skip both. Recipe:
  [drag-channel.md](drag-channel.md).
- **D-pad** (thumb→index *side*) — a directional swipe → arrow keys → **`dpadSwipe(direction)`**.

**On a desktop the arrow keys are the D-pad; the index pinch depends on the mode.** In a
tap-only game (the default) it is `Enter`, and a mouse click does nothing — correct, there is no
cursor on the glasses. In a drag game the pointer stream is the tap source, so a click is the
pinch and the redundant `Enter` is ignored. Neither dead input is a bug.

Three traps:

- **The discrete select is the index pinch.** Never wire `Enter` to the D-pad.
- **There is no D-pad center ("thumb") tap.** The device emits `key="Unidentified"` for *both*
  swipes and side taps, so it is ambiguous; the input layer ignores it. Use `pinchTap`.
- **Never set `pointerDrag: true` so a desktop mouse click selects.** It is not a dev
  convenience: it opts the *device* into the pinch-and-move pointer stream and moves the tap
  source off `Enter`. Turn it on only if a drag drives gameplay — `npm run validate` fails a
  project that enables it without consuming the drag.

How a drag maps to gameplay (aim / move / look) is **game-dependent** — decide it per game.

### The enforced rule

UI is HTML/DOM, but **input never is**. Every gesture flows through the `InputManager` and is
consumed from the game loop. The only file that may touch DOM *input* events is
`src/framework/input/PointerKeyboardInput.ts`. Everywhere else — including on `window` /
`document` — these are violations:

- inline `on*=` attributes in HTML (`onclick=`, `onkeydown=`, …)
- `addEventListener('<input event>', …)`
- `el.on<event> = …` assignments

"Input events" means `click`, `pointer*`, `mouse*`, `key*`, `touch*`, `wheel`,
`input`/`change`/`submit`, `focus`/`blur`, `drag*`. Lifecycle events (`visibilitychange`,
`resize`, `load`, …) are **not** input, so `main.ts` wiring `visibilitychange` is fine. DOM
*output* is always fine — the HUD reads state and writes DOM.

`npm run validate` enforces this. Full detail + device quirks (pointer-lock failure, recenter
snap): [`game-architecture.md`](game-architecture.md).

## 4. Three.js for the world, DOM for everything you read

Two stacked layers inside the 600x600 stage:

```
#game-root (600x600, position: relative)
  ├─ <canvas id="game-canvas">   ← Three.js renders the game world (2D or 3D)
  └─ #hud (position: absolute)   ← DOM HUD / menus float above it
```

- **Three.js canvas** — the game world: player, enemies, projectiles, particles, anything that
  moves each frame. 3D uses the perspective camera; **2D uses the orthographic camera**
  (`{ projection: 'orthographic' }` in `main.ts`) plus textured sprites.
- **DOM overlay** — HUD, menus, title/game-over screens, and **all text**.

**Never render text in WebGL.** DOM text is crisper, accessible, scales to 200%, and is far
cheaper than glyph textures.

Full detail: [`threejs-vs-dom.md`](threejs-vs-dom.md).

## 5. Gameplay is renderer-, input-, and audio-agnostic

The core opinion: **gameplay must not import `three`, touch the DOM, or touch the Web Audio API.**
It talks to the `Renderer`, `InputManager`, and `AudioPlayer` contracts; the concrete
implementations are injected in `main.ts`. That is what makes gameplay unit-testable in plain Node
with fakes — no GPU, no DOM.

```
main.ts              entry: constructs ThreeRenderer + PointerKeyboardInput + Game + GameLoop,
                     injects tunables, starts the loop
models.ts            the game's model ids + Three.js geometry (MODELS catalog)
core/                gameplay, orchestration, state machine
config/              centralized tunables (game-owned; injected into the framework)
hud/                 DOM HUD / menus (read state, write DOM)
framework/           managed engine code — re-copyable, imports no game code. DON'T hand-edit.
```

Who may import what:

| Concern | The only files allowed to touch it |
|---|---|
| `three` | `framework/render/ThreeRenderer.ts`, `framework/render/AssetLoader.ts`, `src/models.ts` |
| DOM | `framework/input/PointerKeyboardInput.ts`, `main.ts`, `src/hud/`, `src/log.ts`, `framework/debug/` + `framework/ui/` |
| Web Audio | `framework/audio/AudioEngine.ts` |
| Concrete audio backend | `src/main.ts` (the composition root constructs it) |
| Web Storage (`localStorage`) | `framework/storage/KeyValueStore.ts` |

Persisting a best score or settings uses that last one: gameplay takes a `KeyValueStore`,
`main.ts` injects `BrowserKeyValueStore`, tests inject `MemoryKeyValueStore`. `localStorage` is a
DOM global, so calling it from `src/core/` fails the layer check. Recipe:
[game-architecture.md § Persisting state across sessions](game-architecture.md#persisting-state-across-sessions).

Add models by extending the `ModelId` union + `MODELS` catalog in `src/models.ts`. Put **all**
tunable numbers in `src/config/gameplayConstants.ts` — never inline a magic number; the framework
receives the few numbers it needs via constructor options, so it never imports config.

The `Renderer` contract carries the per-instance channels a game needs for feel: `setTransform`,
`setRotation`, `setVisible`, plus the optional `setScale` (pulse, pop, squash and stretch),
`setOpacity` (fade, damage flash, ghosting) and `setFrame` (spritesheet animation — the model's
spec declares its `sheet` + frame rects). Each is isolated between instances of the same model.
Drive them from `update(dt)`: there is no tween, easing or playback clock in the framework, and
faking one of these channels with stacked quads or one model id per animation frame is never
necessary. Signatures:
[`framework-api-contracts.md`](framework-api-contracts.md#renderertmodelid--rendering-contract).

`npm run validate` enforces this table for **game** code (the whole `framework/` layer is exempt —
it is what implements these adapters). Two wrinkles worth knowing: `src/log.ts` reads
`window.location.search` for the `?log=` level, so it counts as a DOM adapter alongside `main.ts`
and `src/hud/`; and `main.ts` is a DOM adapter but **not** a Web Audio one — it constructs an
`AmpAudioPlayer`, never an `AudioContext`. Gameplay must not import that backend either: an
`AmpAudioPlayer` / `AudioEngine` / `BankStore` import from `src/core/` is a violation even though
the line names no Web Audio type, because it locks `FakeAudioPlayer` out of the test.

**Everything under `src/framework/` is managed** and re-copied wholesale by
`update-webapp-game-framework`. Edits there are destroyed on the next update.

### Game loop

Variable timestep: one `update(dt)` per animation frame with the real elapsed delta, clamped so a
long pause can't produce a huge jump, then render. Stop the loop when backgrounded.

Full detail: [`game-architecture.md`](game-architecture.md); signatures:
[`framework-api.md`](framework-api.md).

## 6. Two more enforced rules

**Logging** — game code logs through the shared logger, never `console.*`:

```ts
import { log } from '@/log';
log.info('level started', { level: 3 });
```

The glasses have no console and cannot be tethered, so a raw `console.*` call is invisible exactly
where it matters, and it bypasses the level filter, the `?logview` overlay, the remote sink, secret
redaction, and the rate limit. Never log in `update()` without an `if (log.isEnabled('debug'))`
guard — it runs 60x/second. Levels: `error`/`warn`/`info`/`debug`/`trace`, default `warn`;
`?log=debug` raises it, `?logview` draws the log on the display itself.
Detail: [`logging.md`](logging.md).

**No runtime asset loads** — everything loads once up front. A runtime fetch is a visible hitch
on-device. Gameplay/UI/config code must not load assets or open network connections; only the
preload layer may. If the game loads assets at all, call `sealAssetLoaders()` +
`sealAssetNetwork()` in `main.ts` after preload. Detail:
[`loading-screen.md`](loading-screen.md).

That rule is about *when* assets load, not *where the bytes come from*. A scaffolded game also
ships a **service worker** that precaches the build, so the second and every later launch reads
those same up-front loads off disk and the game runs offline. It is on by default, needs no
wiring, and is off in `npm run dev`; `?swreset=1` clears it. Nothing to do unless you are debugging
it — detail: [`offline-caching.md`](offline-caching.md).

## 7. Localization

All user-facing text goes through **i18next**. Add strings to `src/i18n/en.json`, then render with
`t('key')` from `@/i18n` (dynamic text) or a `data-i18n="key"` attribute on an empty element
(static HTML). Never hardcode copy in the DOM.

Bare numbers (`String(score)`) and glyph-only labels are not copy and stay as-is. Implement
**English only** — the setup lets a translator drop in `<lang>.json` later with no code change.
Locale is auto-detected; `?lng=<code>` overrides it for testing.

`npm run validate` enforces this. Full detail: [`localization.md`](localization.md).

---

## The gate

Before considering any change done:

```bash
npm run typecheck && npm test && npm run build && npm run validate
```

`validate` runs seven dependency-free scanners: no DOM input handlers, all text localized, no
runtime network asset loads, no raw `console.*`, the display shell (600x600 viewport, the
`mrbd-web-app-capable` meta, black page background, >= 16px text, no leftover scaffold
placeholders), the layer boundaries in §5 (only `src/models.ts` imports `three`; only
`src/main.ts`, `src/hud/`, and `src/log.ts` touch the DOM; no game code touches Web Audio), and a
coherent drag opt-in (`pointerDrag`, `touch-action: none`, and use of the movement delta agree).

`npm test` runs the game's tests and the scaffold's framework tests together, and the framework
half dominates the total, so **report `npm run test:game` and `npm run test:framework` as two
numbers, never the total** — see [`testing.md`](testing.md) § "Report the game count, never the
total".
