/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Display-shell detector for webapp games — the deterministic core behind
 * `validate-display-shell.mjs`.
 *
 * These are the mechanically checkable items from the create skill's Step 9 checklist. They were
 * previously verified by an agent reading the files and eyeballing them, which is both expensive
 * and unreliable — a scaffold that shipped with the placeholder `<meta name="description">` or a
 * 12px HUD would pass a distracted review.
 *
 * The rules (see docs/display-guidelines.md):
 *   - the viewport is 600x600 (the device's fixed display size);
 *   - `<meta name="mrbd-web-app-capable" content="yes">` is present, or the device never routes
 *     D-pad / EMG input to the page;
 *   - the `<meta name="generator">` attribution marker is present and well formed, so a released
 *     game says which skill and version built it;
 *   - the page background is pure black — on an additive waveguide, black is transparent, and
 *     any non-black page background shows up as a glowing rectangle over the real world;
 *   - HUD text is >= 16px, the floor for legibility on the waveguide;
 *   - no scaffold placeholder tokens survive.
 *
 * Dependency-free (Node built-ins only) so it runs from the plugin cache and inside a scaffolded
 * game with no install step.
 *
 * This file exists twice, byte-identical: the copy the `validate-webapp-game` skill runs
 * (`skills/validate-webapp-game/scripts/lib/`) and the copy shipped in the scaffold so a
 * game can run `npm run validate` standalone (`skills/create-webapp-game/templates/
 * scripts/lib/`). **Fix a bug here and copy the file to the other location** —
 * `tests/scripts/copiesInSync.test.mjs` fails the build on drift.
 *
 * Known limitation: CSS parsing is regex/line based. A relative font size (`rem`/`em`/`%`) can't
 * be resolved statically, so it is returned as `ambiguous` for a human or LLM to adjudicate
 * rather than guessed at.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Minimum legible HUD text size on the waveguide display, in px. */
export const MIN_FONT_PX = 16;
/** The device's fixed display size. */
export const DISPLAY_SIZE = 600;

/**
 * Built at runtime rather than written literally, so this file does not match its own
 * placeholder scan when it sits inside a scaffolded game's `scripts/lib/`.
 */
const PLACEHOLDER_PREFIX = `REPLACE${'_WITH_'}`;

/** The stock description the template ships; Step 4 requires replacing it with a real one. */
const TEMPLATE_DESCRIPTION = 'A webapp game for Meta Display Glasses.';

/**
 * The three parts of the `<meta name="generator">` attribution marker. The skill name is the
 * **public** one on purpose — the marker ships inside released games, so it never carries the
 * internal codename. Kept equal to the constants in `stamp-version.mjs`, which writes the tag;
 * `tests/scripts/stampVersion.test.mjs` fails on drift.
 *
 * The version is only checked for shape, never against the current plugin version: a game
 * legitimately lags behind until it re-syncs its framework.
 */
const GENERATOR_SKILL = 'create-webapp-game';
const GENERATOR_URL = 'https://github.com/facebook/meta-wearables-webapp';
const GENERATOR_VERSION = /\d+\.\d+\.\d+/;

const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.vercel',
  'coverage',
  '.vite',
  '_incoming-assets',
]);

const TEXT_EXTENSIONS = new Set([
  '.html', '.htm', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.css', '.json', '.md',
]);

function toPosix(relPath) {
  return relPath.split(path.sep).join('/');
}

/** Recursively collect text files under `rootDir`, skipping build/vendor dirs. */
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
        if (!SKIP_DIRS.has(entry.name)) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = path.relative(rootDir, abs);
      if (!TEXT_EXTENSIONS.has(path.extname(rel).toLowerCase())) continue;
      results.push({ abs, rel: toPosix(rel) });
    }
  }
  results.sort((a, b) => a.rel.localeCompare(b.rel));
  return results;
}

