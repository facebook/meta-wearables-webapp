---
name: ai-glasses-webapp-optimize-performance
description: >-
  Measure and speed up a Meta Ray-Ban Display webapp using Chrome DevTools
  Protocol only — no device required. Use when the user says the app is slow,
  takes too long to load or start, feels sluggish on glasses, when they ask how
  big the bundle is or how to make it smaller, when they want a startup budget
  or to compare two builds, or before shipping. Covers the throttling profile,
  how to build a measurement you can trust, finding critical CSS, and
  downscaling images.
argument-hint: "[production-url-or-build-directory]"
---

# Measure and optimize a Meta Ray-Ban Display web app

## Required reading and scope

Read `references/playbook.md` before changing application code. Use this skill
with `ai-glasses-webapp-build` and `ai-glasses-webapp-ui`; their viewport,
composition, focus, and UI Toolkit rules remain authoritative. Finish with
`ai-glasses-webapp-test` after measuring the optimized build.

The 600×600 viewport below is a repeatable measurement profile, not an
instruction to hardcode application dimensions. Keep Toolkit applications
responsive. Optimize application source and assets, never installed Toolkit
packages or the bundled validator. Use only public package exports; component
subpaths are allowed when the installed Toolkit manifest declares them. Report
Toolkit network or bundle cost separately; do not hide it, but do not
patch dependency code to remove it.

Everything runs against local Chrome over the Chrome DevTools Protocol. The
profile lets a laptop rank changes without glasses. The zero-dependency scripts
require Node.js 22 or newer.

## The device envelope

| Constraint | Value | What it means for you |
|---|---|---|
| Link | ~500 Kbps down | **1 KB ≈ 16 ms** (62,500 B/s). A 300 KB payload is ~4.8 s of link time before anything runs |
| Latency | ~150 ms RTT | Every extra round trip costs about 150 ms |
| CPU | ~12× slower than a modern laptop core | Parse and hydrate dominate; a 1 MB bundle is not "fast to parse" |
| Viewport | 600×600, DPR 1 | Small images; no need for 2× assets |
| Panel | 30 Hz | The frame budget is **33 ms**, not 16 ms |

The single most useful number is **1 KB ≈ 16 ms**. Most startup wins are byte-count wins, and
you can estimate them before you write any code.

## Step 1 — Serve the production build

