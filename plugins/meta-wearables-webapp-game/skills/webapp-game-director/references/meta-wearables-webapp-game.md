# Working in concert with the `meta-wearables-webapp-game` skills

Reference for the `webapp-game-director` skill — read once the Meta Display Glasses platform is detected.

For a **webapp game**, this skill is one member of a family and
must play its part without stepping on the others. The family covers a game's whole life; this
skill owns the **iterate / improve / quality** phase that sits between scaffolding and shipping.

```
create-webapp-game   →   webapp-game-director (this skill)   →   publish
        (scaffold)                          (survey · slate · plan ·       (ship)
                                             build · user playtest · milestone)
  read-webapp-game-docs  ← consulted throughout →  update-webapp-game-framework
        (platform + framework knowledge)                       (re-pull managed engine code)
```

**Detect the platform** from: a 600×600 additive display, EMG/D-pad input, a Vite + TypeScript
+ Three.js + Vitest scaffold, `three`/glasses deps, a `src/framework/` dir, or a `CLAUDE.md`
describing the platform. When detected:

- **Consult the docs, don't guess budgets.** Before proposing any platform-touching change,
  invoke **`meta-wearables-webapp-game:read-webapp-game-docs`** (the project's `CLAUDE.md`
  already sanctions this) and score against what it says —
  `${CLAUDE_PLUGIN_ROOT}/docs/display-guidelines.md` and
  `${CLAUDE_PLUGIN_ROOT}/docs/performance-guidelines.md` are the source of truth — except for the
  always-on HUD, which `${CLAUDE_PLUGIN_ROOT}/docs/core-contract.md` section 1 carves out and
  `display-guidelines.md` still states unqualified. Hard budgets to
  treat as **rubric failures**, not nice-to-haves, if you can't reach the docs: 600×600 viewport;
  additive display (pure black = transparent, only bright pixels show); the always-on HUD is
  bright text over the black page, never a filled strip; text ≥16px (24px
  outdoors); 30 fps; JS < 500 KB gzipped; memory < 128 MB; < 10 network requests on load. For the
  deeper patterns behind specific rubric dimensions, the same `docs/` folder has `audio.md`
  (juice and sound design), `display-guidelines.md` (layout, safe zone, typography traps), and
  `query-parameters.md` (the debug switches below).

