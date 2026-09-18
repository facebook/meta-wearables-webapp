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
 * Vercel route patterns are path-to-regexp, which has no lookahead. A `source` containing one
 * is rejected outright — `Error: Rewrite at index 0 has invalid 'source' pattern` — and the
 * deploy fails before it builds, so any surviving occurrence is worth a warning.
 */
const LOOKAHEAD_RE = /\(\?!/;

/**
 * The catch-all the scaffold ships. Kept here so it cannot drift from
 * `create-webapp-game/templates/vercel.json`.
 *
 * It needs no `api/` carve-out: Vercel resolves the filesystem — static files, then Serverless
 * Functions — before it consults `rewrites`, so `/api/*` reaches the function and only unmatched
 * paths fall through to the SPA.
 */
const CANONICAL_CATCH_ALL = '/(.*)';

/**
 * Catch-alls written by earlier versions of this installer and of the scaffold, both of which
 * carved `api/` out with a negative lookahead. They are not merely redundant — Vercel rejects
 * the pattern, so a project still carrying one cannot deploy at all until it is migrated.
 */
const MIGRATABLE_CATCH_ALLS = new Set(['/((?!api/).*)', '/((?!api(/|$)).*)']);

/** The `headers` counterpart, which excluded the two narrower cache tiers instead of `api/`. */
const LEGACY_HEADER_CATCH_ALL = '/((?!_vite/|api/).*)';
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
 * Add the `/logs` rewrite ahead of the SPA catch-all, and migrate any lookahead-bearing route
 * pattern an older scaffold left behind. Merges into whatever the project already has rather
 * than overwriting.
 *
 * This is the deployment half of the `/logs` path; `PAGE_ALIASES` in `templates/scripts/
 * vite-log-api.mjs` is the dev-server half. Change one, change the other.
 */
function mergeVercelJson(file) {
  const config = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  const rewrites = Array.isArray(config.rewrites) ? config.rewrites : [];

  for (const rewrite of rewrites) {
    if (rewrite.destination !== '/index.html' || typeof rewrite.source !== 'string') {
      continue;
    }
    if (MIGRATABLE_CATCH_ALLS.has(rewrite.source)) {
      rewrite.source = CANONICAL_CATCH_ALL;
    }
  }
  if (!rewrites.some((r) => r.destination === '/logs.html')) {
    rewrites.unshift({ source: '/logs', destination: '/logs.html' });
  }

  config.rewrites = rewrites;

  // Header sources are the same path-to-regexp dialect and the same rejection, so a project
  // whose headers still carry the old exclusion cannot deploy either. Only the exact pattern
  // the scaffold used is migrated; anything else is reported rather than rewritten blind.
  //
  // Broadening the pattern also has to move the entry to the front. The old scaffold listed
  // this rule last and relied on the lookahead to keep it off `_vite/` and `api/`; `/(.*)` has
  // no such carve-out, and Vercel applies every matching entry with the later one winning for
  // a repeated key. Left in place it would override the narrower tiers it used to exclude.
  const headers = Array.isArray(config.headers) ? config.headers : [];
  const broadened = headers.filter((header) => header.source === LEGACY_HEADER_CATCH_ALL);
  for (const header of broadened) {
    header.source = CANONICAL_CATCH_ALL;
  }
  if (broadened.length > 0) {
    config.headers = [...broadened, ...headers.filter((header) => !broadened.includes(header))];
  }

  const stranded = [...rewrites, ...headers]
    .map((entry) => entry.source)
    .filter((source) => typeof source === 'string' && LOOKAHEAD_RE.test(source));

  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);

  return stranded.length === 0
    ? 'merged (/logs rewrite)'
    : `merged (/logs rewrite); WARNING: unrecognized lookahead pattern ${stranded.join(', ')} — ` +
        'Vercel rejects these, so rewrite them by hand or the deploy will fail';
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
