# The optional browser verification pass

The scaffold workflow can end by opening the finished game in a real Chrome over CDP and checking
it. It is **opt-in**, decided in Step 1, smoke-tested in Step 5, and run in Step 7. This file
holds all three parts.

## Step 1 — asking for it, and proving a browser exists

Ask, with `AskUserQuestion`, whether to include a browser verification pass after the one-shot
build. Give them the real trade-off rather than a leading question:

- **What it buys.** It is the only way to catch the defects every static check misses — sprites at
  the wrong scale, art that is invisible on the additive display, a HUD clipped outside the 600x600
  stage, an input wired to nothing, a title screen that never advances. The gate can be entirely
  green on a game that renders a black rectangle.
- **What it costs.** More tokens, and noticeably: the pass takes screenshots, images cost far more
  than text, and each one stays in context for the rest of the run. It also adds turns at the end
  of a run that is otherwise unattended.

**If they say yes, prove a browser is reachable before you leave plan mode.** Finding out after the
build that the pass was never possible wastes the decision. The probe is read-only:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/scripts/cdp.mjs" status
```

> There is no `npm run chrome` yet, and no `setup-cdp.mjs` to run — the project does not exist
> until Step 3. Both the probe and the launcher work standalone from the plugin, which is why the
> paths here are `${CLAUDE_PLUGIN_ROOT}` ones.

- **Exit 0** → done; note in the plan that the pass will run.
- **Exit 3** → ask the user, **once**, to run this in a terminal **outside** the agent and leave it
  running, then re-probe:

  ```bash
  bash "${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/scripts/start-chrome-cdp.sh"
  ```

  Don't try to launch it yourself first and don't reach for Playwright or `chrome --headless`:
  sandboxes that block Chromium (Claude Code's macOS one included) kill all three the same way, and
  the failed attempt costs a turn.
- **Still unreachable** → **degrade, don't block.** Drop the pass, say so in the plan in one line,
  and build the game anyway. Step 7 will end with the explicit `visual checks: NOT RUN` disclaimer.

Record the outcome either way — it decides whether Step 5 runs the smoke test and whether Step 7
runs the pass.

## Step 5 — prove the browser loop works

**Only if Step 1 opted in.** Skip this entirely otherwise.

Step 1 proved a Chrome is reachable. This proves the whole chain works end to end — Vite, Chrome,
CDP, screenshot — while the game is still the untouched starter, which already renders something.
Doing it now rather than at Step 7 means a broken link costs you nothing: no game code has been
written yet.

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/scripts/setup-cdp.mjs" <project-dir>
```

