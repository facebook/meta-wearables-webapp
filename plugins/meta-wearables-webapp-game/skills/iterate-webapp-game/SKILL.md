---
name: iterate-webapp-game
description: >-
  Autonomously iterate on a webapp game in a real browser via the Chrome DevTools
  Protocol (CDP): load the running game, take screenshots, click/type/press keys, run
  console commands, read game state, and capture console errors — then change code and
  repeat. Also runs a structured verification pass over a finished build (renders at all, visible
  on the additive display, every input responds, HUD inside the 600x600 stage) using a
  screenshot-statistics tool, so frames can be checked numerically instead of eyeballed. Drives a
  Chrome it launches itself, or attaches to one the user started with `npm run chrome` when the
  agent is sandboxed and cannot launch a browser. Use when the user wants to screenshot the game,
  see what it looks like, debug it in the browser, click through it, drag in it, reproduce a bug,
  check the console, inspect runtime state, verify a change visually, or check whether a finished
  game actually works — all without a headset.
argument-hint: "[project-dir]"
allowed-tools: Bash(node:*), Bash(npm run:*), Bash(npm install:*), Bash(curl -fs http://127.0.0.1:*), Bash(curl -fs http://localhost:*), Bash(lsof:*), Bash(cd:*), Read
---

# Iterate on a webapp game over CDP

Drive a running game in a real desktop Chrome to see it, debug it, and verify changes — a
load → screenshot → inspect → edit → reload loop the agent can run on its own.

**This is the agent's tool, not the developer's preview.** For looking at a game yourself, the
**Meta Ray-Ban Display Web App Simulator** Chrome extension is the better instrument: it recreates
the 600x600 surface with additive blending over real or webcam backgrounds, gives you on-screen
D-pad buttons, brightness and blur controls, a viewport recorder, and a QA checklist. What it does
not give is a programmatic handle — nothing here can click its buttons, read a number off a frame,
step the game loop, or scrape the console. Use the simulator to judge how a game *looks*; use this
skill when an agent has to drive the game and measure what came back.

## How it works (launch, or attach)

All browser interaction goes through one bundled, zero-dependency driver (`cdp.mjs`, Node 22+, no
`npm install`), and screenshots are measured by a second script beside it (`frame-stats.mjs`).
Define both as shell functions once; every command in this skill and its references is a call to
one of them:

```bash
P="${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/scripts"
cdp()   { node "$P/cdp.mjs"         "$@"; }
stats() { node "$P/frame-stats.mjs" "$@"; }
```

**Functions, not variables.** zsh does not word-split an unquoted parameter, so a
`CDP="node .../cdp.mjs"` string expands to one argument and `$CDP status` tries to exec the whole
`node /path/cdp.mjs` string as a single filename — it works under bash and fails under zsh. A
function behaves identically in both. Where the shell does not persist between commands, re-emit
these three lines in the same invocation as the call.

`cdp` prints JSON to stdout and a human summary to stderr. `cdp --help` prints its whole surface
and `cdp --version` prints the driver version plus its subcommand list — run that before working
around a command you think is missing, since older copies of this script exist on disk. It is a
pure CDP **client**: it attaches to a Chrome already listening on a
debugging port and never launches one itself. Starting that Chrome is a separate step, and it
has two paths:

- **Unsandboxed** — you start it yourself, by running `npm run chrome` as a background task.
- **Sandboxed** — some agent sandboxes cannot launch Chromium at all. Claude Code's macOS
  sandbox is one: Chromium dies at startup on a Mach bootstrap restriction, and
  Playwright/Puppeteer/`chrome --headless` all fail the same way. Such sandboxes can still open
  localhost connections, so the model becomes **connect, don't launch** — the user starts Chrome
  in a normal terminal and you attach to it.

Step 3 covers both: try to launch, fall back to asking. Either way the Vite dev server and
Chrome are both host processes and reach each other over the loopback interface.

The launcher runs Chrome **headed** on purpose — you can watch the game as the agent drives it,
and WebGL gets the real GPU instead of a software renderer.

## Workflow

### Step 1: Resolve the project and wire in the CDP launcher

Use the argument if given, else the current directory; confirm it's a game project (has
`package.json` and `src/`). Then wire in the `npm run chrome` launcher — always run this the
first time you iterate on a project (it's idempotent, so re-running it is safe):

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/scripts/setup-cdp.mjs" <project-dir>
```

This copies `scripts/start-chrome-cdp.sh` into the project and adds a `"chrome"` npm script.
Games aren't scaffolded with the launcher — it's only needed once someone iterates over CDP,
so this skill provisions it on first use.

### Step 2: Make sure the Vite dev server is running

The game is served by Vite on `http://127.0.0.1:5173`. First check whether it's already up:

```bash
if   curl -fs http://127.0.0.1:5173 >/dev/null 2>&1; then echo "dev server up on 127.0.0.1"
elif curl -fs http://localhost:5173 >/dev/null 2>&1; then echo "dev server up on localhost ONLY"
else echo "dev server down"; fi
```

`-f` matters: bare `curl -s` exits 0 on any HTTP response, so a 404 or 500 from something entirely
unrelated on 5173 reads as a live dev server. A Vite serving the game answers 200.

Both hosts, and the three outcomes kept apart, because a Vite started without `--host 127.0.0.1` —
a bare `npm run dev`, typically a human's — binds `[::1]` only and refuses the IPv4 probe. Chaining
the two probes with `|| … && echo up` would collapse that case into the healthy one (`||` and `&&`
are left-associative, so it prints "up" whichever probe answered) and you would only find out when
every command below failed against a server the check called healthy.

**`dev server up on 127.0.0.1`** means *a* server answered, not that it is this project's. Another
project's Vite holding 5173 answers exactly the same way, and the steps below would then drive it.
Confirm before relying on it — `lsof -ti tcp:5173` for the owner, or the page title `cdp open`
reports once you get there — and if it belongs to another project, take the `--strictPort` bullet's
other-project path.

**`up on localhost ONLY`** means the server is running but unreachable at the
`http://127.0.0.1:5173` every command below uses. If it is a Vite for *this* project, stop it and
restart it with the line below rather than rewriting the URLs; if it belongs to another project,
take the `--strictPort` bullet's other-project path. `lsof -ti tcp:5173` says who holds it.

If it's down, start it from the project directory with:

```bash
cd <project-dir> && npm run dev -- --host 127.0.0.1 --strictPort < /dev/null
```

Run that as a **background Bash task** (the Bash tool's `run_in_background` option) — never
foreground (`npm run dev` is a blocking watch process), and **not** with `nohup`/`&`, which would
detach a process that outlives this session. A background task ties the dev server's lifetime to
the session; stop it (kill that background task) when you're done iterating.

Each addition to that line is load-bearing:

- **`< /dev/null`** — Vite attaches a `readline` interface to `process.stdin` whenever stdin is a
  TTY, to serve its `h + enter` shortcuts (`bindCLIShortcuts`, gated on `process.stdin.isTTY`). A
  background process group that reads the controlling terminal is sent `SIGTTIN`, whose default
  disposition stops the process — so a backgrounded server dies seconds after printing "ready".
  With stdin redirected it is not a TTY and the reader is never attached.
- **`--host 127.0.0.1`** — Vite's default host is `localhost`, which on macOS binds `[::1]` only,
  so the `http://127.0.0.1:5173` that every command below uses is refused.
- **`--strictPort`** — otherwise a taken 5173 sends Vite quietly to the next free port, and every
  hardcoded `:5173` after that drives some other server, or nothing. The trade is that a held 5173
  is now a startup error instead of a silent move. Find out who holds it — `lsof -ti tcp:5173` —
  and if it is a Vite for *this* project that bound `[::1]`, stop that one and start this line
  instead. If it belongs to another project, leave it alone and run this one on its own port
  (`--port 5174`), remembering that every `:5173` below then has to change with it.

Then wait for it to bind before running anything against it — the background task returns
immediately, but Vite needs a moment, and a command that arrives first gets a connection refusal
that looks like a broken game rather than a slow start:

```bash
for _ in $(seq 20); do curl -fs http://127.0.0.1:5173 >/dev/null && break; sleep 0.5; done
curl -fs http://127.0.0.1:5173 >/dev/null || echo "dev server never came up — read the background task's output"
```

The trailing probe is the point: the loop alone just ends after ~10s, so without it a server that
never started is indistinguishable from one that did, and you find out from a blank screenshot two
steps later.

If Vite isn't installed (`node_modules` missing), run `npm install` first. If your sandbox
blocks network access (Claude Code's does), **ask the user to run it** instead.

### Step 3: Get a Chrome with remote debugging listening

First check whether one is already there:

```bash
cdp status
```

**Reachable** (`"reachable": true`, exit 0) → skip to Step 4.

**Not reachable** (exit 3) → try to start it yourself, as a **background Bash task** (same rule
as the dev server in Step 2 — never foreground, never `nohup`/`&`):

```bash
cd <project-dir> && npm run chrome
```

Wait a couple of seconds, then re-run `status`.

- **Now reachable** → continue to Step 4. Kill that background task when you're done iterating.
- **The launch failed or Chrome died immediately** → you're in a sandbox that can't launch
  Chromium (a Mach bootstrap crash / SIGSEGV at startup is the signature). Don't retry, and
  don't reach for Playwright or `chrome --headless` — they fail identically. Ask the user to run
  this in a **separate terminal outside the agent** and leave it running:

  ```
  npm run chrome
  ```

  Then re-run `status`. (Telling the user to type `! npm run chrome` works only if that escapes
  the sandbox in their setup; otherwise a real terminal is required.)
- **The launcher prints `No Chrome/Chromium/Edge found`** → no browser is installed (`status`
  can't tell you this — it only probes the port). Ask the user to install Google Chrome.

> **Neither `status` nor the launcher needs a project.** `status` is a bare HTTP probe of the CDP
> port, and the launcher can be run straight from the plugin:
>
> ```bash
> bash "${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/scripts/start-chrome-cdp.sh"
> ```
>
> That's what `create-webapp-game` uses to check, while still in plan mode, whether a
> browser will be available later — before the game directory exists, so before there is any
> `npm run chrome` to call.

### Step 4: Load the game

```bash
cdp open --url http://127.0.0.1:5173
```

`open` picks (or creates) one page tab, navigates it, installs console/error capture, and
remembers that tab so later commands act on the same page.

### Step 5: See it — screenshot

```bash
cdp shot --out /tmp/game.png
```

Then **view it with the Read tool** (`Read /tmp/game.png`) — the image renders inline. Add
`--full` to capture beyond the viewport.

**Clip it to the stage.** The browser viewport is much larger than the game, and the 600x600 stage
sits centred inside it, so a bare `shot` is mostly desktop background — and every pixel of it costs
image tokens. `--selector` captures one element instead:

```bash
cdp shot --selector "#game-root" --out /tmp/game.png
```

The image is then the stage itself, so `stats --region` coordinates are stage-local
(`0,0,600,80` is the top strip) rather than needing the stage's viewport offset added to them.
`--selector` and `--full` are mutually exclusive.

**Or measure it instead of looking at it.** A screenshot is an image, and images stay in context
for the rest of the run — they're the expensive tokens in this loop. When the question has a
numeric answer, ask `stats` (zero-dependency, same JSON-on-stdout convention):

```bash
stats --png /tmp/game.png [--baseline /tmp/earlier.png] [--region x,y,w,h]
```

It reports `meanLuminance` / `fractionNearBlack` (is anything emitting light? the additive-display
question), `nonBlackBBox` (where the lit content is, and how big — catches wrong-scale sprites),
and with `--baseline`, `changedPixelFraction` / `changedBBox` (did that input change anything, and
where). Read the PNG when you need to *judge* it; run this when you need to *check* it.

### Step 6: Drive & debug it interactively

Run any of these against the same page (flags may go before or after the subcommand — except a
valueless one, `--full` / `--clear` / `--drive`, which swallows the next token as its value, so
keep those after it):

| Goal | Command |
|------|---------|
| Read game/runtime state | `cdp eval --expr "window.__game?.state ?? 'no debug handle'"` |
| Run any JS **expression** (statements need an IIFE) | `cdp eval --expr "document.querySelectorAll('canvas').length"` |
| **Advance a `?drive` page** by N frames | `cdp step --frames 30` |
| **Index pinch SELECT** (`pinchTap`) — **tap-only game** (the default) | `cdp keys --keys "Enter"` |
| **Index pinch SELECT** — **drag game** (`pointerDrag: true`) | `cdp click --selector "#game-canvas"` |
| **D-pad swipes** (`dpadSwipe`) — either mode | `cdp keys --keys "ArrowRight ArrowRight ArrowUp"` |
| **Index pinch-and-DRAG** — **drag game only** | `cdp drag --selector "#game-canvas" --dx 120 --dy -40` (add `--drive` on a `?drive` page) |
| Click / type on a **non-game page** (e.g. the `/logs` portal's passcode form) | `cdp click --selector "#unlock"` / `cdp type --selector "input#key" --text "1234"` |
| **Screenshot just the 600x600 stage** | `cdp shot --selector "#game-root" --out /tmp/game.png` |
| Read captured console logs + uncaught errors | `cdp logs` (add `--clear` to reset the buffer) |
| Reload after an HMR-missed change | `cdp reload` |
| **Foreground the tab**, and count the frames it then delivers | `cdp foreground` |
| **Measure a screenshot** instead of looking at it | `stats --png /tmp/game.png [--baseline <earlier.png>]` |

#### Drive it deterministically (`?drive`)

A game keeps advancing between the commands you send, so a screenshot captures whatever state
the frame clock reached and a before/after diff of a self-animating game proves nothing about the
input in between. Load it with `?drive` and the loop never starts — you advance it yourself:

```bash
cdp open --url "http://127.0.0.1:5173/?drive"
cdp keys --keys "Enter"                    # discrete input works while paused
cdp step --frames 30                       # advance exactly 30 frames
cdp eval --expr "[window.__webappGame.status(), window.__game.state]"
```

`step` reports how many frames the harness advanced and exits 1 if that is fewer than `--frames`.
Read the count before you pick a fix, because the two shortfalls have different causes: **zero**
means the loop is running and stepped nothing — a manual step and an rAF tick cannot be
interleaved, so `pause()` first (or reload with `?drive`). A **partial** advance means the loop
did accept steps and then stopped part-way, which `pause()` will not fix; the command says which
of the two it saw. `status()` reports `{driven, running, frames, simSeconds, stepSeconds}`, and
`resume()` hands control back to `requestAnimationFrame`.

This fixes *timing*, not randomness — a game calling `Math.random()` still diverges run to run.

**A drag needs `--drive`, discrete input does not.** `pinchTap` and `dpadSwipe` reach their
subscribers synchronously, so they land on a paused game and the next `step()` applies them. A
drag does not: the framework discards any movement still unconsumed when the pinch ends, so with
no frame running between the moves, `pointerup` throws the whole gesture away and the game sees a
delta of exactly zero. `cdp drag --drive` interleaves a `step(1)` after each move (and one
after the release), which drains it the way a real frame would:

```bash
cdp drag --selector "#game-canvas" --dx 120 --dy -40 --drive
```

It exits 1 before dispatching anything if the page has no usable harness, rather than performing
a gesture the game would silently discard — and it says which of the two it is: no
`window.__webappGame` at all (reload with `?drive`), or a `window.__webappGame` whose `step()` is
missing because the game predates `debug/DriveHarness.ts` (re-sync with
`/update-webapp-game-framework`).

Notes:
- **Reading game state** works best if the game exposes a debug handle (e.g. `main.ts` sets
  `window.__game = game` in dev). If none exists and you need state, suggest adding one, or
  read observable DOM/HUD via `eval`.
- **How you fire the index pinch depends on the game's drag mode — check it first.** The D-pad
  is always the arrow keys, but the pinch is not:
  - **Tap-only** (the scaffold's default): the pinch is the `Enter` keydown. No pointer
    listeners are wired at all, so a click does nothing.
  - **Drag opted in** (`{ pointerDrag: true }` + `touch-action: none`): the pointer stream is
    the tap source — a zero-travel press-and-release is `pinchTap` — and the redundant `Enter`
    is **deliberately ignored** so the device's two channels don't double-fire. So here a
    `click` is the pinch and `keys "Enter"` does nothing.

  Tell the modes apart by grepping `src/main.ts` for `pointerDrag`, or by running
  `validate-drag-optin.mjs` from the `validate-webapp-game` skill — it prints
  `mode: tap-only` or `mode: drag (opted in)`.
- **A click is a raw pointer event, never a DOM handler.** A Meta Display Glasses game handles **no** input
  through the DOM — the HUD is display-only and `validate-webapp-game` enforces it —
  so you never click a HUD element to trigger gameplay. In a drag game, `--selector` is only a
  way to pick coordinates inside the 600x600 stage (`#game-canvas` is the obvious target); the
  `InputManager`'s `window`-level pointer listener is what receives it. `click`/`type` against
  actual DOM controls are for non-game pages only.
- **`click` is a tap; `drag` is a drag.** `click` presses and releases at one point, so it always
  reads as zero-travel. To exercise an actual drag use `drag`, which holds the primary button down
  across interpolated moves (`--steps`, default 12) so the game accumulates a real movement delta.
  Give it more than a few pixels of travel: the framework classifies a pinch under ~6px as a
  `pinchTap`, and `drag` warns when your `--dx`/`--dy` fall in that range. `drag` only does anything
  in a game that opted into `pointerDrag` — in a tap-only game no pointer listeners exist at all.
- **Don't check the movement delta *after* the drag — it will always be zero.**
  `consumeMovementDelta()` is designed to be drained once per frame by the game's `update()`, and
  the release discards whatever is left (`endPinch` → `resetPinch`), so a post-hoc
  `eval "input.consumeMovementDelta()"` reads `{x:0,y:0}` on a drag that worked perfectly. To
  observe it, sample per frame the way a game does, then drag, then read the accumulator:

  ```
  cdp eval --expr "(()=>{window.__acc={x:0,y:0};const t=()=>{const d=window.__input.consumeMovementDelta();window.__acc.x+=d.x;window.__acc.y+=d.y;requestAnimationFrame(t)};t();return 'sampling'})()"
  cdp drag --selector "#game-canvas" --dx 120 --dy -40
  cdp eval --expr "window.__acc"
  ```

  Or just watch what the drag *does* on screen, which is usually the real question.
- `logs` reflects everything since `open`/`reload`; call it after reproducing a bug.

### Step 7: Iterate

Edit the game code. Vite HMR usually updates the page automatically — re-run `shot` / `logs`
to observe. If a change didn't hot-reload (new modules, config), run `cdp reload` first.
Repeat Steps 5–6 until the change looks and behaves right, then run the project's own checks
(`npm run typecheck && npm run test && npm run validate`; `npm run build` before done).

## Verifying a whole game, not just one change

Steps 5–7 above are the loop for chasing **one** thing — a bug, a change you just made. When the
job instead is *"is this finished game actually working?"*, **read** the sweep now — do not run it
from memory:

```
${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/references/verification-pass.md
```

Then work its structured checks: boot errors, a non-blank frame, additive-display visibility, the
title transition, every input, HUD bounds, the outcomes the design promises, and perf. It says what
counts as a pass, which failures to fix yourself and which to leave to the developer, and how to
report what didn't run.

Use it after a build is otherwise complete — `create-webapp-game` calls it at the end of
a scaffold-and-build run, and it's the right sweep before handing any build to a human.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `status` exits 3 / "not reachable" | No Chrome with remote debugging is listening. Start one yourself with `npm run chrome` as a background task; if the launch crashes, you're sandboxed — ask the user to run it in a terminal **outside** the agent (Step 3). |
| Chrome crashes the instant you launch it | A sandbox that blocks Chromium (Mach bootstrap → SIGSEGV). Not fixable from inside; Playwright and `chrome --headless` fail the same way. Fall back to a user-launched Chrome. |
| `open`/commands hang or "WebSocket timeout" | The Chrome being driven was closed or crashed. Relaunch it (or ask the user to), then `open` again. |
| Screenshot is blank / black | The game may not have rendered yet — wait and re-`shot`, or check `logs` for a load error. A black page background is expected; game content should draw on the canvas. |
| "Target … has no webSocketDebuggerUrl" | DevTools is open on that tab and holds the debugger. Close DevTools for it (or open a fresh tab) and retry. |
| `eval` returns `undefined` for `window.__webappGame` | Either the URL has no `?drive`, or the game predates `framework/debug/DriveHarness.ts` — re-sync with `/update-webapp-game-framework` and wire `main.ts` per that skill's Step 7.5. |
| The game doesn't advance under `?drive` | That is the flag working. Run `cdp step --frames <n>` to advance it, or `eval --expr "window.__webappGame.resume()"` to hand control back to `requestAnimationFrame`. |
| A free-running game doesn't advance, and `?stats` reads all zeros | Run `cdp foreground` and read `frames`, the rAF callbacks it counts in ~1s. `frames: 0` means the loop never ticks, so the overlay's zeros are not measurements — usually a Chrome window covered by another window. The `visibilityState` / `hasFocus` / `occluded` fields it also reports do **not** settle this: a covered window has been measured reporting `visible`, `hasFocus: true`, `occluded: false` and 0 frames (macOS, 2026-08-28). `Page.bringToFront` alone does not clear it. Uncover the window (or relaunch it — `npm run chrome` passes the anti-occlusion flags), or measure under `?drive` instead: check 8 of [`references/verification-pass.md`](references/verification-pass.md) has the recipe. |
| `eval` returns `null` for `window.__game` | The game predates the scaffolded debug handle (or is a production build, where it is stripped). Add `if (import.meta.env.DEV) window.__game = game;` in `main.ts`, or inspect the DOM/HUD instead. |
| `click` does nothing in the game | Check the mode. In a **tap-only** game this is expected and correct — no pointer listeners exist, and the glasses have no cursor; press `Enter` instead. **Do NOT "fix" it by adding `pointerDrag: true`** — that flag opts the *device* into the EMG pinch-and-move pointer stream and moves the tap source off `Enter`; it belongs on only if a drag drives gameplay, and `npm run validate` fails a game that sets it otherwise. In a **drag** game a click should fire `pinchTap`: confirm you targeted an element inside the stage (`#game-canvas`) and that `touch-action: none` is present. |
| `keys "Enter"` does nothing | Expected in a **drag** game — the pointer stream is the tap source there, so `Enter` is ignored to stop the device's two channels double-firing. Use `click --selector "#game-canvas"`. In a tap-only game, see the row below. |
| `keys` seem to do nothing | Confirm the game has focus (run `open` first so the driver targets the game tab) and that the input is wired through the `InputManager` (see `validate-webapp-game`). |
| `open` reports `title: "<host>"` (e.g. `"127.0.0.1"`) rather than the game title | Nothing is serving that URL, and Chrome titles its connection-error page after the host. Re-check Step 2: the server has to be alive (a backgrounded Vite without `< /dev/null` is killed by `SIGTTIN` shortly after it prints "ready"), bound where you are asking (`--host 127.0.0.1`, since `localhost` is `[::1]`-only on macOS), and on the port you are asking for (`--strictPort`). |
| Dev server not reachable on 5173 | Start it in the background (Step 2). If `node_modules` is missing, run `npm install` — or ask the user to, if your sandbox blocks the network. A server that answers on `localhost:5173` but not `127.0.0.1:5173` is up on `[::1]` only: restart it with `--host 127.0.0.1`. |
| `--strictPort` refuses to start: 5173 is in use | `lsof -ti tcp:5173` names the holder. A stale Vite for this project — stop it and restart with the Step 2 line. Another project's — use `--port 5174` and change every `:5173` in this skill to match. |
| Wrong port | The driver takes `--port <n>`, else `$CDP_PORT`, else `9222` — and warns on stderr whenever it falls back to `9222`, because that default is shared with every other Chrome on the machine. `npm run chrome` reads `$CDP_PORT` too, so `export CDP_PORT=<n>` once and both ends agree; heed the warning rather than driving someone else's browser. |
