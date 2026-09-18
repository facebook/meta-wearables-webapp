#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Install the remote-logging backend into a scaffolded webapp game.
 *
 * This is Step 3 of the skill (copy templates, merge `vercel.json`, register the dev-server
 * plugin in `vite.config.ts`, update `.gitignore`, write the token to `.env`). All of it is
 * mechanical and previously cost the agent ~13 tool-calls; none of it involves judgment.
 *
 * The judgment calls stay in SKILL.md: whether remote logging is the right answer at all
 * (Step 1), agreeing the token with the user (Step 2), the consent-sequence walkthrough
 * (Step 4), and deployment (Step 5+).
 *
 * Usage:
 *   node install.mjs --project <dir> [--token <token>]
 *
 * Options:
 *   --project <dir>   The game directory. Defaults to the current directory.
 *   --token <token>   Ingest/portal token. Generated if omitted.
 *   --no-env          Don't write `.env` (the caller sets LOG_TOKEN some other way).
 *
 * Safe to re-run: every step is idempotent.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(HERE, '../templates');

const COPIES = [
  ['api/_http.js', 'api/_http.js'],
  ['api/_store.js', 'api/_store.js'],
  ['api/logs.js', 'api/logs.js'],
  ['api/log-auth.js', 'api/log-auth.js'],
  ['public/logs.html', 'public/logs.html'],
  ['public/logs.js', 'public/logs.js'],
  ['scripts/debug-url.mjs', 'scripts/debug-url.mjs'],
  ['scripts/vite-log-api.mjs', 'scripts/vite-log-api.mjs'],
  // Without this the first `npm run typecheck` fails with TS7016, because tsconfig
  // type-checks vite.config.ts and that now imports the .mjs plugin.
  ['scripts/vite-log-api.d.mts', 'scripts/vite-log-api.d.mts'],
  ['scripts/lib/deep-link.mjs', 'scripts/lib/deep-link.mjs'],
];

const GITIGNORE_ENTRIES = ['.env', '.logs/'];

/**
 * A rewrite can only shadow `/api/*` if its pattern starts wildcarding at the root — `/(.*)`,
 * `/:path*`, `/*`. A scoped rewrite like `/help/(.*)` cannot reach `/api/...`, and warning about
 * it would send the user to edit a route that was never at risk.
 */
