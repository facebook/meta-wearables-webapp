/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Layer-boundary detector for webapp games — the deterministic core behind
 * `validate-layer-boundaries.mjs`.
 *
 * The rule it enforces (see the plugin's docs/core-contract.md section 5): gameplay is renderer-,
 * input-, and audio-agnostic. Game code must not import `three`, touch the DOM, or touch the Web
 * Audio API; it talks to the `Renderer` / `InputManager` / `AudioPlayer` contracts, and the
 * concrete implementations are injected in `main.ts`. That is what lets a whole game be unit-tested
 * in plain Node with fakes — no GPU, no DOM, no AudioContext.
 *
 * Only a handful of game files are adapters and may cross a boundary:
 *
 *   three      src/models.ts                      (model geometry is inherently renderer-specific)
 *   DOM        src/main.ts, src/hud/, src/log.ts  (composition root, HUD output, query string)
 *   Web Audio  — nothing in game code             (only framework/audio/AudioEngine.ts)
 *   audio impl src/main.ts                        (composition root: it constructs the player)
 *
 * The last one is the audio counterpart of the `three` rule. Importing `AmpAudioPlayer` /
 * `AudioEngine` / `BankStore` from gameplay hard-wires it to the concrete backend even though no
 * forbidden global appears on the line, so `FakeAudioPlayer` can no longer stand in and the file
 * stops being node-testable. Gameplay takes an injected `AudioPlayer` instead; `main.ts` is the one
 * place that names the implementation.
 *
 * Scope is `src/` only, and the managed framework layer (`src/framework/`) is exempt: it is the
 * layer that *implements* these adapters, it is re-copied wholesale by
 * `update-webapp-game-framework`, and a game author never edits it.
 *
 * Dependency-free (Node built-ins only) so it runs from the plugin cache and inside a scaffolded
 * game with no install step.
 *
 * Comments are blanked before matching (see `stripComments`). Unlike the sibling scanners, this one
 * has to: the words it looks for — `AudioContext`, `document`, `window` — are ordinary prose that
 * the template's own `main.ts` uses in explanatory comments, so a purely line-based match fails a
 * clean scaffold out of the box.
 *
 * Known limitation: still regex/line based, so a match inside a *string literal* is reported.
 * String contents cannot be blanked because an import specifier (`from 'three'`) is itself a
 * string. Cases a single line genuinely cannot decide — a dynamic `import()` whose specifier is
 * not a string literal — are reported as `ambiguous` rather than failing the run.
 */

import fs from 'node:fs';
import path from 'node:path';

const TARGET_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

// `public/` is copied verbatim into the build and `scripts/` is Node tooling — neither is game
// source. Both sit outside `src/`, but keep them here so pointing the scanner at a project root
// with no `src/` still does the right thing.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.vercel',
  'coverage',
  '.vite',
  'public',
  'scripts',
]);

const MAX_SNIPPET = 200;

/** POSIX-style relative path for stable matching regardless of OS separators. */
function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/**
 * Match allowlists against the path as it appears inside `src/`, so the scanner behaves the same
 * whether it was pointed at the project root or straight at the `src` directory.
 */
