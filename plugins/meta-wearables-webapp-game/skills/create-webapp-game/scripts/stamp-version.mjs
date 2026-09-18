#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Stamp the plugin version into a scaffolded game, in the two places that record it.
 *
 * 1. `src/framework/VERSION` — read by `update-webapp-game-framework` to detect a
 *    stale framework snapshot. Never reaches the build output.
 * 2. `<meta name="generator">` in `src/index.html` — the attribution marker that *does* reach
 *    the build output, so a released game (hosted, or shipped as the single-file artifact)
 *    declares the skill that produced it, the version it was built from, and where to read
 *    more.
 *
 * Both `init-game.mjs` (scaffold) and the framework-update skill (re-sync) call this, so the
 * stamp has exactly one definition. It is idempotent, and it **inserts** the generator tag when
 * absent — that is how a game scaffolded before the marker existed gets backfilled.
 *
 * Usage:
 *   node stamp-version.mjs <project-dir> [--version <x.y.z>]
 *
 * Options:
 *   --version <x.y.z>  Version to stamp. Defaults to this plugin's `.claude-plugin/plugin.json`.
 *
 * Prints a JSON summary. Exits non-zero with a one-line reason on any failure.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_JSON = path.resolve(HERE, '../../../.claude-plugin/plugin.json');

/**
 * The **public** name of the scaffolding skill, deliberately. This marker ships inside every
 * released game, so it must read the same whichever release of this plugin scaffolded the game,
 * and must never carry a Meta-only codename. Writing the published name directly is what makes
 * that true; a release cut renames the skill directory to match, and
 * `tests/scripts/stampVersion.test.mjs` asserts the two still agree. Do not "correct" this to the
 * directory name it currently sits under.
 */
export const GENERATOR_SKILL = 'create-webapp-game';

/** Where a reader of a released game goes to learn what built it. */
export const GENERATOR_URL = 'https://github.com/facebook/meta-wearables-webapp';

/** Matches the whole tag; `[^>]*` spans newlines, so a multi-line tag is found too. */
const GENERATOR_TAG = /<meta\b[^>]*\bname=["']generator["'][^>]*>/i;
const CONTENT_ATTR = /(\bcontent\s*=\s*")([^"]*)(")/i;

/** The value of the generator tag's `content` attribute for a given version. */
export function generatorContent(version) {
  return `${GENERATOR_SKILL} ${version} (${GENERATOR_URL})`;
}

function fail(message) {
  throw new Error(message);
}

/** Escape for an HTML double-quoted attribute value. `&` must be replaced first. */
function escapeHtmlAttribute(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Rewrite the generator tag's `content`, or insert the whole tag before `</head>` when there is
 * none. Returns `{ html, generator }` where `generator` is `inserted` / `updated` / `unchanged`.
 */
function upsertGenerator(html, version) {
  const wanted = escapeHtmlAttribute(generatorContent(version));
  const match = html.match(GENERATOR_TAG);

  if (!match) {
    if (!/<\/head>/i.test(html)) {
      fail('src/index.html has no </head> — cannot insert the <meta name="generator"> tag');
    }
    const tag = `<meta name="generator" content="${wanted}" />`;
    return { html: html.replace(/<\/head>/i, () => `  ${tag}\n  </head>`), generator: 'inserted' };
  }

  const tag = match[0];
  if (!CONTENT_ATTR.test(tag)) {
    fail('the <meta name="generator"> in src/index.html has no content="..." attribute');
  }
  const updated = tag.replace(CONTENT_ATTR, (_whole, open, _old, close) => `${open}${wanted}${close}`);
  if (updated === tag) return { html, generator: 'unchanged' };
  return {
    html: `${html.slice(0, match.index)}${updated}${html.slice(match.index + tag.length)}`,
    generator: 'updated',
  };
}

/**
 * Stamp `projectDir`. Throws with a one-line reason if the project does not look like a
 * scaffolded game.
 */
export function stampVersion(projectDir, version) {
  if (!/^\d+\.\d+\.\d+/.test(version)) fail(`version must be semver, got "${version}"`);

  const indexHtml = path.join(projectDir, 'src', 'index.html');
  if (!fs.existsSync(indexHtml)) fail(`no src/index.html under ${projectDir}`);

  const before = fs.readFileSync(indexHtml, 'utf8');
  const { html, generator } = upsertGenerator(before, version);
  if (html !== before) fs.writeFileSync(indexHtml, html);

  const versionFile = path.join(projectDir, 'src', 'framework', 'VERSION');
  fs.mkdirSync(path.dirname(versionFile), { recursive: true });
  fs.writeFileSync(versionFile, `${version}\n`);

  return { version, versionFile, generator, content: generatorContent(version) };
}

function parseArgs(argv) {
  const out = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--version') out.version = argv[++i];
    else if (argv[i].startsWith('--')) fail(`unknown argument: ${argv[i]}`);
    else positionals.push(argv[i]);
  }
  if (positionals.length !== 1) fail('usage: node stamp-version.mjs <project-dir> [--version x.y.z]');
  out.dir = positionals[0];
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const version = args.version ?? JSON.parse(fs.readFileSync(PLUGIN_JSON, 'utf8')).version;
  const result = stampVersion(path.resolve(args.dir), version);
  console.log(JSON.stringify(result, null, 2));
}

// Only when run as a CLI — `init-game.mjs` imports `stampVersion` from here.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`stamp-version: ${error.message}`);
    process.exit(1);
  }
}
