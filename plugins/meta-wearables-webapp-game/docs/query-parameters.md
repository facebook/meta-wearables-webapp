# URL query parameters

The complete set of URL query-string options a scaffolded Meta Display Glasses game understands. All are
**opt-in and read from `window.location.search`** — none change behavior unless present, so they're
safe to leave wired in a shipped build. Each has a pure, unit-tested parser in the framework (so
the flag semantics are consistent and testable), wired in `main.ts`.

| Parameter | Example | Effect | Parser | Details |
|-----------|---------|--------|--------|---------|
| `?lng=<code>` | `?lng=fr` | Force the UI locale (overrides detection) for testing a translation. | i18next language detector | [localization.md](localization.md) |
| `?stats` | `?stats` / `?stats=1` | Show the live FPS / CPU / draw-call / memory perf overlay. | `statsOverlayRequested` | [framework-api-debug.md § Performance overlay](framework-api-debug.md#performance-overlay-stats) |
| `?drive` | `?drive` / `?drive=1` | Don't start the game loop. Frames come from `window.__webappGame.step(n)` instead, so an external driver controls exactly how far the simulation has advanced. | `driveModeRequested` | [§ Drive mode](#drive-mode-drive) |
| `?slowload` | `?slowload` / `?slowload=1500` | Stagger asset preloading so the loading-screen progress bar steps visibly (ms per asset; default 800). | `loadDelayFromSearch` | [loading-screen.md § Previewing](loading-screen.md#previewing-the-loading-screen-slowload) |
| `?strict` | `?strict` / `?strict=1` | Make a runtime network load **throw** (instead of warn) via `sealAssetNetwork`. | `strictSealRequested` | [loading-screen.md § Enforcing](loading-screen.md#enforcing-preload-only-no-runtime-loads) |
| `?swreset` | `?swreset` / `?swreset=1` | Unregister every service worker and delete every cache, then reload without the flag. The only way to clear a bad precache on the glasses, which have no reachable DevTools. | `swResetRequested` | [offline-caching.md § `?swreset=1`](offline-caching.md#swreset1--the-escape-hatch) |
| `?mute` | `?mute` / `?mute=1` | Start the session with audio muted (handy for capturing/demoing on the glasses, where there's no volume control). | `muteRequested` | [audio.md § Mute & buses](audio.md#volume-buses-and-mute) |
| `?log=<level>` | `?log=debug` | Set the log level for this session (`error`/`warn`/`info`/`debug`/`trace`). Default without the flag is `warn`. | `logLevelFromSearch` | [logging.md § The logger](logging.md#the-logger) |
| `?logview` | `?logview` / `?logview=1` | Draw the last log lines on the 600x600 display — the on-glasses console. No backend needed. | `logOverlayRequested` | [logging.md § The on-glasses overlay](logging.md#the-on-glasses-overlay-logview) |
| `?logkey=<token>` | `?logkey=k3j9xz` | Send log records to the game's `/api/logs` backend, after an explicit consent gate. Requires the `add-webapp-game-logging` skill and a matching `LOG_TOKEN`. | `logKeyFromSearch` | [logging.md § Remote logging](logging.md#remote-logging) |

## Value conventions

- **Boolean flags** (`?stats`, `?strict`, `?mute`, `?logview`, `?drive`, `?swreset`) — **present with any value except
  `0` / `false` → on**; absent, `=0`, or `=false` → off. So `?stats`, `?stats=1`, `?stats=on` all
  enable; `?stats=0` disables.
- **`?log`** — a level name; bare (`?log`) means `debug`; `=0` / `=false` / `=off` / `=none` means
  `silent`; an unrecognized value falls back to `debug`, so a typo still turns logging on rather
  than silently doing nothing.
- **`?logkey`** — a secret string, so there is no default and no bare form; empty is treated as
  absent.
- **`?slowload`** — bare (`?slowload`) uses a default delay; `?slowload=<ms>` sets it; `?slowload=0`
  (or absent/invalid) is off.
- **`?lng`** — takes an i18next locale code (e.g. `fr`, `en`); with only English bundled it falls
  back to English until a `<code>.json` is added.

Combine them freely, e.g. `?slowload=1500&strict&stats` to preview the loading screen slowly with
strict network enforcement and the perf overlay on, or `?log=debug&logview` to watch verbose logs
on the glasses. `?drive&stats` is a combination with a caveat of its own — see
[§ `?drive&stats`](#drivestats--the-perf-overlay-on-a-stepped-loop).

> Putting a flagged URL on the glasses via a QR deep link requires percent-encoding the whole game
> URL into the deep link's `appUrl` parameter, or the flags are silently dropped. Use
> `scripts/debug-url.mjs` — see [logging.md](logging.md#getting-the-flagged-url-onto-the-glasses).

## Drive mode (`?drive`)

Normally the loop runs itself off `requestAnimationFrame`, so a game advances between any two
commands an external driver sends: a screenshot lands at whatever state the frame clock reached,
and a before/after pixel diff of a game that animates on its own proves nothing about the input
in between. Under `?drive` the loop never starts, and frames come only from the console:

```js
window.__webappGame.step()          // one frame of LOOP.stepSeconds
window.__webappGame.step(30)        // thirty frames
window.__webappGame.step(1, 0.5)    // one frame of an explicit half-second
window.__webappGame.status()        // {driven, running, frames, simSeconds, stepSeconds}
window.__webappGame.resume()        // hand control back to requestAnimationFrame
window.__webappGame.pause()         // take it back
```

Those are the console forms, for a human in DevTools. From outside the page the plugin's CDP
driver has the same operations — `cdp.mjs step --frames 30` advances thirty frames and reports how
many actually ran, and `cdp.mjs eval --expr "window.__webappGame.status()"` reads the rest.

`step(n)` returns how many frames it actually advanced, which is `0` while the loop is running
(a manual step and an rAF tick cannot be interleaved deterministically — `pause()` first).
Discrete input still works while paused: `pinchTap` and `dpadSwipe` reach their subscribers
synchronously, so pressing Enter hides the title screen with no frame in between, and a queued
D-pad intent is applied by the next `step()`. A **drag** is the exception — it must be
interleaved with stepping, which the plugin's `cdp.mjs drag --drive` does.

> **`?drive` makes a run reproducible in *timing*, not in general.** It fixes when frames happen
> and how long each one is. It seeds nothing: a game calling `Math.random()` still produces a
> different run every time.

The harness reports on the **loop** only. Game state is read through the separate dev-only
`window.__game` handle — see [project-structure.md](project-structure.md).

### `?drive&stats` — the perf overlay on a stepped loop

The two flags are independent booleans, so `?drive&stats` turns on both. The overlay keeps
updating while the loop is paused: `PerfOverlay.beginFrame()` / `endFrame()` are called from the
loop's `update` / `render`, and a `step()` runs those synchronously, so every stepped frame is
sampled.

- **It reports** `CPU` ms, `Draw`, `Tris`, `P/L` and the geometry/texture gauges — the per-frame
  cost of the frames you stepped, since a step runs `update()` + `render()` on the caller's stack.
- **It cannot report a frame rate.** `PerfSampler` derives `FPS` from the begin-to-begin interval
  between successive frames, and under stepping that interval is the gap between `step()` calls —
  a property of whatever drove the page, not of the display. Ignore the `FPS` row here.

That is the way to get per-frame CPU and draw-call numbers when `requestAnimationFrame` is
throttled and a free-running `?stats` reads zeros — on macOS, a Chrome window covered by another
window is the usual cause. The plugin's CDP driver has a recipe for it.

## Adding a new flag

Keep them consistent: add a pure `<flag>Requested(search)` / `<flag>FromSearch(search)` parser next
to the feature it controls (DOM-free, unit-tested — see `statsOverlayRequested` in
`framework/debug/PerfSampler.ts`, `loadDelayFromSearch` in `framework/render/assetFormats.ts`,
`strictSealRequested` in `framework/debug/NetworkGuard.ts`, `muteRequested` in
`framework/audio/AudioEngine.ts`, `logLevelFromSearch` in `framework/debug/Logger.ts`,
`driveModeRequested` in `framework/debug/DriveHarness.ts`, `swResetRequested` in
`framework/sw/register.ts`), wire it in `main.ts`, and add a row to
the table above.
