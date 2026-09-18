# What the scaffold produces

`init-game.mjs` does everything mechanical in one call and prints a JSON summary (paths, install
method, anything stashed) so you don't need follow-up `ls` / `grep` calls.

## What the one command does

- copies the template tree (skipping build/install artifacts);
- **sets aside anything already in the target** into `_incoming-assets/` first, so a user who
  pre-dropped their art doesn't lose a file the template also ships (`README.md`, `docs/`,
  `package.json`) — Step 4 files those. `.claude/` and `.git/` are left where they are: they're
  agent and VCS state, not art, and moving `.claude/` would revoke your own project permissions
  mid-scaffold;
- renames the three files that ship under safe names so packaging cannot strip them:
  `project-claude.md` → `CLAUDE.md`, `gitignore` → `.gitignore`, and
  `src/framework/framework-license.txt` → `src/framework/LICENSE`;
- stamps `src/framework/VERSION` with the plugin version, which
  `update-webapp-game-framework` reads to detect newer framework releases, **and** the
  matching `<meta name="generator">` in `src/index.html` — the attribution marker that reaches the
  build output, so a released game says which skill and version built it;
- replaces `REPLACE_WITH_GAME_NAME` / `REPLACE_WITH_GAME_TITLE` everywhere and **verifies none
  survived**, and writes the `<meta name="description">` you passed;
- installs dependencies (see the note below);
- **runs the full gate** — `typecheck`, `test`, `validate` — and reports each one in a `gate`
  block, exiting non-zero if any fails. This is Step 5, done here: the whole scaffold plus the
  gate takes a few seconds in one call, and a check costs steps x context-size-at-that-point, so
  the identical gate is several times cheaper now than at the end of the build.

```json
"install": "npm ci --offline",
"gate": { "typecheck": "pass", "test": "pass", "validate": "pass" }
```

**`"skipped"` is not `"pass"`.** The gate is skipped when the install was skipped or failed (it
needs `node_modules`) — read the field, don't assume it.

It refuses to run over an existing game unless you pass `--force`, and rejects a non-kebab-case
name. Pass `--skip-install` to scaffold without touching the network (which also skips the gate),
or `--skip-gate` to install without running it.

> **On `npm install` and the sandbox.** The agent's Bash sandbox usually has **no network**, so a
> plain `npm install` hangs until it times out — this has cost whole minutes of a build. The
> template ships a `package-lock.json`, so `init-game.mjs` tries `npm ci --offline` first, which
> completes in seconds against a warm `~/.npm/_cacache`, and only then falls back to `npm ci` and
> `npm install`. If all three fail it says so and exits non-zero; ask the user to run
> `npm install` in their own terminal rather than retrying in the sandbox.

## The scaffolded tree

```
<game-name>/
  package.json  tsconfig.json  vite.config.ts   # tooling (vitest config is in vite.config.ts)
  vercel.json                                    # Vercel SPA fallback (stays at the root)
  scripts/validate-all.mjs                       # `npm run validate`: runs the seven checks
  scripts/package-single-file.mjs                # `npm run package`: emits the single-file bundle
  scripts/validate-{input-handlers,localized-strings,network-loads,console-logging}.mjs
  scripts/validate-{display-shell,layer-boundaries,drag-optin}.mjs   # (+ scripts/lib/)
  CLAUDE.md  README.md  docs/design.md           # project docs
  src/                                           # Vite root: index.html lives here
    index.html  style.css  main.ts               # game: page shell + entry wiring
    log.ts                                       # game: shared logger (level from ?log) — see docs/logging.md
    models.ts                                    # game: model ids + Three.js geometry
    audio/audioSettings.json                     # game: the sound catalog, designer-owned — see docs/audio.md
    audio/soundIds.ts  audio/audioSettings.test.ts  # game: the SoundId union + its drift guard
    core/Game.ts  core/Game.test.ts             # game: gameplay + its test
    config/gameplayConstants.ts  hud/Hud.ts     # game: tunables + DOM HUD
    i18n/en.json  i18n/index.ts                  # game: UI strings + i18next bootstrap
    framework/                                   # managed engine code (re-copyable; don't hand-edit)
      README.md
      core/GameLoop.ts
      render/Renderer.ts  render/ThreeRenderer.ts   # ThreeRenderer: 2D (ortho) or 3D (perspective)
      render/AssetLoader.ts                          # loads textures + 3D models + preloadManifest (imports three)
      render/assetFormats.ts  render/assetFormats.test.ts   # pure URL/format + manifest helpers (three-free)
      input/InputManager.ts  input/PointerKeyboardInput.ts  input/PointerKeyboardInput.test.ts
      audio/AudioPlayer.ts  audio/AmpAudioPlayer.ts   # audio contract + event/bank implementation — see docs/audio.md
      audio/AudioEngine.ts  audio/VoicePool.ts          # only Web Audio file + pure concurrency policy
      audio/audioSettings.ts  audio/BankStore.ts        # JSON schema/parse/validate + byte store — see docs/audio-banks.md
      audio/soundDefinitions.ts                        # synth layer format + builders (pure)
      i18n/i18n.ts                                    # i18next setup + locale detection (managed)
      debug/Logger.ts  debug/LogOverlay.ts  debug/RemoteLogSink.ts   # leveled logging, ?logview overlay, remote sink — see docs/logging.md
      ui/LoadingScreen.ts                            # opt-in DOM loading screen (progress bar) — see docs/loading-screen.md
      ui/ConsentGate.ts                              # blocking consent gate for remote logging — see docs/logging.md
      storage/KeyValueStore.ts                       # persistence port: localStorage impl + memory fake
      testing/fakes.ts                               # Renderer/Input/Audio fakes for unit tests
      math/Vector3.ts
  public/                                          # create if you add static assets (textures, models)
```

Everything under `src/framework/` is reusable engine code (renderer/input/audio contracts, game
loop, math) shared across games — it depends on no game code and is meant to be re-pulled
wholesale later. Everything else in `src/` is yours to edit. To pull a newer framework after
the plugin is updated, run the `update-webapp-game-framework` skill (it overwrites
only `src/framework/`).
