/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Input-handling detector for webapp games — the deterministic core behind
 * `validate-input-handlers.mjs`.
 *
 * The rule it enforces (see the plugin's docs/game-architecture.md and docs/threejs-vs-dom.md):
 * UI is HTML/DOM, but INPUT must never be handled through the DOM. All input flows through the
 * framework `InputManager` and is consumed from the main game loop. The ONLY sanctioned place
 * that touches DOM input events is the input layer (`src/framework/input/`), which attaches to
 * `window`. Everything else — inline `on*=` HTML attributes, `addEventListener` for input
 * events, or `el.on<event> =` assignments — is a violation, even on `window`/`document`.
 *
 * Dependency-free (Node built-ins only) so it runs from the plugin cache and inside a
 * scaffolded game with no install step.
 *
 * Known limitation: detection is regex/line based, so a match inside a comment or string is
 * still reported. Those surface as violations for human review; genuinely undecidable cases
 * (a non-literal event name) are returned as `ambiguous` for an LLM to adjudicate.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Event names that constitute user INPUT. Handling any of these outside the input layer is a violation. */
export const BANNED_EVENTS = [
  'click',
  'dblclick',
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'contextmenu',
  'wheel',
  'keydown',
  'keyup',
  'keypress',
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointercancel',
  'touchstart',
  'touchend',
  'touchmove',
  'touchcancel',
  'input',
  'change',
  'submit',
  'focus',
  'blur',
  'drag',
  'dragstart',
  'dragend',
  'drop',
];

/**
 * Events that are NOT input (lifecycle / network / messaging). Listed for documentation and
 * tests only — anything not in BANNED_EVENTS is ignored, so e.g.
 * `document.addEventListener('visibilitychange', ...)` in main.ts is fine.
 */
export const NON_INPUT_EVENTS = [
  'visibilitychange',
  'resize',
  'load',
  'beforeunload',
  'unload',
  'DOMContentLoaded',
  'online',
  'offline',
  'hashchange',
  'popstate',
  'message',
  'error',
];

const EVENT_ALTERNATION = BANNED_EVENTS.join('|');

/**
 * Inline HTML handler attribute, e.g. `onclick=` / `onKeyDown =`. The lookbehind rejects a
 * preceding word char or hyphen so hyphenated attributes like `data-onclick=` do not match
 * (a plain `\b` boundary matches at the hyphen and would flag them as violations).
 */
const HTML_ATTR_RE = new RegExp(`(?<![\\w-])on(${EVENT_ALTERNATION})\\s*=`, 'gi');
/** `.addEventListener(` capturing the raw first argument up to the first comma or `)`. */
const ADD_LISTENER_RE = /\.addEventListener\s*\(\s*([^,)]*)/g;
/** Handler property assignment, e.g. `btn.onclick =` (but not `==`). */
const ON_PROP_RE = new RegExp(`\\.on(${EVENT_ALTERNATION})\\s*=(?!=)`, 'gi');

const TARGET_EXTENSIONS = new Set([
  '.html',
  '.htm',
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
]);

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

/** Basenames of this validator's own tooling — excluded so it never flags its own event lists. */
const SELF_FILES = new Set([
  'validate-input-handlers.mjs',
  'list-target-files.mjs',
  'scan.mjs',
]);

const MAX_SNIPPET = 200;

/** POSIX-style relative path for stable matching regardless of OS separators. */
function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/** The sanctioned DOM-input layer — its files are allowed to attach input listeners. */
export function isAllowlisted(relPath) {
  return /(^|\/)framework\/input\//.test(toPosix(relPath));
}

/** Test files ship fake event targets; the validator's own scripts list event names verbatim. */
function isExcludedFile(relPath) {
  const posix = toPosix(relPath);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(posix)) {
    return true;
  }
  if (/(^|\/)scripts\/lib\//.test(posix)) {
    return true;
  }
  return SELF_FILES.has(path.basename(posix));
}