Measure the same optimized output that would ship, never a development/HMR
server. From the app root, build once and leave the preview running in a
separate terminal (use the framework's equivalent production server if needed):

```bash
npm run build
npm run preview -- --host 127.0.0.1 --port 5173 --strictPort
```

The scripts reject common development-server resources rather than presenting
their module and HMR traffic as production evidence.

## Step 2 — Start Chrome with the protocol open

Create a unique browser profile for every session. The cleanup trap removes
only that generated directory after Chrome exits. Run the setup and one launch
command in the same Bash terminal:

```bash
PERF_PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/ai-glasses-perf.XXXXXX")"
trap 'rm -rf -- "$PERF_PROFILE"' EXIT

# macOS — choose this launch command
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$PERF_PROFILE"

# Linux — or choose this one
google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$PERF_PROFILE"
```

Close Chrome when finished so the trap cleans the profile. Never point these
tools at a daily-use browser profile. If an app cannot mount without media permission,
add `--grant-media`; the tools never grant those permissions by default and
reset them after the run.

On Windows PowerShell, use a unique directory and guaranteed cleanup too
(adjust the Chrome path if needed):

```powershell
$perfProfile = Join-Path ([IO.Path]::GetTempPath()) ("ai-glasses-perf-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $perfProfile | Out-Null
try {
  & "$env:ProgramFiles\Google\Chrome\Application\chrome.exe" `
    --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 `
    "--user-data-dir=$perfProfile"
} finally {
  Remove-Item -LiteralPath $perfProfile -Recurse -Force
}
```

## Step 3 — Measure before you change anything

```bash
node <this-skill>/scripts/measure.mjs --url http://127.0.0.1:5173 \
  --reps 10 --clear-storage \
  --oracle "document.querySelector('[data-testid=primary-screen]')"
```

Replace the example selector with one unique to usable content in the app.
`--clear-storage` deletes all data for that origin and the HTTP cache in the
temporary profile so every repetition starts from the same state.

It prints one line — the median over N cold loads, plus the spread:

```
cold  n=10  FCP 420 ms   visible 262 ms (spread 12)   HTTP wire 872 B   reqs 2
```

- **FCP** — first pixel of anything
- **visible** — your app's real content on screen (see the oracle below)
- **HTTP wire** / **reqs** — completed HTTP(S) response bytes and request count.
  A startup WebSocket makes the run invalid because its traffic is not counted

Warm launch is a **separate run**, add `--warm`: it clears the explicitly
authorized throwaway profile, loads once to populate the cache and any service
worker, then measures the reload. Record both. Every later claim is a
comparison against them. `--clear-storage` is required because a cold or warm
claim without a declared starting cache state is not reproducible.

The tools require at least 10 runs for a result. `--smoke --reps 2` is available
only to verify plumbing; never cite a smoke result as performance evidence.

## Four traps that make a measurement lie

Each trap below has produced a confident, wrong answer.

### 1. FCP is not "the app is usable"

FCP fires for a background colour. If you optimise FCP you will paint a blank box sooner and
call it a win. **Define a content oracle**: a predicate that is true only when the user can
actually use the app.

`--oracle` is interpolated into `!!( ... )`, so it must be a **single expression**. Anything
containing statements has to be an IIFE, or it is a syntax error and the run
reports `NEVER` and exits nonzero:

```js
// Bad: true for an empty shell, and for the browser's own error page
document.querySelector('#root').children.length > 0

// Good: names content only your app can produce
(() => {
  const t = document.body.innerText || '';
  return /Tuner/.test(t) && /E\s*A\s*D\s*G\s*B\s*E/.test(t)
    && document.querySelectorAll('button').length >= 3;
})()
```

Without one, a network error page scores well, because it has DOM and it paints fast.

### 2. A "content is in the DOM" oracle can fire while a splash still covers the screen

If you show a splash or loading overlay, the content underneath is in the DOM — and
`innerText` already contains it — **while the user still sees the splash**. An oracle that
only checks the DOM is blind to anything that changes how long the overlay stays up.

Measured on a real app: a change that shortened the splash hold scored **+20 ms (noise)** on a
DOM-presence oracle and **−609 ms** on an oracle that also required the overlay to be gone.
Same change, same build; one oracle simply could not see it.

So your oracle must also assert the overlay is gone:

```js
(() => {
  const t = document.body.innerText || '';
  const contentPresent = /Tuner/.test(t);
  const splash = document.querySelector('.splash');
  const covered = !!splash && getComputedStyle(splash).opacity !== '0';
  return contentPresent && !covered;
})()
```

### 3. Cold-only measurement hides the entire cache story

A cold load says nothing about the second launch, which is the common case for an app someone
uses daily. Measure both. `measure.mjs --warm` loads once to populate, then measures the
reload.

### 4. One run is not a measurement

The page timestamps the first frame the oracle passes with `performance.now()`.
Machine noise remains, and three runs cannot resolve a small effect.

- Use **n ≥ 10**.
- **Never compare A-then-B in sequence.** Machine state drifts. Measured on one batch, a change
  that could not possibly matter — it touched no served file — scored −43 ms at p=0.002.
  Absolute numbers moved ~1,200 ms between sessions on the same build.
- **Interleave** instead: `node <this-skill>/scripts/ab.mjs --a ./before --b ./after --reps 10 --clear-storage --oracle "document.querySelector('[data-testid=primary-screen]')"` alternates
  A,B,A,B… in one session and reports the paired difference.
- **Run a null control**: compare a build against *itself*. Whatever delta that produces is
  your noise floor. Anything smaller than it is not a result, whatever the p-value says.

## The optimization playbook

Ranked by what actually paid off, measured. Each line links to the detail, the code and the
numbers in `references/playbook.md` — read that before doing any of them.

| # | Change | Measured |
|---|--------|----------|
| 1 | **Paint from the HTML, not from your bundle.** Inline the first frame and critical CSS; make stylesheets non-blocking. Find the critical set with `critical-css.mjs` rather than guessing | first paint **11,208 → 440 ms** |
| 2 | **Stop shipping the same bytes twice.** Fonts inlined as base64 *and* served as files is the usual one | **−518 KB, −5,326 ms** |
| 3 | **Tree-shake app code and use declared component subpaths.** Toolkit manifests stay immutable; change `sideEffects` only in app-owned packages | **−72 KB, −1,754 ms** |
| 4 | **Downscale images to the smallest safe rendered size, then WebP at q75-80.** The audit preserves `object-fit` crop needs and treats ambiguous backgrounds as unmeasured | up to **−583 KB** on one asset in testing |
| 5 | **Declare the module graph** with `modulepreload` so it is not discovered a hop at a time | **−312 ms** |
| 6 | **Drop third-party font CDNs.** Costs bytes, a connection, and breaks offline | **−30 KB** net |
| 7 | **Ship WOFF2, three weights, subset to the characters you render** | **−23 KB** |
| 8 | **Count a splash hold from when the splash appeared**, not from when your framework mounted | **−609 ms** |
| 9 | **Respect the 30 Hz panel.** 33 ms frame budget; stop `requestAnimationFrame` loops on hidden screens | — |

`references/playbook.md` also covers the smaller wins — `font-display: swap`, keeping
`<head>` free of render-blocking work, removing stale `preconnect` hints, and why more
parallel requests do not add throughput on this link.

## After you change something

1. Re-measure interleaved against the previous build, n ≥ 10.
2. Run the null control in the same session.
3. Accept the result only if it clears the null control by a comfortable margin.
4. Check HTTP wire bytes as well as time. Byte counts are deterministic — they are the most trustworthy
   number you have, and on this link they are most of the story.

## Verify

- [ ] The production build, not a development server, is being measured
- [ ] Chrome is using a unique temporary profile that is removed after exit
- [ ] Storage clearing was explicitly authorized with `--clear-storage`
- [ ] A content oracle is defined that an error page would fail
- [ ] The oracle also requires any splash or overlay to be gone
- [ ] Baseline recorded: cold FCP, cold visible, warm visible, wire bytes, request count
- [ ] n ≥ 10 per arm, comparisons interleaved rather than sequential
- [ ] A null control (build vs itself) was run in the same session
- [ ] Total startup traffic is accounted for; no unmeasured WebSocket is present
- [ ] Critical CSS measured; only a safely separable app-owned candidate is
      inlined. Toolkit-containing or mixed stylesheets remain report-only
- [ ] Images use only safe audit targets; ambiguous crop/background cases were not guessed
- [ ] Images are WebP at quality 75-80 unless there is a reason not to
- [ ] No app-authored third-party font or icon CDN on the startup path;
      Toolkit requests are identified separately and left to its contract
- [ ] No 60 fps animation loop; loops stop when their screen is hidden

## Related skills

- `ai-glasses-webapp-build` — application architecture, data, and offline behavior
- `ai-glasses-webapp-ui` — responsive Toolkit composition and public imports
- `ai-glasses-webapp-test` — the final deterministic correctness and release gate
- `ai-glasses-webapp-publish` — production deployment after both gates pass
