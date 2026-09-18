---
name: add-webapp-game-logging
description: >-
  Add a remote log sink and a passcode-gated web log portal to a
  webapp game, so logs from the game running on Meta Display
  Glasses can be read on a laptop. The glasses have no console and cannot be
  tethered to attach one, so the game POSTs batched log records to serverless
  endpoints served by its own deployment, and the developer reads them at
  /logs. Use when the user wants to see logs from the device, debug a
  glasses-only bug, add a log viewer or log server, or asks why they cannot
  read console output on the glasses.
argument-hint: "[project-dir]"
allowed-tools: Bash, Read, Write, Edit, AskUserQuestion
---

# Add remote logging to a webapp game

Wire up the **backend half** of the logging subsystem: serverless log-ingest endpoints, a
passcode-gated portal page, and a helper that builds the debug URL / QR deep link.

The **client half already ships in every scaffolded game** — the `Logger`, the `?logview`
on-screen overlay, the `RemoteLogSink`, and the consent gate are all in `src/framework/`, and
`main.ts` is already wired for them. This skill only adds what a backend needs. Read
`${CLAUDE_PLUGIN_ROOT}/docs/logging.md` before starting.

## When NOT to run this

Say so and stop if the user's problem is solved more cheaply:

- **They just want to see logs on the device** → no backend needed. Tell them to open the game
  with `?log=debug&logview`. That draws the last log lines straight onto the 600x600 display, works
  offline, and needs no backend or deploy.
- **They are debugging on a desktop browser** → the console sink is already active; `?log=debug` is
  the whole answer.

Remote logging is for the case where the bug only reproduces **on the glasses** and the log is too
long, too fast, or too awkward to read on the display itself.

## What gets added

All outside `src/framework/` — that directory is managed and re-synced wholesale by
`update-webapp-game-framework`, so anything written there would be destroyed on the next
framework update.

```
<project>/
  api/
    _http.js          shared auth / body / cookie helpers (fail-closed)
    _store.js         pluggable log store (Upstash Redis | file | memory)
    logs.js           POST ingest (token) + GET tail (cookie)
    log-auth.js       portal sign-in -> HttpOnly cookie
  public/
    logs.html         the portal page
    logs.js           the portal client (textContent-only rendering)
  scripts/
    debug-url.mjs       prints the debug URL + the fb-viewapp:// deep link
    lib/deep-link.mjs   the URL/deep-link builders (the double-encoding rule)
    vite-log-api.mjs    serves the api/ handlers and /logs during `npm run dev`, and prints
                        the logging-enabled game URL + the portal URL alongside Vite's own
    vite-log-api.d.mts  its type declarations — tsconfig type-checks vite.config.ts
  vercel.json         updated: /logs route + /api/* excluded from the SPA catch-all
  vite.config.ts      updated: registers the dev-server plugin
  .gitignore / .env   updated: .env + .logs/ ignored; LOG_TOKEN written to .env
```

Source templates: `${CLAUDE_PLUGIN_ROOT}/skills/add-webapp-game-logging/templates/`.

## Workflow

### Step 1: Resolve and check the project

```bash
PROJECT="${1:-$(pwd)}"
test -f "$PROJECT/package.json" && test -d "$PROJECT/src/framework" \
  && echo "OK: $PROJECT" || echo "NOT a meta-wearables-webapp game"
```

Confirm the framework is new enough to have the client half:

```bash
test -f "$PROJECT/src/framework/debug/RemoteLogSink.ts" \
  && echo "client half present" \
  || echo "MISSING — run /update-webapp-game-framework first"
```

If it's missing, **stop** and tell the user to run `/update-webapp-game-framework`, then
re-run this skill. Do not hand-write the framework files.

### Step 2: Choose a token with the user

