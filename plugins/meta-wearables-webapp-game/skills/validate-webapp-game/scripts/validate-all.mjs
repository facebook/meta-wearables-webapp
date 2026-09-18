#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Run every webapp game validator and print ONE line per check.
 *
 * This is the entry point `npm run validate` uses. The individual `validate-*.mjs` scripts each
 * print a full JSON report, so chaining all seven with `&&` buries the one failure under six
 * passing reports — and re-sends every one of them through the reader's context on each run.
 * Here the detail is printed only for checks that fail.
 *
 * It also does NOT stop at the first failure, so one run reports everything that is wrong.
 *
 * Usage: node validate-all.mjs [project-dir] [--ci] [--json]
 *   project-dir  directory to scan (default: current directory)
 *   --ci         also fail (exit 1) when ambiguous cases exist, for unattended CI runs
 *   --json       print the combined machine-readable report on stdout (per-check `violations`
 *                and `ambiguous`, so a caller can adjudicate the ambiguous ones)
 *   --           end option parsing; everything after is positional (pass a dir starting with --)
 *
 * Output: the human summary on stderr; nothing on stdout unless `--json` is passed.
 * Exit code: 1 if any check failed, 2 on bad usage, else 0.
 *
 * Dependency-free (Node built-ins only) so it runs from the plugin cache and inside a scaffolded
 * game with no install step.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const USAGE = 'Usage: node validate-all.mjs [project-dir] [--ci] [--json]';

/**
 * Every check, in the order they run. `id` matches the script name for drilling down.
 *
 * `ci: false` marks a check with no ambiguous category: `--ci` would mean nothing to it, and it
 * rejects unknown options with exit 2, so the wrapper must not forward the flag.
 */
const CHECKS = [
  { id: 'input-handlers', script: 'validate-input-handlers.mjs' },
  { id: 'localized-strings', script: 'validate-localized-strings.mjs' },
  { id: 'network-loads', script: 'validate-network-loads.mjs' },
  { id: 'console-logging', script: 'validate-console-logging.mjs', ci: false },
  { id: 'display-shell', script: 'validate-display-shell.mjs', ci: false },
  { id: 'layer-boundaries', script: 'validate-layer-boundaries.mjs' },
  { id: 'drag-optin', script: 'validate-drag-optin.mjs' },
];

let ci = false;
let json = false;
const positionals = [];
let optionsEnded = false;
for (const arg of process.argv.slice(2)) {
  if (!optionsEnded && arg === '--') {
    optionsEnded = true;
  } else if (!optionsEnded && arg === '--ci') {
    ci = true;
  } else if (!optionsEnded && arg === '--json') {
    json = true;
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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

/** Run one validator and normalize its result, including the ways it can fail to run at all. */
function runCheck(check) {
  const scriptPath = path.join(scriptDir, check.script);
  const args = [scriptPath, projectDir];
  if (ci && check.ci !== false) {
    args.push('--ci');
  }
  const run = spawnSync(process.execPath, args, { encoding: 'utf8' });

  if (run.error) {
    return { ...check, pass: false, error: run.error.message, violations: [], ambiguous: [] };
  }

  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch {
    // A validator that crashed (or was passed a bad argument) never printed JSON. Surface its
    // stderr rather than reporting a silent pass.
    const detail = (run.stderr || '').trim().split('\n').slice(-3).join(' ').trim();
    return {
      ...check,
      pass: false,
      error: `did not report JSON (exit ${run.status})${detail ? `: ${detail}` : ''}`,
      violations: [],
      ambiguous: [],
    };
  }

  return {
    ...check,
    pass: report.pass === true,
    filesScanned: report.filesScanned,
    violations: report.violations ?? [],
    ambiguous: report.ambiguous ?? [],
    notes: report.notes ?? [],
  };
}

const results = CHECKS.map(runCheck);
const pass = results.every((result) => result.pass);

if (json) {
  process.stdout.write(`${JSON.stringify({ pass, projectDir, checks: results }, null, 2)}\n`);
}

function count(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** `file:line — reason`, plus the snippet on its own line when there is one. */
function formatItem(item) {
  const location = item.file ? `${item.file}${item.line ? `:${item.line}` : ''}  ` : '';
  const lines = [`    ${location}${item.reason ?? ''}`];
  if (item.snippet) {
    lines.push(`        ${item.snippet}`);
  }
  return lines.join('\n');
}

const idWidth = Math.max(...CHECKS.map((check) => check.id.length));

process.stderr.write(`Validating ${projectDir}\n\n`);
for (const result of results) {
  const mark = result.pass ? '✓' : '✗';
  const id = result.id.padEnd(idWidth);
  let detail;
  if (result.error) {
    detail = `ERROR — ${result.error}`;
  } else if (result.violations.length > 0) {
    detail = count(result.violations.length, 'violation');
  } else {
    detail = typeof result.filesScanned === 'number' ? count(result.filesScanned, 'file') : 'ok';
  }
  const ambiguous =
    result.ambiguous.length > 0 ? `  (${count(result.ambiguous.length, 'ambiguous case')})` : '';
  process.stderr.write(`  ${mark} ${id}  ${detail}${ambiguous}\n`);
}

for (const result of results) {
  if (result.violations.length === 0) {
    continue;
  }
  process.stderr.write(`\n${result.id} — ${count(result.violations.length, 'violation')}:\n`);
  for (const violation of result.violations) {
    process.stderr.write(`${formatItem(violation)}\n`);
  }
}

// Ambiguous cases are not failures on their own (without --ci): they are the ones a line-based
// scan cannot decide, so they need a human or a subagent to read the line.
const ambiguousTotal = results.reduce((sum, result) => sum + result.ambiguous.length, 0);
if (ambiguousTotal > 0) {
  process.stderr.write(`\nAMBIGUOUS — needs review (${ambiguousTotal}):\n`);
  for (const result of results) {
    for (const item of result.ambiguous) {
      process.stderr.write(`${formatItem({ ...item, reason: `[${result.id}] ${item.reason ?? ''}` })}\n`);
    }
  }
}

if (pass) {
  process.stderr.write(
    ambiguousTotal > 0
      ? `\nPASS — ${CHECKS.length} checks, no violations (ambiguous cases above need review).\n`
      : `\nPASS — all ${CHECKS.length} checks.\n`,
  );
  process.exit(0);
}

const failed = results.filter((result) => !result.pass);
const summary = failed
  .map((result) => {
    if (result.error) {
      return `${result.id} — ${result.error}`;
    }
    // Under `--ci` a check can fail on ambiguous cases alone, where `0 violations` would say
    // nothing about why it failed.
    const reasons = [];
    if (result.violations.length > 0) {
      reasons.push(count(result.violations.length, 'violation'));
    }
    if (result.ambiguous.length > 0) {
      reasons.push(count(result.ambiguous.length, 'ambiguous case'));
    }
    return `${result.id} — ${reasons.join(', ') || count(0, 'violation')}`;
  })
  .join('; ');
process.stderr.write(`\nFAILED: ${summary}\n`);
process.exit(1);
