# Logging — on desktop, on the glasses, and off the device

**There is no console on Meta Display Glasses.** The device cannot be tethered to your machine,
so there is no way to attach one. The loop is *develop on your laptop → publish to the public
internet → scan a QR or open the URL on the glasses*. So the moment a bug only reproduces on
hardware, `console.log` stops being a debugging tool.

This is what the framework provides instead, in increasing order of effort:

| Reach | How | Needs |
|-------|-----|-------|
| Desktop browser console | Always on | nothing |
| **On the glasses display** | `?logview` draws the last log lines on screen | nothing |
| **Off the device, on your laptop** | `?logkey=` POSTs records to your deployment; read them at `/logs` | the [`/add-webapp-game-logging`](#remote-logging) skill |

Try them in that order. The on-screen overlay needs no backend, no network, and no deploy — it
works offline and on a build that has never been published, and it answers a large share of "why
did it do that?" on its own.

## Quick start

```
?log=debug                        verbose logging (console, and the overlay if enabled)
?log=debug&logview                ...and draw it on the 600x600 display
?log=debug&logkey=<token>         ...and send it to your backend (asks for consent first)
```

Full flag semantics live in [`query-parameters.md`](query-parameters.md).

## The logger

Game code logs through a shared `Logger` instead of `console.*`. This is **enforced** — `npm run
validate` fails on a direct console call in game code (see [Enforced rule](#enforced-rule-no-raw-console-in-game-code)).

```ts
import { log } from '@/log';

log.info('level started', { level: 3, seed });
log.warn('save file was corrupt, starting fresh');
log.error('could not build renderer', toErrorData(error));

const audio = log.child('audio');   // tags records with a subsystem
audio.debug('unlocked context');
```

`src/log.ts` is **game code** — a thin module that constructs the logger from `?log=`, exactly like
`src/i18n/index.ts` bootstraps i18next. Edit it freely.

### Levels

`error` › `warn` › `info` › `debug` › `trace`, plus `silent` as a setting.

**The default is `warn`.** A published build stays quiet: real problems still reach the console,
nothing chatty does. `?log=<level>` raises it for one session.

### What a record looks like

```ts
{ seq: 41, time: 1765040000123, level: 'info', scope: 'audio', message: 'unlocked', data: { … } }
```

`seq` is a per-session monotonic counter, so a consumer can tell a quiet game from dropped records.

### Structured data, not string concatenation

Pass a `data` object rather than interpolating. It survives to the portal as JSON you can read and
filter, and it costs nothing when the level is off.

```ts
log.debug('spawned wave', { wave, enemies: enemies.length });   // good
log.debug(`spawned wave ${wave} with ${enemies.length}`);       // works, but harder to read later
```

## Performance: do not log in `update()`

`update()` runs 60 times a second. A log call there is a log *storm* — it will drown the buffer,
burn CPU on a mobile-class device, and (with remote logging on) spend battery on the radio.

Guard hot paths so the message is never even built:

```ts
if (log.isEnabled('debug')) {
  log.debug('tick', { entities: entities.length });
}
```

`isEnabled()` is a single integer compare. There is also a rate limiter (120 records/second by
default) that coalesces the overflow into one `"N log message(s) dropped"` warning — treat that
warning as a bug report about your logging, not as a safety net you can lean on.

Two more measurement notes:

- **Don't take performance measurements with remote logging on.** It is a deliberate runtime
  network request, which is exactly what the ["< 10 requests on load"](performance-guidelines.md)
  budget forbids during play. Use `?stats` on its own.
- The `?logview` overlay writes to the DOM at most ~7 times a second, but it is still DOM work
  inside the 600x600 stage. It is a debugging tool, not something to leave on while profiling.

## The on-glasses overlay (`?logview`)

Draws the last 10 records at the bottom of the display, colored by level (errors in red, so they're
findable at a glance). Pairs with `?stats`, which sits at the top-left.

Like every framework overlay it is display-only: it writes `textContent`, adds no event listeners,
and styles inline — so it obeys the ["no input through the DOM"](game-architecture.md) rule and
survives a `src/framework/` re-sync.

## Remote logging

Run [`/add-webapp-game-logging`](../skills/add-webapp-game-logging/SKILL.md) to add the backend. What it
builds:

```
  glasses                          your Vercel deployment                laptop
  ┌────────────────┐   POST /api/logs?k=<token>   ┌──────────────┐
  │ game           │ ───────────────────────────► │ api/logs.js  │
  │  RemoteLogSink │      (batched, 2s / 50)      │   + store    │
  └────────────────┘                              └──────┬───────┘
                                                         │ GET /api/logs?since=
                                                  ┌──────▼───────┐
                                                  │ /logs portal │ ◄── passcode
                                                  └──────────────┘
```

The endpoints are **Vercel serverless functions in `api/`**. They are the sanctioned exception to
"a game is a static build" — see [`project-structure.md`](project-structure.md). Do **not** add a
`server.js` or a `package.json` `start` script to serve them; that makes Vercel run the whole app
as a Node function and 404 every route.

### Consent

A session launched with `?logkey=` shows a **blocking consent gate before anything else** — before
preload, before the title screen. The player picks *Enable debug logging* or *Play without
logging* (D-pad to choose, pinch to confirm; focus starts on the safe option).

The guarantees, and why each exists:

- **Nothing transmits before acceptance.** `main.ts` attaches the sink only in the accept branch,
  so it is structurally incapable of sending early. Records made in the meantime sit in the
  logger's ring buffer: accepting backfills them (you still see the boot sequence), declining calls
  `log.clear()` so they're dropped.
- **Declining is real.** The game runs normally with local logging.
- **The choice is not persisted.** The gate appears every session that requests remote logging. A
  remembered opt-in is exactly the state in which someone forgets they're transmitting.
- **A `LOGGING` badge stays up all session**, so consent given at startup doesn't become invisible
  ten minutes in.

Customize the wording in `src/i18n/en.json` (`logConsent*` keys) — say plainly what is sent and
where. The framework keeps no strings of its own; `main.ts` injects them.

### Authentication

One secret, `LOG_TOKEN`, set as an environment variable and **never committed**. `install.mjs`
generates 16 random bytes (22 base64url characters) when you don't supply one; a token you choose
yourself needs comparable entropy, because it sits on a public URL and gates both directions:

- **Ingest** — the game carries it as `?logkey=`, forwarded to the endpoint as `?k=`. (A query
  parameter, not a header, because `navigator.sendBeacon` — the transport for the final flush
  during a crash — cannot set headers. It is no more exposed there than in the page URL that
  enabled logging.)
- **Portal** — you type it once at `/logs`; the server sets an HttpOnly cookie holding a *hash* of
  the token, so a leaked cookie doesn't hand over the ingest key.

**With `LOG_TOKEN` unset, every endpoint 404s.** A game published without deliberately turning
logging on has no ingest endpoint to abuse and no portal to find. Rotate by changing the variable
and redeploying.

Both gates are throttled the same way, because both hold the same secret and the weaker one sets
the price of guessing it: a rejected `?k=` and a rejected passcode each cost a fixed delay, and
each counts against a per-IP, ten-in-ten-minutes budget. The budgets are separate per endpoint, and
a request carrying the right token is never throttled — the game posts every couple of seconds from
one address and must not be able to lock itself out. Exceeding the ingest budget returns `429`,
which `RemoteLogSink` retries with backoff, rather than the `401` that makes it disable itself.

The counters live in the instance's memory, so a cold start or a request routed elsewhere starts
from zero: the lockout makes guessing tedious, it is not a rate limiter, and the fixed delay on each
rejection is the only part that holds regardless of instance or IP. What actually keeps the door
shut is the entropy of `LOG_TOKEN`.

"Per-IP" is only meaningful if the caller can't choose its own IP, so the address comes from the
socket, not from `x-forwarded-for` — that header is caller-supplied unless a proxy overwrote it, and
one that is believed lets an attacker rotate it and never reach a lockout at all. On Vercel the
header *is* trustworthy (the edge sets it, and the socket address is an internal hop identical for
every request), so it is used automatically there. **A self-hosted Node deployment behind nginx or
another reverse proxy must set `LOG_TRUST_PROXY=1`**, or every visitor is counted as the proxy and
one guesser locks everyone out. Leave it unset when the process is reachable directly.

Where the variable comes from differs by environment. On the deployment you set it with
`vercel env add LOG_TOKEN production`, and it only takes effect on the **next deploy**. Locally it
lives in the project's gitignored `.env`, which the dev-server plugin (`scripts/vite-log-api.mjs`)
loads into `process.env` — Vite's own `.env` handling would not, since it only exposes
`VITE_`-prefixed variables and only to client code. A variable exported into the shell overrides
the file, so `LOG_TOKEN= npm run dev` is how you check the fail-closed behavior locally.

The token is redacted from logs automatically (`log.addSecret()` in `main.ts`), including out of
the `location.href` recorded in the session header — otherwise the first record of every session
would leak the key authorizing it.

### Storage

Serverless functions are stateless and have no shared disk, so the records have to live somewhere
between the glasses POSTing them and you opening the portal. `api/_store.js` picks a backend:

| Backend | When | Durable? |
|---------|------|----------|
| **Upstash Redis** | `KV_REST_API_URL` + `KV_REST_API_TOKEN` set | Yes — survives cold starts, shared across instances |
| **File (JSONL)** | A persistent filesystem exists — `npm run dev`, self-hosted Node | Yes, per host; also readable with `cat .logs/game-logs.jsonl` |
| **Memory ring** | Fallback — **the default on Vercel** | **No** |

The memory ring is zero-setup and fine for "I'm watching the portal while I test". It is *not* fine
for "let me play for ten minutes and read it later": a cold start or a second serverless instance
has its own empty buffer, and records go missing. The portal shows a banner in that mode so a gap
is explained rather than mysterious. To upgrade, add an Upstash Redis integration from the Vercel
Marketplace and redeploy — no code change.

> There is no SSH on Vercel, so "write to a file and log in to read it" only applies to the local
> dev server or a self-hosted Node deployment.

### The portal

`/logs`, on the deployment and on `npm run dev` alike — it is `public/logs.html`, routed by a
`vercel.json` rewrite in production and by the dev-server plugin locally. Live tail, level filter,
session picker, pause, and JSONL download.

Locally you don't have to assemble either URL by hand: with a token configured, `npm run dev`
prints the logging-enabled game URL and the portal URL under Vite's own.

```
  ➜  Logging: http://localhost:5173/?log=debug&logkey=k3j9xz
  ➜  Portal:  http://localhost:5173/logs
```

It renders every value with `textContent` and ships a restrictive CSP. Log text arrives from a
device over the public internet, so a viewer that interpolated it into markup would be a
straightforward XSS hole. If you edit `public/logs.js`, keep that property.

### Getting the flagged URL onto the glasses

`scripts/debug-url.mjs` prints both the plain URL and the deep link. **Use it — do not hand-build
the deep link.** The webapp is registered via:

```
fb-viewapp://web_app_deep_link?appName=<name>&appUrl=<url>
```

`appUrl` is a value *inside another query string*, so the game URL's own `?` and `&` must be
percent-encoded. Get it wrong and the parser reads `&logkey=…` as its own parameter, drops it, and
registers the plain URL — nothing errors, you just never get logs:

```
✗ …&appUrl=https%3A%2F%2Fgame.example/?log=debug&logkey=k3j9
✓ …&appUrl=https%3A%2F%2Fgame.example%2F%3Flog%3Ddebug%26logkey%3Dk3j9
```

By default it registers a separate `<name> (debug)` entry, so the launcher shows the normal game
and the debug build side by side and you never re-register to toggle logging. Hand the deep link to
the `/qr-code` skill to make a scannable PNG. That generator tops out around 271 characters, which
a generated 22-character token comfortably fits inside — a typical debug deep link is about 185. If
one ever doesn't fit, shorten the app name rather than the token.

## Interaction with the network guard

`sealAssetNetwork()` flags any runtime network request as a probable stray asset load. Remote
logging is a deliberate one, so allow it explicitly — otherwise every batch warns, or throws under
`?strict`:

```ts
import { isLogEndpoint } from '@/framework/debug/RemoteLogSink';

sealAssetNetwork({
  strict: strictSealRequested(search),
  allow: isLogEndpoint,
});
```

(The scaffold only calls `sealAssetNetwork` once you opt into the manifest preloader — see
[`loading-screen.md`](loading-screen.md).)

## Enforced rule: no raw `console.*` in game code

`npm run validate` fails on any `console.<method>(` outside `src/framework/`, tests, and the
validator's own tooling. A raw console call is invisible on the device and bypasses everything the
logger provides: the level filter, the ring buffer the overlay and remote sink read from, secret
redaction, and the rate limit.

`src/framework/` is exempt — it *implements* the logger and its console sink, and its low-level
guards (e.g. `NetworkGuard`) must be able to warn without depending on game wiring.

## Privacy

The transport is only as careful as what you feed it. The consent gate covers *that* logging is
happening; it cannot cover *what* you chose to log.

- **Never log user content**: typed text, voice transcripts, camera frames, location. If a value
  came from a person rather than from your game state, don't put it in a log record.
- Log identifiers and shapes, not payloads — `{ items: 12 }`, not the items.
- Remote logging is for **your own** development device. Don't ship a build with a live `?logkey`
  URL to playtesters without telling them what it collects, and rotate `LOG_TOKEN` afterwards.
- The logs land on infrastructure you control and are readable by anyone with the passcode. Treat
  that passcode like any other credential.

## API reference

Signatures live in [`framework-api-debug.md` § Logging](framework-api-debug.md#logging-log-logview-logkey).
