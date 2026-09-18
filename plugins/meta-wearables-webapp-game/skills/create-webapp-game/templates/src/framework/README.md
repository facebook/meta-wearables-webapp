# `src/framework/` — managed framework code

Reusable engine infrastructure shared across webapp games (2D and 3D): the renderer,
input, audio, and persistence contracts and their implementations, asset loading, the game loop,
the i18next localization setup, framework-free math, and the test fakes for those contracts
(`testing/fakes.ts`).

**Don't hand-edit files in here.** This directory is meant to be re-pulled wholesale when the
plugin ships an improved framework: run the `update-webapp-game-framework` skill to
overwrite it with the latest version. Local edits would be overwritten. It also depends on
**no** game code — nothing here imports `@/config/*`, `@/models`, or anything outside
`framework/`. Tunables are passed in via constructors (see `main.ts`).

`VERSION` records the plugin version this framework snapshot came from. It is written
automatically by the create/update skills — don't edit it by hand. The same stamp writes the
`<meta name="generator">` attribution marker in `src/index.html`, which is the copy of the version
that survives into a built, released game (`VERSION` never reaches `dist/`).

Put game code **outside** this directory:

- Models (ids + geometry) → `src/models.ts`
- Gameplay / orchestration → `src/core/`
- HUD / menus → `src/hud/` (+ `index.html`, `style.css`)
- UI strings / i18next bootstrap → `src/i18n/` (`en.json` + `index.ts`)
- Tunable constants → `src/config/gameplayConstants.ts`
- Entry wiring → `src/main.ts`
