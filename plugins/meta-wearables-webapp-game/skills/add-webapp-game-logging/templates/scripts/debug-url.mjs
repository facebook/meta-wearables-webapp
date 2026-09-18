#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Print the URLs for launching a debug-logging session on the glasses.
 *
 * Emits BOTH forms, because they are used in different places:
 *   1. the plain game URL — to open in a desktop browser, or type into the glasses browser;
 *   2. the `fb-viewapp://` deep link — to turn into a QR code and scan with your phone, which
 *      registers the webapp on the glasses.
 *
 * The deep link's `appUrl` must be percent-encoded so the game's own `?`/`&` survive; getting that
 * wrong registers the URL without its flags and fails silently. That rule lives in
 * `scripts/lib/deep-link.mjs`.
 *
 * By default the deep link registers a SEPARATE "(debug)" entry, so the glasses launcher shows the
 * normal game and the debug build side by side and you never re-register to toggle logging.
 *
 * Usage:
 *   node scripts/debug-url.mjs <base-url> [options]
 *
 * Options:
 *   --token=<t>    the LOG_TOKEN value; enables remote logging (omit for local-only logging)
 *   --level=<l>    log level: error|warn|info|debug|trace  (default: debug)
 *   --name=<n>     app name for the deep link (default: the package.json name)
 *   --logview      also show the on-screen log overlay on the glasses
 *   --stats        also show the performance overlay
 *   --same-name    register under the plain app name instead of "<name> (debug)"
 *
 * Example:
 *   node scripts/debug-url.mjs https://my-game.vercel.app --token=k3j9xz --logview
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  MAX_QR_CHARS,
  buildDeepLink,
  buildGameUrl,
  debugAppName,
} from './lib/deep-link.mjs';

const USAGE = 'Usage: node scripts/debug-url.mjs <base-url> [--token=X] [--level=debug] [--name=N] [--logview] [--stats] [--same-name]';

const options = { level: 'debug' };
const positionals = [];
for (const arg of process.argv.slice(2)) {
  if (arg === '--logview') {
    options.logview = true;
  } else if (arg === '--stats') {
    options.stats = true;
  } else if (arg === '--same-name') {
    options.sameName = true;
  } else if (arg.startsWith('--token=')) {
    options.token = arg.slice('--token='.length);
  } else if (arg.startsWith('--level=')) {
    options.level = arg.slice('--level='.length);
  } else if (arg.startsWith('--name=')) {
    options.name = arg.slice('--name='.length);
  } else if (arg.startsWith('--')) {
    process.stderr.write(`Unknown option: ${arg}\n${USAGE}\n`);
    process.exit(2);
  } else {
    positionals.push(arg);
  }
}

if (positionals.length !== 1) {
  process.stderr.write(`Expected exactly one base URL.\n${USAGE}\n`);
  process.exit(2);
}

let gameUrl;
try {
  gameUrl = buildGameUrl(positionals[0], {
    level: options.level,
    logkey: options.token,
    logview: options.logview,
    stats: options.stats,
  });
} catch {
  process.stderr.write(`Not a valid URL: ${positionals[0]}\n${USAGE}\n`);
  process.exit(2);
}

/** Fall back to the package name so the launcher entry matches the project. */
function packageName() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.resolve('package.json'), 'utf8'));
    return typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : 'game';
  } catch {
    return 'game';
  }
}

const baseName = options.name ?? packageName();
const appName = options.sameName ? baseName : debugAppName(baseName);
const deepLink = buildDeepLink(appName, gameUrl);

process.stdout.write(`${JSON.stringify({ gameUrl, appName, deepLink }, null, 2)}\n`);

process.stderr.write(`
Game URL (open in a browser, or type into the glasses browser):
  ${gameUrl}

Deep link (turn into a QR code, scan with your phone to register on the glasses):
  ${deepLink}

Next: generate the QR with the /qr-code skill, e.g.
  python3 <qr-code-skill>/scripts/qr_generator.py --png qr-debug.png --open '${deepLink}'
`);

if (!options.token) {
  process.stderr.write(
    'NOTE: no --token, so this session logs locally only (console + ?logview). Pass --token=<LOG_TOKEN> to send logs to the portal.\n',
  );
}
if (deepLink.length > MAX_QR_CHARS) {
  process.stderr.write(
    `WARNING: the deep link is ${deepLink.length} chars, over the ~${MAX_QR_CHARS} the QR generator supports. ` +
      'Shorten the token or the app name, or use a shorter domain.\n',
  );
}
