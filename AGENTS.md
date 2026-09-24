# Meta Wearables Web Apps

> Developer docs: https://wearables.developer.meta.com/docs/develop/webapps
> Web Apps docs MCP: https://mcp.developer.meta.com/wearables
> MCP tool: search_webapps_docs
> Auth: no auth, OAuth, tokens, or custom authorization headers are required.

If your AI tool supports MCP, configure `https://mcp.developer.meta.com/wearables` as a remote HTTP MCP server and call `search_webapps_docs` for current Web Apps documentation. If MCP is unavailable, use the developer docs URL above directly.

This file is the single-file edition of the `meta-wearables-webapp` plugin for tools without plugin
support. It follows the plugin's six skills. When you have the skill files locally, each skill's
`SKILL.md` is authoritative; this file tells you when to use each one and what it requires.

| Skill | Use it for |
|---|---|
| [`ai-glasses-webapp-build`](#build-ai-glasses-webapp-build) | Creating, redesigning, or extending an app: architecture, screens, routes, state, APIs, persistence, offline |
| [`ai-glasses-webapp-ui`](#ui-toolkit-ai-glasses-webapp-ui) | Scaffolding, installing UI Toolkit for Meta Ray-Ban Display, composing any glasses UI |
| [`ai-glasses-webapp-device`](#device-capabilities-ai-glasses-webapp-device) | Sensors, geolocation, pinch/drag, D-pad game controls, handwriting/voice text input |
| [`ai-glasses-webapp-test`](#test-gate-ai-glasses-webapp-test) | The deterministic quality gate run after every implementation |
| [`ai-glasses-webapp-optimize-performance`](#performance-ai-glasses-webapp-optimize-performance) | Startup measurement and optimization before release, or when the app is slow |
| [`ai-glasses-webapp-publish`](#publish-ai-glasses-webapp-publish) | Vercel production deployment and the add-to-glasses QR code, only on explicit request |

## Get the skill scripts

The skills ship Node.js helpers (Python 3 for the QR code). If they are not already on disk, check
out the toolkit **outside the app directory**. The app initializer refuses to scaffold into a
directory that already contains files.

```sh
git clone --depth 1 https://github.com/facebook/meta-wearables-webapp.git <toolkit-dir>
SKILLS=<toolkit-dir>/plugins/meta-wearables-webapp/skills
```

Every command below uses `$SKILLS/<skill>/scripts/...`. Each skill directory is self-contained, with
its own scripts, assets, and bundled validator. Run commands from anywhere and pass the app directory
explicitly.

## Workflow

1. **New app:** run the UI Toolkit initializer, then build the application
   ([Build](#build-ai-glasses-webapp-build), [UI Toolkit](#ui-toolkit-ai-glasses-webapp-ui)).
   **Existing app:** inspect and keep its working toolchain, and add the Toolkit with the idempotent
   installer if it is missing.
2. Add sensors or glasses-specific input only when needed
   ([Device capabilities](#device-capabilities-ai-glasses-webapp-device)).
3. Run the [test gate](#test-gate-ai-glasses-webapp-test) and fix every failure in application source.
4. For a complete new or substantially redesigned app, start the
   [local production preview](#local-preview-completion-contract) and give the user its URL.
5. Before release, or whenever the app is slow or its startup payload grows, run the
   [performance pass](#performance-ai-glasses-webapp-optimize-performance), then rerun the test gate.
6. [Publish](#publish-ai-glasses-webapp-publish) **only** when the user explicitly asks to make the
   app publicly accessible.

---

## Build (`ai-glasses-webapp-build`)

Create, redesign, or extend a web app for Meta Ray-Ban Display glasses. Use normal React knowledge
for APIs, storage, routing, and service workers, then apply the glasses-specific rules below. Use the
[UI Toolkit](#ui-toolkit-ai-glasses-webapp-ui) section for every new app and UI change unless the
user explicitly opts out of the Toolkit.

### Start or inspect

- **Empty destination:** run the Toolkit initializer before writing any application source. It
  creates the required React + Vite + TypeScript app and installs the public npm packages only when
  they are not already usable.
- **Existing app:** inspect and keep its working toolchain. If the Toolkit is missing, use the
  idempotent existing-app installer.
- Never introduce a machine-specific checkout, source alias, or `file:` dependency.

### Viewport and Toolkit authority

For a Toolkit application:

- Viewport `width=device-width, initial-scale=1.0`, plus `viewport-fit=cover` when appropriate.
- An app-specific `<meta name="description">` and a real `<title>`. The starter placeholders fail
  the test gate.
- `<meta name="mrbd-web-app-capable" content="yes">`.
- `html`, `body`, and `#root` take the full available width and height (`100%`).
- Derive layout from available space with shrinkable grid/flex tracks. Never hardcode device or
  viewport dimensions, or branch on them.
- Use `var(--uit-color-background-window)` for the whole window.

Before editing Toolkit UI, read the installed `wearables-ui-toolkit-web/SKILL.md` entrypoint, then
load only the production pattern or direct references it selects (see
[Read the Toolkit guidance once](#read-the-toolkit-guidance-once)). The public repository
<https://github.com/facebook/meta-ray-ban-display-ui-toolkit-web/> contains the documentation and
LLM skills. Its guidance is authoritative for component choice, route geometry, typography, and
verification. The npm acquisition and package-scope rules in [Install from npm](#install-from-npm)
take precedence over stale setup text. An explicit custom-UI opt-out keeps the custom scaffold's own
mount contract (see [Custom-UI opt-out](#custom-ui-opt-out)).

### Input and state

- There is no free cursor or touchscreen. Directional input moves focus, and Select or an EMG pinch
  activates the focused semantic control.
- Keep every command reachable and keep focus visible.
- After Escape/Back, a route return, or a modal dismissal, restore the originating control and the
  scroll position.
- Do **not** add an in-app Back button.
- Use stable geometry for the loading, empty, stale, offline, denied, error, active, and completion
  states that actually apply.
- Ordinary REST, WebSocket, storage, and offline code needs no separate skill. Render a useful shell
  first, abort stale work, close polling and sockets when hidden, and never bundle secrets.

### Composition boundaries

Follow the selected Toolkit pattern instead of imposing a host-specific screen blueprint. In
particular:

- Keep exactly one vertical scroll owner per route. Never put `ListItem` in `ScrollView`, and never
  nest `VerticalList` inside it.
- When the selected pattern uses a page-level `Panel width="100%"`, keep it directly inside
  `ScrollView`.
- When page commands exist, place them in a sibling bottom `ButtonRail` or `ButtonGroup` dock, with
  a shrinkable content track.
- Render rows without actions as ordinary text, not focus stops.

`TextStyle` members are exactly `NUMERAL1`, `NUMERAL2`, `DISPLAY1`, `HEADING1`, `HEADING2`, `BODY1`,
`BODY1_EMPHASIZED`, `BODY2`, `BODY2_EMPHASIZED`, `LABEL`, `LABEL_EMPHASIZED`, `META1`,
`META1_EMPHASIZED`, `META2`, `META2_EMPHASIZED`, and `META3`. Keep routine product copy at `BODY2` or
smaller. Use larger roles only when the selected Toolkit pattern calls for them.

### Performance targets

Measured under the [device profile](#the-device-envelope):

| Metric | Target |
|---|---|
| First paint | under 1 s |
| Usable content | under 5 s |
| Total first-load transfer | under 300 KB |
| Warm launch | under 2 s, with 0 transferred bytes |
| Initial requests | fewer than 15 |
| JavaScript heap | under 128 MB |
| Frame budget | 33 ms (the panel is 30 Hz; never add a 60 fps loop) |

- Run timers, animation frames, sensors, polling, and sockets only while needed. Stop them on pause,
  hide, route exit, and unmount.
- Use local assets and bundled icons. Do not download icon packs.

### Completion

Use [Device capabilities](#device-capabilities-ai-glasses-webapp-device) for sensors or
glasses-specific input. Run the [test gate](#test-gate-ai-glasses-webapp-test) after implementation
and fix every failure. Before a release, complete the
[performance pass](#performance-ai-glasses-webapp-optimize-performance) and rerun the gate. For
Toolkit apps, the gate runs the official structure validator and requires zero findings.

### Local preview completion contract

When the user asks for a complete app to be created or substantially redesigned, finishing the files
and tests is not enough. After the test gate passes, start a separate production preview from the app
directory in a persistent terminal session:

```sh
npm run preview -- --host 127.0.0.1 --port 4173
```

- The test gate's own preview is temporary and does not count.
- Keep the new preview running, wait for its ready message, and verify that the reported loopback URL
  responds.
- Prefer port 4173. If it is taken, use the fallback port the server prints.
- If a preview of an older build is running, stop it and start the newly validated build.
- The final response must include a clickable local URL such as `http://127.0.0.1:4173/`, say the app
  is ready for local review, and say the server keeps running until stopped. Do not claim the initial
  build is complete without that URL.
- If the environment cannot keep a local server running, say so and give the exact preview command
  instead.

This local preview is not publishing. Never run Vercel or [Publish](#publish-ai-glasses-webapp-publish)
unless the user later explicitly asks to make the app publicly accessible.

---

## UI Toolkit (`ai-glasses-webapp-ui`)

Install and use UI Toolkit for Meta Ray-Ban Display in React web apps. Use it whenever you create or
change glasses UI, choose Toolkit components, scaffold a new app, or migrate custom UI. The Toolkit
is required by default unless the user explicitly opts out. The public repository
<https://github.com/facebook/meta-ray-ban-display-ui-toolkit-web/> contains the current
documentation, examples, and `llm-skills` guidance.

### Read the Toolkit guidance once

Before writing Toolkit UI, check whether the `wearables-ui-toolkit-web` skill is already available to
your coding agent. Reuse it when present, and do not reinstall it for every app. If it is missing,
install it once at account scope with the wrapper for the supported clients:

```sh
node $SKILLS/ai-glasses-webapp-ui/scripts/install-ui-toolkit-skills.mjs \
  --client <claude-code|codex|muse-code> --account
```

The wrapper checks the client's standard skill location first (`~/.claude/skills`,
`~/.codex/skills`, or `~/.agents/skills`). Only when installation is needed does it make a temporary
shallow clone of the Toolkit repository, run the repository's `tools/install-skills.mjs`, and remove
the clone. Use `--project <dir>` instead of `--account` for a project-scoped install, and `--force` to
reinstall. If your tool is not one of these clients, read the `wearables-ui-toolkit-web` guidance
from the repository's `llm-skills` content directly.

Read `wearables-ui-toolkit-web/SKILL.md` first, then only the production pattern or direct
references it selects. The Toolkit guidance governs components and layout. The npm names and setup
rules in this file override stale acquisition or package-scope text in an older Toolkit skill
installation.

When a Toolkit verifier passes, continue with the host sequence: the
[test gate](#test-gate-ai-glasses-webapp-test), the performance pass before release, and the
[local preview](#local-preview-completion-contract). This is the one exception to Toolkit guidance
that says to stop after its focused verifier.

### Install from npm

The application dependencies are:

```sh
npm install @wearables-ui-toolkit/mrbd
npm install @wearables-ui-toolkit/icons
```

For an **empty destination**:

```sh
node $SKILLS/ai-glasses-webapp-ui/scripts/init-webapp.mjs <app-dir>
```

The initializer creates `index.html`, `vite.config.ts`, `tsconfig.json`, `vercel.json`,
`src/main.tsx`, `src/App.tsx`, `src/styles.css`, `package.json` (with `dev`, `typecheck`, `build`,
and `preview` scripts, plus the `playwright` and `sharp` dev dependencies the test gate needs), and
`wearables.config.json`. The Toolkit dependencies are installed during initialization. Next, replace
the placeholder title and description and write the application source. It refuses to scaffold over
existing application files. Only agent/VCS folders (`.agents`, `.claude`, `.codex`, `.cursor`,
`.git`) may already be present.

For an **existing React application**:

```sh
node $SKILLS/ai-glasses-webapp-ui/scripts/install-ui-toolkit.mjs <app-dir>
```

Both commands are idempotent:

- They first check the app's manifest and installed modules, and skip npm when both packages are
  already usable.
- Otherwise they check the global npm installation and try a one-time shared install:

  ```sh
  npm install --global @wearables-ui-toolkit/mrbd
  npm install --global @wearables-ui-toolkit/icons
  ```

- They record both registry packages in the app's own `dependencies` and lockfile (installing with
  `--save-exact`), and remove legacy `@meta/wearables-ui-*` dependencies.
- They write `wearables.config.json`. If the npm install fails, they restore the original
  `package.json` and lockfile.

Every app still records both packages in its own `package.json` and lockfile, and materializes a local
`node_modules`, because Node, Vite, CI, and Vercel do not resolve global packages as application
dependencies. npm's shared cache reuses downloaded content across apps. Never add a fixed checkout
path, `file:` dependency, source alias, or silent local-source fallback. Registry or repository access
failures are blocking setup errors.

### Imports

- Import components from `@wearables-ui-toolkit/mrbd` (or subpaths its `exports` map declares).
- Render the app inside the Toolkit `App` component. It loads the Toolkit stylesheet itself, so do not
  import `@wearables-ui-toolkit/mrbd/styles.css` manually.
- Import filled icon assets from the public `@wearables-ui-toolkit/icons` exports.
- Never use the legacy `@meta/wearables-ui-toolkit-*` scope, and never import package implementation
  source.

### Custom-UI opt-out

Pass `--no-ui-toolkit` to `init-webapp.mjs` **only** when the user explicitly opts out. The scaffold
then records `"ui": "custom-explicit-opt-out"` in `wearables.config.json`. Run `npm install` yourself
so a `package-lock.json` exists. Its mount contract is a fixed canvas: `#root` is exactly
`600px × 600px`, with no percentage or viewport-unit sizing, and `body` uses
`display: grid; place-items: center` to center it in larger windows. The test gate enforces this
contract instead of the responsive Toolkit contract.

### Validate

For an early structure-only check:

```sh
node $SKILLS/ai-glasses-webapp-ui/scripts/validate-ui-toolkit.mjs <app-dir>
```

The wrapper runs the Apache-2.0 licensed UI Toolkit structure validator bundled with the plugin
against `<app-dir>/src`, so validation does not depend on a machine-specific checkout or a mutable
network clone. Fix every finding. Before handoff, run the [test gate](#test-gate-ai-glasses-webapp-test),
which runs the same validation again.

---

## Device capabilities (`ai-glasses-webapp-device`)

Add sensors and input behavior specific to the glasses: motion, orientation, compass, step detection,
geolocation, neural-band activation and drag, D-pad game controls, and handwriting/voice text input.
Use standard browser APIs. This section covers only behavior that differs on the glasses. Use
[Build](#build-ai-glasses-webapp-build) for the screen and the UI Toolkit shell.

### Sensors and location

- Request motion, orientation, or location from an explicit Start or Enable action. Await
  `DeviceMotionEvent.requestPermission()` and `DeviceOrientationEvent.requestPermission()` where they
  exist.
- Use `devicemotion` for acceleration and rotation, `deviceorientation` /
  `deviceorientationabsolute` for heading and tilt, and `navigator.geolocation.watchPosition()` for
  position and speed.
- Treat nullable, denied, revoked, stale, inaccurate, and unsupported readings as ordinary states.
  Never present demo values as live data.
- Keep stable listener functions and watch IDs. Stop them exactly once on Pause/Stop, visibility loss,
  route exit, and unmount. A resumable session keeps accumulated metrics and elapsed time while
  releasing resources.
- Process raw motion only when required, and throttle React/UI commits to 10–30 Hz. Step counting
  should filter acceleration magnitude and reject implausibly rapid peaks. Label steps as estimated.
- Use the reported geolocation speed when it is accurate. Otherwise, derive distance and speed only
  from accurate, timestamped positions.
- Provide deterministic injection for tests and, when useful, a clearly labeled desktop Demo action
  that never requests device permission.

### D-pad, pinch, and continuous gestures

- Pinch and Enter already map to `onClick` on a focused Toolkit `Button`. Supply one `onClick` handler
  only.
- Do not add `onActivate` handlers that synthesize a second click, or time-based click debouncing.
  Both create stale or ignored state transitions. Pinch is not a positioned pointer event.
- **Continuous drag only:** put `touch-action: none` on `body` in the initial stylesheet. Use Pointer
  Events with pointer capture and client-coordinate deltas, and cancel on pointer cancellation, hide,
  route exit, and unmount. Do not set `touch-action: none` in apps without continuous drag.
- Pointer Lock is unsupported. The test gate fails on `requestPointerLock()`.

### Games

- Focus the canvas only after Play. While playing, arrow keys control the game and do not navigate
  the page.
- Escape pauses or exits, stops the loop, and restores focus to the Toolkit action that started the
  game.
- Keep score and status available as ordinary accessible text.
- Commit an accepted direction to the observable game state immediately. Deterministic or test modes
  may freeze board advancement, so a direction snapshot must not depend on a later animation tick.

### Text input

Standard text-like `<input>` and `<textarea>` controls open the glasses' handwriting/voice composer
after the wearer focuses and activates them. No proprietary SDK call is needed.

- Read committed text from `input` or `change`.
- Programmatic focus does not open the composer.
- Use clear labels, and keep essential flows usable when composition is unavailable.
- Do not build a custom keyboard.

Run the [test gate](#test-gate-ai-glasses-webapp-test) with every scenario that applies: granted,
denied, unsupported, active, paused, hidden page, cleanup, and deterministic demo.

---

## Test gate (`ai-glasses-webapp-test`)

The complete deterministic quality gate: package and UI Toolkit checks, typecheck, production build,
responsive viewport containment, local performance smoke checks, Playwright interaction,
accessibility, sensors, and screenshots.

```sh
node $SKILLS/ai-glasses-webapp-test/scripts/check-webapp.mjs <app-dir>
```

It prints a JSON summary (`passed`, `bundleGzipBytes`, `browser`, `warnings`, `failures`) and exits
nonzero on any failure. Options:

- `--artifacts-dir <dir>` changes the screenshot location from `<app-dir>/.wearables-test/`.
- `--static-only` stops after the build. It is diagnostic only and never counts as a full browser
  pass.

### What it checks

**Project and dependencies**

- `package.json`, `index.html`, and `src/` exist. `package.json` has `typecheck`, `build`, and
  `preview` scripts.
- `package-lock.json` is present.
- It skips installation when the locked dependency tree is already complete. Otherwise it runs
  `npm ci` against the lockfile and never rewrites package versions.
- There is no `server.js`, and `vite.config.ts` does not alias UI Toolkit to source.
- For Toolkit apps (`wearables.config.json` `"ui": "meta-ray-ban-display-ui-toolkit"`, the default
  when the file is missing): both `@wearables-ui-toolkit/*` packages are in `dependencies` with npm
  registry versions (no path, URL, workspace, or Git specifiers), and no legacy
  `@meta/wearables-ui-toolkit-*` dependencies remain.

**Metadata and source**

- Viewport has `width=device-width` and `initial-scale=1`, plus `mrbd-web-app-capable=yes`.
- The title and description are not the starter placeholders.
- Toolkit apps import public Toolkit components, render inside the Toolkit `App`, do not import the
  Toolkit stylesheet or implementation source, and give `html`, `body`, and `#root` 100% width and
  height with no hardcoded `600px`. Custom opt-out apps must follow the fixed-canvas contract instead.
- Cleanup evidence: `setInterval` needs `clearInterval` or a `visibilitychange` handler,
  `watchPosition` needs `clearWatch`, and `devicemotion`/`deviceorientation` listeners must be removed.
- No `requestPointerLock()`.
- Literal colors in Toolkit source produce a warning. Keep them to intrinsic canvas or media content.
- The bundled UI Toolkit structure validator must report zero findings.

**Build and browser QA** (runs against the production build served by `vite preview`)

- Typecheck and production build succeed.
- Gzipped JavaScript alone must be under the 300 KB first-load budget.
- At 600×600, the app root fills the viewport edge to edge (Toolkit) or is exactly 600×600 (custom),
  with no document overflow.
- There is at least one visible focus target. Every focus target has an accessible name and is not
  clipped.
- Arrow keys move focus, Enter activates a focused button exactly once, and focus stays set after
  Escape.
- Every `<img>` has `alt`.
- No console or page errors.
- Fast-host smoke ceilings: local load under 3000 ms, heap under 128 MB (after the interaction
  scenario too), fewer than 15 initial requests, and animation-frame sampling of at least 27 fps
  against the 30 Hz panel.
- A 1000×800 desktop window must stay full-viewport (Toolkit) or keep a centered 600×600 canvas
  (custom).
- Writes `normal.png` and `additive-composite.png`, a simulation of the additive display, to the
  artifacts directory.
- The browser gets sensor mocks: granted motion/orientation permission, a fixed geolocation, and
  `window.__WEARABLES_SENSOR_MOCK__.emitMotion()` / `.emitOrientation()` for deterministic events.

These fast-host checks catch regressions. They do not emulate the device link or CPU and cannot prove
startup performance. Before release, run the
[performance pass](#performance-ai-glasses-webapp-optimize-performance) against a production build
with a content oracle, cold and warm runs, n ≥ 10, interleaved A/B, and a null control.

### Rules

- Every failure blocks. Fix the application source, never the validator or the Toolkit package.
- Feature scenarios are still required:
  - Sensor apps: granted, denied, unsupported, demo, Pause/Stop, and cleanup.
  - Games: deterministic D-pad play, Escape focus restoration, game-over, and persisted scores.
  - Network apps: slow, empty, offline, aborted, error, stale, and recovery states.
- Browser QA needs the exact dev dependencies `playwright@1.55.0` and `sharp@0.35.4` in the app. The
  initializer adds them. Add them yourself for other apps.
- On restricted hosts, the gate tries sandboxed Chromium, then Firefox. If local browsers cannot
  launch, set `WEARABLES_CDP_ENDPOINT` to an approved Chromium DevTools endpoint.
  `WEARABLES_BROWSER_EXECUTABLE` selects a specific Chromium binary. Only after reviewing and trusting
  the application code may a developer explicitly set `WEARABLES_ALLOW_UNSANDBOXED_BROWSER=1` to allow
  the Chromium single-process no-sandbox fallback. The browser transport never relaxes assertions.

---

## Performance (`ai-glasses-webapp-optimize-performance`)

Measure and speed up startup using only the Chrome DevTools Protocol. No device is required. Use it
when the app is slow or sluggish, when the user asks about bundle size or a startup budget, to
compare two builds, and before shipping.

### Scope

- [Build](#build-ai-glasses-webapp-build) and [UI Toolkit](#ui-toolkit-ai-glasses-webapp-ui) rules
  (viewport, composition, focus) still apply. Finish with the
  [test gate](#test-gate-ai-glasses-webapp-test) after measuring the optimized build.
- The 600×600 viewport is a repeatable measurement profile, not an instruction to hardcode app
  dimensions. Keep Toolkit apps responsive.
- Optimize application source and assets, never installed Toolkit packages or the bundled validator.
  Use only public package exports. Component subpaths are fine when the installed Toolkit manifest
  declares them.
- Report Toolkit network or bundle cost separately. Do not hide it, and do not patch dependency code
  to remove it.
- The scripts have no dependencies and need **Node.js 22 or newer** and a local Chrome.

### The device envelope

| Constraint | Value | What it means |
|---|---|---|
| Link | ~500 Kbps down | **1 KB ≈ 16 ms** (62,500 B/s). A 300 KB payload is ~4.8 s of link time before anything runs |
| Latency | ~150 ms RTT | Every extra round trip costs about 150 ms |
| CPU | ~12× slower than a modern laptop core | Parse and hydrate dominate; a 1 MB bundle is not "fast to parse" |
| Viewport | 600×600, DPR 1 | Small images; no need for 2× assets |
| Panel | 30 Hz | The frame budget is **33 ms**, not 16 ms |

The most useful single number is **1 KB ≈ 16 ms**. Most startup wins come from sending fewer bytes,
and you can estimate them before writing code.

### Step 1: Serve the production build

Measure the optimized output that would ship, never a development/HMR server. From the app root:

```sh
npm run build
npm run preview -- --host 127.0.0.1 --port 5173 --strictPort
```

Leave the preview running in a separate terminal. The scripts reject common development-server
resources.

### Step 2: Start Chrome with the protocol open

Use a unique throwaway profile for every session, never a daily-use browser profile. Run the setup
and one launch command in the same Bash terminal:

```bash
PERF_PROFILE="$(mktemp -d "${TMPDIR:-/tmp}/ai-glasses-perf.XXXXXX")"
trap 'rm -rf -- "$PERF_PROFILE"' EXIT

# macOS
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$PERF_PROFILE"

# Linux
google-chrome --remote-debugging-address=127.0.0.1 --remote-debugging-port=9222 \
  --user-data-dir="$PERF_PROFILE"
```

On Windows PowerShell:

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

Close Chrome when finished so the profile is removed. If an app cannot mount without media permission,
add `--grant-media` to the tool commands. The tools never grant it by default and reset it after the
run.

### Step 3: Measure before changing anything

```sh
node $SKILLS/ai-glasses-webapp-optimize-performance/scripts/measure.mjs \
  --url http://127.0.0.1:5173 --reps 10 --clear-storage \
  --oracle "document.querySelector('[data-testid=primary-screen]')"
```

Replace the example selector with an oracle that matches only usable content in your app.
`--clear-storage` is required. It deletes all data for that origin, plus the HTTP cache, in the
temporary profile, so every repetition starts from the same declared state. The output is one line:
the median over N cold loads, plus the spread.

```
cold  n=10  FCP 420 ms   visible 262 ms (spread 12)   HTTP wire 872 B   reqs 2
```

- **FCP:** the first pixel of anything.
- **visible:** your app's real content on screen, according to the oracle.
- **HTTP wire** / **reqs:** completed HTTP(S) response bytes and the request count. A startup
  WebSocket invalidates the run because its traffic is not counted.

Measure warm launch as a **separate run** with `--warm`. It loads once to populate the cache and any
service worker, then measures the reload. Record both. Other flags: `--by-type` (bytes per resource
type), `--json`, `--port` (default 9222), and `--timeout` (ms). At least 10 reps are required for a
result. `--smoke --reps 2` only checks the plumbing. Never cite a smoke result as evidence.

### Four traps that make a measurement lie

1. **FCP is not "usable."** FCP fires for a background color. Define a **content oracle** that is
   true only when the user can actually use the app. `--oracle` is wrapped in `!!( ... )`, so it must
   be a **single expression**. Wrap statements in an IIFE, or the run reports `NEVER` and exits
   nonzero. Without a real oracle, a network error page scores well.

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

2. **A DOM-presence oracle can fire while a splash still covers the screen.** The oracle must also
   assert that any splash or overlay is gone. Measured on a real app, a shorter splash hold scored
   +20 ms (noise) with a DOM-only oracle and −609 ms with an overlay-aware one.

   ```js
   (() => {
     const t = document.body.innerText || '';
     const contentPresent = /Tuner/.test(t);
     const splash = document.querySelector('.splash');
     const covered = !!splash && getComputedStyle(splash).opacity !== '0';
     return contentPresent && !covered;
   })()
   ```

3. **Cold-only measurement hides the cache story.** The second launch is the common case for an app
   used daily. Measure both cold and `--warm`.

4. **One run is not a measurement.** Use **n ≥ 10**. Never compare A-then-B in sequence, because
   machine state drifts. In one session, a change that touched no served file scored −43 ms at
   p=0.002, and absolute numbers moved ~1,200 ms between sessions on the same build. **Interleave**
   instead, and always **run a null control** (a build against itself) in the same session. Anything
   smaller than the null-control delta is not a result, whatever the p-value says.

   ```sh
   # Interleaved A/B: arms are build directories (served for you) or production preview URLs
   node $SKILLS/ai-glasses-webapp-optimize-performance/scripts/ab.mjs \
     --a ./dist-before --b ./dist-after --reps 10 --clear-storage \
     --oracle "document.querySelector('[data-testid=primary-screen]')"

   # Null control: A against itself
   node $SKILLS/ai-glasses-webapp-optimize-performance/scripts/ab.mjs \
     --a ./dist-before --null --reps 10 --clear-storage \
     --oracle "document.querySelector('[data-testid=primary-screen]')"
   ```

### Optimization playbook

Work top-down. The first two items are usually worth more than everything below them combined. Full
detail is in `$SKILLS/ai-glasses-webapp-optimize-performance/references/playbook.md`. Read it before
making any of these changes.

| # | Change | Measured |
|---|---|---|
| 1 | **Paint from the HTML, not from your bundle.** Inline the first frame and critical CSS; make stylesheets non-blocking. Find the critical set with `critical-css.mjs` rather than guessing | first paint **11,208 → 440 ms** |
| 2 | **Stop shipping the same bytes twice.** Fonts inlined as base64 *and* served as files is the usual one | **−518 KB, −5,326 ms** |
| 3 | **Tree-shake app code and use declared component subpaths.** Toolkit manifests stay immutable; change `sideEffects` only in app-owned packages | **−72 KB, −1,754 ms** |
| 4 | **Downscale images to the smallest safe rendered size, then WebP at q75–80.** The audit preserves `object-fit` crop needs and treats ambiguous backgrounds as unmeasured | up to **−583 KB** on one asset in testing |
| 5 | **Declare the module graph** with `modulepreload` so it is not discovered a hop at a time | **−312 ms** |
| 6 | **Drop third-party font CDNs.** They cost bytes and a connection, and break offline | **−30 KB** net |
| 7 | **Ship WOFF2, three weights, subset to the characters you render** | **−23 KB** |
| 8 | **Count a splash hold from when the splash appeared**, not from when your framework mounted | **−609 ms** |
| 9 | **Respect the 30 Hz panel.** 33 ms frame budget; stop `requestAnimationFrame` loops on hidden screens | — |

Key details:

- **First paint from HTML.** Put the first frame (logo, app chrome, spinner) in `index.html` with
  inline critical CSS, load the stylesheets non-blocking, and remove the boot element in a layout
  effect when the app mounts.
- **Critical CSS.** Measure it instead of guessing. The first run is report-only:

  ```sh
  node $SKILLS/ai-glasses-webapp-optimize-performance/scripts/critical-css.mjs \
    --url http://127.0.0.1:5173 --clear-storage \
    --oracle "document.querySelector('[data-testid=primary-screen]')"
  ```

  For a same-origin stylesheet whose contents and license you own, rerun with a new `--out
  critical.css` path and the exact reported source (for example `--owned-style /app.css`), inline the
  candidate, load the rest non-blocking, and re-measure. The tool refuses to overwrite an existing
  output file, never extracts cross-origin or unselected sheets, and refuses rules with a relative
  `url(...)`. In a Toolkit app, sheets containing Toolkit markers stay report-only. Do not extract,
  rewrite, or separately load installed Toolkit CSS, because the Toolkit `App` owns that stylesheet
  and its load order.
- **Duplicate bytes.** Use `measure.mjs --by-type` to see bytes per resource type.
- **Fonts.** Serve faces from your own origin or use the system stack. Removing an external font can
  make the browser fetch local faces instead, so measure the net saving. If the installed Toolkit
  owns a documented font-registration fallback, report that traffic separately and do not override
  `App`, its stylesheet, or package code. Use `font-display: swap`. When subsetting, verify coverage
  of every rendered glyph, including symbols such as `¢` and `●`.
- **Toolkit imports.** Use only subpaths declared in the installed package's `exports` map. Keep
  runtime constants and enums on the package root when Toolkit guidance requires it, and never import
  from `dist` or source paths.
- **Images.**

  ```sh
  node $SKILLS/ai-glasses-webapp-optimize-performance/scripts/audit-images.mjs \
    --url http://127.0.0.1:5173 --clear-storage \
    --oracle "document.querySelector('[data-testid=primary-screen]')"
  ```

  It reports each image's bytes, intrinsic size, drawn box, and the potential saving. Resize first,
  then re-encode, using only targets the audit reports as safe: `cwebp -q 78 -resize <boxWidth> 0
  in.png -o out.webp`. Confirm `cwebp` is available first. If it is not, use an already approved
  image pipeline or report the missing tool, and do not install system software without the user's
  approval. Prefer no image at all (CSS gradient, Unicode glyph, inline SVG). Inline assets under
  ~2 KB as data URIs. Always set explicit `width`/`height`.
- **Requests.** More parallel requests do not add throughput on this link. Fetch what the first
  screen needs and defer the rest until after paint. Keep `<head>` free of render-blocking scripts
  and stylesheets apart from inline critical CSS, and remove `preconnect`/`dns-prefetch` hints for
  origins you no longer use.

### After you change something

1. Re-measure interleaved against the previous build, n ≥ 10.
2. Run the null control in the same session.
3. Accept the result only if it clears the null control by a comfortable margin.
4. Check HTTP wire bytes as well as time. Byte counts are deterministic, the most trustworthy number
   you have, and on this link most of the story.

### Checklist

- [ ] The production build, not a development server, is being measured
- [ ] Chrome is using a unique temporary profile that is removed after exit
- [ ] Storage clearing was explicitly authorized with `--clear-storage`
- [ ] A content oracle is defined that an error page would fail
- [ ] The oracle also requires any splash or overlay to be gone
- [ ] Baseline recorded: cold FCP, cold visible, warm visible, wire bytes, request count
- [ ] n ≥ 10 per arm, comparisons interleaved rather than sequential
- [ ] A null control (build vs itself) was run in the same session
- [ ] Total startup traffic is accounted for; no unmeasured WebSocket is present
- [ ] Critical CSS measured; only a safely separable app-owned candidate is inlined. Toolkit-containing
      or mixed stylesheets remain report-only
- [ ] Images use only safe audit targets; ambiguous crop/background cases were not guessed
- [ ] Images are WebP at quality 75–80 unless there is a reason not to
- [ ] No app-authored third-party font or icon CDN on the startup path; Toolkit requests are identified
      separately and left to its contract
- [ ] No 60 fps animation loop; loops stop when their screen is hidden

---

## Publish (`ai-glasses-webapp-publish`)

Publishing changes external state. Run it only after confirming that the user asked for it:

```sh
node $SKILLS/ai-glasses-webapp-publish/scripts/publish-to-vercel.mjs <app-dir>
```

The script:

1. Runs the complete [test gate](#test-gate-ai-glasses-webapp-test).
2. Verifies Vercel CLI authentication with `vercel whoami`.
3. Deploys straight to production with `vercel --prod --yes`.
4. Confirms the returned HTTPS URL is anonymously accessible.
5. Writes `qr-publish.png` in the app directory. It encodes the Meta AI deep link
   `fb-viewapp://web_app_deep_link?appName=<package name>&appUrl=<production URL>`.

It requires Node/npm, Python 3, and an authenticated Vercel CLI.

- Before running it, complete the [performance pass](#performance-ai-glasses-webapp-optimize-performance)
  against the production build candidate and keep the cold, warm, A/B, and null-control results. The
  deterministic publish gate does not replace the throttled device-profile measurement.
- Do not create `server.js`, preview or staging deployments, `stage-*` aliases, passcode screens,
  deployment-protection workarounds, or GitHub deployment plumbing.
- If production access is protected, report the exact Vercel setting. Do not weaken unrelated account
  or team security automatically.
- After success, show the production URL, the QR image, and the phone setup steps. Scanning the QR
  code with the phone opens the Meta AI app to add the web app to the glasses. Manual alternative: in
  the Meta AI app, go to **Devices** → **Display Glasses settings** → **App connections** →
  **Web apps** → **Add a web app**, then enter the app name and the production URL.
- Existing glasses installations keep using the same URL only when the deployment reuses the
  previously linked Vercel project and production domain.

---

## Never

- Scaffold into a non-empty directory, or clone this toolkit into the app directory.
- Add a fixed checkout path, `file:`/`link:`/Git/URL dependency, source alias, or local-source fallback
  for UI Toolkit, or use the legacy `@meta/wearables-ui-toolkit-*` scope.
- Import Toolkit implementation source, `dist` paths, or `@wearables-ui-toolkit/mrbd/styles.css`.
- Hardcode device or viewport dimensions in a Toolkit app, or branch on them.
- Add an in-app Back button, a custom keyboard, Pointer Lock, synthesized double clicks, or
  time-based click debouncing.
- Leave timers, animation frames, sensors, watches, polling, or sockets running when paused, hidden,
  or unmounted, or run a 60 fps loop.
- Present demo sensor values as live data.
- Bundle secrets, or download icon packs or third-party fonts at startup.
- Edit the validator or installed Toolkit packages to make a check pass.
- Cite a single run, a sequential A-then-B comparison, a `--smoke` result, or a development-server
  measurement as performance evidence.
- Publish, or run Vercel at all, without an explicit user request.
