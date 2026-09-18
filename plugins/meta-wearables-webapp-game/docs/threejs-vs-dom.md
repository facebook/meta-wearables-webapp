# Three.js vs HTML/DOM — what renders where

A webapp game uses **two** stacked layers inside the 600x600 stage:

1. A **WebGL `<canvas>`** driven by Three.js — the game world (2D or 3D).
2. An **HTML/DOM overlay** on top — the UI: HUD, menus, score, modals.

```
#game-root (600x600, position: relative)
  ├─ <canvas id="game-canvas">   ← Three.js renders the game scene here (2D or 3D)
  └─ #hud (position: absolute)   ← DOM HUD / menus float above the canvas
```

Three.js drives **both 2D and 3D** games. A 3D game uses the default perspective camera; a 2D
game uses the orthographic camera (parallel projection, no depth foreshortening) plus textured
sprites. See `asset-loading.md` for the `projection` option and the sprite helper.

## Use Three.js (the canvas) for

- The game world: player, enemies, projectiles, terrain, particles, effects.
- Anything that moves each frame — whether in a 3D scene (depth, lighting) or a flat 2D scene.
- Vector/line art and low-poly meshes, and 2D sprites (all cheap on the additive display).

## Use HTML/DOM for

- The HUD: score, health bar, ammo, timers, floor/level indicator.
- Menus, title screen, game-over screen, pause/modal dialogs.
- Any text. **Do not render text in WebGL** — DOM text is crisper, accessible, scales to
  200%, and is far cheaper than texture/SDF glyphs. (If you must draw text inside the game
  scene, that's the rare exception — measure it.) All user-facing text must be localized via
  i18next (`t('key')` / `data-i18n`), never hardcoded — see [`localization.md`](localization.md).
- Reticles/crosshairs that don't need to sit in the scene (a centered DOM element is simplest).
- Debug overlays — the built-in `?stats` perf HUD is a DOM panel (see
  [framework-api-debug.md § Performance overlay](framework-api-debug.md#performance-overlay-stats)).

## Why split this way

- **Legibility**: DOM text stays sharp and accessible; the display guidelines (text ≥16px,
  scales to 200%, 4.5:1 contrast) apply to DOM, not WebGL glyphs.
- **Performance**: updating a DOM number is far cheaper than re-rendering a textured quad.
  Keep the canvas for things that genuinely need the GPU.
- **Additive display**: both layers sit on a pure-black (`#000000`) page background, which
  is transparent on the waveguide. Bright lines/meshes and bright DOM surfaces are what the
  wearer sees. Keep *bounded* surfaces — cards, panels, modals — a dark gray (not pure black) so
  they read as opaque, and leave the always-on HUD unfilled: bright text over the black page. See
  [`core-contract.md` § 1](core-contract.md#1-the-display-is-additive--black-is-transparent).

## HUD wiring pattern

The HUD reads game state and writes DOM — it never touches Three.js:

```ts
// src/hud/Hud.ts — DOM only; subscribes to game state, writes text/styles.
export class Hud {
  private readonly score = document.querySelector<HTMLElement>('#score')!;
  update(state: { score: number }): void {
    this.score.textContent = String(state.score);
  }
}
```

Keep the canvas and the HUD as separate concerns: gameplay updates state, the renderer
draws the game world (2D or 3D) from state, and the HUD reflects state into the DOM. None of
them import each other's internals.
