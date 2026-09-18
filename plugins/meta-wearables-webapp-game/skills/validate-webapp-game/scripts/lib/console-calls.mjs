/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Direct-`console` detector for webapp games — the deterministic core behind
 * `validate-console-logging.mjs`.
 *
 * The rule it enforces (see the plugin's docs/logging.md): game code logs through the framework
 * `Logger` (`import { log } from '@/log'`), never `console.*` directly. A raw console call is
 * invisible on the glasses — there is no console on the device and no way to attach one — and it
 * bypasses everything the logger provides: the level filter that keeps a shipped build quiet, the
 * ring buffer the `?logview` overlay and the remote sink read from, secret redaction, and the
 * rate limit that stops a call in `update()` from becoming 60 messages a second.
 *
 * The managed framework layer (`src/framework/`) is exempt: it is the layer that *implements* the
 * logger and its console sink, and its low-level guards (e.g. `NetworkGuard`) must be able to warn
 * without depending on game wiring.
 *
 * Dependency-free (Node built-ins only) so it runs from the plugin cache and inside a scaffolded
 * game with no install step.
 *
 * Known limitation: regex/line based, so a match inside a comment or a string literal is still
 * reported. Those surface for human review — there is no ambiguous category here, because a
 * `console.` call is decidable on sight.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Console methods that produce output. `console.log` is the common one; the rest are equivalent. */
const CONSOLE_METHODS = [
  'log',
  'info',
  'warn',
  'error',
  'debug',
  'trace',
  'dir',
  'dirxml',
  'table',
  'group',
  'groupCollapsed',
  'groupEnd',
  'time',
  'timeEnd',
  'timeLog',
  'count',
  'countReset',
  'assert',
];

/**
 * `console.<method>(`, tolerating whitespace around the dot. Deliberately NOT anchored with a
 * `(?<![.\w])` lookbehind: `globalThis.console.log(...)` is still a console call and should be
 * flagged, and an object property genuinely named `console` is a console-like logger either way.
 */
const CONSOLE_RE = new RegExp(`\\bconsole\\s*\\.\\s*(${CONSOLE_METHODS.join('|')})\\b`, 'g');

const TARGET_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// `public/` is copied verbatim into the build: static assets, plus (with the add-webapp-game-logging
// skill) the developer log portal. That is tooling and build output, never game source.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.vercel',
  'coverage',
  '.vite',
  'public',
]);

const MAX_SNIPPET = 200;

/** POSIX-style relative path for stable matching regardless of OS separators. */
function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/**
 * The managed framework layer — it implements the logger and the console sink, so it is the one
 * place allowed to reference `console` directly.
 */
export function isAllowlisted(relPath) {
  return /(^|\/)framework\//.test(toPosix(relPath));
}

/** Basenames of this scanner's own tooling — its docs and patterns name console methods verbatim. */
const SELF_FILES = new Set(['validate-console-logging.mjs', 'console-calls.mjs']);

/**
 * Test files, the project's Node tooling, and this validator's own scripts are not game runtime
 * code. Mirrors `scan.mjs` and `network-loads.mjs` so all three scanners exclude the same shape of
 * files.
 *
 * Top-level `scripts/` is Node build tooling: it runs outside the browser, where there is no
 * `@/log` and `console` is the only output. Anchored at the project root, because a game's own
 * `src/scripts/` is game source and must still be scanned.
 */
export function isExcludedFile(relPath) {
  const posix = toPosix(relPath);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(posix)) {
    return true;
  }
  if (/^scripts\//.test(posix)) {
    return true;
  }
  return SELF_FILES.has(path.basename(posix));
}

export function isTargetFile(relPath) {
  return TARGET_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

/**
 * Recursively collect scannable files under `rootDir`. Skips build/vendor dirs, the allowlisted
 * framework layer, test files, and dev tooling.
 */
export function walk(rootDir) {
  const results = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) {
          stack.push(abs);
        }
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const rel = path.relative(rootDir, abs);
      if (!isTargetFile(rel) || isAllowlisted(rel) || isExcludedFile(rel)) {
        continue;
      }
      results.push({ abs, rel: toPosix(rel) });
    }
  }
  results.sort((a, b) => a.rel.localeCompare(b.rel));
  return results;
}

function truncate(text) {
  const trimmed = text.trim();
  return trimmed.length > MAX_SNIPPET ? `${trimmed.slice(0, MAX_SNIPPET)}…` : trimmed;
}

/**
 * Scan a single file's `text`. Returns `{ violations, ambiguous }`; `ambiguous` is always empty
 * (kept for shape-compatibility with the other validators' JSON output).
 */
export function scanContent(text, relPath) {
  const violations = [];
  const file = toPosix(relPath);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const m of line.matchAll(CONSOLE_RE)) {
      violations.push({
        file,
        line: i + 1,
        snippet: truncate(line),
        reason: `console.${m[1]}() in game code — use the framework logger (import { log } from '@/log')`,
      });
    }
  }

  return { violations, ambiguous: [] };
}

/** Walk and scan an entire project directory. Returns `{ filesScanned, violations, ambiguous }`. */
export function scanProject(rootDir) {
  const files = walk(rootDir);
  const violations = [];
  for (const { abs, rel } of files) {
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    violations.push(...scanContent(text, rel).violations);
  }
  return { filesScanned: files.length, violations, ambiguous: [] };
}
