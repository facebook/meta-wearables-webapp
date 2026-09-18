# Project structure & conventions — webapp games

The opinionated layout and tooling for a webapp game. A game is a **static
build** — no backend, no server-side logic. Vite produces a folder of static assets that
any HTTPS static host can serve as-is.

> **One sanctioned exception:** the opt-in remote-logging backend
> ([`logging.md`](logging.md)) adds serverless functions under `api/`, because the glasses have no
> console and cannot be tethered. That is *developer* infrastructure, not game logic — the game
> itself is still a static bundle, and the endpoints 404 unless a `LOG_TOKEN` is configured. Even
> then: **never** add a `server.js` or a `package.json` `start` script. That makes Vercel run the
> whole app as a Node function whose working directory has no `index.html`, and every route 404s.

## Tech stack (fixed)

| Tool | Role |
|------|------|
| **Node.js** (>= 18) | Toolchain runtime only — not shipped to the device |
| **Vite** | Dev server (HMR) + production bundler |
| **TypeScript** (strict) | All game code. `tsc --noEmit` is the real type gate |
| **Three.js** | WebGL rendering for the game world — 2D (orthographic) or 3D (perspective) |
| **Vitest** | Unit tests for game logic |

Do not add a backend, a UI framework (React/Vue/Angular), or a CSS framework. They make
the performance budgets (see `performance-guidelines.md`) much harder to hit, and a game's
UI is small enough to do in plain DOM + CSS. (i18next — used for localization — is a small
text-catalog *library*, not a UI framework; it is the one sanctioned runtime dependency besides
Three.js. See [`localization.md`](localization.md).)

## Folder layout

```
my-game/
  index.html              # at src/ root — the page shell (see vite root below)
  package.json            # type:module, pinned deps, dev/build/test/typecheck scripts
  tsconfig.json           # strict; path alias @/* -> src/*
  vite.config.ts          # Vite + inlined Vitest config; root:'src', base:'./', outDir:'../dist'
  CLAUDE.md               # LLM orientation for the project
  README.md               # human-facing overview + commands
  docs/
    design.md             # the game's design document (keep granular, add more docs as needed)
  public/                 # static assets copied verbatim (textures, audio/, fonts)
  src/
    index.html            # the page shell (Vite root is src/); its head carries the required
                          # meta tags, incl. the managed <meta name="generator"> attribution
                          # marker — see core-contract.md
    style.css             # additive-display dark theme
    main.ts               # entry point: wires Renderer + InputManager + AudioPlayer + game loop
    log.ts                # the game's shared logger (level from ?log) — see logging.md
    models.ts             # the game's model ids + Three.js geometry (MODELS catalog)
    audio/                # audioSettings.json (designer-owned catalog) + soundIds.ts — see audio.md
                          # audioSizes.json is generated from public/ audio; commit it
    core/                 # gameplay, orchestration, state machine
    config/               # centralized tunable constants
    hud/                  # DOM HUD + menus (NOT Three.js — see threejs-vs-dom.md)
    i18n/                 # game strings (en.json) + i18next bootstrap — see localization.md
    framework/            # managed engine code (re-copyable; don't hand-edit; imports no game code)
      LICENSE             # BSD, Meta-copyright — covers this directory only, not your game
      core/               # variable-timestep game loop
      render/             # Renderer contract + Three.js impl (2D/3D camera) + asset loading
      input/              # InputManager contract + pointer/keyboard implementation
      audio/              # AudioPlayer contract, event/bank player, engine, banks — see audio.md
      i18n/               # i18next setup + locale detection policy (managed)
      debug/              # opt-in ?stats perf overlay + the logger, ?logview overlay, remote sink
      ui/                 # framework-provided DOM UI (LoadingScreen, remote-logging ConsentGate)
      storage/            # KeyValueStore persistence port (localStorage impl + memory fake)
      testing/            # Renderer/Input/Audio fakes for unit tests — see testing.md
      math/               # framework-free value types / helpers
  dist/                   # build output (generated; git-ignored)
```

The managed `src/framework/` code is documented as an API in
[`framework-api.md`](framework-api.md) (the layering rationale is in
[`game-architecture.md`](game-architecture.md)); the test setup is in
[`testing.md`](testing.md).

Why `root: 'src'`: it keeps `index.html` next to the code it loads and keeps config files
out of the served root. `base: './'` makes the built `index.html` reference assets
relatively (`./assets/...`) so the bundle works when it is served from a sub-path rather
than the server root.

## package.json scripts (standard set)

