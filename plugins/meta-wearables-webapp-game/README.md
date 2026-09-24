# Meta Display Glasses WebApp Game Plugin

Opinionated scaffolding for building **games** as webapps on Meta Display Glasses.

Where `meta-wearables-webapp` builds React apps on UI Toolkit for Meta Ray-Ban Display, this plugin
sets up a game project: **Vite + TypeScript + Three.js + Vitest**, a static build (no backend), and a
renderer- and input-agnostic architecture — all within the 600x600 additive-display and
EMG/D-pad constraints. Three.js drives both **2D** (orthographic camera + sprites) and **3D**
(perspective camera + meshes) games.

This plugin builds on `meta-wearables-webapp` (declared as a required dependency, so installing this
one installs it too), giving you its toolset as well: `ai-glasses-webapp-device` (sensors and glasses input),
`ai-glasses-webapp-optimize-performance` (startup measurement), and `ai-glasses-webapp-publish`
(production deployment and the add-to-glasses QR code).

## Skills

| Skill | Purpose |
|-------|---------|
| `/create-webapp-game` | Scaffold a new Vite + TS + Three.js + Vitest game project from bundled templates. Point it at a folder of starter art/audio and it files those under `public/` and builds the game around them. Optionally finishes by checking the built game in a real browser (see below) |
| `/webapp-game-director` | Iterate on an existing game as a demanding creative director: survey it against a 9-dimension quality rubric, agree a ranked slate of issues, then work them one at a time — plan, build, and hand each back for a real on-glasses playtest that decides whether it's done |
| `/iterate-webapp-game` | Drive the running game in a real desktop Chrome over the Chrome DevTools Protocol — screenshot it, press keys, click, drag, run console commands, read game state, capture errors — then edit and repeat. Also runs a structured verification pass over a finished build. Attaches to a Chrome you start with `npm run chrome` when the agent's sandbox can't launch one |
| `/update-webapp-game-framework` | Pull the latest bundled framework code (`src/framework/`) into an existing game after updating the plugin |
| `/read-webapp-game-docs` | Discover and read the bundled Meta Display Glasses platform + game-framework documentation (`docs/`) |
| `/validate-webapp-game` | Validate a game against project guidelines (no DOM input, all text localized, no runtime network asset loads, no raw `console.*`, the display shell, and the layer boundaries — gameplay imports no `three`, DOM, or Web Audio). Orchestrates bundled scripts, using a cheap subagent only for ambiguous cases |
| `/add-webapp-game-logging` | Add a log-ingest backend and a passcode-gated `/logs` portal, so logs from the game running on the glasses can be read on a laptop |

## Bring your own art (recommended)

Muse Code reads image files directly and is good at making sense of raw art — hand it a spritesheet,
tileset, or character sheet and it will work out the grid, the frame boundaries, and which row is
which animation, then build the game around what's actually in the sheet.

