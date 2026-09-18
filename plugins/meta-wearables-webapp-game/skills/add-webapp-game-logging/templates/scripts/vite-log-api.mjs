/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Vite dev-server plugin that reproduces the deployment's log routing during `npm run dev`: it
 * mounts the `/api/logs` and `/api/log-auth` handlers, and serves the portal at `/logs`.
 *
 * Without this, the endpoints only exist on the deployed Vercel functions, and you could not test
 * remote logging — or the consent gate, or the portal — without publishing first. With it, the
 * entire feature runs on localhost against the same handler code that ships, at the same paths,
 * and the file store kicks in (a real filesystem exists), so `.logs/game-logs.jsonl` is also
 * readable directly.
 *
 * It only touches the dev server: `configureServer` is a no-op in a production build, so nothing
 * here reaches the bundle.
 *
 * It also loads the project's `.env` into `process.env` (see {@link loadDotEnvInto}). Vite's own
 * `.env` handling only reaches *client* code via `import.meta.env`, and only for `VITE_`-prefixed
 * keys — the handlers here run in Node and read `process.env`, so without this `LOG_TOKEN` is
 * undefined during `npm run dev` and every endpoint fails closed with a 404. On the deployment the
 * platform supplies those variables; this is the local equivalent.
 */

import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

/** Routes served in dev, mirroring the files Vercel would route from `api/`. */
const ROUTES = {
  '/api/logs': 'api/logs.js',
  '/api/log-auth': 'api/log-auth.js',
};

/**
 * Pages Vercel serves under a prettier path than their file name. Vite cannot read `vercel.json`,
 * so without this the portal would be `/logs` on the deployment but only `/logs.html` in dev.
 * Keep in sync with `mergeVercelJson` in the skill's `scripts/install.mjs`, which writes the
 * matching rewrite.
 */
const PAGE_ALIASES = {
  '/logs': '/logs.html',
};

/**
 * Merge `<dir>/.env` into `env`, filling only keys that are **not already present**. A variable
 * exported into the real environment therefore always wins — including one deliberately set to the
 * empty string, which is how the smoke test asserts the fail-closed contract. Hence the
 * `hasOwnProperty` test rather than a truthiness check.
 *
 * A missing or unreadable `.env` is not an error: no token means the endpoints 404, which is the
 * correct posture for a project that never configured logging.
 */
export function loadDotEnvInto(dir, env = process.env) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, '.env'), 'utf8');
  } catch {
    return;
  }

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;

    const key = trimmed.slice(0, eq).trim();
    // Split on the FIRST `=` only: a token or URL may well contain more of them.
    let value = trimmed.slice(eq + 1).trim();
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.length > 1 && value.endsWith(quote)) {
      value = value.slice(1, -1);
    }

    if (!Object.prototype.hasOwnProperty.call(env, key)) env[key] = value;
  }
}

/**
 * The two remote-logging URLs worth knowing about, derived from the address Vite is listening on.
 *
 * - `game` — the game with the remote sink armed. `?log=debug` sets the level and `?logkey=` is
 *   what makes the client offer the consent gate at all. Deliberately NOT `?logview`: that draws
 *   the log on the 600x600 display, which is the other, separate way of reading it.
 * - `portal` — always the site root, never under Vite's `base`: the middleware here matches the
 *   exact path `/logs`, as does the deployment's `vercel.json` rewrite.
 *
 * Returns `null` with no token — there is nothing to advertise, since every endpoint 404s.
 */
export function logUrlsFor(baseUrl, token) {
  if (!token) return null;
  return {
    game: new URL(`?log=debug&logkey=${encodeURIComponent(token)}`, baseUrl).href,
    portal: new URL('/logs', baseUrl).href,
  };
}

/**
 * Print those URLs under Vite's own, so the thing you need in order to use the feature is on
 * screen at the moment you start the server rather than in the skill's docs.
 */
function printLogUrls(server) {
  const base = server.resolvedUrls?.local?.[0];
  const urls = base ? logUrlsFor(base, process.env.LOG_TOKEN) : null;
  if (!urls) return;

  const color = process.stdout.isTTY && !process.env.NO_COLOR;
  const arrow = color ? '\x1b[32m➜\x1b[0m' : '➜';
  // Padded to 9 so the URLs line up with Vite's own `Local:` / `Network:` column.
  const label = (text) => {
    const padded = text.padEnd(9);
    return color ? `\x1b[1m${text}\x1b[0m${padded.slice(text.length)}` : padded;
  };

  server.config.logger.info(`  ${arrow}  ${label('Logging:')}${urls.game}`);
  server.config.logger.info(`  ${arrow}  ${label('Portal:')}${urls.portal}`);
}

export function logApiPlugin() {
  return {
    name: 'webapp-game-log-api',
    apply: 'serve',
    configureServer(server) {
      // Anchored on the cwd, like the handler resolution below and the file store's `.logs/`:
      // `npm run dev` runs from the project root, which is where `.env` and `api/` are. NOT
      // `server.config.root` — the scaffold sets Vite's root to `src/`, one level down.
      loadDotEnvInto(process.cwd());

      // Wrapping `printUrls` rather than listening for `listening` keeps these lines attached to
      // Vite's own URL block, including on a restart, where Vite reprints it.
      if (typeof server.printUrls === 'function') {
        const printUrls = server.printUrls.bind(server);
        server.printUrls = () => {
          printUrls();
          printLogUrls(server);
        };
      }

      server.middlewares.use(async (req, res, next) => {
        const url = new URL(req.url ?? '/', 'http://localhost');

        // Rewrite, then hand back to Vite's static middleware to serve the file out of `public/`.
        // A plugin's middlewares run before Vite's internal ones, so the SPA fallback — which
        // would otherwise answer `/logs` with the game's index.html — never sees the original path.
        const alias = PAGE_ALIASES[url.pathname];
        if (alias) {
          req.url = `${alias}${url.search}`;
          next();
          return;
        }

        const file = ROUTES[url.pathname];
        if (!file) {
          next();
          return;
        }

        try {
          // Imported per request so edits to the handlers are picked up without restarting the
          // dev server. The cache-busting query is the standard ESM re-import trick.
          const moduleUrl = `${pathToFileURL(path.resolve(process.cwd(), file)).href}?t=${Date.now()}`;
          const { default: handler } = await import(moduleUrl);
          await handler(req, res);
        } catch (error) {
          // A handler crash in dev should be visible, not a hung request.
          server.config.logger.error(`[log-api] ${url.pathname} failed: ${String(error)}`);
          res.statusCode = 500;
          res.end('log api error');
        }
      });
    },
  };
}