function withinSrc(relPath) {
  return toPosix(relPath).replace(/^src\//, '');
}

/**
 * The managed framework layer — it implements the renderer, the input layer, and the audio engine,
 * so every boundary crossing in there is the point rather than a violation.
 */
export function isAllowlisted(relPath) {
  return /(^|\/)framework\//.test(toPosix(relPath));
}

/** Basenames of this scanner's own tooling — its patterns name the forbidden globals verbatim. */
const SELF_FILES = new Set(['validate-layer-boundaries.mjs', 'layer-boundaries.mjs']);

/**
 * Test files and this validator's own tooling are not game runtime code. A test is *expected* to
 * reach for a DOM stub or a fake AudioContext. Mirrors `scan.mjs`, `network-loads.mjs`, and
 * `console-calls.mjs` so all the scanners exclude the same shape of files.
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
 * The game-code adapters, per concern. Everything else in `src/` is gameplay and must stay
 * agnostic. `hud/` is a prefix (a HUD is usually several files); the rest are exact files.
 */
const ADAPTERS = {
  three: { files: new Set(['models.ts']), dirs: [] },
  dom: { files: new Set(['main.ts', 'log.ts']), dirs: ['hud/'] },
  webAudio: { files: new Set(), dirs: [] },
  audioImpl: { files: new Set(['main.ts']), dirs: [] },
};

/** Whether `relPath` is the sanctioned adapter for `concern` and may therefore cross that boundary. */
export function isAdapterFor(relPath, concern) {
  const rel = withinSrc(relPath);
  const adapter = ADAPTERS[concern];
  if (!adapter) {
    return false;
  }
  // Compare without the extension so `main.ts` also covers a `main.js`/`main.tsx` variant.
  const base = rel.replace(/\.[cm]?[jt]sx?$/, '');
  for (const file of adapter.files) {
    if (base === file.replace(/\.[cm]?[jt]sx?$/, '')) {
      return true;
    }
  }
  return adapter.dirs.some((dir) => rel.startsWith(dir));
}

/** `import`/`export`/`require`/`import()` of `three` or any of its subpaths. */
const THREE_RE =
  /(?:\bfrom\s*|\bimport\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]three(?:\/[^'"]*)?['"]/g;

/**
 * A DOM global used as an object (`document.querySelector`, `window.location`), a `typeof` guard
 * on one, or a DOM element type. The lookbehind keeps `this.window` / `state.document` — ordinary
 * property names — out of the results; a bare word in prose has no trailing dot and is ignored.
 */
const DOM_RE =
  /(?<![.\w$])(?:(?:document|window|navigator|localStorage|sessionStorage)\s*\.|typeof\s+(?:document|window|navigator)\b|HTML[A-Za-z]*Element\b)/g;

/** Web Audio constructors and node types, plus the `new Audio(...)` element shortcut. */
const WEB_AUDIO_RE =
  /(?<![.\w$])(?:webkitAudioContext|AudioContext|AudioBuffer|AudioParam|AudioListener|AudioWorkletNode|AudioBufferSourceNode|OscillatorNode|GainNode|StereoPannerNode|PannerNode|AnalyserNode|BiquadFilterNode|ConvolverNode|DelayNode|DynamicsCompressorNode|WaveShaperNode|ChannelSplitterNode|ChannelMergerNode|MediaElementAudioSourceNode|MediaStreamAudioSourceNode|ScriptProcessorNode)\b|\bnew\s+Audio\s*\(/g;

/**
 * An import of a concrete audio backend rather than the `AudioPlayer` contract. Matched on the
 * module specifier, not on a global, because this crossing is invisible to the `WEB_AUDIO_RE` scan:
 * the offending line names no Web Audio type at all.
 */
const AUDIO_IMPL_RE =
  /(?:\bfrom\s*|\bimport\s+|\brequire\s*\(\s*|\bimport\s*\(\s*)['"][^'"]*\/audio\/(?:AmpAudioPlayer|AudioEngine|BankStore)['"]/g;

/** A dynamic `import(...)` whose specifier is not a string literal — undecidable from one line. */
const DYNAMIC_IMPORT_RE = /(?<![.\w$])import\s*\(\s*(?!['"])[^)\s]/g;

const CHECKS = [
  {
    concern: 'three',
    re: THREE_RE,
    reason:
      "imports `three` in gameplay code — only src/models.ts may (gameplay talks to the Renderer contract)",
  },
  {
    concern: 'dom',
    re: DOM_RE,
    reason:
      'touches the DOM in gameplay code — only src/main.ts, src/hud/, and src/log.ts may (HUD output belongs in src/hud/)',
  },
  {
    concern: 'webAudio',
    re: WEB_AUDIO_RE,
    reason:
      'touches the Web Audio API — game code must go through the AudioPlayer contract (see docs/audio.md)',
  },
  {
    concern: 'audioImpl',
    re: AUDIO_IMPL_RE,
    reason:
      'imports a concrete audio backend — only src/main.ts may (gameplay takes an injected AudioPlayer, so FakeAudioPlayer can stand in; see docs/audio.md)',
  },
];

/**
 * Recursively collect scannable files under `rootDir`, scoping to `src/` when it exists. Skips
 * build/vendor dirs, the managed framework layer, test files, and dev tooling. `rel` is relative
 * to `rootDir` so reported paths read as `src/core/Game.ts`.
 */
export function walk(rootDir) {
  const src = path.join(rootDir, 'src');
  const start = fs.existsSync(src) && fs.statSync(src).isDirectory() ? src : rootDir;
  const results = [];
  const stack = [start];
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
 * Blank out `//` and block comments, replacing their contents with spaces so every line keeps its
 * length and its number. Quoted strings are preserved verbatim — an import specifier is a string,
 * so blanking those would blind the `three` check. A backslash always escapes the next character,
 * which is what keeps `\/` inside a regex literal from reading as the start of a comment.
 */
export function stripComments(text) {
  const out = [];
  let state = 'code';
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];
    if (state === 'code') {
      if (char === '\\') {
        out.push(char, next ?? '');
        i += 1;
      } else if (char === '/' && next === '/') {
        state = 'line';
        out.push('  ');
        i += 1;
      } else if (char === '/' && next === '*') {
        state = 'block';
        out.push('  ');
        i += 1;
      } else {
        if (char === "'") state = 'single';
        else if (char === '"') state = 'double';
        else if (char === '`') state = 'template';
        out.push(char);
      }
    } else if (state === 'line') {
      if (char === '\n') {
        state = 'code';
        out.push(char);
      } else {
        out.push(' ');
      }
    } else if (state === 'block') {
      if (char === '*' && next === '/') {
        state = 'code';
        out.push('  ');
        i += 1;
      } else {
        out.push(char === '\n' ? char : ' ');
      }
    } else {
      // Inside a string literal: copy through, honouring escapes, until the matching quote.
      if (char === '\\') {
        out.push(char, next ?? '');
        i += 1;
      } else {
        if (
          (state === 'single' && char === "'") ||
          (state === 'double' && char === '"') ||
          (state === 'template' && char === '`')
        ) {
          state = 'code';
        }
        out.push(char);
      }
    }
  }
  return out.join('');
}

/** Scan a single file's `text`. Returns `{ violations, ambiguous }`. */
export function scanContent(text, relPath) {
  const violations = [];
  const ambiguous = [];
  const file = toPosix(relPath);
  // Match against the comment-stripped text, but report the original line so the snippet reads
  // the way the file actually looks.
  const lines = stripComments(text).split(/\r?\n/);
  const originalLines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const snippet = truncate(originalLines[i] ?? line);
    for (const check of CHECKS) {
      if (isAdapterFor(file, check.concern)) {
        continue;
      }
      check.re.lastIndex = 0;
      if (check.re.test(line)) {
        violations.push({
          file,
          line: i + 1,
          snippet,
          concern: check.concern,
          reason: check.reason,
        });
      }
    }
    DYNAMIC_IMPORT_RE.lastIndex = 0;
    if (DYNAMIC_IMPORT_RE.test(line)) {
      ambiguous.push({
        file,
        line: i + 1,
        snippet,
        reason: 'dynamic import() with a non-literal specifier — confirm it pulls in no renderer, DOM, or audio dependency',
      });
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
