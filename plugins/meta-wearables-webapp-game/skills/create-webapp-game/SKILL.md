---
name: create-webapp-game
description: >-
  Scaffold a new webapp game for Meta Display Glasses using Vite +
  TypeScript + Three.js + Vitest, with a renderer- and input-agnostic
  architecture. Supports both 2D and 3D games. Use when the user wants to start a
  glasses game, build a 2D or 3D game for smart glasses, or scaffold a Three.js
  game project for Meta Display Glasses.
argument-hint: "[game-name] [game concept]"
---

# Create a webapp game

Scaffold a new game for Meta Display Glasses: an opinionated **Vite + TypeScript + Three.js
+ Vitest** project (static build, no backend) with a renderer- and input-agnostic
architecture, set up for the 600x600 additive display and EMG/D-pad input. Three.js drives
both **2D** (orthographic camera + sprites) and **3D** (perspective camera + meshes) games.

This is the game-focused counterpart to `meta-wearables-webapp`'s `ai-glasses-webapp-build` (which
builds React apps on UI Toolkit for Meta Ray-Ban Display). Use **this** skill when the project is a real-time 2D or 3D game.

## Required reading

The non-negotiables live in one Tier-0 digest:
**`${CLAUDE_PLUGIN_ROOT}/docs/core-contract.md`** — display physics and the additive-display
color rules, performance budgets, the EMG/D-pad input model and the no-input-through-the-DOM
rule, the Three.js-vs-DOM split, the renderer/input-agnostic layering, logging, and localization.
It is sufficient on its own for a procedural game with no art, sound, or preloader. Generated code
that ignores it will fail on-device or rot architecturally.

**Read it in Step 2 — after the Q&A, not before.** Which of the deeper docs you need depends
entirely on the Step 1 answers (art? sound? a preloader?), so reading up front means paying for
docs the game will never use, and paying again on every turn that carries them.

If a reference is unavailable in an isolated eval, still apply the hard budgets: 600x600
viewport; black page background (transparent on the additive display), with dark gray reserved
for bounded surfaces such as cards and modals and the always-on HUD left unfilled; HUD text
>= 16px; 30 fps; JS < 500 KB gzipped; runtime memory < 128 MB.

## Workflow

### Step 0: Enter plan mode

**Before anything else, make sure you are in plan mode** — call `EnterPlanMode` if you are not.
Do all of the required reading and the Step 1 Q&A **inside plan mode**, and do not scaffold, copy
the template, or run any non-read-only command until the user has approved the plan via
`ExitPlanMode`. Scaffolding is a long, mostly-unattended operation, so the whole point of this
phase is to align tightly up front; a shallow understanding here is expensive later.

**Keep any task list coarse — one item per Step below, not one per file.** Task bookkeeping is
pure overhead: it produces no build output, and in a measured run of this skill it consumed 15% of
the total tokens. Thinking harder inside a step is nearly free; adding steps is not.

### Step 1: Understand the game

Run a **thorough, multi-round conversation** to pin down what the user wants before you plan or
build. **Do not stop after one round.** Keep going until you can restate the game back to the
user with no gaps AND the user has no remaining questions — only then move on.

**How to ask:**

- Use the **`AskUserQuestion`** tool for discrete choices (2D vs 3D, sound on/off, synth vs
  samples, loading screen yes/no, …) — batch up to 4 per call so the user can click through them.
- Use **free-form prose** for the open-ended design discussion (the concept, the core loop, what
  makes it fun, how a drag should feel).
- **Between rounds, summarize your current understanding back to the user** and ask what's wrong
  or missing. Each round should resolve the previous round's open threads and open the next.
- **If the user already gave a detailed concept**, don't re-interrogate everything: play the
  concept back as a summary first, then ask only about the dimensions still unspecified.

**Cover this question catalog** (each answer feeds a real scaffold decision and, later, a
section of `docs/design.md`). Don't skip a group just because it seems obvious — confirm it.

- **Concept & core loop** — What is the game? What's the moment-to-moment loop
  (perceive → decide → act → feedback)? How do you win, lose, and score? What makes it fun?