- **Respect the framework/game split when you build — this is how you stay compatible with the
  other skills.** The scaffold splits code into *managed engine code* under `src/framework/`
  (re-copyable; owned by `create-` and re-pulled by `update-webapp-game-framework`)
  and *your game code* everywhere else. If you hand-edit `src/framework/`, you silently break the
  `update-` skill's re-pull and lose your edits on the next framework bump. So route every
  improvement to the right place:
  - Gameplay/feel logic → `src/core/` (+ new entity/system files). Must **not** import `three`
    or touch the DOM — it talks to the `Renderer` / `InputManager` contracts.
  - **Tuning (a huge share of iteration — difficulty curve, pacing, juice timings, speeds)** →
    named constants in `src/config/gameplayConstants.ts`. Never inline magic numbers; this file
    is *the* dial-board for balance passes. When a tuning change is supposed to produce an
    *outcome* (a win rate, a run length, a difficulty ramp), measure it with a seeded simulation
    test rather than asserting it — balance is invisible to the gate, so an unmeasured tuning
    claim is the easiest thing on the board to get wrong. Treat any outcome figure quoted in the
    design as an estimate, not a spec, and never adjust the measurement to make it agree.
  - Models/geometry → `src/models.ts` (the only game file that imports `three`).
  - **Visual juice** → the `Renderer`'s per-instance channels, driven from `update(dt)`:
    `setScale?.()` (pulse, pop, squash and stretch), `setOpacity?.()` (fade, damage flash,
    ghosting) and `setFrame?.()` (spritesheet animation, frames declared on the model's spec).
    They are isolated per instance, so a slate item like "the pickup needs to read as collectable"
    is usually a few lines in `src/core/` — not stacked quads toggled with `setVisible` or one
    model id per animation frame.
  - **Sound (the other half of juice)** → declarative events in `src/audio/audioSettings.json`. The
    framework ships the synthesis engine and the format but **no sounds** — a game's
    fire/hit/pickup/death catalog is game code, and adding it is often the highest-leverage feel
    fix available. See `${CLAUDE_PLUGIN_ROOT}/docs/audio.md`.
  - HUD / menus → the DOM (`src/hud/` + `index.html` + `style.css`), never WebGL. **Every
    user-facing string goes through i18next** — `t('key')` in TS, `data-i18n` in HTML, with the
    text in `src/i18n/en.json`. Hardcoded DOM strings fail `npm run validate`; don't introduce
    them while polishing copy. See `${CLAUDE_PLUGIN_ROOT}/docs/localization.md`.
  - Keep the design record current in `docs/design.md`, alongside this skill's `critique.md` /
    `playtest-log.md` so they all live with the game.

- **Close every build pass with the family's gate.** Run `npm run typecheck && npm test &&
  npm run validate && npm run build` before calling a change good — the same gate `create-` and
  `update-` enforce. `validate` is the project's guideline check (no input through the DOM, all
  text localized, no runtime network asset loads, no raw `console.*`, the display shell, and the
  layer boundaries — gameplay imports no `three`, DOM, or Web Audio); when it fails, use
  **`meta-wearables-webapp-game:validate-webapp-game`** to interpret and fix it. Add/adjust
  Vitest tests (mirroring `src/core/Game.test.ts`) for non-trivial logic you change.

- **Use the built-in instruments before guessing.** The scaffold ships debug switches you append
  to the game URL, on device or on desktop. `?stats` draws live FPS / CPU / draw calls — score
  *Performance & platform fit* against that, not against how it feels on your laptop.
  `?log=debug&logview` draws the log on the 600×600 display, which is the only way to diagnose a
  device-only bug: there is no console on the glasses. When the log needs to reach the laptop,
  **`meta-wearables-webapp-game:add-webapp-game-logging`** adds a `/logs` portal. Full switch list in
  `${CLAUDE_PLUGIN_ROOT}/docs/query-parameters.md`; logging detail in
  `${CLAUDE_PLUGIN_ROOT}/docs/logging.md`.

- **Sweep for objective defects before you critique anything.** `iterate-webapp-game`
  ships a structured 8-check sweep at
  `${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/references/verification-pass.md`:
  does it boot clean, render at all, render *visibly on the additive display*, respond to every
  input, keep the HUD inside 600×600, reach the outcomes `docs/design.md` promises. Run it at the
  top of the survey and fix what it finds — those are not slate items, because "the enemy sprite
  is `#0a0a12` and therefore invisible on device" is not a matter of taste and does not need the
  user's ranking. A defect left in place also poisons the rubric: you cannot score *Feel* on a
  game whose input is broken.

  Keep the boundary the reference itself draws — **the pass asks "does it work", this skill asks
  "is it good"**, and only a real on-glasses playtest settles the second. If you catch yourself
  ranking the pass's findings by how much fixing them would improve the game, that is this
  skill's job starting, not the pass's continuing.

- **Survey on your own where you can — but playtest on the real surface, because desktop lies.**
  For your own survey pass, **`iterate-webapp-game`** drives a real headed browser over
  CDP so you can screenshot the game, click through it, read console errors, and inspect state —
  including from a sandbox that can't launch a browser, by attaching to one the user started. It
  also crops a screenshot to the 600x600 stage and reduces a frame to numbers, so "is anything
  drawn" is answerable without eyeballing. Load the game with `?drive` and the loop pauses so you
  advance it a known number of frames (`window.__webappGame.step(30)`), which is what makes "did
  that input do anything" answerable on a game that animates on its own. All of it is for
  *diagnosis*. None of it substitutes for a playtest: the desktop hides the input model, the
  additive display, and the true perf, so get each pass in front of a player on device. Hand off
  to the shipping skills by name:
  **`meta-wearables-webapp:test-on-device`** (quick staging URL) or
  **`meta-wearables-webapp:publish-to-vercel`** (stable URL — deploy from the project root, accept the
  Vite preset, never add a `server.js`/`start` script).

- **Critique controls against what the hardware can express.** EMG pinch = discrete select
  (`pinchTap`); D-pad swipes move focus; continuous drag is opt-in; there is no touchscreen, no
  chords, and no discrete D-pad center tap. Judge control feel against that model, not a mouse.