The token is the single secret. It gates ingest (in the game's URL) **and** portal access, and
without it set, every endpoint 404s.

Use `AskUserQuestion` to offer:

- **Generate one** (recommended) — `node -e "console.log(require('crypto').randomBytes(16).toString('base64url'))"`
  gives 22 URL-safe characters (128 bits). Step 3 does this for you if you omit `--token`.
- **They supply one.** Hold it to the same bar: this secret sits on a public URL and gates both
  ingest and log reading, so a short or guessable one is the whole security of the feature. A word,
  a date, or anything under ~16 random characters is not enough.

A 22-character token costs 22 characters in the QR deep link (base64url needs no percent-encoding),
which leaves plenty of room under the QR generator's ~271-char capacity — a typical debug deep link
lands around 185 characters. If a QR ever refuses to encode, shorten the **app name**, not the token.

**Never write the token into a tracked file.** Step 3 puts it in `.env` — which it also adds to
`.gitignore` — and that is the only file it may live in. It reaches the deployment as an
environment variable, never through a commit.

### Step 3: Install the backend

One command does all the mechanical wiring:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/add-webapp-game-logging/scripts/install.mjs" \
  --project "$PROJECT" --token <token>
```

It is idempotent, prints a JSON summary, and:

- copies `api/`, `public/logs.*`, and the three `scripts/` helpers — **including
  `scripts/vite-log-api.d.mts`**, without which the first `npm run typecheck` fails with `TS7016`
  (the scaffold's `tsconfig.json` type-checks `vite.config.ts`, which now imports the `.mjs`
  plugin);
- **merges** `vercel.json` rather than overwriting it: adds
  `{ "source": "/logs", "destination": "/logs.html" }` *before* the catch-all so `/logs` serves the
  portal, and rewrites the catch-all source to `/((?!api(/|$)).*)` so it can never shadow a function;
- registers the dev-server plugin in `vite.config.ts` (`logApiPlugin()`), which is what makes the
  whole feature testable on localhost before publishing — it serves the `api/` handlers and the
  portal at `/logs`, the same paths the deployment uses; loads `.env` into `process.env` so the
  handlers see `LOG_TOKEN` (Vite itself only exposes `VITE_`-prefixed vars, and only to client
  code); and prints the two URLs you need under Vite's own on startup;
- ensures `.env` and `.logs/` are in `.gitignore` (the scaffold already ships `.env`) and writes
  `LOG_TOKEN` into `.env`.

Omit `--token` to have one generated; pass `--no-env` to set `LOG_TOKEN` some other way.

For the deployment, set the token there too:

```bash
vercel env add LOG_TOKEN production
```

> Vercel will not pick up a new environment variable until the next deploy. Redeploy after adding
> it, or the endpoints keep 404ing.

### Step 4: Verify locally before deploying

First the mechanical half — endpoints, auth, ingest, read-back, and the fail-closed contract:

```bash
node "${CLAUDE_PLUGIN_ROOT}/skills/add-webapp-game-logging/scripts/smoke-log-api.mjs" --project "$PROJECT"
```

It starts the dev server (reading `LOG_TOKEN` from `.env`), checks ingest, portal sign-in,
read-back, the fail-closed contract, and that a bare `npm run dev` picks the token up from `.env`,
then restores the log store and exits non-zero listing any failure. It does **not** need the
browser.

Then walk the consent sequence by hand. This part is the privacy contract and is the reason the
smoke test isn't the whole story:

```bash
npm run dev
```

It prints both URLs you need, filled in with the token from `.env`:

```
  ➜  Local:   http://localhost:5173/
  ➜  Network: use --host to expose
  ➜  Logging: http://localhost:5173/?log=debug&logkey=k3j9xz
  ➜  Portal:  http://localhost:5173/logs
```

(The last two appear only when a token is configured — an unconfigured project has nothing to
advertise. To override the token for one run — a different value, or none, to see the fail-closed
behavior — export it inline: `LOG_TOKEN=<token> npm run dev`.)

1. Open the **Logging** URL. The consent gate appears **first**, before the game.
2. With the network panel open, confirm **no request to `/api/logs` before you accept**.
3. Press **↓ then Enter** (D-pad + pinch) to accept. The startup backlog flushes and the `LOGGING`
   badge appears.
4. Open the **Portal** URL, sign in with the token, and confirm records arrive.
5. Reload the game and **decline** this time: nothing is POSTed, the game runs normally, and
   `?logview` still shows logs on screen.
6. Reload again — the gate reappears (the choice is deliberately not remembered).

(The fail-closed check — no `LOG_TOKEN`, so both `/api/logs` and `/api/log-auth` 404 — is already
covered by the smoke test above. The portal page itself still loads either way; it is a static
file, it just can't authenticate or read anything.)

### Step 5: Deploy and produce the device URL

Deploy from the project root as usual (never add a `server.js` or a `package.json` `start` script —
see `${CLAUDE_PLUGIN_ROOT}/docs/logging.md` and the create skill). Then:

```bash
node scripts/debug-url.mjs https://<project>.vercel.app --token=<token> --logview
```

It prints the plain game URL and the correctly encoded `fb-viewapp://` deep link. Hand the deep
link to the **`/qr-code`** skill to make a scannable PNG. By default it registers a separate
`<name> (debug)` entry, so the glasses launcher shows the normal game and the debug build side by
side and the user never re-registers to toggle logging.

### Step 6: Confirm the query string survived registration (on device)

**This is a real unknown — check it, don't assume.** After scanning the QR and launching the debug
entry on the glasses, confirm the consent gate appears. If it does, the query string survived. If
the game launches straight into play, it did not survive registration and remote logging can never
turn on that way.

Fallback if it was stripped: switch to a path-based flag. The SPA rewrite already sends every path
to `index.html`, so `/<token>/` can be read from `location.pathname` in `src/log.ts` and passed to
`logKeyFromSearch`'s caller in `main.ts`. Tell the user what you changed and why.

### Step 7: Report

Give the user, concisely:

- the portal URL and that the passcode is `LOG_TOKEN`;
- the debug game URL / QR;
- which store backend is active (the portal's status line says `memory`, `file`, or `redis`) and,
  **if it is `memory`**, that records can be lost on a cold start and how to upgrade (below).

## Storage backends

Auto-selected by `api/_store.js`; no configuration needed to start.

| Backend | When it is used | Durable? |
|---------|-----------------|----------|
| **Upstash Redis** | `KV_REST_API_URL` + `KV_REST_API_TOKEN` are set | Yes — survives cold starts, shared across instances |
| **File (JSONL)** | A persistent filesystem exists (`npm run dev`, self-hosted Node) | Yes, per host. Also readable with `cat .logs/game-logs.jsonl` |
| **Memory ring** | Fallback (the default on Vercel) | **No** — a cold start or a second instance loses records |

On Vercel the default is the memory ring, and the portal shows a banner saying so. It is fine for
"I am watching the portal while I test"; it is not fine for "let me play for ten minutes and read
it later". To upgrade, add an Upstash Redis integration from the Vercel Marketplace (it sets
`KV_REST_API_URL` / `KV_REST_API_TOKEN` automatically) and redeploy — no code change.

## Security

### What this is

A public HTTPS endpoint on the game's own deployment, gated by **one shared secret**. `LOG_TOKEN`
is simultaneously the write key (the game sends it as `?k=`) and the read passcode (you type it at
`/logs`). There are no accounts, no roles, and no way to grant read without granting write.

So anyone who learns the token can:

- **write** arbitrary records into the log stream — junk, forged messages, or enough volume to push
  the real records out of the bounded store, which is the cheapest way to destroy evidence of a bug
  you were trying to catch;
- **read** everything the game has logged in the retained window, from any browser.

The token travels in the game's URL and therefore in the QR deep link, the launcher entry on the
glasses, and anything that records browser history. Treat a URL with `?logkey=` in it as the secret
itself. It reaches the deployment as an environment variable and must never be committed.

**Rotate by changing `LOG_TOKEN` and redeploying** — old URLs stop working immediately. Rotate after
sharing a debug URL with anyone, after a demo, and when you are done debugging. Or turn the feature
off entirely by unsetting the variable; the endpoints then 404.

### What protects it, and how far that goes

Do not weaken these; each one is load-bearing.

- **Fail closed.** No `LOG_TOKEN`, no endpoints. A game published without deliberately enabling
  logging has no ingest endpoint to abuse and no portal to find.
- **Constant-time comparison** on the ingest token and the passcode. Every rejection — on ingest as
  well as on portal sign-in — costs a fixed delay and counts against a per-IP budget, with separate
  budgets per endpoint. Throttling only the portal would leave ingest as a free oracle for the same
  secret.
- **The client address comes from the socket**, not from a caller-supplied `x-forwarded-for` — a
  believed header defeats the per-IP budget entirely. Vercel is the exception (its edge sets the
  header and the socket is an internal hop), and is detected automatically. If the user self-hosts
  behind a reverse proxy, tell them to set `LOG_TRUST_PROXY=1`; otherwise leave it unset.
- **The portal cookie is a hash of the token**, not the token, so a leaked cookie does not hand
  over the ingest key.
- **The portal renders with `textContent` only.** Log text arrives from a device over the public
  internet; a viewer that interpolates it into markup is an XSS hole. Keep the CSP in `logs.html`
  too — the two are halves of the same defense.
- **Never log user content.** A log record can hold whatever the game passed to the logger, and all
  of it leaves the device and sits readable behind that one passcode. No text input, voice
  transcripts, camera frames, or location. Only the `?logkey` token is redacted automatically;
  nothing else is. This is also why the consent gate is not a formality — the wearer is agreeing to
  transmit off-device, so it must appear before the game, must be declinable, and must not be
  remembered across sessions.

### Limits — be honest with the user about these

- **The lockout is in-memory and per instance.** Every serverless instance keeps its own counter, so
  a cold start or a request routed to a second instance starts from zero. It makes guessing tedious;
  it is not a rate limiter. The fixed per-rejection delay applies everywhere and is the part that
  does not depend on instance or IP.
- **The lockout is per IP**, so it does not slow an attacker with many addresses. It is capped at
  10,000 tracked keys and evicts oldest-first, so a flood can also age out a real lockout early.
- **The 256 KB body cap does not apply on Vercel**, which parses the request body before the handler
  sees it; there the platform's own 4.5 MB request limit is the ceiling. The cap is real on
  self-hosted Node and `npm run dev`.
- **Nothing is encrypted at rest.** Records sit in the memory ring, `.logs/game-logs.jsonl`, or your
  Upstash instance in plain JSON.
- The token's entropy is what actually holds the door. Everything above is a speed bump layered on
  top of it — see Step 2.

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Every endpoint 404s | `LOG_TOKEN` is unset — or was set after the last deploy. Set it and redeploy. In dev it comes from `.env`, loaded by `logApiPlugin()`; if the portal rejects the right passcode on localhost, check that the plugin is registered in `vite.config.ts` and that `.env` has a `LOG_TOKEN=` line. |
| Portal says "incorrect passcode" with the right one | The deployment has a different `LOG_TOKEN` than you think. `vercel env ls` to check. |
| Game shows the badge but the portal is empty | Memory store on a different instance. Check the portal's store line; move to Upstash. |
| Consent gate never appears on device | The query string was stripped at registration — Step 6's fallback. |
| Consent gate appears in a desktop browser but nothing sends | You declined, or `LOG_TOKEN` doesn't match the `?logkey` in the URL (the POST 401s and the sink disables itself; look for the "remote logging stopped" warning in the console). |
| `/logs` shows the game instead of the portal | The SPA catch-all answered first: on the deployment the `/logs` rewrite in `vercel.json` is missing or sits after it; in dev `logApiPlugin()` isn't registered in `vite.config.ts`. `/logs.html` works either way and confirms the diagnosis. |
| Deep link registers without the flags | The `appUrl` wasn't percent-encoded — use `scripts/debug-url.mjs`, never a hand-built string. |
| QR won't scan / too dense | The deep link is over ~271 chars. Shorten the app name — not the token. |
| `NetworkGuard` warns about `/api/logs` | Pass `allow: isLogEndpoint` to `sealAssetNetwork` — see `${CLAUDE_PLUGIN_ROOT}/docs/logging.md`. |

## Related

| Skill | Purpose |
|-------|---------|
| `/read-webapp-game-docs` | The `docs/logging.md` reference this skill implements |
| `/update-webapp-game-framework` | Required first if the client half is missing |
| `/qr-code` (`meta-wearables-webapp`) | Turns the deep link into a scannable PNG |
| `/validate-webapp-game` | Enforces that game code logs through the logger, not `console.*` |
