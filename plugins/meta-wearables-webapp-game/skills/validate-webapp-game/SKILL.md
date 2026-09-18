---
name: validate-webapp-game
description: >-
  Validate a webapp game against its project guidelines. Six checks:
  (1) input — UI may be HTML/DOM, but NO input handled through the DOM (no inline
  on*= attributes, no addEventListener for input events); all input flows through
  the InputManager; (2) localization — all user-facing text goes through i18next
  (t('key'), data-i18n), no hardcoded DOM strings; (3) preload — no assets loaded
  over the network at runtime; (4) logging — game code logs through the framework
  logger, never console.*; (5) layering — gameplay stays renderer-, input- and
  audio-agnostic (only src/models.ts imports three, only src/main.ts + src/hud/ +
  src/log.ts touch the DOM, no game code touches the Web Audio API); (6) drag
  opt-in — pointerDrag, touch-action:none and use of the movement delta must
  agree, so a tap-only game never ships the drag flag.
  Use when the user wants to validate, lint, or check a Meta Display Glasses game project, or
  verify its input-handling, localization, asset-loading, logging, layering, or
  drag opt-in conventions.
argument-hint: "[project-dir]"
allowed-tools: Bash(node:*), Read, Task
---

# Validate a webapp game

Run the project's validation checks and report a PASS/FAIL summary. This skill is an
**orchestrator**: deterministic work is done by bundled scripts (fast, cheap, exact), and a
cheap subagent is used **only** where a script genuinely can't decide. It makes **no** changes
to the project.

This version runs **seven** checks from the plugin's docs — an **input-handler** check, a
**localized-string** check, a **network-load** check, a **console-logging** check, a
**display-shell** check, a **layer-boundary** check, and a **drag-opt-in** check. One wrapper
script (`validate-all.mjs`) runs them all; the rules each one enforces are below.

**1. Input rule** (`${CLAUDE_PLUGIN_ROOT}/docs/game-architecture.md`,
`${CLAUDE_PLUGIN_ROOT}/docs/threejs-vs-dom.md`): gameplay reads input only through the
`InputManager` and consumes it from the main game loop. The only sanctioned place that touches DOM
input events is the input layer (`src/framework/input/`), which attaches to `window`. Everything
else is a violation:

- inline `on*=` handler attributes in `.html` (e.g. `onclick=`, `onkeydown=`, `onchange=`);
- `addEventListener` for an input event in `.ts`/`.js` — **even on `window`/`document`** —
  outside `src/framework/input/`;
- `el.on<event> =` handler assignments (e.g. `btn.onclick = …`).

Non-input listeners are fine anywhere (e.g. `document.addEventListener('visibilitychange', …)`
to stop the loop when backgrounded).

**2. Localization rule** (`${CLAUDE_PLUGIN_ROOT}/docs/localization.md`): all user-facing text goes
through i18next — `t('key')` for dynamic text in TS/JS, `data-i18n="key"` for static text in HTML.
Hardcoded human-readable copy written straight into the DOM (a string literal with letters assigned
to `.textContent` / `.innerText` / `.innerHTML`, or passed to `insertAdjacentText` /
`insertAdjacentHTML`) is a violation. Bare numbers (`String(score)`), symbol-only glyphs, and text
already wrapped in `t(...)` are fine. The `src/i18n/` and `src/framework/` layers are exempt.

**3. Preload rule** (`${CLAUDE_PLUGIN_ROOT}/docs/loading-screen.md`): assets load once up front (the
manifest + the framework `AssetLoader`); gameplay/UI/config code must not load assets or open
network connections at runtime — a runtime request hitches on the glasses. Outside `src/framework/`,
instantiating a Three.js/asset loader (`new TextureLoader`/`GLTFLoader`/…) or setting a media `src`
to a network URL is a violation. `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource`, and a
media `src` from a non-literal expression, are *ambiguous* (they may be an intended API call or a
preloaded `blob:`/`data:` URL). In-memory `blob:` / `data:` URLs are always fine.

