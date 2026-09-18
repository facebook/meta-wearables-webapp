#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Validate that a webapp game logs through the framework logger, not `console.*`.
 *
 * Flags (deterministically): any `console.<method>(` call outside the managed framework layer
 * (`src/framework/`), test files, and this validator's own tooling. There is no ambiguous
 * category — a console call is decidable on sight. See docs/logging.md.
 *
 * Usage: node validate-console-logging.mjs [project-dir]
 *   project-dir  directory to scan (default: current directory)
 *   --           end option parsing; everything after is positional (pass a dir starting with --)
 *
 * Output: machine-readable JSON on stdout; a human summary on stderr.
 * Exit code: 1 if any violation; 2 on bad usage; else 0.
 */

import fs from 'node:fs';
import path from 'node:path';
import { scanProject } from './lib/console-calls.mjs';

const USAGE = 'Usage: node validate-console-logging.mjs [project-dir]';

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

process.stderr.write(`Console-logging check: scanned ${filesScanned} file(s) under ${projectDir}\n`);

if (violations.length > 0) {
  process.stderr.write(`\nVIOLATIONS — direct console use in game code (${violations.length}):\n`);
  for (const item of violations) {
    process.stderr.write(`  ${item.file}:${item.line}  ${item.reason}\n`);
    process.stderr.write(`      ${item.snippet}\n`);
  }
  process.stderr.write('\nFAIL — replace these with the shared logger (see docs/logging.md).\n');
} else {
  process.stderr.write('\nPASS — all game logging goes through the framework logger.\n');
}

process.exit(pass ? 0 : 1);