- **2D or 3D** — 2D (orthographic camera + sprites) or 3D (perspective camera + meshes)? This
  picks the `ThreeRenderer` projection and shapes everything downstream.
- **Controls & feel** — What does an **index tap** select? What does each **D-pad swipe**
  direction do? And the one decision to make explicitly: **does an index DRAG do anything**
  (aim, move, look)? **Tap-only is the default and the scaffold ships that way** — the drag
  channel is a three-edit opt-in that changes what the device delivers. Note that browser
  iteration uses `Enter` for the index pinch either way, so "so mouse clicks work in Chrome" is
  never a reason to opt in.
- **Art & source assets** — Procedural Three.js geometry, or real art files (PNG/WebP/JPG
  textures, GLB/GLTF/FBX/OBJ models)? **Where are the source art assets — an existing
  path/folder, or should they be generated?** (This decides whether `public/` + the asset
  loader are used at all.) **Act on the answer now, in plan mode — don't just record it.** If the
  user gave paths, `ls` the folder, **read the image files**, and play your interpretation back
  for confirmation — grid, cell size, frame count, per-row contents, transparency, and which
  assets are too dark for the additive display. If they gave none, offer to wait while they
  gather some. Either way, read
  [`references/source-art.md`](references/source-art.md) first: it has the measurement recipe
  (silhouette vs. cell), the brightness rule, and the ImageMagick tooling for looking at
  individual frames. A silently wrong reading of a spritesheet is the expensive failure here —
  it surfaces only after the whole game is built around it.
- **Sound** — **Should the game have sound at all?** If so, **synthesized** (oscillator/noise +
  ADSR via `synth(...)`, for a retro 8-bit feel) or **sample-based** (audio files)? Background
  music too? **Where are the source sound files** if using samples? Which sound events matter
  (e.g. player-fire, pickup, explosion, UI select)?
- **Loading screen** — **Should it include a loading-screen progress bar** (the opt-in manifest
  preloader shown before the title)? Usually yes when there are real assets; skip it for a tiny
  procedural game with nothing to preload.
- **Persistence** — Persist anything across sessions (high scores, settings, unlocks) via
  localStorage?
- **Difficulty & progression** — Does difficulty ramp? Levels/waves, endless, or fixed?
- **Localization** — English-only is the default (a translator can add `<lang>.json` later).
  Ask only if other languages are needed up front.
- **Scope & vertical slice** — What is the **smallest playable slice** to build first, and what
  is explicitly **out of scope** for now? Keep the first target small.
- **Target** — Is this headed for a public URL on the glasses, or staying a local prototype?
  (Informs Step 8; not blocking.)
- **Autonomous browser verification** — after the build, should you open the game in a real
  browser and check it yourself? **Ask this one explicitly**, with the real trade-off rather than
  a leading question. It buys the defects every static check misses (sprites at the wrong scale,
  art invisible on the additive display, a clipped HUD, an input wired to nothing, a title screen
  that never advances — the gate can be entirely green on a game that renders a black rectangle);
  it costs tokens, noticeably, because screenshots are images and each stays in context for the
  rest of the run.

  **If they say yes, prove a browser is reachable before you leave plan mode** — finding out after
  the build that the pass was never possible wastes the decision. Read
  [`references/browser-verification.md`](references/browser-verification.md) § "Step 1" for the
  read-only probe, what to do on exit 3, and why not to reach for Playwright. If no browser can
  be reached, **degrade, don't block**: drop the pass, say so in the plan in one line, and build
  anyway. Record the outcome either way — it decides whether Step 5 runs the smoke test and
  whether Step 7 runs the pass.

When the conversation converges, capture the agreed design in the plan; it becomes the content
you write into `docs/design.md` in Step 3. Then present the plan and `ExitPlanMode` for approval
before scaffolding.

#### A stated outcome is an estimate, not a spec

A brief often quotes an outcome its numbers are supposed to produce — *"these land at a ~53% win
rate, don't re-derive them"*, *"a run takes 6–9 minutes"*. That figure is **derived** from the
constants, usually measured once against an earlier design, and it goes stale without anyone
noticing. **Treat it as a broad guideline, not a rule**: your own measurement is the truth.

