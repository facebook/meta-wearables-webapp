#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Scaffold a webapp game from this skill's `templates/` tree.
 *
 * Everything here is mechanical — copying, renaming, stamping the framework version and the
 * `<meta name="generator">` attribution marker (both via `stamp-version.mjs`), swapping
 * the two placeholder tokens, installing dependencies, and running the gate. Doing it in one
 * process instead of a dozen agent tool-calls is both faster and dramatically cheaper: each
 * round-trip an agent makes re-sends the whole conversation context.
 *
 * The gate runs HERE, at the very start of the build, on purpose. A check costs
 * steps x context-size-at-that-point, and measured context per step is roughly 4x larger during
 * late verification than during setup — so the identical typecheck/test/validate is several times
 * cheaper now than it will ever be again. Running it here also means the agent never spends a
 * round-trip asking whether the scaffold is sound.
 *
 * Usage:
 *   node init-game.mjs --dir <target> --name <kebab-name> --title "<Human Title>"
 *
 * Options:
 *   --dir <path>            Target directory. Created if missing.
 *   --name <name>           kebab-case npm package name, e.g. `neon-runner`.
 *   --title <title>         Human-readable title, e.g. "Neon Runner".
 *   --description <text>    Game-specific <meta name="description">. Strongly recommended:
 *                           `npm run validate` flags the template's placeholder copy.
 *   --skip-install          Don't install dependencies (for tests and offline dry runs).
 *                           Implies --skip-gate: the gate needs node_modules.
 *   --skip-gate             Install, but don't run typecheck/test/validate afterwards.
 *   --force                 Proceed even if the target already looks like a scaffolded game.
 *
 * Exits non-zero with a one-line reason on any failure, including a failing gate.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runNpm } from './run-npm.mjs';
import { stampVersion } from './stamp-version.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEMPLATES = path.resolve(HERE, '../templates');
const PLUGIN_JSON = path.resolve(HERE, '../../../.claude-plugin/plugin.json');

/** Never copied out of `templates/` — local build/install artifacts, not part of the scaffold. */
const COPY_EXCLUDE = new Set(['node_modules', 'dist', '.DS_Store']);
/** Never scanned for placeholders. */
const SCAN_EXCLUDE = new Set(['node_modules', '.git', 'dist', '_incoming-assets']);
/**
 * Never set aside into `_incoming-assets/` — agent and VCS state, not user art. Moving `.claude`
 * out from under a running agent revokes its own project permissions mid-scaffold; moving `.git`
 * detaches the repository. `copyTree` writes none of these names, so leaving them clobbers nothing.
 */
const STASH_EXCLUDE = new Set(['_incoming-assets', '.claude', '.git', '.DS_Store']);

const NAME_TOKEN = 'REPLACE_WITH_GAME_NAME';
const TITLE_TOKEN = 'REPLACE_WITH_GAME_TITLE';