/** Check the page shell: viewport, the MRBD capability meta, and the description placeholder. */
export function scanHtml(text, relPath) {
  const violations = [];
  const file = toPosix(relPath);

  const viewport = text.match(/<meta\s+name=["']viewport["']\s+content=["']([^"']*)["']/i);
  if (!viewport) {
    violations.push({ file, line: 0, reason: 'no <meta name="viewport"> — the 600x600 display size must be declared' });
  } else {
    const content = viewport[1];
    const width = content.match(/width\s*=\s*(\d+)/i);
    const height = content.match(/height\s*=\s*(\d+)/i);
    if (!width || Number(width[1]) !== DISPLAY_SIZE || !height || Number(height[1]) !== DISPLAY_SIZE) {
      violations.push({
        file,
        line: 0,
        reason: `viewport must be width=${DISPLAY_SIZE}, height=${DISPLAY_SIZE} (got "${content}")`,
      });
    }
  }

  const capable = text.match(/<meta\s+name=["']mrbd-web-app-capable["']\s+content=["']([^"']*)["']/i);
  if (!capable) {
    violations.push({ file, line: 0, reason: 'missing <meta name="mrbd-web-app-capable" content="yes"> — the device will not route D-pad / EMG input to the page' });
  } else if (capable[1].trim().toLowerCase() !== 'yes') {
    violations.push({ file, line: 0, reason: `mrbd-web-app-capable must be content="yes" (got "${capable[1]}")` });
  }

  const description = text.match(/<meta\s+name=["']description["']\s+content=["']([^"']*)["']/i);
  if (description && description[1].trim() === TEMPLATE_DESCRIPTION) {
    violations.push({ file, line: 0, reason: 'the <meta name="description"> is still the scaffold placeholder — write a game-specific one' });
  }

  // `[^>]*` spans newlines, so the tag is found however it is wrapped.
  const generator = text.match(/<meta\b[^>]*\bname=["']generator["'][^>]*>/i);
  if (!generator) {
    violations.push({
      file,
      line: 0,
      reason: 'missing <meta name="generator"> — a released game must say what built it; run the framework-update skill to add it',
    });
  } else {
    const content = generator[0].match(/\bcontent\s*=\s*["']([^"']*)["']/i)?.[1] ?? '';
    if (!content.includes(GENERATOR_SKILL)) {
      violations.push({ file, line: 0, reason: `<meta name="generator"> must name the scaffolding skill (${GENERATOR_SKILL})` });
    }
    if (!GENERATOR_VERSION.test(content)) {
      violations.push({ file, line: 0, reason: '<meta name="generator"> must carry the plugin version (x.y.z) it was stamped from' });
    }
    if (!content.includes(GENERATOR_URL)) {
      violations.push({ file, line: 0, reason: `<meta name="generator"> must link to ${GENERATOR_URL}` });
    }
  }

  return violations;
}

/** Check the stylesheet: pure-black page background and a >= 16px HUD floor. */
export function scanCss(text, relPath) {
  const violations = [];
  const ambiguous = [];
  const file = toPosix(relPath);
  const lines = text.split(/\r?\n/);

  // Strip block comments so a documented example doesn't read as a rule.
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '');
  // `(?![\w-])` rather than `\b`: a trailing `\b` never matches after the `)` of `rgb(0,0,0)`
  // (both `)` and the following `;` are non-word), which would reject a perfectly black page.
  // The lookahead still rejects `#000` as a prefix of `#000080`.
  const blackBackground =
    /background(?:-color)?\s*:\s*(#000|#000000|black|rgb\(\s*0\s*,\s*0\s*,\s*0\s*\))(?![\w-])/i;
  if (!blackBackground.test(code)) {
    violations.push({
      file,
      line: 0,
      reason: 'no pure-black page background found — on the additive display a non-black background glows over the real world',
    });
  }

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) continue;
    const match = line.match(/font-size\s*:\s*([\d.]+)\s*(px|rem|em|%|pt)/i);
    if (!match) continue;
    const value = Number(match[1]);
    const unit = match[2].toLowerCase();
    const entry = { file, line: i + 1, snippet: line.trim() };
    if (unit === 'px') {
      if (value < MIN_FONT_PX) {
        violations.push({ ...entry, reason: `font-size ${value}px is below the ${MIN_FONT_PX}px legibility floor` });
      }
    } else {
      ambiguous.push({ ...entry, reason: `font-size in ${unit} cannot be resolved statically — confirm it renders at >= ${MIN_FONT_PX}px` });
    }
  }

  return { violations, ambiguous };
}

/** Any surviving scaffold placeholder token is a violation wherever it appears. */
export function scanPlaceholders(text, relPath) {
  const violations = [];
  const file = toPosix(relPath);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].includes(PLACEHOLDER_PREFIX)) {
      violations.push({
        file,
        line: i + 1,
        snippet: lines[i].trim().slice(0, 200),
        reason: 'unreplaced scaffold placeholder token',
      });
    }
  }
  return violations;
}

/** Walk and check an entire project. Returns `{ filesScanned, violations, ambiguous }`. */
export function scanProject(rootDir) {
  const files = walk(rootDir);
  const violations = [];
  const ambiguous = [];
  let sawHtml = false;
  let sawCss = false;

  for (const { abs, rel } of files) {
    let text;
    try {
      text = fs.readFileSync(abs, 'utf8');
    } catch {
      continue;
    }

    violations.push(...scanPlaceholders(text, rel));

    // Only the entry page and its stylesheet define the display shell. `public/` is static
    // tooling (e.g. the log portal), not the game shell.
    if (rel === 'src/index.html') {
      sawHtml = true;
      violations.push(...scanHtml(text, rel));
    }
    if (rel === 'src/style.css') {
      sawCss = true;
      const result = scanCss(text, rel);
      violations.push(...result.violations);
      ambiguous.push(...result.ambiguous);
    }
  }

  if (!sawHtml) violations.push({ file: 'src/index.html', line: 0, reason: 'not found — the game entry page is required' });
  if (!sawCss) violations.push({ file: 'src/style.css', line: 0, reason: 'not found — the game stylesheet is required' });

  return { filesScanned: files.length, violations, ambiguous };
}
