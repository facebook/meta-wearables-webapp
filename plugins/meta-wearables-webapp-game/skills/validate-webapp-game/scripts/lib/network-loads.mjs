/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Runtime-network detector for webapp games — the deterministic core behind
 * `validate-network-loads.mjs`.
 *
 * The rule it enforces (see the plugin's docs/loading-screen.md and docs/game-architecture.md):
 * gameplay/UI/config code must not load assets or open network connections. All asset I/O happens
 * up front in the preload layer (the manifest + `preloadManifest` / the framework `AssetLoader`);
 * once the loop is running the game is effectively offline, because a runtime request hitches on
 * the glasses (the budget is "< 10 requests on load"). The sanctioned loaders live in
 * `src/framework/`, so that layer is exempt; everything else is checked.
 *
 * What it flags (JS/TS only; a line-based scan):
 *   - VIOLATION: instantiating a Three.js/asset loader (`new TextureLoader`/`GLTFLoader`/… ) outside
 *     the framework; a media source set to a string-literal network URL (`img.src = 'x.png'`,
 *     `new Audio('theme.mp3')`).
 *   - AMBIGUOUS (needs review; fails only with --ci): `fetch(` / `new XMLHttpRequest` /
 *     `new WebSocket` / `new EventSource`, and a media source set from a non-literal expression —
 *     each could be an intended API/live-data call or a preloaded `blob:`/`data:` URL rather than a
 *     runtime asset load.
 *
 * A `blob:` / `data:` string literal is always OK (an in-memory reference to a preloaded asset).
 * The framework's own loaders (`loadTexture`/`preloadManifest`/…) are wrappers, not raw primitives,
 * so calling them is NOT flagged here — the loader seal (`sealAssetLoaders`) guards those at runtime.
 *
 * Dependency-free (Node built-ins only) so it runs from the plugin cache and inside a scaffolded
 * game with no install step.
 *
 * Known limitations: regex/line based, so a match inside a comment/string is still reported, and
 * markup-driven loads (`innerHTML = '<img src=…>'`, `setAttribute('src', …)`, CSS
 * `background-image`) are not caught — the runtime `NetworkGuard` and a CSP are the tools for those.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Three.js / asset loaders — instantiating one outside the framework is always a network load. */
const LOADER_RE =
  /new\s+(?:THREE\.)?(TextureLoader|CubeTextureLoader|GLTFLoader|FBXLoader|OBJLoader|ImageLoader|FileLoader|AudioLoader)\b/g;
/** `fetch(` as a call (not `.prefetch(` / `foo.fetch(`). */
const FETCH_RE = /(?<![.\w])fetch\s*\(/g;
/** `new XMLHttpRequest`. */
const XHR_RE = /\bnew\s+XMLHttpRequest\b/g;
/** Live network connections. */
const LIVE_RE = /\bnew\s+(WebSocket|EventSource)\b/g;
/** `new Audio(<args>)` — the Audio constructor loads its URL argument immediately. */
const AUDIO_RE = /\bnew\s+Audio\s*\(([^)]*)\)/g;
/**
 * `el.src = …` / `el.srcset = …` (not `==`), capturing the right-hand side up to the next `;` or
 * end of line. Global so multiple assignments on one physical line are each inspected.
 */
const SRC_ASSIGN_RE = /\.(src|srcset)\s*=(?!=)\s*([^;]*)/g;

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

/** The sanctioned preload layer — its files may use the raw loaders/network primitives. */
export function isAllowlisted(relPath) {
  return /(^|\/)framework\//.test(toPosix(relPath));
}

/** Basenames of this scanner's own tooling — its docs/patterns mention network primitives verbatim. */
const SELF_FILES = new Set(['validate-network-loads.mjs', 'network-loads.mjs']);

/**
 * Test files and this validator's own tooling are not game runtime code. The `scripts/lib/` match is
 * anchored to the shared-scanner dir (not any nested `scripts/`), so gameplay code placed under e.g.
 * `src/scripts/` is still scanned; the root-level validator entrypoints are excluded by `SELF_FILES`
 * basename instead. Mirrors `scan.mjs` so the two scanners exclude the same shape of files.
 */
export function isExcludedFile(relPath) {
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
 * If `text` begins with a `'…'` or `"…"` string literal, return its contents; otherwise `null`
 * (a variable, a template literal, or nothing — undecidable from a single line).
 */
function leadingStringLiteral(text) {
  const m = text.trimStart().match(/^(['"])((?:[^\\]|\\.)*?)\1/);
  return m ? m[2] : null;
}

/** Classify a URL string literal: an in-memory reference, a network URL, or neither. */
function classifyUrl(value) {
  if (value.startsWith('blob:') || value.startsWith('data:')) {
    return 'inmemory';
  }
  // A resource reference: a protocol URL, an absolute/relative path, or a filename with an
  // extension. A bare word (e.g. 'placeholder', a state/enum name) is not a network load.
  //
  // Known false positives: a non-URL literal shaped like a path or extension — a MIME type
  // ('text/plain'), a dotted token ('event.name') — classifies as 'network'. This is narrow in
  // practice because classifyUrl only runs on `.src` / `.srcset` / `new Audio(...)` literals, which
  // are almost always real URLs; we accept it rather than tighten the regex, since a stricter test
  // would risk the worse failure of missing an actual runtime network load.
  const looksLikeNetwork =
    /:\/\//.test(value) ||
    value.startsWith('/') ||
    /\/[^/\s]/.test(value) ||
    /\.[a-z0-9]{1,5}([?#]|$)/i.test(value);
  return looksLikeNetwork ? 'network' : 'other';
}

/**
 * Scan a single file's `text`. Returns `{ violations, ambiguous }`, each an array of
 * `{ file, line, snippet, reason }`.
 */
export function scanContent(text, relPath) {
  const violations = [];
  const ambiguous = [];
  const file = toPosix(relPath);
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNo = i + 1;
    const snippet = truncate(line);
    const violation = (reason) => violations.push({ file, line: lineNo, snippet, reason });
    const ambiguity = (reason) => ambiguous.push({ file, line: lineNo, snippet, reason });

    for (const m of line.matchAll(LOADER_RE)) {
      violation(`instantiates asset loader ${m[1]} outside the preload layer`);
    }
    for (const _ of line.matchAll(FETCH_RE)) {
      ambiguity('fetch() outside the preload layer — a runtime asset fetch or an intended API call?');
    }
    for (const _ of line.matchAll(XHR_RE)) {
      ambiguity('XMLHttpRequest outside the preload layer — asset fetch or intended API call?');
    }
    for (const m of line.matchAll(LIVE_RE)) {
      ambiguity(`new ${m[1]} — live network connection; not an asset load, but confirm it's intended`);
    }
    for (const m of line.matchAll(AUDIO_RE)) {
      const args = m[1].trim();
      if (args === '') {
        continue; // `new Audio()` with no source loads nothing.
      }
      const literal = leadingStringLiteral(args);
      if (literal === null) {
        ambiguity(
          'new Audio(<expr>) — prefer the framework AudioPlayer (audio.play); if using <audio>, ' +
            'ensure the source is a preloaded blob:/data: URL, not a network URL',
        );
      } else if (classifyUrl(literal) === 'network') {
        violation(
          `new Audio('${literal}') loads a network URL at runtime — add an { type: 'audio' } ` +
            'manifest entry and play it via the framework AudioPlayer (see docs/audio.md)',
        );
      }
    }

    for (const m of line.matchAll(SRC_ASSIGN_RE)) {
      const literal = leadingStringLiteral(m[2]);
      // Only a string literal is decidable; a variable RHS (e.g. `data.src = x`) is left alone to
      // avoid false positives on non-DOM `.src` fields — the runtime NetworkGuard covers those.
      if (literal !== null && classifyUrl(literal) === 'network') {
        violation(
          `.${m[1]} set to a network URL ('${literal}') at runtime — preload it in the manifest`,
        );
      }
    }
  }

  return { violations, ambiguous };
}

/** Walk and scan an entire project directory. Returns `{ filesScanned, violations, ambiguous }`. */
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