function fail(message) {
  console.error(`init-game: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const out = { skipInstall: false, skipGate: false, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--skip-install') out.skipInstall = true;
    else if (arg === '--skip-gate') out.skipGate = true;
    else if (arg === '--force') out.force = true;
    else if (arg === '--dir') out.dir = argv[++i];
    else if (arg === '--name') out.name = argv[++i];
    else if (arg === '--title') out.title = argv[++i];
    else if (arg === '--description') out.description = argv[++i];
    else fail(`unknown argument: ${arg}`);
  }
  return out;
}

/** Recursive copy that skips build artifacts and preserves the rest verbatim. */
function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    if (COPY_EXCLUDE.has(entry.name)) continue;
    const src = path.join(from, entry.name);
    const dest = path.join(to, entry.name);
    if (entry.isDirectory()) copyTree(src, dest);
    else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(src), dest);
    else fs.copyFileSync(src, dest);
  }
}

function* walkFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SCAN_EXCLUDE.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else if (entry.isFile()) yield full;
  }
}

/** Text files only — a NUL byte in the first 4 KB means binary, so leave it alone. */
function isProbablyText(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, 4096, 0);
    return !buf.subarray(0, read).includes(0);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Escape for an HTML double-quoted attribute value. A description is prose the caller typed, so
 * `&` and `<` are ordinary characters in it ("Dodge & duck") that would otherwise land in the
 * markup as an entity fragment or a stray tag. `&` must be replaced first.
 */
function escapeHtmlAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dir) fail('--dir is required');
  if (!args.name) fail('--name is required');
  if (!args.title) fail('--title is required');
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(args.name)) {
    fail(`--name must be kebab-case (lowercase, digits, single hyphens): got "${args.name}"`);
  }
  if (!fs.existsSync(TEMPLATES)) fail(`template tree not found at ${TEMPLATES}`);

  const target = path.resolve(args.dir);
  fs.mkdirSync(target, { recursive: true });

  // A previously scaffolded game would be silently clobbered — the placeholder tokens are gone,
  // so the substitution pass below would be a no-op and the copy would overwrite real game code.
  if (!args.force && fs.existsSync(path.join(target, 'src', 'core', 'Game.ts'))) {
    fail(`${target} already looks like a scaffolded game (src/core/Game.ts exists); pass --force to overwrite`);
  }

  // Set aside anything the user pre-dropped here (art, notes) so the template copy can't clobber
  // it. The skill's asset step files these; we only move them out of the way.
  const preExisting = fs.readdirSync(target).filter((e) => !STASH_EXCLUDE.has(e));
  const stashed = [];
  if (preExisting.length > 0) {
    const incoming = path.join(target, '_incoming-assets');
    fs.mkdirSync(incoming, { recursive: true });
    for (const entry of preExisting) {
      fs.renameSync(path.join(target, entry), path.join(incoming, entry));
      stashed.push(entry);
    }
  }

  copyTree(TEMPLATES, target);

  // Three files ship under safe names so packaging cannot strip them, and take their real names
  // here.
  const renames = [
    ['project-claude.md', 'CLAUDE.md'],
    ['gitignore', '.gitignore'],
    // The framework is Meta-licensed and the game is not, so the notice is scoped to the
    // directory it covers.
    ['src/framework/framework-license.txt', 'src/framework/LICENSE'],
  ];
  for (const [from, to] of renames) {
    const src = path.join(target, from);
    if (fs.existsSync(src)) fs.renameSync(src, path.join(target, to));
  }

  // Stamp the framework snapshot so update-webapp-game-framework can detect staleness,
  // and the `<meta name="generator">` marker so a released game says what built it. Done before
  // the placeholder pass below, so a stamp that silently did nothing surfaces as a surviving
  // REPLACE_WITH_PLUGIN_VERSION rather than as a shipped placeholder.
  const version = JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version;
  const stamp = stampVersion(target, version);

  // Replace the placeholder tokens everywhere they appear.
  let filesChanged = 0;
  for (const file of walkFiles(target)) {
    if (!isProbablyText(file)) continue;
    const before = fs.readFileSync(file, 'utf8');
    if (!before.includes(NAME_TOKEN) && !before.includes(TITLE_TOKEN)) continue;
    const after = before.split(NAME_TOKEN).join(args.name).split(TITLE_TOKEN).join(args.title);
    fs.writeFileSync(file, after);
    filesChanged += 1;
  }

  // The template ships stock description copy. `validate-display-shell.mjs` flags it, so swap in
  // the real one here when the caller supplied it (they know the concept from the Step 1 Q&A).
  let description = 'template placeholder (run validate; replace before shipping)';
  if (args.description) {
    const indexHtml = path.join(target, 'src', 'index.html');
    const before = fs.readFileSync(indexHtml, 'utf8');
    const after = before.replace(
      /(<meta\s+name="description"\s+content=")[^"]*(")/i,
      (_m, open, close) => `${open}${escapeHtmlAttribute(args.description)}${close}`,
    );
    if (after === before) fail('could not find <meta name="description"> in src/index.html');
    fs.writeFileSync(indexHtml, after);
    description = args.description;
  }

  // Verify rather than assume — a missed token surfaces as a broken package name much later.
  const leftovers = [];
  for (const file of walkFiles(target)) {
    if (!isProbablyText(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    if (text.includes(NAME_TOKEN) || text.includes(TITLE_TOKEN)) {
      leftovers.push(path.relative(target, file));
    }
  }
  if (leftovers.length > 0) fail(`placeholders survived in: ${leftovers.join(', ')}`);

  // Install. The agent's Bash sandbox usually has no network, so `npm install` hangs
  // until it times out. The template ships a package-lock.json, so try the offline path first —
  // with a warm ~/.npm/_cacache it completes in seconds.
  let install = 'skipped';
  let ranNpm = false;
  let spawnFailure = null;
  if (!args.skipInstall) {
    const attempts = [
      { label: 'npm ci --offline', args: ['ci', '--offline', '--no-audit', '--no-fund'] },
      { label: 'npm ci', args: ['ci', '--no-audit', '--no-fund'] },
      { label: 'npm install', args: ['install', '--no-audit', '--no-fund'] },
    ];
    install = 'failed';
    for (const attempt of attempts) {
      const result = runNpm(attempt.args, {
        cwd: target,
        stdio: 'ignore',
        timeout: 300_000,
      });
      if (result.status !== null) ranNpm = true;
      if (result.status === 0) {
        install = attempt.label;
        break;
      }
      // `status: null` with an `error` means npm never ran at all — a broken PATH, or a Node that
      // cannot exec it. That is a different problem from a network-less sandbox, and reporting it
      // as one sends the reader off to fix the wrong thing.
      //
      // Recorded, never cleared: evidence that npm could not be executed is not withdrawn by a
      // later attempt failing some other way. A timeout is not that evidence — a hung install is
      // the network-less sandbox itself — so it neither sets nor clears this. Whether some attempt
      // did get npm to run is `ranNpm`'s job, and that is what gates the message below.
      if (result.error && result.error.code !== 'ETIMEDOUT') spawnFailure = result.error.message;
    }
  }

  // Run the gate now, while it is cheap, and report each step so the caller never has to spend a
  // round-trip re-running it to find out whether the scaffold is sound. `skipped` is a real
  // outcome, not a pass — a caller that treats it as one is exactly the failure this reports.
  const gate = { typecheck: 'skipped', test: 'skipped', validate: 'skipped' };
  const gateFailures = [];
  const canGate = !args.skipGate && !args.skipInstall && install !== 'failed' && install !== 'skipped';
  if (canGate) {
    for (const step of ['typecheck', 'test', 'validate']) {
      const result = runNpm(['run', '--silent', step], {
        cwd: target,
        encoding: 'utf8',
        timeout: 600_000,
      });
      if (result.status === 0) {
        gate[step] = 'pass';
      } else {
        gate[step] = 'fail';
        const detail = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
        gateFailures.push(`${step}: ${detail.slice(-2000) || `exited ${result.status}`}`);
      }
    }
  }

  const summary = {
    target,
    name: args.name,
    title: args.title,
    frameworkVersion: version,
    generator: stamp.content,
    description,
    filesWithPlaceholdersReplaced: filesChanged,
    placeholdersRemaining: 0,
    install,
    gate,
    stashedToIncomingAssets: stashed,
    topLevel: fs.readdirSync(target).sort(),
  };
  console.log(JSON.stringify(summary, null, 2));

  if (install === 'failed') {
    console.error(
      spawnFailure && !ranNpm
        ? `init-game: could not run npm at all (${spawnFailure}). This is not a network problem — ` +
            'npm is missing from PATH, or Node cannot execute it. Fix npm, then re-run.'
        : 'init-game: dependency install failed. The Bash sandbox blocks network access; run ' +
            '`npm ci --offline` (or `npm install` outside the sandbox) in the project directory.',
    );
    process.exit(1);
  }

  if (gateFailures.length > 0) {
    console.error(`init-game: the scaffold does not pass its own gate:\n\n${gateFailures.join('\n\n')}`);
    process.exit(1);
  }
}

main();
