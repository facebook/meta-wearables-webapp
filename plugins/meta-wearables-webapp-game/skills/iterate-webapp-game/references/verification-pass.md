# The verification pass

A structured sweep of a game in a real browser, run **after** a build is otherwise complete, to
catch the defects no static check can see. `npm run validate`, `typecheck`, and `test` can all be
green on a game that renders nothing, renders invisibly on the additive display, or ignores every
input. Only looking at the running game finds those.

Run this when you have finished building (or changing) a game and want to know whether it actually
works, before handing it to a human. It is a *self-check*, not a critique — see
[What this is not](#what-this-is-not).

## Before you start

Steps 1–4 of [`../SKILL.md`](../SKILL.md): project resolved, `setup-cdp.mjs` run, Vite dev server
up, a Chrome reachable on the CDP port, and the game opened.

**Open it with `?drive`** — `cdp open --url "http://127.0.0.1:5173/?drive"`. The loop then never
starts on its own, and you advance it with `cdp step --frames 30`. That is what makes checks 4, 5
and 7 mean anything: a self-animating game changes every frame regardless of input, so without it
a before/after diff proves nothing and every capture lands at an arbitrary state. Confirm it took
— `cdp eval --expr "window.__webappGame?.status() ?? 'no harness'"` — and if the harness is
missing (a game predating `framework/debug/DriveHarness.ts`), run the pass free-running and say
so in the report; the affected checks need the control-capture workaround check 5 describes.

Stepping fixes *timing*, not randomness. A game calling `Math.random()` still behaves differently
each run, so treat a one-off outcome as one sample, not as reproducible.

Two things to establish first, because they change what the later checks mean:

- **The drag mode.** Grep `src/main.ts` for `pointerDrag`, or run `validate-drag-optin.mjs` from
  `validate-webapp-game`. Tap-only → the pinch is `keys "Enter"` and `click` does nothing.
  Drag → the pinch is `click`, `Enter` is ignored, and check 5 has a drag to exercise.
- **What the game is supposed to do.** Read the game's `docs/design.md`. Checks 3 and 7 compare the
  running game against what was agreed, and without it you are only checking that *something*
  happens.

Set a working directory for captures — `SHOTS=$(mktemp -d)` — and keep the paths straight; several
checks compare two frames.

**Capture the stage, not the viewport.** Every `shot` below passes
`--selector "#game-root"`, which clips the capture to the 600x600 stage. Without it you get the
whole browser window with the stage centred somewhere inside it, and every `--region` then needs
the stage's viewport offset added to it — get that wrong and `stats` reports
`every pixel is near-black` for a patch of desktop background, a false failure indistinguishable
from the real defect check 3 looks for. With it, region coordinates are stage-local: `0,0,600,80`
is the top strip.

If `devicePixelRatio` is not 1 the image is that many times larger than 600x600, so scale region
coordinates to match; `stats` prints the image's real dimensions, which is how you check.

Every command below calls `cdp` or `stats`. Define them in the shell you run the pass in, before
the first check — a function rather than a variable holding a command string, because zsh does not
word-split an unquoted parameter and would try to exec the whole string as one filename:

```bash
P="${CLAUDE_PLUGIN_ROOT}/skills/iterate-webapp-game/scripts"
cdp()   { node "$P/cdp.mjs"         "$@"; }
stats() { node "$P/frame-stats.mjs" "$@"; }
# export CDP_PORT=9333   # uncomment, with your port, if Chrome is not on 9222
```

`export CDP_PORT` beats appending `--port` to the dozens of commands below: one missed line drives
a different browser, and every capture after it belongs to that one. The driver warns on stderr
each time it falls back to 9222.

## Cost discipline

Every screenshot you take is an image, and images stay in context for the rest of the run — they
are the expensive tokens in this loop, by a wide margin.

- **Read a number before you read a picture.** `stats` and `cdp eval` answer most of the
  questions below numerically. Open the PNG with the Read tool only when you need to *judge* the
  image — check 3's "is this readable / is it the right thing" and nothing else.
- **Reuse captures.** The frame you shot for check 2 is check 4's baseline. Don't re-shoot an
  unchanged page.
- **Don't screenshot to confirm a number you already have.** If `changedPixelFraction` is 0, the
  input did nothing; a picture of the unchanged frame adds no information.

## The checks

### 1. It boots clean

```bash
cdp logs
```

**Pass:** no entries at level `uncaught`, `unhandledrejection`, or `error`.

An uncaught error during startup usually means everything after it is meaningless, so run this
first and fix what it reports before continuing. Framework logging goes through the game's logger,
so a `?log=debug` reload surfaces more if the failure is silent.

### 2. It renders something

```bash
cdp shot --selector "#game-root" --out "$SHOTS/01-boot.png"
stats --png "$SHOTS/01-boot.png"
```

**Pass:** `nonBlackBBox` is not `null`.

A `null` bbox means every pixel is at or below the darkness threshold — the game is drawing nothing
the glasses would emit. That is a hard failure even if the canvas exists and no error was logged.

### 3. What it draws would be visible on the glasses

The display is **additive**: black emits no light. Art drawn against an opaque white editor
canvas — or any sprite left near-black — is invisible on device while looking fine in Chrome. No
static check can catch this, and neither can a person who only ever sees it on a monitor.

```bash
stats --png "$SHOTS/01-boot.png"                      # whole stage
stats --png "$SHOTS/01-boot.png" --region 0,0,600,80  # the HUD strip — resize to your HUD's height
```

Then **read the PNG** — this is the one check that needs your eyes.

**Pass:** every element the player must react to is legible, nothing gameplay-critical is
near-black, no backdrop band is a slab by the rule below, and the HUD strip is not a filled band
by the numbers in its bullet. Weigh it against the game's own
`docs/design.md` asset inventory: that is where the scaffold recorded what each sprite is and any
brightness fix it was supposed to get.

Three failure shapes to look for specifically:

- **Something the player must dodge is invisible.** The worst case, because the game is unplayable
  in a way that is invisible to every other check.
- **An opaque full-bleed backdrop.** It lights up the wearer's entire field of view instead of
  receding. A backdrop should be sparse, not a filled rectangle.
- **A filled band behind an always-on HUD.** The same defect in strip form: a HUD is on screen for
  the whole round, so a background fill on it is lit for the whole round. A HUD is text over the
  black page, and a dark gray is no defence — dark gray is allowed on cards and modals *because*
  they come and go, and a HUD does not.

  **Measure the strip on its own; the slab rule below cannot see this one.** `#1c1e21` has a
  luminance of ~0.12, so a strip filled with it scores `fractionLit` ~0 and a `meanLuminance` in
  the same range as a correctly drawn playfield — the slab rule passes it either way. Read two
  numbers over the strip instead:

  - **`p50Luminance` off zero.** A HUD drawn as text on black is mostly black, so its median pixel
    is 0. A flat fill puts the median at the fill's own luminance, however dark that fill is.
  - **`fractionNearBlack` below 0.5.** The share of pixels at or below `--dark-threshold`, so it
    *falls* as more of the strip is lit: read a low value as "mostly lit", not the other way
    round. Sharper than the median where it applies, but the threshold defaults to 0.08 and
    `#0a0a0f` is ~0.04 — the darker half of the sanctioned `#0a0a0f` – `#1C1E21` range is below
    it, and a strip filled flat with `#0a0a0f` scores ~1.0 and passes. That blind spot is what
    `p50Luminance` covers. The 0.5 line also assumes the default threshold; pass a different one
    and the number means something else.

  Both readings depend on the region, so measure the full row the HUD occupies — not the whole
  stage, and not a box hugging the glyphs. Running past the HUD into empty black page hides a
  fill; cropping tight to bright text invents one; and on a transparent full-width HUD the row
  also contains whatever the playfield draws behind it, which invents one too. **Neither number
  decides on its own — a reading that says "filled" is a prompt to read the PNG, which is what
  tells a background fill apart from a lit playfield or large bright glyphs.**

  The 0.5 line was placed to sit between a strip filled flat and a strip drawn as text on black,
  from one calibration run of six games. Measure your own strip; do not carry a number over from
  another game.

  The separators `docs/core-contract.md` does allow — a hairline rule, a short gradient — cost the
  strip only the pixels they cover, so a separator over a small share of it leaves both numbers
  where an unfilled strip leaves them. Cover more than half the strip and the median stops
  agreeing: `p50Luminance` is a median, so it lifts off zero however dim the gradient is, while
  `fractionNearBlack` stays ~1.0 for anything under the dark threshold. Read that pair as "something
  covers most of the strip" and open the PNG; it is not on its own a fill. A gradient that drags
  `fractionNearBlack` under 0.5 is the other case — covering more than half the strip in light,
  which is a fill with soft edges rather than a separator.

`--region` is how you interrogate one part of the frame: compare the playfield's `meanLuminance`
against the HUD strip's rather than reasoning about a single whole-frame average.

**The slab has a number.** Measure the backdrop band on its own — sky, floor, wall — and read
`fractionLit`, the share of pixels at or above 0.5 luminance:

```bash
stats --png "$SHOTS/01-boot.png" --region 100,60,500,140   # a sky band
stats --png "$SHOTS/01-boot.png" --region 0,300,600,300    # the playfield, to compare against
```

**It is a slab if `fractionLit` is above 0.15.** The band's `meanLuminance` against the
playfield's is a second *reading*, not a second threshold: a backdrop several times brighter than
the thing the player is watching is a slab whatever its absolute number says.

Do not read a bare "exceeds the playfield" as that test. On an additive display a correct
playfield is mostly black, so a sky that is merely *drawn* outscores it routinely — the three
correctly-reading games below sat at `meanLuminance` 0.113, 0.126 and 0.169, above what a sparse
playfield would measure, and a bare comparison would have failed all three. That round did not record the
playfield's mean beside the band's, so there is no measured margin to quote here. A band close to
or a little above the playfield is inconclusive; settle it by reading the frame.

Calibration, from the six games of one calibration run — the same sky band `100,60,500,140`, measured
mid-play. What that round measured was `meanLuminance`: the four that read correctly on the
additive display scored 0.005 (no sky drawn at all), 0.113, 0.126 and 0.169; the two that failed
scored 0.444 and 0.635, both large solid-white shapes with a `p95Luminance` of 1.0. The 0.15
`fractionLit` line was proposed from those frames rather than read off them, and six games is the
entire sample — treat both numbers as where the line fell once, not as constants of the display.

**The most likely offender is a sprite you derived yourself** — the crops and chroma-keys of Step 4
of `create-webapp-game`. A crop that clips a shape mid-curve ships as a rectangle; a
chroma-key that removes a blue sky leaves the white cloud behind. Look at the derived PNG at the
size `models.ts` draws it.

### 4. The title screen advances

```bash
cdp keys --keys "Enter"             # tap-only game
cdp click --selector "#game-canvas" # drag game — Enter is deliberately ignored there
cdp step --frames 2                 # let the frame after the tap actually render
cdp shot --selector "#game-root" --out "$SHOTS/02-playing.png"
stats --png "$SHOTS/02-playing.png" --baseline "$SHOTS/01-boot.png"
```

**Pass:** `changedPixelFraction` is clearly non-zero.

Compare the two captures *before* you look at either — the number comes first here as everywhere
else in this pass. If `$STATS --baseline` did not run, `md5sum` the two files: identical hashes are
the same frame, and that answers the check without an image.

A `changedPixelFraction` of 0 — or two identically-hashed captures — means the input did nothing.
First confirm you sent the right one — sending `Enter` to a drag game (or a `click` to a tap-only
one) is the single most common false failure here. Once the input is confirmed correct, a zero is a
**failure**: the frame in front of you is the one from before the input, and you must not describe
it as if the input worked.

With the right gesture and still zero, a `click` in a drag game can be dropped for reasons that are
not understood. Dispatch the pointer sequence yourself before you believe the game is at fault —
`PointerKeyboardInput` listens on `window` for `pointerdown` / `pointerup` and reads only `button`
(0 = primary), so a synthetic pair reaches it exactly as a real pinch does. `eval` takes an
expression, hence the IIFE:

```bash
cdp eval --expr "(()=>{const o={bubbles:true,pointerType:'mouse',isPrimary:true,button:0};
  window.dispatchEvent(new PointerEvent('pointerdown',{...o,buttons:1}));
  window.dispatchEvent(new PointerEvent('pointerup',{...o,buttons:0}));return true})()"
```

Step and re-diff. If this advances the title and `click` did not, report the `click` as unreliable
and use this for the rest of the pass.

### 5. Every input does something

Once past the title, exercise **every** control the design says exists — each D-pad direction it
uses, the **pinch**, and in a `pointerDrag` game an actual **drag**. Fill in one row per control as
you go, and carry the table into the report:

| input | how driven | state before → after |
|---|---|---|
| move left | `cdp keys --keys "ArrowLeft"` then `cdp step --frames 5` | `hero.x` 300 → 264 |

(On a game with no readable state the last column holds a pixel measurement instead — see the
fallback below.)

The table is the check. In prose an omission is invisible to the agent writing it: of six games in
one calibration run, one run reported "dash left/right" having never dispatched `ArrowRight`, and
another exercised 2 of its game's 5 gestures and called the check complete. Name the **exact** key
or gesture in the middle column — a row you cannot fill is a control you did not drive.

**Read state, not pixels.** `window.__game` is unambiguous where a pixel diff is not and costs no
image tokens; `cdp eval --expr "(()=>{const g=window.__game;return g?Object.keys(g):null})()"`
shows what the game exposes.
The scaffold ships that handle under `import.meta.env.DEV`; a game predating it returns `null`, in
which case say so in the report and suggest adding
`if (import.meta.env.DEV) window.__game = game;` to `main.ts`.

Only with no readable state, fall back to pixels — and then diff a **tight `--region`** around
where the design says the effect appears, never the whole stage. **The last column still gets
filled on this path**: write the region's `changedPixelFraction` and `changedBBox` in place of the
state, e.g. `region 0,420,600,180 → changed 0.07, bbox 96x40 at 210,441`. A row with a measurement
in it is a driven control; the pass criterion below does not soften for older games.

```bash
cdp shot --selector "#game-root" --out "$SHOTS/before.png"
cdp keys --keys "ArrowLeft"
cdp step --frames 5
cdp shot --selector "#game-root" --out "$SHOTS/after.png"
# The region is the strip the player moves along, read off docs/design.md — substitute yours.
stats --png "$SHOTS/after.png" --baseline "$SHOTS/before.png" --region 0,420,600,180
```

The region has to come from the design, not from habit: it is what makes the diff evidence that
*this* control did *that*. Copy the numbers above and a game whose player is elsewhere on the stage
reports zero for a move that worked.

A whole-frame diff is not evidence in a game that animates itself, because the animation churns
pixels whether or not the input landed. In that same calibration run one run read a `changedBBox` of
596x513 as confirmation that both jump and pound worked, at a churn its own idle frames already
produced. The remedy differs by mode. Under `?drive`, step the same number of frames on both sides,
so the input is the only difference between them. Free-running (no `?drive`), nothing is stepped at
all: capture twice with **no** input first, and require the input's diff to beat that measured
baseline churn — measure it, do not carry a number over from another game.

The drag is the one input that needs a flag:

```bash
cdp drag --selector "#game-canvas" --dx 120 --dy -40 --drive
```

**`--drive` is mandatory for a drag on a driven page.** A tap or a swipe reaches its subscriber
synchronously and the next `step()` applies it; a drag's movement is discarded at `pointerup` if no
frame ran to consume it, so an unstepped drag on a paused game delivers a delta of exactly zero — a
false failure that looks exactly like broken drag handling. Drop the flag only when running free.

**Pass:** every row is filled, and each change is the one the design describes — not merely *a*
change.

### 6. The HUD stays inside the 600x600 stage

The boxes are in viewport coordinates and so is the stage, so let one expression do the
subtraction and report each child **relative to the stage** — comparing raw viewport numbers
against `0,0–600,600` fails every correct game and passes some broken ones:

```bash
cdp eval --expr "(()=>{const s=document.querySelector('#game-root').getBoundingClientRect();
  return [...document.querySelectorAll('#game-root *')].map(el=>{const r=el.getBoundingClientRect();
  return {sel:el.id||el.className||el.tagName, x:Math.round(r.left-s.left), y:Math.round(r.top-s.top),
  w:Math.round(r.width), h:Math.round(r.height)}}).filter(b=>b.w>0)
  .filter(b=>b.x<0||b.y<0||b.x+b.w>Math.round(s.width)||b.y+b.h>Math.round(s.height))})()"
```

**Run it once per screen, and name the screens in the report.** The `.filter(b=>b.w>0)`
keeps only the elements that are laid out at the instant you measure, so a run made during play
says nothing at all about the title card or the game-over card — the two surfaces carrying the most
text, and so the two likeliest to overflow. There is no way to measure them from elsewhere:
measuring a screen means being on it. Take one reading at the title before the pinch of check 4,
one mid-play, and one after driving the game to an ending in check 7. That last one lands *inside*
check 7, so **this check does not finish in numbered order**: take the first two readings here,
then leave check 6's verdict unsettled and record it once check 7 has reached an ending — deferred,
not the `open` verdict § Reporting defines. Recording it as
`passed` on two of the three screens is the overclaim itself, not a shortcut to it — of six games
in one calibration run, both runs that got this far claimed more screens than they had measured.

**Pass:** on each screen the list is empty — every visible box lies inside the stage — and no two
boxes that carry text overlap. (Drop the overflow filter — the `b.x<0||…` line — to see every
laid-out box when you need to check the overlap by hand. Keep the `b.w>0` one.)

`validate` already enforces the 600x600 viewport and a >=16px HUD font, but it reads the CSS — it
cannot see a label that overflows its container once a real score is in it, or two elements that
collide only at four digits. This is the check for that.

### 7. It does what the design says

Drive the game through the outcomes `docs/design.md` promises: make the score change, get far
enough to see the difficulty ramp if there is one, and reach **every ending it lists**. A game that
can end on a timer and on running out of lives has two, and the report names each one separately
with how it was reached. Of six games in one calibration run, one run reached the lives-exhausted loss,
never the 60-second timer expiry that was that game's primary ending, and reported the check
complete.

**Step in chunks and read state between them.** A single `cdp step --frames 3200` gives you a
terminal state and nothing else — you cannot see the ramp, or which hazard cost the lives, or that
any given entity type ever spawned. A few hundred frames, then `window.__game`, then step again: at
the default `stepSeconds` of 1/60, `--frames 600` buys ten simulated seconds with no real time
spent waiting and no frames lost to whatever else the machine was doing.

**Better, play the round inside the page in one call.** `eval` can run the whole thing: synthesise
real `PointerEvent` / `KeyboardEvent` so the game's own handlers run, drive
`window.__webappGame.step()` between them, accumulate state as you go, and return a single JSON
blob.

Driving `step()` from inside an expression skips the guards `cdp step` applies, so put them in the
expression. Assert the harness exists before the first call, and check every return value — under
a running loop `step(n)` returns 0, and a round built on zero advanced frames still comes back as
a plausible JSON blob:

Wrap it in the IIFE every evaluated snippet here uses — `--expr` takes an expression, so a
top-level `return` is a syntax error and you would get a parse failure instead of the diagnosis:

```js
(()=>{
  const h = window.__webappGame;
  // Distinguish the two failures: no `__webappGame` at all means the page was not loaded with
  // `?drive`; an `__webappGame` without a callable `step` means the game predates
  // `framework/debug/DriveHarness.ts` and needs the framework re-synced, which no reload fixes.
  if (h == null) return {error: 'no drive harness — reload the page with ?drive'};
  if (typeof h.step !== 'function') return {error: 'harness predates DriveHarness.ts — run update-webapp-game-framework'};
  const advance = n => {
    const got = h.step(n);
    // Same split `cdp step` makes: zero means the loop is running and refused every step;
    // anything else short means it accepted some and stopped part-way, which `pause()` won't fix.
    if (got === 0) throw new Error('loop is running — pause() first, or reload with ?drive');
    if (got !== n) throw new Error(`loop stopped accepting steps part-way (${got}/${n})`);
  };
  // `advance` throws rather than returning, because a `return` inside it would abandon only the
  // helper and let the round carry on over frames that never ran. Catching here is what keeps the
  // promise above that every outcome, success or failure, comes back as one JSON blob.
  try {
    // ... the round ...
    return {/* score, lives, telemetry, localStorage dump — what the round gathered */};
  } catch (e) {
    return {error: e.message};
  }
})()
```

An in-page round advances the loop synchronously, so the whole thing costs no wall-clock wait and
no image tokens, and returns score, lives, telemetry and a `localStorage` dump from one
`cdp eval`. Screenshot only where you must *see* the result.

**Pass:** each documented outcome is reachable and behaves as written, and every ending is named.

This is the open-ended check and the one most worth your judgment. It is also where you will find
out that a number in `docs/design.md` was an estimate rather than a spec — if what you measure
disagrees, the measurement wins; record both.

### 8. Performance sanity

```bash
cdp open --url "http://127.0.0.1:5173/?stats"
cdp foreground
```

This URL drops `?drive`: a frame *rate* only means something on a free-running loop. Everything
before this check ran driven; this part does not.

#### Is the page delivering frames? Everything here depends on it

`foreground` raises the tab, emulates focus, forces the document lifecycle back to `active`, and
then counts `requestAnimationFrame` callbacks for about a second. **That count is the test.** Read
`frames` out of its report before anything else:

- **`frames: 0`** — the loop never ticks, the game clock does not advance, and the `?stats` overlay
  reads all zeros or freezes on the first frame (drawn before anything spawned, so its `Draw` /
  `Tris` describe an empty scene). **None of those numbers are measurements.** Reporting them as
  perf results is the specific mistake this section exists to prevent.
- **a low but non-zero count** (under 20 in that second) — the tab is being throttled, not running,
  so the overlay understates the game rather than measuring it; treat it like the zero case.
  `foreground` reports `throttled: true` and says so. Only 0 and 61 have ever actually been
  measured here, so this band guards the gap between them rather than describing an observed state.
- **20 or more** — the tab is delivering frames, and the overlay is worth reading. This is a
  measurable/not-measurable verdict, not a frame-rate one: the 20 line sits in the unobserved gap
  between 0 and 61, so a count of 25 clears the tab for measurement without saying the game hits
  its 30 fps target. Read that off `?stats`, which is what measures it.
- **a count near the display's refresh rate** (~60 on a 60 Hz screen) — the loop is running at full
  speed; read the overlay.

If the probe itself never comes back, `foreground` gives up after a few seconds and reports
`frames: null` with the reason, rather than sitting on the CDP timeout: a tab throttled hard enough
to stop delivering frames throttles the timer the probe resolves from too.

The usual cause of zero is a Chrome window covered by another window, and it is not a rare state:
one headed Chrome per CDP port is how parallel runs stay off each other's browser, so several
windows are open at once and most of them are covered. In one calibration run every parallel run hit it,
and rAF delivered **zero callbacks in five seconds** on each.

**The visibility fields cannot clear a tab for measurement.** `foreground` also reports
`visibilityState` and `hasFocus` from before and after its three calls, plus a derived `occluded`
from the post-call read only — there is no `before.occluded`, since the point of the derivation is
the state the tab was left in. Treat
them as corroborating detail, never as the verdict: on macOS on 2026-08-28, a Chrome window
completely covered by a fullscreen terminal reported `visible` / `hasFocus: true` /
`occluded: false` while delivering **0 rAF callbacks in 1 second**. A clean-looking visibility read
alongside a dead loop is exactly the trap that turns a stalled `?stats` overlay into a reported
result.

`Page.bringToFront` **alone does not fix it** — verified in the calibration run above: it returns
`{"result":{}}` and changes nothing. The one reliable cure is a Chrome window nothing overlaps —
ask the user to uncover it, or to relaunch it with `npm run chrome`, whose anti-occlusion flags took
that same covered window from 0 to 61 rAF callbacks in a second (same single measurement, macOS,
2026-08-28). Then re-run `cdp foreground` and read `frames` again. Still zero: fall back to the
driven measurement below, which does not need rAF at all.

#### If the overlay is live

Read it: FPS, CPU ms, draw calls, triangles, GPU memory.

**Read the frame rate first.** At or near zero, the loop is not running, and every other number on
the overlay is a stale sample from whenever it last ticked — draw calls and triangle counts from a
loop that stopped say nothing about the build's cost. A zero frame rate makes check 8 `NOT RUN` —
never a `passed`. The stalled loop is a finding in its own right, so report it as a separate `open`
line rather than a second verdict for check 8.

**Pass:** the loop is ticking, and nothing is obviously pathological against the budgets in
[`../../../docs/performance-guidelines.md`](../../../docs/performance-guidelines.md).

#### The fallback: measure CPU work per frame under `?drive`

A stepped loop runs `update()` + `render()` synchronously, on the caller's stack, with no rAF
involved — so it works while the window is occluded. **It measures CPU work per frame, not frame
rate.** There is no frame clock and no compositor in the loop, so it **cannot** produce an FPS
number; deriving one from `msPerFrame` would be inventing a figure the run never observed.

Both flags are independent booleans, so combine them — `?drive&stats` gives the paused loop *and*
the overlay, and the overlay's `Draw` / `Tris` / `CPU` rows update on every frame you step. Its
`FPS` row does not survive the combination: the sampler times begin-to-begin between frames, and
under synchronous stepping that interval is your step call, not a display interval.

```bash
cdp open --url "http://127.0.0.1:5173/?drive&stats"
cdp keys --keys "Enter"      # or `cdp click --selector "#game-canvas"` — use the drag mode's pinch
cdp step --frames 300        # get into real gameplay: a title screen measures nothing
```

Check which handles the page actually exposes before measuring through them — `renderer` is a
game-owned field name, not a framework guarantee:

```bash
cdp eval --expr "(()=>{const g=window.__game;return {game:!!g, fields:g?Object.keys(g):null,
  getStats: typeof g?.renderer?.getStats, harness: typeof window.__webappGame?.step}})()"
```

`getStats: "function"` is what you want: `Renderer.getStats()` is the framework's own
**backend-agnostic** stats call (`drawCalls`, `triangles`, `points`, `lines`, `geometries`,
`textures`), so it works whatever the renderer is. Prefer it over reaching into Three's
`renderer.info`, which is two hops deeper (`__game.renderer.renderer.info`) and only exists on the
Three backend. If `__game` is missing entirely the game predates the scaffold's dev handle — say so
and skip to the verdict; if it is present but `getStats` is not, `renderer.info` is the fallback.

Then time a fixed number of frames and read the counters after them:

```bash
cdp eval --expr "(()=>{const g=window.__game,h=window.__webappGame,n=120;
  if(h.step(30)!==30)return {error:'loop is not paused — reload with ?drive'};
  const t0=performance.now(); const ran=h.step(n); const t1=performance.now();
  const r=g?.renderer;
  return {frames:ran, cpuMsPerFrame:+((t1-t0)/ran).toFixed(3),
    stats: typeof r?.getStats==='function' ? r.getStats() : (r?.renderer?.info ?? null),
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize/1048576).toFixed(1) : null}})()"
```

- `h.step(30)` warms up first (shader compiles and lazy allocations land on the early frames) and
  doubles as the pause check — a running loop returns `0` and the timing would be meaningless.
- `stats` describes the **last frame drawn**, which is why it is read after the timed run. It takes
  the `renderer.info` fallback the discovery step describes, so a game whose `renderer` has no
  `getStats` still reports counters instead of throwing; `null` means neither was there.
- `performance.memory` is Chrome-only and deliberately coarse; `null` elsewhere. It is JS heap, not
  GPU memory.

Report exactly what this yields — CPU ms per frame, draw calls, triangles, JS heap — and state
that no frame rate was measured. For scale, one game in one calibration run measured 0.036 ms/frame,
34 draw calls, 204 triangles and a 38.7 MB heap this way; that is a single reading from a single
game on a laptop, not a baseline.

#### Either way

**A desktop Chrome with a real GPU is not the glasses.** These numbers say a build is *not*
catastrophically over budget; they cannot say it is within budget on device. Report them as an
indication and say so.

**Verdict.** A throttled loop makes this check `NOT RUN`; a driven measurement with no frame rate
makes the frame-rate half `open` (and the CPU half a reported measurement). Neither is a
`passed (limited)` — see [Reporting](#reporting).

## What to fix, and what to leave

**Fix it, then re-verify.** Objective failures, where "wrong" is not a matter of opinion:

- an uncaught error or a rejected promise on boot
- a blank frame, or a `null` `nonBlackBBox` where content is expected
- a gameplay-critical asset that is near-black on the additive display
- a backdrop or decor asset rendering as a large near-white slab (the inverse defect; same
  objective rule, and **not** art direction)
- a HUD element outside the 600x600 stage, clipped, or overlapping another
- an input that produces no change
- a sprite whose rendered bbox is wildly off the size the design gives it

**Report it, don't change it.** Anything where the answer is a judgment call: pacing, difficulty,
balance, whether it is fun, art direction, what to build next. Those belong to the developer and to
`/webapp-game-director`, which ranks them properly and lets a real playtest decide.

**Removing an assertion converts that behaviour to *not verified*.** Deleting a failing test is a
coverage decision, not a fix: if you delete one, say so in the report and name what is now
uncovered. A behaviour with no unit test and no browser check has no coverage from any source, and
nothing downstream will notice.

**Cap the loop at three fix/re-verify rounds.** If something is still failing after three, stop and
report it as open with what you tried. A pass that grinds on one defect burns the budget that the
remaining checks needed.

After any fix, re-run **only the checks that fix could affect** — not the whole sweep.

## What this is not

This pass and `/webapp-game-director` do different jobs, and conflating them wastes both:

|  | This pass | `/webapp-game-director` |
|---|---|---|
| Asks | Does it work? | Is it good? |
| Verdict from | An objective criterion | A real on-glasses playtest |
| Decides | You do | The developer does |
| When | Before handing over a build | Iterating on a working build |

If you find yourself ranking issues by how much they'd improve the game, you have crossed the line.
Note it and move on.

## Reporting

The summary below is the last thing in the report, not the whole of it: check 5's input ledger, the
screens check 6 was run on, and a named line per ending in check 7 sit above it.

Close with a summary that separates the four verdicts, and **name every check that did not run**:

<!-- This block is inlined verbatim in create-webapp-game/SKILL.md Step 7, so a
     scaffold gets the format without opening this file. Change one, change the other. -->


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

`tests` is a trailing metric line, not a fifth verdict — the four verdicts are the four rows above
it. Run both counts rather than carrying either number out of this page: the framework half moves
with every plugin release.

If you cite unit tests at all, cite the two counts and no total: the framework tests under
`src/framework/` are inherited unchanged and identical in every game, so they swamp a total and
make an untested game look tested. See `../../../docs/testing.md` § "Report the game count, never
the total" — including the fallback there for a game old enough that `package.json` has no
`test:game` script.

There are exactly four verdicts: `passed`, `fixed`, `open`, `NOT RUN`. "passed (limited)", "passed
with caveats" and "passed — environment limitation" are none of them; each is a `NOT RUN` or an
`open`. If you need a parenthetical to defend a `passed`, it is not one. Evidence for a pass —
check 5's input ledger, say — is not such a caveat: it is the reading the verdict rests on, not an
excuse for one.

A check you did not run is not a check you passed. Folding an unrun check into "all green" is the
worst outcome available here: it costs nothing, so it reads as efficiency, and it hides exactly the
class of defect this pass exists to catch.