So before you run `/create-webapp-game`, gather whatever starter assets you have
(sprites, spritesheets, 3D models, sound files) into one folder and mention the path in your
prompt. Drop them in the new project's directory or leave them anywhere on disk — the skill files
them under `public/` for you (moving them if they're already in the project, copying them if
they're not, so your originals stay put). No assets is fine too: the game is then built from
procedural Three.js geometry.

**Optional:** installing [ImageMagick](https://imagemagick.org) (`brew install imagemagick`,
`sudo dnf install ImageMagick`, `sudo apt-get install imagemagick`) helps Muse Code *see* your art —
it can crop a single sprite out of a big sheet and zoom it into a scratch file to study one frame
at a time, check the cell grid lines up, and measure the sheet exactly. It's not required: the
skill checks for it, tells you the right command for your platform if it's missing, and carries
on without it.

## What you get from `create-webapp-game`

A ready-to-run project:

```
my-game/
  package.json  tsconfig.json  vite.config.ts   # Vite + Vitest + TS, pinned deps
  CLAUDE.md  README.md  docs/design.md
  src/
    index.html  style.css  main.ts   # page shell + entry wiring
    log.ts                           # shared logger (level from ?log) (game)
    models.ts                        # model ids + Three.js geometry (game)
    core/       gameplay + orchestration (+ an example Vitest test)
    config/     centralized tunable constants
    hud/        DOM HUD / menus
    framework/  managed engine code (re-copyable): GameLoop, Renderer + Three.js impl
                (2D/3D camera), AssetLoader (textures + models), InputManager +
                pointer/keyboard impl, leveled Logger + on-glasses log overlay,
                Vector3
```

```bash
cd my-game
npm install
npm run dev        # desktop browser: arrow keys + Enter + left-mouse drag
npm run typecheck && npm test && npm run build
```

## Iterating on a game

Scaffolding is the easy half. `/webapp-game-director` is the loop that follows: it plays the
current build, scores it against a quality rubric (core loop, juice, clarity, onboarding, pacing,
depth, cohesion, perf, accessibility), and puts a **ranked slate of issues** in front of you
rather than a verdict — you pick what to tackle. Each issue is worked to a change, gated
(`typecheck`/`test`/`validate`/`build`), and then handed back to you to **playtest on the
glasses**, because the agent can't wear them. Playtest feedback is what closes an issue; a change
nobody has played is recorded as `unverified`, not done. When the slate is clear it re-surveys and
opens the next milestone. It won't declare the game finished on its own — on "is it ready?" it
lays out the gaps and the trade, recommends, and leaves the call to you.

Underneath it, `/iterate-webapp-game` is how the agent actually *sees* the game without
a headset: it drives a real headed Chrome over CDP — load, screenshot, press arrow keys / `Enter`,
drag, read `window.__game` state, pull console errors — so a change can be verified visually rather
than inferred from the source. Run `npm run chrome` once (the skill wires up the script) and leave
it running; the agent starts it itself where its sandbox permits. Desktop still lies about the input
model, the additive display, and real perf, so it complements a playtest rather than replacing one.

It also carries a **verification pass** — a fixed sweep over a finished build (does it boot clean,
does it draw anything, would that be *visible on the additive display*, does every input do
something, does the HUD stay inside 600x600, does it do what `docs/design.md` says) that fixes the
clear-cut failures and reports the rest. `/create-webapp-game` offers it during planning:
say yes and it proves a Chrome is reachable **before** the build starts, then runs the sweep once
the build is done. Say no and nothing changes — but the summary will say plainly that the visual
checks did not run, because a scaffold that passes `typecheck`, `test`, `validate` and `build` can
still render a black rectangle.

## Updating the framework in an existing game

`src/framework/` is **managed** engine code — the same across games and meant to be re-pulled,
not hand-edited. When this plugin ships an improved framework, run
`/update-webapp-game-framework` from inside a game project to overwrite `src/framework/`
with the latest version. It previews the diff, confirms before writing, re-runs the build gate,
and leaves your game code (`src/models.ts`, `src/core/`, `src/hud/`, `src/config/`, `src/main.ts`)
untouched. The framework version is the plugin version, recorded in `src/framework/VERSION` and in
the `<meta name="generator">` tag in `src/index.html` — the attribution marker that survives into
a built, released game, naming the skill and version that produced it and linking to
<https://github.com/facebook/meta-wearables-webapp>. Updating re-stamps both, and inserts the tag
in a game scaffolded before it existed.

## The opinions (and why)

- **Three.js for the game world (2D or 3D), DOM for the UI.** A WebGL canvas renders the game
  — 2D with an orthographic camera + sprites, or 3D with a perspective camera + meshes; an
  HTML/DOM overlay renders the HUD, menus, and all text. Never render text in WebGL. See
  `docs/threejs-vs-dom.md`, and `docs/asset-loading.md` for loading textures/models.
- **Renderer- and input-agnostic gameplay.** Gameplay code talks to a `Renderer` and an
  `InputManager` interface and never imports `three` or touches the DOM. The Three.js
  renderer and pointer/keyboard input are injected at startup. This keeps gameplay
  **unit-testable** (the example test drives the game with fakes — no GPU, no DOM) and the
  renderer swappable. The contract carries the per-instance channels a game needs for feel —
  position, rotation, scale, opacity and spritesheet frame — each isolated between instances of
  the same model, so a fade or a walk cycle is a few lines of gameplay rather than a workaround.
  See `docs/game-architecture.md`.
- **Centralized tunables.** All gameplay numbers live in `src/config/` as named constants.
- **Pointer-based input.** The glasses deliver EMG pinch-and-move as a relative pointer drag;
  a desktop mouse drag is the identical stream, so one input path serves both. How a drag
  maps to gameplay is left to each game (it's game-dependent).
- **Static build, no backend.** Vite emits a folder of static assets to host over HTTPS.

## Display & performance constraints

The scaffold respects the Meta Display Glasses guidelines in this plugin's `docs/`: 600x600 viewport, black page background (transparent on the additive
display), dark gray on bounded surfaces, HUD text >= 16px, 30 fps, JS < 500 KB gzipped,
runtime memory < 128 MB. That an always-on HUD takes no fill at all — not even the dark gray
a card may use — is this plugin's own carve-out, in
[`docs/core-contract.md`](docs/core-contract.md) § 1; the shared doc states the dark-gray rule
for bounded surfaces without it.

## Running on the glasses

Because this is a **Vite build-tool app**, deploy it to Vercel from the **project root**
(not `dist/`): Vercel auto-detects Vite, runs the build, and serves the output. The scaffold
ships a root-level `vercel.json` for SPA fallback and caching: Vite's content-hashed output under
`/_vite/*` is immutable, and everything else — including `public/` content, which is copied
verbatim and so keeps stable URLs that must stay bustable — is revalidated, so a redeploy is
picked up on the next load. **Do not** add a `server.js` /
`package.json` `start` script — that makes Vercel run the app as a Node function and 404
every route. Do not run `meta-wearables-webapp`'s `ai-glasses-webapp-publish` script on a game: it first runs the
web app test gate, which checks for a UI Toolkit React shell a game does not have. Follow
[`skills/create-webapp-game/references/hosting.md`](skills/create-webapp-game/references/hosting.md)
instead, and generate the add-to-glasses QR code with that skill's `scripts/qr_generator.py`.

## Debugging on the glasses

The glasses can't be tethered, so **there is no console** once the game is on device. Three ways
to see what it's doing, cheapest first:

```bash
?stats                     # live FPS / CPU / draw calls on the display
?log=debug&logview         # the last log lines, drawn on the display — no backend needed
?log=debug&logkey=<token>  # send logs to your own deployment; read them at /logs
```

The first two need nothing but a URL. The third is added by **`/add-webapp-game-logging`**: the game
POSTs batched records to serverless endpoints in its own deployment and you read them from a
passcode-gated portal on your laptop. It shows a **blocking consent screen** before anything is
transmitted, and every endpoint 404s unless you've deliberately set a `LOG_TOKEN`. See
[`docs/logging.md`](docs/logging.md).

## References

- [`docs/README.md`](docs/README.md) — documentation index (start here)
- [`docs/project-structure.md`](docs/project-structure.md) — layout + tooling conventions
- [`docs/threejs-vs-dom.md`](docs/threejs-vs-dom.md) — what renders where
- [`docs/game-architecture.md`](docs/game-architecture.md) — renderer/input-agnostic layering + the input model
- [`docs/asset-loading.md`](docs/asset-loading.md) — loading 2D textures + 3D models, and the 2D/3D camera
- [`docs/logging.md`](docs/logging.md) — leveled logging, the on-glasses log overlay, and remote logging
- `docs/display-guidelines.md`, `docs/performance-guidelines.md` — shared device constraints
