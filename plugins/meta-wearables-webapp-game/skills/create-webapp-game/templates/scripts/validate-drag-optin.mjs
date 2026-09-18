#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Validate that a webapp game's index-drag opt-in is coherent.
 *
 * The EMG index pinch-and-MOVE channel is opt-in, and opting in is three coordinated edits:
 * `touch-action: none` in the CSS, `{ pointerDrag: true }` on the `PointerKeyboardInput`, and
 * game code that consumes the movement delta. This flags any combination that is missing one of
 * the three — most importantly `pointerDrag: true` on a game that never drags, which is what
 * happens when the flag gets switched on so a desktop mouse click produces a `pinchTap`. It
 * doesn't: `Enter` is the index pinch in a browser, and the flag changes what the *device*
 * delivers. See the plugin's docs/drag-channel.md.
 *
 * Usage: node validate-drag-optin.mjs [project-dir] [--ci]
 *   project-dir  directory to scan (default: current directory)
 *   --ci         also fail (exit 1) when ambiguous cases exist, for unattended CI runs
 *   --           end option parsing; everything after is positional (pass a dir starting with --)
 *
 * Output: machine-readable JSON on stdout; a human summary on stderr.
 * Exit code: 1 if any definite violation (or, with --ci, any ambiguous case); 2 on bad usage; else 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scanProject } from './lib/drag-optin.mjs';

const USAGE = 'Usage: node validate-drag-optin.mjs [project-dir] [--ci]';

let ci = false;
const positionals = [];
let optionsEnded = false;
for (const arg of process.argv.slice(2)) {
  if (!optionsEnded && arg === '--') {
    optionsEnded = true;
  } else if (!optionsEnded && arg === '--ci') {
    ci = true;
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

const scan = scanProject(projectDir);
const { filesScanned, violations, ambiguous, notes } = scan;
const pass = violations.length === 0 && (!ci || ambiguous.length === 0);

const result = { ...scan, pass, projectDir };
process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);

function report(label, items) {
  if (items.length === 0) {
    return;
  }
  process.stderr.write(`\n${label} (${items.length}):\n`);
  for (const item of items) {
    process.stderr.write(`  ${item.file}:${item.line}  ${item.reason}\n`);
    process.stderr.write(`      ${item.snippet}\n`);
  }
}

const mode = scan.dragEnabled ? 'drag (opted in)' : 'tap-only';
process.stderr.write(
  `Drag-opt-in check: scanned ${filesScanned} file(s) under ${projectDir}\n` +
    `  mode: ${mode} | touch-action:none: ${scan.touchActionNone} | drag consumed: ${scan.dragConsumed}\n`,
);
for (const note of notes) {
  process.stderr.write(`  note: ${note}\n`);
}
report('VIOLATIONS — incoherent drag opt-in', violations);
report('AMBIGUOUS — needs review (non-literal `pointerDrag`)', ambiguous);

if (pass) {
  process.stderr.write(
    ambiguous.length > 0
      ? '\nPASS — no definite violations (ambiguous cases listed above need review).\n'
      : `\nPASS — ${mode} configuration is coherent.\n`,
  );
} else {
  process.stderr.write('\nFAIL — resolve the findings above.\n');
}

process.exit(pass ? 0 : 1);
