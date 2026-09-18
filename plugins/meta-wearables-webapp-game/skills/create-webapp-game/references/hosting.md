# Hosting the game, and reading logs off the device

The build needs HTTPS hosting to run on the glasses. Offer it, but don't auto-run it.

## Deploying this game to Vercel

This is a **Vite build-tool app**, so deploy it differently from the vanilla
`meta-wearables-webapp` apps:

- **Do NOT add a `server.js` or a `package.json` `start` script.** Vercel is serverless —
  a `start` script makes it run the app as a Node function whose working directory has no
  `index.html`, so **every route 404s** (body `<h1>404 Not Found</h1>`, no `x-vercel-error`
  header). Let Vercel build and serve static output instead.
- **Deploy from the project root, not from `dist/`.** Run `vercel` in the game directory.
  Accept the auto-detected **Vite** framework preset (build command `npm run build`, output
  directory `dist`); Vercel runs the build itself.
- The scaffold ships a root-level **`vercel.json`** (SPA fallback + cache policy). Leave it at
  the project root — **never move it into `dist/`**, which Vite empties on every build.
- **Caching is already correct; don't "fix" it with `no-store`.** `/_vite/*` is `immutable`
  because Vite content-hashes it, `/api/*` is `no-store`, and everything else (`index.html`
  plus the verbatim `public/` assets) is `no-cache` — stored but revalidated every load, so a
  republish lands immediately. A blanket `no-store` re-downloads the whole payload on every
  launch over the glasses' constrained link, and buys nothing the hashes don't already give.
  The broad `/(.*)` rule is listed **first** and the two narrow ones after it, because Vercel
  applies every matching `headers` entry and the later one wins for a repeated key.
- **Never use a negative lookahead in a route `source`.** Vercel rejects the whole config —
  `Error: Rewrite at index 0 has invalid 'source' pattern`, and the deploy fails before it
  builds. Route patterns are path-to-regexp, not arbitrary regex: `:param`, `:param*` and
  `(.*)` are available; `(?!...)` is not. Any exclusion has to come from rule ordering or
  from Vercel's routing order, never from a lookahead.
- **Don't re-point the immutable tier at `/assets/`, and don't drop `build.assetsDir` from
  `vite.config.ts`.** They are one mechanism: `public/` is copied into the build root, so with
  Vite's default `assetsDir` the hashed output and the verbatim `public/assets/...` files share a
  prefix and no rule can tell them apart. `_vite/` is written by the bundler alone, which is what
  lets the immutable rule stand with no per-subdirectory carve-out.
- Use `meta-wearables-webapp`'s **`/publish-to-vercel`** / **`/test-on-device`** only for the
  account-level steps (`vercel login`, disabling Deployment Protection, aliasing to a stable
  URL). **Skip their `server.js` / `start`-script hosting setup** — it does not apply to this
  build-tool app and is what causes the 404.
- Serverless functions under **`api/`** are the one sanctioned server-side addition, and the
  SPA catch-all does not shadow them. Vercel resolves the filesystem — static files, then
  Serverless Functions — *before* it consults `rewrites`, so `/api/<name>` reaches the
  function and only unmatched paths fall through to `/index.html`. The catch-all is therefore
  a plain `/(.*)`; it needs no carve-out. That is how the opt-in remote-logging backend works
  — see `/add-webapp-game-logging`. It is still never a `server.js` or a `start` script.

## Reading logs from the glasses

Once the game is on device there is no console, so mention this when the user hits a
device-only bug: `?log=debug&logview` draws the log on the 600x600 display with no backend at
all, and the **`/add-webapp-game-logging`** skill adds a log portal they can read on their laptop.
See `${CLAUDE_PLUGIN_ROOT}/docs/logging.md`.

For faster iteration without a device, **`/iterate-webapp-game`** drives the game in a
desktop Chrome over CDP — screenshot it, send D-pad/pinch/drag input, read state, capture console
errors. It's the same driver the Step 7 verification pass uses.