const ROOT_WILDCARD_RE = /^\/[(:*]/;

/**
 * The catch-all the scaffold ships, and the target every migratable catch-all is rewritten to.
 * Kept here so it cannot drift from `create-webapp-game/templates/vercel.json`.
 *
 * The alternation is `(/|$)`, not a bare `api/`: with only the trailing slash the bare path `/api`
 * passes the negative lookahead, `.*` swallows it, and the SPA shadows a function mounted at
 * exactly `/api`.
 */
const API_SAFE_CATCH_ALL = '/((?!api(/|$)).*)';

/**
 * The catch-alls this installer knows how to replace: the scaffold's plain SPA fallback, and the
 * output of an earlier version of this installer. The second one has to be listed, not skipped as
 * "already handled" — it excludes `api/` only, so it still shadows a function mounted at exactly
 * `/api`, which is the whole reason {@link API_SAFE_CATCH_ALL} spells the exclusion `api(/|$)`.
 */
const MIGRATABLE_CATCH_ALLS = new Set(['/(.*)', '/((?!api/).*)']);
const IMPORT_LINE = "import { logApiPlugin } from './scripts/vite-log-api.mjs';";

function fail(message) {
  console.error(`add-webapp-game-logging: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { project: process.cwd(), writeEnv: true };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--no-env') out.writeEnv = false;
    else if (arg === '--project') out.project = argv[++i];
    else if (arg === '--token') out.token = argv[++i];
    else fail(`unknown argument: ${arg}`);
  }
  return out;
}

/**
 * Add the `/logs` rewrite ahead of the SPA catch-all, and stop the catch-all from shadowing
 * `api/` functions. Merges into whatever the project already has rather than overwriting.
 *
 * This is the deployment half of the `/logs` path; `PAGE_ALIASES` in `templates/scripts/
 * vite-log-api.mjs` is the dev-server half. Change one, change the other.
 */
function mergeVercelJson(file) {
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const rewrites = Array.isArray(config.rewrites) ? config.rewrites : [];

  const unrecognized = [];
  for (const rewrite of rewrites) {
    if (rewrite.destination !== '/index.html' || typeof rewrite.source !== 'string') {
      continue;
    }
    if (rewrite.source === API_SAFE_CATCH_ALL) {
      // Already canonical — an idempotent re-run. Nothing to rewrite and nothing to warn about.
      continue;
    }
    if (MIGRATABLE_CATCH_ALLS.has(rewrite.source)) {
      rewrite.source = API_SAFE_CATCH_ALL;
    } else if (ROOT_WILDCARD_RE.test(rewrite.source)) {
      // A catch-all we don't recognize, so we can't safely rewrite it. Rewriting it blind could
      // break a deliberate route; leaving it silent is worse, because it still shadows `/api/*`.
      // Matched against the known forms above rather than a loose `includes('api')` test: a
      // pattern like `/((?!rapid/).*)` carries those letters for an unrelated reason, and
      // treating it as api-safe would suppress this warning while the shadowing remained.
      unrecognized.push(rewrite.source);
    }
  }
  if (!rewrites.some((r) => r.destination === '/logs.html')) {
    rewrites.unshift({ source: '/logs', destination: '/logs.html' });
  }

  config.rewrites = rewrites;
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);

  return unrecognized.length === 0
    ? 'merged (/logs rewrite + api/ excluded from catch-all)'
    : `merged (/logs rewrite); WARNING: unrecognized catch-all ${unrecognized.join(', ')} — ` +
        'exclude api/ from it by hand or the deployed /api/* routes will serve index.html';
}

/** Register the dev-server plugin, whether or not the config already has a `plugins` array. */
function patchViteConfig(file) {
  let text = fs.readFileSync(file, 'utf8');
  if (text.includes('vite-log-api.mjs')) return 'already registered';

  // `[^;]*` spans a multi-line specifier list (`import {\n  defineConfig,\n} from 'vite';`) while
  // still stopping at the statement's own semicolon — an import contains no other `;`.
  const importMatch = [...text.matchAll(/^import[\s{'"][^;]*;/gm)].pop();
  if (!importMatch) fail(`could not find an import statement to anchor to in ${file}`);
  const at = importMatch.index + importMatch[0].length;
  text = `${text.slice(0, at)}\n${IMPORT_LINE}${text.slice(at)}`;

  const pluginsMatch = text.match(/plugins:\s*\[/);
  if (pluginsMatch) {
    const at2 = pluginsMatch.index + pluginsMatch[0].length;
    text = `${text.slice(0, at2)}logApiPlugin(), ${text.slice(at2)}`;
  } else {
    const configMatch = text.match(/defineConfig\(\{/);
    if (!configMatch) fail(`could not find defineConfig({ in ${file}`);
    const at2 = configMatch.index + configMatch[0].length;
    text = `${text.slice(0, at2)}\n  plugins: [logApiPlugin()],${text.slice(at2)}`;
  }

  fs.writeFileSync(file, text);
  return 'registered';
}

function appendMissingLines(file, entries) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = new Set(existing.split('\n').map((l) => l.trim()));
  const missing = entries.filter((e) => !lines.has(e));
  if (missing.length === 0) return [];
  const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(file, `${prefix}${missing.join('\n')}\n`);
  return missing;
}

/** Upsert `LOG_TOKEN=` in `.env` without disturbing other variables. */
function writeEnvToken(file, token) {
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  // Only the previous LOG_TOKEN line goes. Dropping every empty line would silently collapse the
  // blank-line grouping in a `.env` the user organized by hand.
  const lines = existing.split('\n').filter((l) => !l.startsWith('LOG_TOKEN='));
  while (lines.length > 0 && lines[lines.length - 1].trim() === '') {
    lines.pop();
  }
  lines.push(`LOG_TOKEN=${token}`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const project = path.resolve(args.project);

  // Step 1's guards, kept here so a bad target fails immediately instead of half-installing.
  if (!fs.existsSync(path.join(project, 'package.json'))) {
    fail(`${project} has no package.json — not a webapp game`);
  }
  if (!fs.existsSync(path.join(project, 'src/framework/debug/RemoteLogSink.ts'))) {
    fail(
      'src/framework/debug/RemoteLogSink.ts is missing — the client half of remote logging is ' +
        'not in this project. Run /update-webapp-game-framework first.',
    );
  }

  // 16 bytes -> 22 base64url characters. This one secret is both the ingest key and the portal
  // passcode on a public URL, so it has to be infeasible to guess offline, not merely tedious to
  // guess online. base64url characters are URL-safe, so it costs 22 characters in the QR deep link
  // and nothing in encoding overhead.
  const token = args.token ?? crypto.randomBytes(16).toString('base64url');

  const copied = [];
  for (const [from, to] of COPIES) {
    const src = path.join(TEMPLATES, from);
    if (!fs.existsSync(src)) fail(`template missing: ${src}`);
    const dest = path.join(project, to);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    copied.push(to);
  }

  const vercelJson = mergeVercelJson(path.join(project, 'vercel.json'));

  const viteConfig = path.join(project, 'vite.config.ts');
  if (!fs.existsSync(viteConfig)) fail(`${viteConfig} not found`);
  const vitePlugin = patchViteConfig(viteConfig);

  const gitignoreAdded = appendMissingLines(path.join(project, '.gitignore'), GITIGNORE_ENTRIES);

  if (args.writeEnv) writeEnvToken(path.join(project, '.env'), token);

  console.log(
    JSON.stringify(
      {
        project,
        copied,
        vercelJson,
        viteConfig: vitePlugin,
        gitignoreAdded,
        env: args.writeEnv ? '.env updated with LOG_TOKEN' : 'not written',
        token,
        next:
          'LOG_TOKEN is in .env, which the dev-server plugin loads for `npm run dev` (an exported ' +
          'LOG_TOKEN wins); run `vercel env add LOG_TOKEN production` before deploying',
      },
      null,
      2,
    ),
  );
}

main();
