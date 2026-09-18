#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Validate that a webapp game loads no assets over the network at runtime.
 *
 * Flags (deterministically): instantiating a Three.js/asset loader, or setting a media source to a
 * string-literal network URL, outside the framework preload layer (`src/framework/`). Network calls
 * whose intent a single line can't decide (`fetch(`, `XMLHttpRequest`, `WebSocket`, `EventSource`,
 * a media source from a non-literal expression) are reported as `ambiguous` for review; they never
 * fail the run on their own unless `--ci` is passed. See docs/loading-screen.md.
 *
 * Usage: node validate-network-loads.mjs [project-dir] [--ci]
 *   project-dir  directory to scan (default: current directory)
 *   --ci         also fail (exit 1) when ambiguous cases exist, for unattended CI runs
 *   --           end option parsing; everything after is positional (pass a dir starting with --)
 *
 * Output: machine-readable JSON on stdout; a human summary on stderr.
 * Exit code: 1 if any definite violation (or, with --ci, any ambiguous case); 2 on bad usage; else 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scanProject } from './lib/network-loads.mjs';

const USAGE = 'Usage: node validate-network-loads.mjs [project-dir] [--ci]';

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

const { filesScanned, violations, ambiguous } = scanProject(projectDir);
const pass = violations.length === 0 && (!ci || ambiguous.length === 0);

const result = { pass, projectDir, filesScanned, violations, ambiguous };
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

process.stderr.write(
  `Network-load check: scanned ${filesScanned} file(s) under ${projectDir}\n`,
);
report('VIOLATIONS — assets loaded over the network at runtime', violations);
report('AMBIGUOUS — needs review (network call outside the preload layer)', ambiguous);

if (pass) {
  process.stderr.write(
    ambiguous.length > 0
      ? '\nPASS — no definite violations (ambiguous cases listed above need review).\n'
      : '\nPASS — no runtime network asset loads found.\n',
  );
} else {
  process.stderr.write('\nFAIL — resolve the findings above.\n');
}

process.exit(pass ? 0 : 1);
