#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Validate the display shell of a webapp game.
 *
 * Checks the mechanically decidable items from the create skill's Step 9 checklist: the 600x600
 * viewport, the `mrbd-web-app-capable` meta tag, a pure-black page background, a >= 16px HUD
 * text floor, a game-specific `<meta name="description">`, and that no scaffold placeholder
 * tokens survived. See docs/display-guidelines.md.
 *
 * Usage: node validate-display-shell.mjs [project-dir]
 *   project-dir  directory to scan (default: current directory)
 *   --           end option parsing; everything after is positional (pass a dir starting with --)
 *
 * Output: machine-readable JSON on stdout; a human summary on stderr.
 * Exit code: 1 if any violation; 2 on bad usage; else 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scanProject } from './lib/display-shell.mjs';

const USAGE = 'Usage: node validate-display-shell.mjs [project-dir]';

const positionals = [];
let optionsEnded = false;
for (const arg of process.argv.slice(2)) {
  if (!optionsEnded && arg === '--') {
    optionsEnded = true;
  } else if (!optionsEnded && arg.startsWith('--')) {
    process.stderr.write(`Unknown option: ${arg}\n${USAGE}\n`);
    process.exit(2);
  } else {
    positionals.push(arg);
  }
}
if (positionals.length > 1) {
  process.stderr.write(`Unexpected extra argument: ${positionals[1]}\n${USAGE}\n`);
  process.exit(2);
}
const projectDir = path.resolve(positionals[0] ?? '.');

let projectStat;
try {
  projectStat = fs.statSync(projectDir);
} catch {
  process.stderr.write(`Project directory not found: ${projectDir}\n${USAGE}\n`);
  process.exit(2);
}
if (!projectStat.isDirectory()) {
  process.stderr.write(`Not a directory: ${projectDir}\n${USAGE}\n`);
  process.exit(2);
}

const { filesScanned, violations, ambiguous } = scanProject(projectDir);
const pass = violations.length === 0;

process.stdout.write(`${JSON.stringify({ pass, projectDir, filesScanned, violations, ambiguous }, null, 2)}\n`);

process.stderr.write(`Display-shell check: scanned ${filesScanned} file(s) under ${projectDir}\n`);

if (violations.length > 0) {
  process.stderr.write(`\nVIOLATIONS (${violations.length}):\n`);
  for (const item of violations) {
    process.stderr.write(`  ${item.file}${item.line ? `:${item.line}` : ''}  ${item.reason}\n`);
    if (item.snippet) process.stderr.write(`      ${item.snippet}\n`);
  }
  process.stderr.write('\nFAIL — fix these (see docs/display-guidelines.md).\n');
} else {
  process.stderr.write('\nPASS — display shell matches the 600x600 additive-display rules.\n');
}

if (ambiguous.length > 0) {
  process.stderr.write(`\nAMBIGUOUS — needs a human/LLM call (${ambiguous.length}):\n`);
  for (const item of ambiguous) {
    process.stderr.write(`  ${item.file}:${item.line}  ${item.reason}\n`);
  }
}

process.exit(pass ? 0 : 1);