Audio is no exception, and gets it for free: a **bank** decodes and frees clips whose *compressed
bytes* the preload manifest already fetched, so `loadBank` costs a decode and never a request.
Streamed music plays from a `blob:` URL over those same preloaded bytes. If you see a `fetch` in an
audio code path, that is a real regression, not a carve-out.

**4. Logging rule** (`${CLAUDE_PLUGIN_ROOT}/docs/logging.md`): game code logs through the framework
logger (`import { log } from '@/log'`), never `console.*`. A raw console call is invisible on the
glasses — the device has no console and no way to attach one — and it bypasses the level filter,
the `?logview` overlay, the remote sink, secret redaction, and the rate limit. Any
`console.<method>(` outside `src/framework/` (which implements the logger and its console sink) is
a violation. There are no ambiguous cases for this check.

**5. Display-shell rule** (`${CLAUDE_PLUGIN_ROOT}/docs/display-guidelines.md`): the page shell must
match the device's fixed display. The viewport is `width=600, height=600`;
`<meta name="mrbd-web-app-capable" content="yes">` is present (without it the device never routes
D-pad / EMG input to the page); the page background is pure black (on an additive waveguide a
non-black background glows over the real world); HUD text is `>= 16px`; the
`<meta name="description">` is game-specific rather than the scaffold's placeholder copy; the
`<meta name="generator">` attribution marker is present and names the scaffolding skill, a version
and the learn-more URL; and no scaffold placeholder tokens survive. A `font-size` in `rem`/`em`/`%`
can't be resolved statically and is reported as *ambiguous*.

A missing `generator` marker usually means the game was scaffolded before the marker existed, not
that someone deleted it — running `update-webapp-game-framework` inserts it. The marker's
version is only checked for shape, never against the current plugin version: a game legitimately
lags behind until it re-syncs.

**6. Layer rule** (`${CLAUDE_PLUGIN_ROOT}/docs/core-contract.md` section 5): gameplay is renderer-,
input-, and audio-agnostic — it talks to the `Renderer` / `InputManager` / `AudioPlayer` contracts,
and the concrete implementations are injected in `main.ts`. That is what makes a whole game
unit-testable in plain Node with fakes. Only a few game files are adapters and may cross a
boundary: `src/models.ts` for `three`; `src/main.ts`, `src/hud/`, and `src/log.ts` for the DOM;
**nothing in game code** for the Web Audio API (only `src/framework/audio/AudioEngine.ts`); and
`src/main.ts` alone for the concrete audio backend. That last one is the audio counterpart of the
`three` rule: importing `AmpAudioPlayer` / `AudioEngine` / `BankStore` from gameplay hard-wires it
to the backend even though no forbidden global appears on the line, so `FakeAudioPlayer` can no
longer stand in. Gameplay takes an injected `AudioPlayer<SoundId>`; importing the
`AudioPlayer` contract, the `audioSettings` schema, or the `soundDefinitions` builders is fine.
`src/framework/` is exempt — it *implements* those adapters. A dynamic `import()` with a
non-literal specifier is *ambiguous*. Comments are stripped before matching, so a prose mention of
`AudioContext` or `window` is not a violation.