| Script | Command | Purpose |
|--------|---------|---------|
| `dev` | `vite` | Dev server with HMR (desktop browser at `localhost:5173`) |
| `build` | `tsc --noEmit && vite build` | Type-check, then bundle to `dist/` |
| `preview` | `vite preview` | Serve the production build locally |
| `test` | `vitest run` | Run the unit-test suite once (see `testing.md`) |
| `test:watch` | `vitest` | Re-run tests on change (TDD loop) |
| `typecheck` | `tsc --noEmit` | Type gate (Vite/esbuild strip types without checking) |
| `validate` | `node scripts/validate-all.mjs .` | Run all seven project-guideline checks — no input through the DOM, all user-facing text localized, no runtime network asset loads, no raw `console.*`, the display shell, the layer boundaries, and a coherent drag opt-in. One line per check; detail only for failures. Each check is also its own `scripts/validate-<id>.mjs` if you want to re-run one (see `game-architecture.md`, `localization.md`, `loading-screen.md`, `logging.md`, `display-guidelines.md`, `drag-channel.md`) |
| `package` | `node scripts/package-single-file.mjs` | Convert `dist/` into `index.single.html` plus a three-file `prototype-artifact.json`. Inlines JS/CSS, injects an early boot shell, generates a valid PNG icon + manifest, syntax-checks every script, and rejects any unconsumed build file. |
| `ship` | full gate + Vite build + `package` | Produce the artifact only after typecheck, tests, validators, and build all pass. |

Run `typecheck`, `test`, `validate`, and `build` before considering a change done.

### Single-file packaging boundary

The glasses host can omit `Content-Type` headers, so a multi-file module build can be blocked by
strict MIME checking and render only black. `npm run package` therefore emits one self-contained
HTML file and fails closed if any build file remains outside it. The current packager intentionally
supports procedural games and assets already represented as data URIs. A texture, model, sample,
dynamic chunk, or other loose file is a packaging failure until the packager has an explicit,
tested rewrite for that asset class.

`prototype-artifact.json` describes the three root-level files that make up the deliverable —
`index.html`, `favicon.png`, and `manifest.webmanifest` — each with its encoding and inline
contents, plus the total byte count and a sha256 over all three. A host is expected to serve those
three files from the root of wherever the game lives; whatever else it does with the artifact
(validating it, archiving it, publishing it) needs nothing further from the game.

## The dev-only debug handle

`main.ts` assigns the `Game` instance to `window.__game` behind `import.meta.env.DEV`, so it
exists while `npm run dev` is serving and is stripped from a production build. It is there to be
read from outside the page — `cdp.mjs eval --expr "window.__game.state"` answers "did that input
change anything" definitively, where diffing two screenshots of a game that animates on its own
cannot. See the plugin's `iterate-webapp-game` skill.

Reading it is safe from anywhere; **nothing in the game may read it**, since it does not exist in
the build the player runs.

## TypeScript conventions

- `strict: true`, `noUnusedLocals: true`. An unread private field is a compile error —
  expose it with a getter if it's real data, otherwise remove it.
- Path alias `@/* -> src/*` for clean imports (`import { DISPLAY } from '@/config/...'`).
- Descriptive names, not one-letter abbreviations (`row` not `r`, `player` not `p`).
  Exceptions: loop indices (`i`) and domain-conventional math locals (`x`/`y`/`z`).
- A type used by only one module lives in that module, not a shared `types.ts`. Only
  genuinely cross-module, behavior-free value types belong in a shared module.
- Prefer classes that own their behavior; give each entity/aggregate its own file.

## Where tunable numbers live

All gameplay tunables (speeds, sizes, colors, durations, input sensitivity) live as named
exported constants in `src/config/` — never inline magic numbers in gameplay code. This
makes tuning a single-file edit and keeps gameplay readable.

The managed framework classes under `src/framework/` never import `config` (so the framework
stays free of game code and can be re-copied safely). `main.ts` reads the constants and passes
the few the framework needs — the frame-delta cap, input sensitivity, tap threshold — as
constructor options.

One block is a partial exception worth knowing about. `AUDIO` holds only what the *device*
dictates: `maxVoices` (the channel-strip pool size, and so the hard voice ceiling),
`maxResidentBytes` (the decoded-PCM budget, default 24 MB — see
[audio-banks.md](audio-banks.md)), the spatial model, and the starting mix. What a *sound* is —
volumes, variation, fades, per-event voice limits — lives in `src/audio/audioSettings.json`
instead, so a sound designer can retune the game without touching TypeScript. See
[audio.md](audio.md).

**Don't put `as const` on a tunable block.** It gives each member a literal type, so a mutable
field seeded from one can never be reassigned — `private timeLeft = ROUND.duration` infers the
literal `60` and every later `this.timeLeft = …` is a type error. Without it the member types as
`number` and the field works. `DISPLAY` keeps `as const` because 600x600 is a fixed device fact,
not something a game tunes.