**Never bend the measurement to fit the claim.** If a balance test measures 100% where the brief
says 53%, the brief is out of date: change the constants, or accept the new figure and say so.
Do not rewrite the bot, loosen the assertion, or keep editing until the two agree — that is
tampering with the instrument, and a run that does it can burn its whole back half and never
reach a gate. Note what you measured and what you changed in `docs/design.md`.

### Step 2: Read the docs the answers call for

Now that you know what the game is, read for it. **Always** read the Tier-0 digest:

```
${CLAUDE_PLUGIN_ROOT}/docs/core-contract.md
```

Then add **only** the docs the Step 1 answers actually implicate:

| If Step 1 said… | Also read |
|---|---|
| An index **drag** does something (aim/move/look) | `docs/drag-channel.md` |
| Real art files (textures, 3D models) | `docs/asset-loading.md` |
| Frames packed into a spritesheet / atlas | `docs/spritesheets.md` |
| Sound of any kind | `docs/audio.md` |
| Recorded (not synthesized) sound, or music | `docs/audio.md` + `docs/audio-banks.md` |
| A loading-screen progress bar | `docs/loading-screen.md` |
| You'll need logs off the device | `docs/logging.md` |
| — (always, when you write the tests in Step 6) | `docs/testing.md` |

A procedural game with no art, no sound, and no preloader needs **none** of the conditional set —
`core-contract.md` alone is enough. Don't read them "just in case": every doc you open is re-sent
with every subsequent turn for the rest of the build.

The `docs/framework-api*.md` reference is deliberately **not** in the default set. Together it is
the largest body of prose in the plugin, and you will be reading the actual `src/framework/**`
sources anyway once the template is copied — they are authoritative and cheaper. Open it only when
you need a signature and the source isn't to hand, and then open only the one part you need:
`docs/framework-api.md` is a slim index that says which part documents which symbol.

For anything else, the **`read-webapp-game-docs`** skill indexes every platform and
framework doc; `docs/README.md` is the index it starts from.

### Step 3: Scaffold the project

Pick the two names, then run one command:

- **Game name**: kebab-case, lowercase, no spaces (the npm package name), e.g. `neon-runner`.
- **Title**: the human name, e.g. "Neon Runner".
- **Location**: ask, or default to `~/webapp-games/<game-name>/`.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/create-webapp-game/scripts/init-game.mjs" \
  --dir ~/webapp-games/<game-name> \
  --name <game-name> \
  --title "<Game Title>" \
  --description "<one-line, game-specific meta description>"