export function isTargetFile(relPath) {
  return TARGET_EXTENSIONS.has(path.extname(relPath).toLowerCase());
}

function isHtml(relPath) {
  const ext = path.extname(relPath).toLowerCase();
  return ext === '.html' || ext === '.htm';
}

/**
 * Recursively collect scannable files under `rootDir`. Returns objects with the absolute path
 * and the path relative to `rootDir`. Skips build/vendor dirs, test files, the allowlisted
 * input layer, and this validator's own scripts.
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
  return trimmed.length > MAX_SNIPPET
    ? `${trimmed.slice(0, MAX_SNIPPET)}…`
    : trimmed;
}

/**
 * True when the raw first arg of addEventListener is a *static* string literal — the ENTIRE arg
 * is one quoted string with no trailing tokens and no template interpolation. A computed value —
 * a template literal containing `${…}` (e.g. `` `${eventName}` ``) or a concatenation whose first
 * token is a literal (e.g. `'click' + suffix`) — is treated as non-literal and routed to
 * `ambiguous`, rather than being unquoted to a string that never matches BANNED_EVENTS and thus
 * silently skipped. The regexes anchor with `^`/`$` so anything after the closing quote fails.
 */
function isStringLiteralArg(raw) {
  return (
    /^'(?:[^'\\]|\\.)*'$/.test(raw) ||
    /^"(?:[^"\\]|\\.)*"$/.test(raw) ||
    /^`(?:[^`\\$]|\\.|\$(?!\{))*`$/.test(raw)
  );
}

function unquote(raw) {
  return raw.replace(/^['"`]/, '').replace(/['"`]$/, '');
}

/**
 * Scan a single file's `text`. `relPath` selects HTML-vs-JS rules and the file field on
 * findings. Returns `{ violations, ambiguous }`, each an array of
 * `{ file, line, snippet, reason }`.
 */
export function scanContent(text, relPath) {
  const violations = [];
  const ambiguous = [];
  const file = toPosix(relPath);
  const lines = text.split(/\r?\n/);
  const html = isHtml(relPath);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const snippet = truncate(line);

    if (html) {
      for (const m of line.matchAll(HTML_ATTR_RE)) {
        violations.push({
          file,
          line: lineNo,
          snippet,
          reason: `inline "on${m[1].toLowerCase()}" input handler attribute`,
        });
      }
      continue;
    }

    for (const m of line.matchAll(ADD_LISTENER_RE)) {
      const raw = m[1].trim();
      if (raw === '') {
        // Event name is on another line (multiline call) — undecidable from this line.
        ambiguous.push({
          file,
          line: lineNo,
          snippet,
          reason: 'addEventListener with an event name this line-based scan could not read',
        });
        continue;
      }
      if (isStringLiteralArg(raw)) {
        const event = unquote(raw).toLowerCase();
        if (BANNED_EVENTS.includes(event)) {
          violations.push({
            file,
            line: lineNo,
            snippet,
            reason: `addEventListener('${event}', …) outside the input layer`,
          });
        }
        // A non-input literal (e.g. 'visibilitychange') is intentionally ignored.
        continue;
      }
      ambiguous.push({
        file,
        line: lineNo,
        snippet,
        reason: `addEventListener with a non-literal event name (${truncate(raw)})`,
      });
    }

    for (const m of line.matchAll(ON_PROP_RE)) {
      violations.push({
        file,
        line: lineNo,
        snippet,
        reason: `"on${m[1].toLowerCase()}" input handler property assignment`,
      });
    }
  }

  return { violations, ambiguous };
}

/**
 * Walk and scan an entire project directory. Returns
 * `{ filesScanned, violations, ambiguous }`.
 */
export function scanProject(rootDir) {
  const files = walk(rootDir);
  const violations = [];
  const ambiguous = [];
  for (const { abs, rel } of files) {
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }
    const result = scanContent(text, rel);
    violations.push(...result.violations);
    ambiguous.push(...result.ambiguous);
  }
  return { filesScanned: files.length, violations, ambiguous };
}