**7. Drag opt-in rule** (`${CLAUDE_PLUGIN_ROOT}/docs/drag-channel.md`): the EMG index
pinch-and-move channel is opt-in, and opting in is **three coordinated
edits** — `touch-action: none` in the CSS, `{ pointerDrag: true }` on the `PointerKeyboardInput`,
and game code that consumes the movement delta. Any two without the third is a violation. The one
that matters most: `pointerDrag: true` on a game that never drags, which happens when the flag is
switched on so a desktop mouse **click** produces a `pinchTap` while iterating in a browser. It is
not a dev convenience — it opts the *device* into the pointer stream and moves the tap source off
`Enter`. `Enter` is the index pinch in a browser too; press that. A `pointerDrag` whose value is
not a boolean literal is *ambiguous*. The project's `CLAUDE.md` must not contradict the mode
either: on a game with `pointerDrag: true`, an assertion there that the game is **tap-only**
(`this game is tap-only`, `press \`Enter\`, don't click`) is a violation. That file is the first
thing an agent reads, and in drag mode the pinch is a mouse click while `Enter` is deliberately
ignored — so the claim points every future agent at an input the framework drops. Only the
assertion form is matched; prose that describes both modes is fine — and the bare imperative is
disowned when a clause names the mode it belongs to ("In tap-only mode, press `Enter`, don't
click"), so only an imperative asserted of the game itself counts.

## Workflow

### Step 1: Resolve the project directory

Use the argument if given, else the current directory. Confirm it looks like a scaffolded game
(it has a `src/` directory). If not, tell the user and stop.

### Step 2: Run all seven checks (one script, run it directly)

Every check is fully scriptable, so run them directly — do **not** spawn a subagent to do the
scanning. One wrapper runs all seven; run the plugin-bundled copy so the rules are always current
without a project re-sync:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/validate-webapp-game/scripts/validate-all.mjs" <project-dir> --json
```

It never stops at the first failure, so a single run reports everything that is wrong. It prints
a one-line-per-check human summary to stderr, and with `--json` the combined machine-readable
report to stdout. Exit `1` if any check has definite violations (add `--ci` to fail on ambiguous
cases too).

The JSON is `{ pass, projectDir, checks: [...] }`, one entry per check:

- `id` — `input-handlers` / `localized-strings` / `network-loads` / `console-logging` /
  `display-shell` / `layer-boundaries` / `drag-optin`.
- `pass`, `filesScanned`.
- `violations[]` — `{ file, line, snippet, reason }` for definite problems.
- `ambiguous[]` — same shape, for what the line-based scan couldn't classify. These are the
  only part that needs judgment; Step 3 adjudicates them.

Each check also has its own `validate-<id>.mjs` script taking the same arguments, if you need to
re-run one after a fix. Don't loop over them by hand for a full pass — that is what the wrapper
is for, and seven JSON reports per run is pure context cost.

### Step 3: Adjudicate ambiguous cases with a cheap subagent

Definite violations need no adjudication — report them. For **each** entry in any check's
`ambiguous[]`, spawn a subagent to decide it; this is the part a script can't do. Launch them in
parallel (one message, multiple `Task` calls) and use a cheap model:

- `subagent_type`: `general-purpose`
- `model`: `haiku`
- Pass the **literal absolute file path** (subagents do not inherit `${CLAUDE_PLUGIN_ROOT}` or
  the parsed JSON — give them a real path they can `Read`).

Fan out only where the volume justifies it. `input-handlers`, `localized-strings`, and
`network-loads` can produce many ambiguous entries, so give each its own subagent. The other four
produce at most a handful of one-line judgments (a relative `font-size`, a computed dynamic
`import()`, a non-literal `pointerDrag`) — read those yourself.

Treat a `VIOLATION` verdict as a violation; `OK` clears it. Use the prompt for the check that
reported the entry:

**`input-handlers`** — ambiguous when `addEventListener` has a non-literal event name:

> Read `<abs-file-path>` around line `<line>`. Snippet: `<snippet>`.
> A Meta Display Glasses game must not handle user INPUT through the DOM — all input must go through the
> `InputManager` / the main game loop. The only exception is the input layer under
> `src/framework/input/`. Non-input listeners (visibilitychange, resize, load, etc.) are fine.
> Does this line attach a handler for a user-INPUT event (click, key*, pointer*, touch*, mouse*,
> wheel, input, change, submit, focus, blur, drag*, drop, contextmenu) outside the input layer?
> Answer strictly as `VIOLATION` or `OK`, then one short sentence of reasoning.

**`localized-strings`** — ambiguous when HTML text carries no `data-i18n` attribute:

> Read `<abs-file-path>` around line `<line>`. Snippet: `<snippet>`.
> A Meta Display Glasses game must route all user-facing text through i18next: dynamic text via `t('key')`,
> static HTML text via a `data-i18n="key"` attribute. Does this element contain user-facing copy
> (words a player reads) that lacks a `data-i18n` attribute? Ignore bare numbers, single
> symbols/glyphs, and non-visible metadata. Answer strictly `VIOLATION` or `OK`, then one short
> sentence.

**`network-loads`** — ambiguous for `fetch` / `XMLHttpRequest` / `WebSocket` / `EventSource`, or
a media `src` / `new Audio(...)` from a non-literal expression (which may be a preloaded
`blob:` / `data:` URL):

> Read `<abs-file-path>` around line `<line>`. Snippet: `<snippet>`.
> A Meta Display Glasses game preloads all assets up front and must not load assets over the network at
> runtime (during gameplay). In-memory `blob:`/`data:` URLs (a preloaded asset) are fine, and an
> intended non-asset API/live-data call is allowed. Does this line load an ASSET (image, audio,
> model, texture, data file) over the network after startup? Answer strictly `VIOLATION` or `OK`,
> then one short sentence.

**`console-logging`** never produces ambiguous entries — a console call is decidable on sight.

**`display-shell`** reports only relative font sizes (`rem` / `em` / `%`), which a script can't
resolve: read the stylesheet and decide whether each renders at `>= 16px`.

**`layer-boundaries`** reports dynamic `import()` calls with a computed specifier: read each and
decide whether it pulls in a renderer, DOM, or audio dependency. Violations also carry a
`concern` field (`three` / `dom` / `webAudio`) so the fix is unambiguous.

**`drag-optin`** reports a `pointerDrag` whose value isn't a boolean literal: read the one line
and decide. Its report also carries the three facts it derived (`dragEnabled`, `touchActionNone`,
`dragConsumed`) and a `notes[]` for cases that are deliberately not failures (a project that
builds its own `InputManager` can't be checked). A `CLAUDE.md` tap-only claim needs no
adjudication — the mode is already decided from the code, so the contradiction is definite.

### Step 4: Summarize

Report a single **PASS/FAIL** across **all seven** checks:

- **PASS** — zero definite violations and zero ambiguous cases adjudicated as `VIOLATION`.
- **FAIL** — otherwise. List every violation as `file:line — reason` with its snippet, and for
  each, point to the fix:
  - *Input violation* → route the input through the `InputManager` (add/extend it in
    `src/framework/input/`) and consume it from the game loop / `Game.update`, or make the DOM
    element display-only (read state and write DOM, like `src/hud/Hud.ts`).
  - *Localization violation* → move the string into `src/i18n/en.json` and reference it with
    `t('key')` (dynamic text) or a `data-i18n="key"` attribute (static HTML), per
    `${CLAUDE_PLUGIN_ROOT}/docs/localization.md`.
  - *Network-load violation* → move the asset into the preload manifest and load it up front with
    `preloadManifest` (behind the `LoadingScreen`); at runtime use the preloaded object (or a
    `blob:`/`data:` URL from a preloaded `raw` asset), never a network URL. See
    `${CLAUDE_PLUGIN_ROOT}/docs/loading-screen.md`.
  - *Console-logging violation* → replace the call with the shared logger: `import { log } from
    '@/log'`, then `log.info(...)` / `log.warn(...)` / `log.error(...)` at the appropriate level
    (and `log.child('scope')` to tag a subsystem). See `${CLAUDE_PLUGIN_ROOT}/docs/logging.md`.
  - *Display-shell violation* → fix the page shell in `src/index.html` / `src/style.css`: restore
    the `width=600, height=600` viewport and the `mrbd-web-app-capable` meta, set the page
    background to pure black (bounded surfaces — cards, panels, modals — dark gray rather than
    black; the always-on HUD unfilled, as text over the page), raise any HUD text to
    `>= 16px`, write a game-specific `<meta name="description">`, and replace any surviving
    scaffold placeholder token. For the surface colors specifically, read
    `${CLAUDE_PLUGIN_ROOT}/docs/core-contract.md` section 1, which carries the HUD carve-out;
    `${CLAUDE_PLUGIN_ROOT}/docs/display-guidelines.md` covers the rest of the shell but still
    states the dark-gray rule unqualified.
  - *Layer violation* → move the crossing into its adapter: model geometry into `src/models.ts`
    (gameplay refers to models by `ModelId` and calls `renderer.addModel(id)`), DOM reads/writes
    into `src/hud/` (which reads game state and writes the DOM, never the reverse) or the
    `main.ts` composition root, and every sound through the injected `AudioPlayer`
    (`audio.play(id)`) rather than a raw `AudioContext` or a directly-imported `AmpAudioPlayer`.
    A sound's *tuning* is not code at all: it belongs in `src/audio/audioSettings.json`, with its
    id in `src/audio/soundIds.ts`. See `${CLAUDE_PLUGIN_ROOT}/docs/core-contract.md` section 5.
  - *Drag-opt-in violation* → make the three edits agree. If no drag drives gameplay (the common
    case), drop `pointerDrag: true` **and** `touch-action: none`: the index select still arrives
    as `Enter` → `pinchTap`, on the device and in a desktop browser. If a drag does drive
    gameplay, add whichever of the three is missing, per
    `${CLAUDE_PLUGIN_ROOT}/docs/drag-channel.md`. If the violation is in `CLAUDE.md`, the code is
    the source of truth: replace the tap-only assertion with the scaffold's derivation — tell the
    reader to run `node scripts/validate-drag-optin.mjs`, which prints the mode — and describe
    both modes rather than naming one.

## Adding future validation steps

Add each new check the same way, cheapest tool first:

1. **Prefer a script.** If the check is decidable mechanically, add a `validate-<id>.mjs` under
   `scripts/` emitting the same `{ pass, filesScanned, violations[], ambiguous[] }` JSON, and add
   it to the `CHECKS` list in `scripts/validate-all.mjs` so it joins the single run. No subagent.
2. **Fan out only for judgment.** If a step needs an LLM, enumerate its items with a script
   (see `scripts/list-target-files.mjs`, which prints one path per line) and spawn one Haiku
   subagent per item (like Step 3) — never one big subagent that re-reads the whole project.

Both copies of every script must stay byte-identical, and each needs a unit test.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| A comment or string is flagged | Known regex-scan limitation — confirm and delete the false positive, or move the code so the literal isn't mistaken for a handler. |
| Input layer listener flagged | It must live under `src/framework/input/`; files there are allowlisted. Move stray input wiring into the input implementation. |
| Legitimate lifecycle listener flagged | Only input events are banned; `visibilitychange`/`resize`/`load`/etc. are ignored. If you see one flagged, check it isn't actually an input event. |
| Everything is "ambiguous" | The event name is computed. Prefer a string literal so the check is exact; otherwise the subagent adjudicates. |
| A `console.` call in the framework is flagged | It shouldn't be — `src/framework/` is allowlisted. If it is flagged, the file is outside that directory; move it there or use the shared logger. |
| A `console.` mention in a comment is flagged | Known regex-scan limitation, same as the other checks — reword the comment or confirm and dismiss. (The layer-boundary check is the exception: it strips comments first, because the words it looks for are ordinary prose.) |
| Gameplay legitimately needs the DOM | It doesn't. Read the state in `src/hud/` and write the DOM there; gameplay stays a pure state machine so it can be unit-tested with fakes. If the need is input, that belongs in the `InputManager`. |
| A tap-only game passes the drag check with `pointerDrag: true` | It left a dead `consumeMovementDelta()` call in `update()`, which reads as a real consumer — whether a call *does* anything with its result is undecidable statically. Delete the dead call and re-run. |
| Drag check says "builds its own `InputManager`" | It found no `new PointerKeyboardInput(...)`, so it can't tell the mode. Verify the three edits by hand: `touch-action: none`, the drag flag, and code that uses the delta. |
| Running standalone in CI | Use the game's own `npm run validate` (shipped in the scaffold), or add `--ci` to fail on ambiguous cases too. |