```

That single call does everything mechanical — copy the tree, stash anything already in the target
into `_incoming-assets/`, rename the safe-named files, stamp the framework version, substitute the
placeholders, install dependencies — and then **runs the full gate** (`typecheck`, `test`,
`validate`), exiting non-zero if any fails. That is Step 5, done here, where it is several times
cheaper than at the end of the build. It prints a JSON summary, so you need no follow-up `ls` /
`grep` calls:

```json
"install": "npm ci --offline",
"gate": { "typecheck": "pass", "test": "pass", "validate": "pass" }
```

**`"skipped"` is not `"pass"`.** The gate is skipped when the install was skipped or failed (it
needs `node_modules`) — read the field, don't assume it.

[`references/scaffold-output.md`](references/scaffold-output.md) has the full step-by-step of what
the command does, the `--force` / `--skip-install` / `--skip-gate` flags, the sandbox-has-no-network
note, and the annotated tree it produces — including which parts of `src/` are yours to edit and
which are managed framework code. Read it if the output surprises you or you need to know where
something landed.

The remaining Step 3 work is the part that needs judgment: **fill in `docs/design.md`** with the
concept agreed in Step 1.

### Step 4: Bring in the source assets

Skip this step for a fully procedural game. Otherwise file every source asset the user provided
(from Step 1, plus anything set aside in `_incoming-assets/` in Step 3) under `public/`, which
Vite copies verbatim into the build.

**Read [`references/source-art.md`](references/source-art.md) § "Filing the assets into the
project" and work it.** It has the per-kind destination table, the multi-file-model rule, and the
two decisions this step turns on:

- **Move vs. copy.** Already inside the project → `mv`. Anywhere outside it → `cp`, and never
  move, rename, or delete the user's own file; their folder must look untouched afterwards.
- **Which copy are you editing** before any destructive edit (recolor, brighten, downscale,
  convert). A `mv`'d file under `public/` is the user's **only** copy — get their go-ahead and
  save the original to `art-originals/` first.

**Do the brightness fixes here, not later**: a dark sprite is cheap to recolor now and expensive
to discover once the game is built around it — and it cannot be discovered at all without a
device or a browser.

**Delete nothing.** Leave anything you can't classify in `_incoming-assets/` and ask the user
about it; whatever is still in it at the end of the run gets named — file and reason — in your
completion summary, which is what Step 7 checks for.

Then record the inventory in `docs/design.md` — each asset's path, what it is, how the game uses
it, the frame grid you read off each spritesheet in Step 1, and any brightness fix it needs.
Step 6 implements against that written interpretation instead of re-deriving it.

### Step 5: Read the gate result (don't re-run it)

**Step 3 already ran `typecheck`, `test`, and `validate`.** Read the `gate` block from its JSON
output and act on it:

- **all `pass`** → continue. Do not re-run the gate to confirm; you already have the answer.
- **any `fail`** → fix it now, then re-run just the failing command.
- **any `skipped`** → the install didn't complete, so nothing has been verified. Get dependencies
  installed (ask the user to run `npm install` in their own terminal if the sandbox blocked it)
  and run the gate yourself before continuing.

The one thing Step 3 does not run is `npm run build`, because it is the slowest step and adds
nothing a passing `typecheck` hasn't already caught at this stage. It gets run in Step 7.

`validate` runs seven dependency-free scanners — no DOM-handled input, all text localized, no
runtime network asset loads, no raw `console.*`, the display shell, the layer boundaries, and a
coherent drag opt-in. The `validate-webapp-game` skill documents exactly what each one
looks for; Step 7 lists what a green run has therefore already proved.

#### Prove the browser loop works

**Only if Step 1 opted into the verification pass.** Skip this entirely otherwise.

Step 1 proved a Chrome is reachable. This proves the whole chain works end to end — Vite, Chrome,
CDP, screenshot — while the game is still the untouched starter, which already renders something.
Doing it now rather than at Step 7 means a broken link costs you nothing: no game code has been
written yet.

Run [`references/browser-verification.md`](references/browser-verification.md) § "Step 5". It has
the exact `setup-cdp.mjs` / dev-server / `cdp shot` sequence, and the flags on the dev-server line
are load-bearing — copy them rather than improvising. You should end up looking at the starter
game's title screen; that is the one screenshot worth spending here.

Leave the dev server running; Step 7 needs it. Kill that background task when the run ends.

**If any of it fails**, don't debug it now and don't retry in a loop — you are at the start of a
long build. Drop the pass, tell the user in one line which step failed, and continue to Step 6.
Step 7 will report `visual checks: NOT RUN`.

### Step 6: Implement the game

**These files already exist — `Read` before you `Write`, or use `Edit`.** Everything you are about
to fill in (`src/config/gameplayConstants.ts`, `src/models.ts`, `src/core/Game.ts`,
`src/audio/audioSettings.json`, `src/audio/soundIds.ts`, `src/i18n/en.json`, `src/index.html`,
`src/style.css`, `docs/design.md`) was created by the scaffold, and `Write` refuses a file it
hasn't read this session. Reading first is worth it anyway: each one shows what the starter
already wires up.

Build the game **on top of the architecture**, not around it:

- Put gameplay in `src/core/` + new entity/system files. Gameplay code talks to the
  `Renderer` and `InputManager` interfaces — it must **not** import `three` or touch the DOM.
- Add models by extending the `ModelId` union + `MODELS` catalog in `src/models.ts` (the only
  game file that imports `three`). Don't edit `src/framework/render/*` — it's managed code.
- **Visual cues come from the renderer contract, not a workaround.** Alongside `setTransform` /
  `setRotation` / `setVisible`, `Renderer` has three per-instance channels: `setScale?.()` (pulse,
  pop, squash and stretch), `setOpacity?.()` (fade in/out, damage flash, ghost preview) and
  `setFrame?.()` (spritesheet animation — declare `sheet` + `frames` on the model's spec, see
  `docs/spritesheets.md`). Each is isolated between instances of the same model. Drive them from
  `update(dt)`; there is no tween or playback clock. Never hand-roll a pool of stacked quads
  toggled with `setVisible`, and never register one `ModelId` per animation frame.
- For a **2D** game, construct the renderer with `{ projection: 'orthographic' }` in `main.ts`.
  To use image or 3D-model files, load them via `framework/render/AssetLoader.ts` and follow the
  preload-then-clone pattern in **`docs/asset-loading.md` — read that doc first**; it covers the
  three gotchas that otherwise cost a debugging round each (ship external textures, clone with
  `cloneModel`, convert lit materials to unlit). Sprites cut from a packed sheet use
  `atlasSprite` / `atlasFrameTexture`, never `createTexturedPlane` on the raw sheet; size the quad
  from the art's measured silhouette, not its cell — see `docs/spritesheets.md`. To preload a
  whole asset set with a size-weighted progress bar before the title screen, declare a manifest
  and use `preloadManifest` + the framework `LoadingScreen` rather than a hand-written
  `loadAssets()` — see `docs/loading-screen.md`. After preloading, call `sealAssetLoaders()` +
  `sealAssetNetwork()` in `main.ts`, before the loop, so an accidental runtime asset load fails
  loudly instead of hitching on-device.
- For **sound**, use the framework `AudioPlayer` (injected into `Game` in `main.ts`), not
  `new Audio()`. Sounds are **declared in `src/audio/audioSettings.json`**, not written in code:
  a named event per sound, whose `clips` are either recorded filenames or inline synth stacks,
  plus tuning. Add each event's name to the `SOUND_IDS` list in `src/audio/soundIds.ts`
  (`audioSettings.test.ts` fails if the two drift), then `audio.play(id, { position })` — pass
  `position` for stereo-pan + distance. The framework ships the synth engine but no specific
  sounds — design your own catalog. Unlock audio with `audio.resume()` on the first pinch.
  **Read `docs/audio.md` first** for the full event schema, and `docs/audio-banks.md` too if the
  game has recorded audio.
- Add tunables to `config/gameplayConstants.ts` — never inline magic numbers. The framework
  classes take the numbers they need via constructor options (wired in `main.ts`), so config
  stays a game file the framework never imports. If the design asserts an *outcome* those numbers
  are supposed to produce, measure it rather than assuming it — and remember that the asserted
  figure is an estimate, not a spec (Step 1).
- Put UI/HUD/text/menus in the DOM (`src/hud/` + `index.html` + `style.css`), not in WebGL.
- **To persist anything** (best score, settings, unlocks), inject the framework
  `KeyValueStore` — `new BrowserKeyValueStore({ namespace: '<game-name>' })` in `main.ts`,
  `MemoryKeyValueStore` in tests. Never call `localStorage` from gameplay: it is a DOM global,
  so `npm run validate` fails it outside the DOM adapters. See `docs/game-architecture.md`
  § "Persisting state across sessions".
- Localize all user-facing text: add strings to `src/i18n/en.json` and render them with `t('key')`
  from `@/i18n` (dynamic text) or a `data-i18n="key"` attribute (static HTML) — never hardcode copy
  in the DOM. Implement **English only**; the game is structured so a translator adds `<lang>.json`
  later. See `docs/localization.md`. (`npm run validate` enforces this.)
- **Input: the scaffold is tap-only, so by default change nothing.** `dpadSwipe` and `pinchTap`
  are wired and need no configuration. Only if Step 1 said an index **drag** drives gameplay,
  make the three coordinated edits in `docs/drag-channel.md`
  (`touch-action: none`, `{ pointerDrag: true }`, and consuming the movement delta) and
  decide the drag-to-gameplay mapping for THIS game. Opting in flips the tap source from `Enter`
  to a click, so also do what that doc's closing section says and correct everything that
  describes the tap-only controls — `main.ts`'s header comment, `README.md`, `docs/design.md`,
  and anything the game's `CLAUDE.md` § Input model adds about the controls. Never turn the flag
  on for any other reason — `npm run validate` fails a game that sets it without using the delta.
- Write Vitest unit tests for non-trivial logic, mirroring `src/core/Game.test.ts`.
  `Game.test.ts` tests the *starter* game, so **replace it wholesale when you replace
  `Game.ts`** — but import `FakeRenderer` / `FakeInput` / `FakeAudioPlayer` from
  `@/framework/testing/fakes` rather than writing your own. Those satisfy framework interfaces;
  rewriting them by hand costs several typecheck round-trips and buys nothing.
  (`MemoryKeyValueStore` from `@/framework/storage/KeyValueStore` is the persistence fake.)

**Run the gate once when the vertical slice is playable**, before authoring the remaining content
— a broken layer boundary or an unlocalized string is far cheaper to fix in the slice than after
six levels are built on top of it. Don't run it more often than that; each run is a round-trip.

The user can run `npm run dev` and try it in a desktop browser at any point: **arrows = D-pad
swipe, Enter = index tap (select)**. A mouse click does nothing in a tap-only game — there is no
cursor on the glasses, so `Enter` is the stand-in for the pinch. Never add `pointerDrag` to make
clicks work.

**You, though, do not drive a browser during this step.** Build the whole slice first. Screenshots
are images and images are re-sent on every subsequent turn, so interleaving them multiplies the
cost of a phase that is otherwise linear and cheap — and it pulls you into polishing one screen
while the rest of the game is unwritten. Looking at the running game is a separate phase, after
the build, and Step 7 runs it.

### Step 7: Verify

**The gate covers most of this — run it first, then check only what a script can't see:**

```bash
npm run typecheck && npm test && npm run build && npm run validate
```

That already proves: no DOM input handlers, all text localized, no runtime network loads, no raw
`console.*`, the 600x600 viewport, the `mrbd-web-app-capable` meta, a black page background, HUD
text >= 16px, a game-specific `<meta name="description">`, an intact `<meta name="generator">`
attribution marker, no surviving placeholder tokens, and
that gameplay imports neither `three`, the DOM, nor the Web Audio API. Don't re-verify any of
those by reading files.

Then get the two test counts you will report — `npm test`'s total is mostly framework tests the
scaffold shipped, so it is not a measure of this game. Run `npm run test:game` and
`npm run test:framework` as **two commands, not `a && b`**: a game with no tests of its own makes
`test:game` exit 1 (`No test files found`), which is a finding for the checklist below — not a
reason to skip the framework count.

What still needs your eyes:

- [ ] **Bounded surfaces are dark gray, not pure black — and the HUD has no fill at all.** A
      `#000000` card is invisible on the additive display, so cards, panels and modals get
      `#0a0a0f` – `#1C1E21`. The HUD is the exception: it is on screen the whole round, so a
      filled strip behind it is a permanently lit band across the wearer's view. (The validator
      checks the *page* background is black; it can't tell a card from the page.)
- [ ] **Every sprite the player must react to emits light** — nothing gameplay-critical, above
      all nothing the player must *dodge*, is near-black, and no opaque full-bleed backdrop lights
      up the whole view. **A source-art check, so it needs no browser**; Steps 1 and 4 should have
      caught it. See `docs/asset-loading.md` § "Art has to emit light".
- [ ] **All text is DOM, not rendered in WebGL.**
- [ ] **Every control the design specifies works** in the desktop browser — each D-pad swipe
      direction (arrows), the index tap (Enter in a tap-only game, a click in a drag game), and
      the drag itself if this game opted in.
- [ ] **No continuous work when idle**; the loop stops cleanly.
- [ ] **Assets are filed correctly** — right subdirectory under `public/`, multi-file model
      dependencies at the relative paths their model expects, originals outside the project
      untouched, pre-edit copies in `art-originals/`, and `_incoming-assets/` gone (or its
      leftovers named, with reasons, in your summary).
- [ ] **`docs/design.md` is filled in**, including the asset inventory and the frame grid read off
      each spritesheet.
- [ ] **The game has tests of its own, not just the framework's** — the logic written in Step 6
      (movement, collisions, scoring, state transitions, spawn rules) is covered by tests outside
      `src/framework/`, and the starter's `Game.test.ts` was replaced along with `Game.ts` rather
      than left standing. `npm run test:game` is that count; a game whose only game test is the
      starter's has not been tested.

#### Now look at the game running

Several boxes above — and anything else that depends on **what the game actually renders** —
cannot be settled by reading files. This is the phase where you open the built game in a real
browser and check it: the one you deferred through all of Step 6.

(If Step 1 asked and the user declined the pass, skip straight to Step 8 — don't run it anyway.
They were told what it costs and said no.)

Otherwise work [`references/browser-verification.md`](references/browser-verification.md)
§ "Step 7". Probe for a browser first — even if Step 1 opted in and Step 5's smoke passed, since
the user may have closed the Chrome in the meantime. If it is reachable, **read** the sweep at
`${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/references/verification-pass.md` (do
not run it from memory) and work its eight checks in order. Those settle the UI-surface,
all-text-is-DOM and controls boxes above, and confirm the sprite-brightness one on the rendered
frame rather than only in the source art. Follow the sweep's fix policy: repair the clear-cut
defects and re-verify, but leave anything judgment-shaped (pacing, balance, difficulty, "is it
fun") to the developer and to `/webapp-game-director`. Close the step in the pass's report format
— the reference has the worked example and the rules for it.

If no browser can be reached, **say so explicitly in your completion summary**:

```
visual checks: NOT RUN (no reachable browser) — layout, sprite visibility, and screenshots unverified
```

Never fold an unrun check into "all gates green," and never write an audit script you don't
execute. Silent non-execution is the worst outcome available here: it costs nothing, so it looks
like efficiency, and it hides exactly the class of bug — "renders invisible on device" — that no
static check can catch.

### Step 8: Offer a hosting / on-device path, and name what comes next

The build needs HTTPS hosting to run on the glasses. Offer, but don't auto-run:

> Your game runs locally. To play it on Meta Display Glasses it needs to be served over HTTPS.
> The quickest route is **Vercel** — deploy from the project root and Vercel runs the Vite
> build and serves the output.
>
> Want me to set that up?

A scaffold is a starting point, not a good game. Once it's playable, point them at the next phase
of the family — **`/webapp-game-director`**, which surveys the build against a quality rubric,
ranks what to fix, and works those issues with a real on-glasses playtest deciding each one.

#### Deploying it, and reading logs off the device

[`references/hosting.md`](references/hosting.md) has the Vercel recipe for this **Vite build-tool
app**, including the mistakes that cause a total 404. The three that matter: **no `server.js` and no `package.json` `start`
script**, **deploy from the project root** (not `dist/`), and **leave `vercel.json` where it is**.
It also covers the cache policy (already correct — don't "fix" it with `no-store`), the `api/`
carve-out, and which parts of `meta-wearables-webapp`'s `ai-glasses-webapp-publish` still apply.

Once the game is on device there is no console, so mention this when the user hits a device-only
bug: `?log=debug&logview` draws the log on the 600x600 display with no backend at all, and the
**`/add-webapp-game-logging`** skill adds a log portal they can read on their laptop. See
`${CLAUDE_PLUGIN_ROOT}/docs/logging.md`.

For faster iteration without a device, **`/iterate-webapp-game`** drives the game in a
desktop Chrome over CDP — screenshot it, send D-pad/pinch/drag input, read state, capture console
errors. It's the same driver Step 7's verification pass uses.

## Reference material

Opened on demand, from the steps that need them — don't read them up front.

| Reference | Covers |
|---|---|
| [`references/source-art.md`](references/source-art.md) | Reading and measuring a spritesheet (Step 1), filing assets under `public/` (Step 4), ImageMagick tooling |
| [`references/scaffold-output.md`](references/scaffold-output.md) | What `init-game.mjs` does, its flags, and the annotated project tree (Step 3) |
| [`references/browser-verification.md`](references/browser-verification.md) | The opt-in browser pass: the probe (Step 1), the smoke test (Step 5), the sweep and its report format (Step 7) |
| [`references/hosting.md`](references/hosting.md) | Deploying to Vercel, and reading logs off the glasses (Step 8) |
| [`references/troubleshooting.md`](references/troubleshooting.md) | Symptom-to-fix table for a scaffolded game |