Then the dev server, on its own because it never returns — run this one as a **background Bash
task** (the Bash tool's `run_in_background` option) and move on while it serves:

```bash
cd <project-dir> && npm run dev -- --host 127.0.0.1 --strictPort < /dev/null
```

Never foreground the dev server, and never `nohup`/`&` it. Each addition to that line is
load-bearing: `< /dev/null` keeps a backgrounded Vite from reading the controlling terminal and
taking the `SIGTTIN` that kills it seconds after it prints "ready"; `--host 127.0.0.1` stops it
binding `[::1]` only, which is what `localhost` means on macOS and what would make the
`http://127.0.0.1:5173` below refuse the connection; `--strictPort` turns a taken 5173 into an
error instead of a silent move to the next free port. If it errors, something else holds the port
(`lsof -ti tcp:5173`) — `iterate-webapp-game` Step 2 has the who-owns-it call. If that
resolves to running this project on its own port (`--port 5174`), every `http://127.0.0.1:5173`
in the rest of this section moves with it: nothing here follows the flag.

Then, in the foreground, open the game and capture it:

```bash
# Vite needs a moment to bind; without this, `open` lands on Chrome's connection-error page and
# the screenshot below looks like a game that renders nothing.
for _ in $(seq 20); do curl -fs http://127.0.0.1:5173 >/dev/null && break; sleep 0.5; done
# The loop just ends after ~10s, so stop the block here rather than screenshotting a dead URL —
# otherwise "never bound" and "renders nothing" reach you as the same blank PNG.
curl -fs http://127.0.0.1:5173 >/dev/null \
  || { echo "dev server never came up — read the background task's output"; exit 1; }
node "${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/scripts/cdp.mjs" open --url http://127.0.0.1:5173
node "${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/scripts/cdp.mjs" shot --out /tmp/scaffold.png
```

Read `/tmp/scaffold.png`. **You should see the starter game's title screen** — this is the one
screenshot worth spending here.

Leave the dev server running; Step 7 needs it. Kill that background task when the run ends.

**If any of it fails**, don't debug it now and don't retry in a loop — you are at the start of a
long build. Drop the pass, tell the user in one line which step failed, and continue to Step 6.
Step 7 will report `visual checks: NOT RUN`.

## Step 7 — run the pass and report it

**Probe for a browser first** — even if Step 1 opted in and Step 5's smoke passed, since the user
may have closed the Chrome in the meantime:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/scripts/cdp.mjs" status
```

(If Step 1 asked and the user declined the pass, skip straight to Step 8 — don't run it anyway.
They were told what it costs and said no.)

**Reachable (exit 0)** → **read** the sweep now — do not run it from memory:

```
${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/references/verification-pass.md
```

Then work its eight checks in order: boot errors, a non-blank frame, additive-display visibility,
the title transition, every input, HUD bounds, the outcomes `docs/design.md` promises, and perf —
settling the UI-surface, all-text-is-DOM and controls boxes in Step 7's checklist, and confirming
the sprite-brightness one on the rendered frame rather than only in the source art. Follow its fix
policy: repair the clear-cut defects and re-verify, but leave anything judgment-shaped (pacing,
balance, difficulty, "is it fun") to the developer and to `/webapp-game-director`.

### The report format

Close the step in the pass's report format, with a verdict for every numbered check — there are
exactly four (`passed`, `fixed`, `open`, `NOT RUN`), and a `passed` that needs a caveat on the
verdict itself ("passed (limited)", "passed with caveats") is really a `NOT RUN` or an `open`.
Evidence for a pass — check 5's input ledger, say — is not such a caveat. The block below is a
worked example from a different game — copy its shape, not its findings:

<!-- This block is inlined verbatim from the "Reporting" section of
     iterate-webapp-game/references/verification-pass.md. Change one, change the other. -->

```
Verification pass — 8 checks
  passed  1 boot, 2 renders, 4 title advances
          5 inputs — every row filled: D-pad left, D-pad right, pinch. Tap-only game,
          so the control set has no drag in it.
  fixed   3 emits light — enemy sprite was #0a0a12, recolored to #6ad2ff (re-verified)
  open    6 HUD bounds — clean on the title card and mid-play; check 7 never reached an
          ending, so the third screen was never measurable and the verdict cannot settle
          7 design acceptance — could not reach the win state; the wave counter
          stops advancing at wave 3 (not fixed: cause not isolated in 3 rounds)
  NOT RUN 8 perf FPS — `cdp foreground` counted 0 rAF callbacks in 1s (the Chrome
          window is covered), so no frame rate exists to measure. Driven CPU
          measurement instead: 0.04 ms/frame, 34 draw calls, 204 tris.
  tests   <game count> game (npm run test:game), <framework count> framework inherited
          from the scaffold
```

The `tests` line is a trailing metric, not a fifth verdict, and it carries two numbers and no
total. Run both counts rather than copying either out of this page. The framework half is the same
in every game built from this scaffold and says nothing about this one, so a single figure reads as
far more depth than was written — see `${CLAUDE_PLUGIN_ROOT}/docs/testing.md` § "Report the game
count, never the total".

That summary is the last thing in the report, not the whole of it: check 5's input ledger, the
screens check 6 was run on, and a named line per ending in check 7 sit above it.

**Not reachable (exit 3)** → try starting one, then re-probe (`iterate-webapp-game`
Step 3 has both paths — launch it yourself as a background task, or ask the user to run
`bash "${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/scripts/start-chrome-cdp.sh"` in
a terminal outside the agent). Some sandboxes, Claude Code's macOS sandbox included, crash Chromium
at launch — Playwright, Puppeteer and `chrome --headless` all fail identically, so don't reach for
those. If it still isn't reachable, **say so explicitly in your completion summary**:

```
visual checks: NOT RUN (no reachable browser) — layout, sprite visibility, and screenshots unverified
```

Never fold an unrun check into "all gates green," and never write an audit script you don't
execute. Silent non-execution is the worst outcome available here: it costs nothing, so it looks
like efficiency, and it hides exactly the class of bug — "renders invisible on device" — that no
static check can catch.
