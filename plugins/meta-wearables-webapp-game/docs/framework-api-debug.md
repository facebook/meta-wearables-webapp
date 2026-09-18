# Framework API — the debug surface (`?drive`, `?stats`, `?log`)

The opt-in developer surfaces. Each is off and zero-cost unless its URL flag is present, so all
of them are safe to leave in a shipped build. Part of the
[framework API reference](framework-api.md); the flags themselves are catalogued in
[`query-parameters.md`](query-parameters.md).

## `DriveHarness` (`?drive`)

`framework/debug/DriveHarness.ts`. Pauses the game loop and exposes it on `window.__webappGame`
so an external driver advances it one explicit frame at a time. Off (and zero-cost) without the
flag.

```ts
driveModeRequested(search: string): boolean

installDriveHarness(
  loop: DrivableLoop,
  options?: { target?: Record<string, unknown>; globalName?: string },
): DriveHarness
```

`DrivableLoop` is the structural subset of `GameLoop` the harness uses (`step`, `start`, `stop`,
`isRunning`, `getStepSeconds`), so tests can pass a fake. `target` defaults to `globalThis` and
`globalName` to `__webappGame`.

| `DriveHarness` member | Semantics |
|-----------------------|-----------|
| `step(frames?, dtSeconds?): number` | Advance `frames` (default 1) frames of `dtSeconds` (default the loop's `stepSeconds`). Returns how many actually advanced — `0` while the loop is running. |
| `resume()` / `pause()` | Hand control to `requestAnimationFrame`, or take it back. |
| `isRunning(): boolean` | Whether the rAF loop is scheduled. |
| `status(): DriveStatus` | `{driven, running, frames, simSeconds, stepSeconds}` — cumulative frames and simulated seconds since install. |

`installDriveHarness` does **not** stop a running loop: a game that already ran has advanced by an
unknown amount, and hiding that would defeat the purpose. `main.ts` installs it *instead of*
calling `start()`.

It reports on the loop only — game state is the separate dev-only `window.__game` handle. See
[query-parameters.md § Drive mode](query-parameters.md#drive-mode-drive) for the console recipes
and the limits (it fixes timing, not randomness).

## Performance overlay (`?stats`)

`framework/debug/`. An opt-in, display-only perf HUD for reading live frame numbers on the
glasses, **where there is no logcat or console**. Load the game with `?stats` in the URL and a
small panel appears in the top-left; it's off (and zero-cost) otherwise, so it's safe to leave
in a shipped build.

Each row shows the **current frame** value and its **1-second average**, to read against the
budgets in [performance-guidelines.md § Targets](performance-guidelines.md#targets):

| Row | Reads | How to interpret |
|-----|-------|------------------|
| `FPS` | frames/sec + last frame interval (ms) | The headline number. Should sit at **30**; a lower average means missed frames. Measured from the real (unclamped) interval, so a stutter shows even though the loop clamps `dt`. |
| `CPU` | ms in `update()` + `render()` | Compute headroom against the **~33.3ms** budget (1000/30). Approaching 33.3ms = no slack. |
| `Draw` | draw calls | Fewer is better — merge geometry / share materials to cut them. |
| `Tris` | triangles rendered | Keep low on the mobile-grade GPU; watch it climb as the scene fills. |
| `P/L` | points / lines rendered | Line-art games live here; triangles stay near zero. |
| `Mem` | live geometry + texture counts | **Gauges**, not per-frame — a steady climb means a leak (dispose removed instances; see [asset-loading.md § Disposal](asset-loading.md#disposal)). |

It's split into a pure, node-testable sampler and a thin DOM wrapper (the same
logic-vs-untestable-surface split as `ThreeRenderer`):

### `statsOverlayRequested`

```ts
statsOverlayRequested(search: string): boolean
```

`framework/debug/PerfSampler.ts`. Whether the overlay was requested. Pass
`window.location.search`. Present with any value except `0`/`false` → `true` (`?stats`,
`?stats=1` → on; `?stats=0`, `?stats=false`, absent → off). DOM-free, so it's unit-testable. `?stats`
is one of the game's URL flags — see [query-parameters.md](query-parameters.md) for the full set.

### `PerfSampler`

`framework/debug/PerfSampler.ts`. The pure timing/averaging engine — no DOM, injectable clock.

```ts
new PerfSampler(options?: { now?: () => number });   // now defaults to performance.now
```

| Member | Semantics |
|--------|-----------|
| `beginFrame()` | Stamp the frame start. The gap between successive `beginFrame()` calls is the real (unclamped) frame interval — the FPS source. Call before `update()`. |
| `endFrame(stats?: RenderStats)` | Record CPU cost (`now − beginFrame`) and the renderer's GPU stats, then evict samples older than the 1-second window. Call after `render()`. |
| `getReport()` | Return a `PerfReport`: each metric's current value plus its 1-second average. |

`PerfReport` fields: `fps` / `fpsAvg`, `frameMs`, `cpuMs` / `cpuMsAvg`, `drawCalls` /
`drawCallsAvg`, `triangles` / `trianglesAvg`, `points` / `pointsAvg`, `lines` / `linesAvg`,
`geometries`, `textures` (gauges, not averaged), and `hasRenderStats` (false → the renderer
supplied no `getStats`, so GPU rows read as unavailable).

### `PerfOverlay`

`framework/debug/PerfOverlay.ts`. The DOM wrapper: owns a `PerfSampler` and one inline-styled
`<div>`. **Display-only** — it writes `style`/`textContent` and adds **no** event listeners, so
it satisfies the [no-input-through-DOM rule](game-architecture.md#input-must-not-flow-through-the-dom-enforced)
(a sanctioned DOM writer, like the HUD). It styles itself inline (not via `style.css`) so the
`update-webapp-game-framework` re-sync (which copies only `src/framework/`) carries it whole.

```ts
new PerfOverlay(
  renderer: Pick<Renderer, 'getStats'>,
  options?: { mount?: HTMLElement; now?: () => number },   // mount defaults to document.body
);
```

| Member | Semantics |
|--------|-----------|
| `beginFrame()` | Delegate to the sampler; call before `update()`. |
| `endFrame()` | Read `renderer.getStats?.()`, feed the sampler, and refresh the panel text (throttled to ~5×/sec; sampling stays per-frame). Call after `render()`. |
| `dispose()` | Remove the element from the DOM. |

## Logging (`?log`, `?logview`, `?logkey`)

`framework/debug/`. Leveled logging that replaces `console.*` in game code (enforced by `npm run
validate`). The full guide — including remote logging, the consent gate, and the privacy rules —
is [logging.md](logging.md); this section is the callable surface.

### `logLevelFromSearch`

```ts
type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
logLevelFromSearch(search: string): LogLevel | null
```

`framework/debug/Logger.ts`. Parse `?log=`. Returns `null` when the flag is absent, so a caller can
distinguish "not requested" from "explicitly silenced" and fall back to `DEFAULT_LOG_LEVEL`
(`'warn'`). Bare `?log` → `'debug'`; `=0`/`=false`/`=off`/`=none` → `'silent'`; an unrecognized
value → `'debug'`. DOM-free, so it's unit-testable.

### `Logger`

`framework/debug/Logger.ts`. Pure and DOM-free — the same logic-vs-DOM split as
`PerfSampler`/`PerfOverlay`. The scaffold constructs one in `src/log.ts`; game code imports that.

```ts
new Logger(options?: {
  level?: LogLevel;          // default 'warn'
  capacity?: number;         // ring-buffer size, default 200
  maxPerSecond?: number;     // rate limit, default 120
  now?: () => number;        // epoch-ms clock, default Date.now
  sessionId?: string;        // default: random
});
```

| Member | Semantics |
|--------|-----------|
| `error/warn/info/debug/trace(message, data?)` | Emit a record if the level passes the filter. |
| `isEnabled(level)` | Whether that level would be kept. A single integer compare — guard hot paths with it. |
| `child(scope)` | A `ScopedLogger` tagging records with `scope` (nests: `child('a').child('b')` → `'a.b'`). Shares the root's level, buffer, and sinks, so there is one ordered stream. |
| `getLevel()` / `setLevel(level)` | Read/raise the filter at runtime. |
| `addSink(sink)` / `removeSink(sink)` | Attach a destination. |
| `addSecret(value)` | Register a value to redact from messages and top-level string `data` fields (values under 3 characters are ignored). `main.ts` registers the `?logkey` token. |
| `redact(text)` | Apply the registered redactions to a string. |
| `getRecent(count?)` | The buffered records, oldest first — the overlay and the post-consent backfill read this. |
| `clear()` | Drop the buffer (the declined-consent path). |
| `flush()` / `dispose()` | Reach the sinks' optional `flush`/`dispose` hooks. |

A `LogRecord` is `{ seq, time, level, scope, message, data? }`. Over the rate limit, records are
dropped and the next window opens with one synthetic `warn`: `"N log message(s) dropped (over
120/s)"`.

Also exported: `consoleSink(target?)` (mirrors records to the browser console; `trace` maps to
`console.debug`), `captureGlobalErrors(logger, target?)` (routes `error` + `unhandledrejection` to
the logger at `error` level, returns a teardown, no-ops without a DOM), and `toErrorData(error)`
(flattens an unknown thrown value into `{ errorName, errorMessage, stack }`).

### `LogOverlay` / `logOverlayRequested`

```ts
logOverlayRequested(search: string): boolean
new LogOverlay(options?: { mount?: HTMLElement; maxLines?: number; now?: () => number });
```

`framework/debug/LogOverlay.ts`. A `LogSink` that draws the last `maxLines` (default 10) records on
the display, colored by level. Display-only — `textContent`, no listeners, inline styles — so it
satisfies the [no-input-through-DOM rule](game-architecture.md#input-must-not-flow-through-the-dom-enforced)
and survives a framework re-sync. `dispose()` removes it. Renders at most ~7×/sec with a trailing
render, so the last line of a burst is never left off-screen.

### `RemoteLogSink`

`framework/debug/RemoteLogSink.ts`. Batches records to `/api/logs`. **Inert unless constructed**,
and `main.ts` constructs it only after the consent gate is accepted.

```ts
logKeyFromSearch(search: string): string | null    // the ?logkey token, null when absent/blank
isLogEndpoint(url: string): boolean                // pass as sealAssetNetwork's `allow`
httpTransport(token: string, endpoint?: string): LogTransport

new RemoteLogSink(options: {
  sessionId: string;
  transport: LogTransport;
  intervalMs?: number;      // batch interval, default 2000
  maxQueued?: number;       // default 500, drops oldest on overflow
  maxPerBatch?: number;     // default 50
  now?: () => number;
  scheduler?: Scheduler;    // setTimeout-shaped, injectable for tests
  redact?: (text: string) => string;
  onDisabled?: (reason: string) => void;
});
```

| Member | Semantics |
|--------|-----------|
| `write(record)` | Queue it. `error` sends immediately; a full batch sends immediately; otherwise the interval timer sends. |
| `backfill(records)` | Queue the pre-consent backlog and send. |
| `flush()` | Send now. |
| `flushFinal()` | Synchronous `sendBeacon` handoff for page teardown, where a `fetch` would be cancelled. Wire to `pagehide`. |
| `dispose()` | Stop the timer, `flushFinal()`, and disable. |
| `isDisabled()` | True after a fatal response or `dispose()`. |

A 401/403/404 disables the sink permanently and calls `onDisabled` — a deployment that will never
accept the batch isn't worth retrying against on battery. Other failures retry with exponential
backoff (`nextBackoffMs`, 2s doubling to a 60s cap). Pure helpers `LogBatchQueue`,
`classifyResponse`, and `nextBackoffMs` are exported and unit-tested.

### `ConsentGate` / `TransmissionBadge`

`framework/ui/ConsentGate.ts`. The blocking accept/decline screen shown before anything is
transmitted, and the badge that stays up while it is.

```ts
new ConsentGate(options: {
  mount?: HTMLElement;
  strings: { title, body, accept, decline, hint };   // injected, so the framework stays string-free
  input: InputManager;
  onDecision: (accepted: boolean) => void;           // called once; the gate removes itself first
});

new TransmissionBadge(label: string, mount?: HTMLElement);   // .dispose() to remove
```

Input comes through the `InputManager` (D-pad moves focus, pinch activates) rather than DOM
listeners, so it obeys the input rule and matches the platform model. Focus starts on **decline** —
an accidental pinch must not opt someone into transmission. `dispose()` detaches the subscriptions.
