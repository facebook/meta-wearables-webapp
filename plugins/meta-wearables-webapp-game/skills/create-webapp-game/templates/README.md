# REPLACE_WITH_GAME_TITLE

A webapp game (2D or 3D) for Meta Display Glasses, built with Vite + TypeScript +
Three.js.

## Requirements

- Node.js >= 18

## Getting started

```bash
npm install
npm run dev     # open the printed localhost URL in a desktop browser
```

Controls (desktop): arrow keys = D-pad swipe, **Enter = index tap (select)**. A mouse click does
nothing — there is no cursor on the glasses, so `Enter` is the stand-in for the EMG index pinch.

## Commands

| Command | What it does |
|---------|--------------|
| `npm run dev` | Vite dev server with hot reload |
| `npm run typecheck` | Type-check (`tsc --noEmit`) |
| `npm test` | Run the whole unit-test suite (Vitest) — game tests plus the framework's |
| `npm run test:game` | Run only this game's own tests (everything outside `src/framework/`) |
| `npm run test:framework` | Run only the framework tests that shipped with the scaffold |
| `npm run build` | Type-check then build to `dist/` |
| `npm run preview` | Serve the production build locally |
| `npm run validate` | Check project guidelines (no input handled via the DOM; all user-facing text localized) |
| `npm run package` | Inline the build and emit `dist/prototype-artifact.json` |
| `npm run ship` | Run every gate, build, then package the artifact |

## Project layout

```
src/
  index.html      page shell (WebGL canvas + DOM HUD overlay)
  style.css       additive-display dark theme
  main.ts         entry: wires renderer + input + game loop
  models.ts       model ids + Three.js geometry (the game's model catalog)
  core/           gameplay + orchestration
  config/         centralized tunable constants
  hud/            DOM HUD / menus
  i18n/           UI strings (en.json) + i18next bootstrap (all user-facing text)
  framework/      managed engine code — re-copyable, don't hand-edit:
    core/GameLoop.ts, render/ (Renderer contract + Three.js impl with 2D/3D camera +
    AssetLoader for textures/models), input/ (InputManager + pointer/keyboard impl),
    i18n/i18n.ts (i18next setup + locale detection), math/Vector3.ts,
    sw/ (service worker: precaches the build so a second launch reads from disk)
scripts/          validation, the service-worker build step, and the fail-closed
                  single-file artifact packager
public/           static assets copied verbatim into the build (textures, models, audio)
docs/design.md    the game design document
```

## Running on the glasses

To run on Meta Display Glasses, the build has to be served over HTTPS.

**Vercel:** deploy from the **project root** (not `dist/`) — run `vercel` and accept the
detected Vite preset; Vercel runs the build and serves the output. The included `vercel.json`
provides SPA fallback and the cache policy (below); keep it at the root (never move it into
`dist/`, which Vite empties on each build). **Do not** add a `server.js` or a `package.json`
`start` script — that makes Vercel run the app as a Node function and 404 every route.

### Caching

Vite fingerprints its own output (`_vite/index-<hash>.js`), so the filename changes whenever the
contents do. `vercel.json` leans on that:

| Path | `Cache-Control` | Why |
|------|-----------------|-----|
| `/_vite/*` | `public, max-age=31536000, immutable` | The hash is the cache key — a new build is a new URL, so these never need revalidating. |
| `/api/*` | `no-store` | Dynamic; never cacheable. Nothing serves this until `/add-webapp-game-logging` adds its endpoints. |
| everything else | `no-cache` | `index.html` and `public/` assets keep stable URLs, so they are revalidated on every load and a republish is picked up immediately. |

**The tier is a directory, not a pattern, on purpose.** `vite.config.ts` sets
`build.assetsDir: '_vite'` so the bundler's hashed output has a prefix of its own. Vite's default
is `assets/`, which `public/assets/...` is copied straight into — leaving hashed and verbatim files
sharing one prefix, where any `immutable` rule either freezes a stable URL for a year or needs a
carve-out per verbatim subdirectory. `_vite/` is written by the bundler and nothing else, so the
rule needs no exceptions and cannot drift as `public/` grows.

`no-cache` means "store it, but revalidate before use" — not "don't store it". The revalidation
costs a round trip and returns `304` with no body, which is what makes a repeat load cheap over
the glasses' constrained Wi-Fi. `no-store` (the opposite) would re-download every byte every time.

Because `index.html` is always revalidated, **a new deploy is picked up on the next load** — there
is no cache to bust by hand and no separate "dev" and "prod" cache mode. Local `npm run dev` never
reads `vercel.json` at all; the Vite dev server serves fresh with its own no-cache and HMR.

Files in `public/` are copied verbatim and keep a stable URL across builds, so they cannot be
`immutable` — a swapped texture would otherwise go unseen. The service worker below is what keeps
that from costing a download every launch.

### Offline and precaching (service worker)

`npm run build` also emits `dist/sw.js`, a service worker that precaches the whole build. The
first launch fills the cache; every launch after that reads the game off disk, and it works with
the Wi-Fi off. Nothing to configure — the precache list is generated from the build.

Publishing a new build re-downloads **only the files whose contents changed**, even though
`public/` filenames stay the same: each file is cached under a content hash, and installing a new
build copies everything unchanged straight across from the old cache.

- Off during `npm run dev` (a service worker plus HMR produces stale-module bugs that look like
  build failures) and outside a secure context.
- **`?swreset=1`** unregisters the worker and deletes every cache, then reloads. This is the only
  way to clear a bad cache on the glasses, which have no reachable DevTools.
- The single-file artifact from `npm run package` has no worker — it fetches nothing.

See the plugin's `docs/offline-caching.md` for the full picture.

## Architecture

Gameplay logic is renderer- and input-agnostic — see `CLAUDE.md` for the boundaries to keep.

## License

**Your game is unlicensed** — no terms are imposed on the code you write. Add whatever license you
want, or none.

The one exception is `src/framework/`, the managed engine code this project was scaffolded with.
That is Meta-copyrighted and BSD-licensed, and its terms are in `src/framework/LICENSE`. Keep that
file, and any per-file notices your copy carries, if you redistribute the framework sources.
