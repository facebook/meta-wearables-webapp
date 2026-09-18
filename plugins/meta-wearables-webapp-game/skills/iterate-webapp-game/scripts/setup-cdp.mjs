#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * setup-cdp.mjs — Idempotently wire the CDP Chrome launcher into a Meta Display Glasses game project so
 * `npm run chrome` works. Copies `start-chrome-cdp.sh` into the project's `scripts/` and adds a
 * `"chrome"` npm script to its package.json. Safe to run repeatedly.
 *
 * Usage: node setup-cdp.mjs [project-dir]
 *   project-dir  the game project to modify (default: current directory)
 *
 * Output: machine-readable JSON on stdout; a human summary on stderr.
 * Exit code: 0 on success; 2 on bad usage (no package.json).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(process.argv[2] ?? '.');
const pkgPath = path.join(projectDir, 'package.json');
const CHROME_CMD = 'bash scripts/start-chrome-cdp.sh';
const actions = [];

if (!fs.existsSync(pkgPath)) {
  bail(`No package.json in ${projectDir} — run this from a Meta Display Glasses game project (or pass its path).`);
}

// 1) Copy the launcher into the project's scripts/ (so the npm script can reference it locally).
const scriptsDir = path.join(projectDir, 'scripts');
fs.mkdirSync(scriptsDir, { recursive: true });
const launcherSrc = path.join(here, 'start-chrome-cdp.sh');
const launcherDst = path.join(scriptsDir, 'start-chrome-cdp.sh');
const srcContent = fs.readFileSync(launcherSrc, 'utf8');
const dstContent = fs.existsSync(launcherDst) ? fs.readFileSync(launcherDst, 'utf8') : null;
if (dstContent !== srcContent) {
  fs.writeFileSync(launcherDst, srcContent);
  actions.push(dstContent == null ? 'wrote scripts/start-chrome-cdp.sh' : 'updated scripts/start-chrome-cdp.sh');
} else {
  actions.push('scripts/start-chrome-cdp.sh already up to date');
}
fs.chmodSync(launcherDst, 0o755);

// 2) Add the "chrome" npm script (idempotent; never clobbers a differing existing one).
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
pkg.scripts = pkg.scripts || {};
if (pkg.scripts.chrome === CHROME_CMD) {
  actions.push('package.json "chrome" script already present');
} else if (pkg.scripts.chrome) {
  actions.push(`package.json already has a different "chrome" script (left as-is): ${pkg.scripts.chrome}`);
} else {
  pkg.scripts.chrome = CHROME_CMD;
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  actions.push('added "chrome" script to package.json');
}

process.stdout.write(JSON.stringify({ ok: true, projectDir, actions }, null, 2) + '\n');
process.stderr.write(
  `CDP setup for ${projectDir}:\n` + actions.map(a => `  - ${a}`).join('\n') +
  '\n\nNext: start `npm run chrome` (in a SEPARATE terminal if your sandbox blocks launching Chromium), then use the iterate skill.\n',
);

function bail(msg) {
  process.stdout.write(JSON.stringify({ ok: false, error: msg }, null, 2) + '\n');
  process.stderr.write(msg + '\n');
  process.exit(2);
}
