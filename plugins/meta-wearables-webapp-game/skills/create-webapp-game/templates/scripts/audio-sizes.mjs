#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Generate `src/audio/audioSizes.json` — the measured `bytes` and `pcmBytes` for every audio file
 * under `public/`.
 *
 * Those two numbers are the only thing in a preload manifest that cannot be written correctly by
 * hand: `bytes` is the file size and `pcmBytes` is what the file becomes once decoded. Keeping them
 * accurate manually is a sync burden and a silent source of wrong memory budgets, so they are
 * measured instead and merged into the hand-written manifest by `withAudioSizes()`.
 *
 * Each entry carries the file's `sha256`, which is what makes staleness detectable: the Vite plugin
 * regenerates on mismatch during `dev` and `build`, and `--check` fails when the committed sidecar
 * no longer describes the committed audio.
 *
 * The sidecar is **committed**, not generated-on-demand, because `npm run build` runs `tsc` before
 * Vite — a file that only appears once Vite starts would break typecheck on a fresh clone.
 *
 * Usage:
 *   node scripts/audio-sizes.mjs [project-dir]            write the sidecar if it changed
 *   node scripts/audio-sizes.mjs [project-dir] --check    exit 1 if it is stale, write nothing
 *
 * A format the parser does not decode still gets an entry — `sha256` and `bytes` — just no
 * `pcmBytes`. That is safe: the audio subsystem treats a missing size as unknown and falls back to
 * a sequential bank swap rather than trusting an estimate it does not have. Only a file that
 * cannot be READ is omitted entirely, and `--check` fails on that. See `docs/audio-banks.md`.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { audioMetadata, pcmBytesFor } from './lib/audio-metadata.mjs';

/** Extensions worth measuring — everything a browser might decode. */
const AUDIO_EXTENSIONS = new Set([
  '.ogg', '.oga', '.opus', '.mp3', '.wav', '.m4a', '.aac', '.flac', '.weba', '.webm',
]);

const SIDECAR = 'src/audio/audioSizes.json';
const PUBLIC_DIR = 'public';

/** Recursively collect audio files under `dir`, keyed by their `public/`-relative POSIX path. */
function findAudioFiles(publicDir) {
  const found = [];
  const stack = [publicDir];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const abs = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(abs);
      } else if (entry.isFile() && AUDIO_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        found.push({ abs, key: path.relative(publicDir, abs).split(path.sep).join('/') });
      }
    }
  }
  return found.sort((a, b) => a.key.localeCompare(b.key));
}

/**
 * Measure every audio file under the project's public directory. Returns the sidecar object: keys
 * are the manifest `path` values, so the merge is a direct lookup.
 *
 * `publicDir` defaults to `<projectDir>/public` for the CLI, whose whole input is a project
 * directory. The Vite plugin passes Vite's resolved `publicDir` instead: it derives `projectDir`
 * from that path, so re-deriving the public directory here would agree only while its basename is
 * literally `public` — and a game that moved it would get a scan of a directory that does not
 * exist, no files, and a silent no-op.
 */
export function measureAudioSizes(projectDir, publicDir = path.join(projectDir, PUBLIC_DIR)) {
  const sizes = {};
  // Two lists, because the two outcomes need different actions: `unreadable` gets no sidecar entry
  // at all and means something is wrong with the file, while `undecodable` is measured for bytes
  // and merely has no duration — the normal result for a container this parser does not decode.
  const unreadable = [];
  const undecodable = [];
  for (const { abs, key } of findAudioFiles(publicDir)) {
    // Tolerated the way the `readdirSync` failure above is: a file that is listed but cannot be
    // read (permissions, or deleted between the scan and the read) leaves that entry unmeasured
    // rather than throwing out of the `buildStart` hook and aborting the whole Vite run.
    let buffer;
    try {
      buffer = fs.readFileSync(abs);
    } catch {
      unreadable.push(key);
      continue;
    }
    const entry = {
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      bytes: buffer.length,
    };
    const meta = audioMetadata(buffer);
    if (meta) {
      entry.pcmBytes = pcmBytesFor(meta.durationSeconds, meta.channels);
    } else {
      undecodable.push(key);
    }
    sizes[key] = entry;
  }
  return { sizes, unreadable, undecodable };
}

/**
 * Stable, diff-friendly serialization — keys sorted, two-space indent, trailing newline.
 *
 * Exported because the Vite plugin writes the same file and `--check` compares byte-for-byte: a
 * second copy of this format would let the two drift, and `audio-sizes:check` would then fail
 * immediately after the plugin had "fixed" the file.
 */
export function serialize(sizes) {
  const ordered = {};
  for (const key of Object.keys(sizes).sort()) {
    ordered[key] = sizes[key];
  }
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes('--check');
  const positional = args.filter((arg) => !arg.startsWith('-'));
  // An unrecognized flag is an error, not something to drop. `--chek` would otherwise fall
  // through to WRITE mode and exit 0 — in CI that rewrites the sidecar and passes the very
  // staleness gate the flag was meant to run. Any leading `-` counts: `-check` would otherwise be
  // taken as the project directory, scan a path that does not exist, and pass the same way.
  const unknown = args.filter((arg) => arg.startsWith('-') && arg !== '--check');
  if (unknown.length > 0 || positional.length > 1) {
    if (unknown.length > 0) {
      process.stderr.write(`Unknown option(s): ${unknown.join(' ')}\n`);
    }
    process.stderr.write('Usage: node audio-sizes.mjs [project-dir] [--check]\n');
    process.exit(2);
  }
  const projectDir = path.resolve(positional[0] ?? '.');

  // An empty scan is reported below as "synth-only game, nothing to write" and exits 0. That is
  // indistinguishable from being pointed at the wrong directory, because `findAudioFiles`
  // swallows the `readdirSync` failure for a missing `public/` — so in CI a mistyped project-dir
  // would pass the very staleness gate `--check` exists to run. Anchor on `package.json` rather
  // than on `public/`: a synth-only game legitimately has no `public/` (the scaffold ships none),
  // so requiring that directory would fail exactly the projects the empty-scan path is for.
  if (!fs.existsSync(path.join(projectDir, 'package.json'))) {
    process.stderr.write(
      `audio-sizes: ${projectDir} is not a game project (no package.json). Pass the project ` +
        'directory, or run this from inside it.\n',
    );
    process.exit(2);
  }

  const sidecarPath = path.join(projectDir, SIDECAR);

  const { sizes, unreadable, undecodable } = measureAudioSizes(projectDir);
  const next = serialize(sizes);
  const current = fs.existsSync(sidecarPath) ? fs.readFileSync(sidecarPath, 'utf8') : null;
  const count = Object.keys(sizes).length;

  if (unreadable.length > 0) {
    process.stderr.write(
      `audio-sizes: could not READ ${unreadable.length} file(s): ${unreadable.join(', ')}. ` +
        'They have no sidecar entry at all, so whatever the manifest hand-writes for them is ' +
        'kept unmeasured. Check permissions.\n',
    );
  }
  if (undecodable.length > 0) {
    process.stderr.write(
      `audio-sizes: could not read duration for ${undecodable.length} file(s): ` +
        `${undecodable.join(', ')}. They are measured for bytes but left without pcmBytes, which ` +
        'the audio subsystem treats as an unknown size (safe — bank swaps stay sequential). ' +
        'Expected for MP3/M4A/AAC, whose containers this parser does not decode.\n',
    );
  }

  // Above the equality check, because an unreadable file gets no sidecar entry: if it never had
  // one, `next` is byte-identical to what is committed and the gate would pass on audio nothing
  // measured — the silent pass `--check` exists to prevent.
  if (check && unreadable.length > 0) {
    process.stderr.write(
      `audio-sizes: ${unreadable.length} file(s) could not be read, so they are unmeasured. ` +
        'Failing the check rather than passing a sidecar that silently omits them.\n',
    );
    process.exit(1);
  }

  if (current === next) {
    process.stderr.write(`audio-sizes: up to date (${count} file(s)).\n`);
    return;
  }

  // Above the --check branch, not below it: a synth-only game has nothing to write, so `next` is
  // `{}` while `current` is `null` and the equality above cannot match. Left below, `--check`
  // would call that stale and fail `npm run ship` with nothing for `npm run audio-sizes` to fix.
  if (count === 0 && current === null) {
    // A game with no audio needs no sidecar; do not create an empty one.
    process.stderr.write('audio-sizes: no audio files found; nothing to write.\n');
    return;
  }

  if (check) {
    process.stderr.write(
      `audio-sizes: ${SIDECAR} is stale. Run \`npm run audio-sizes\` and commit the result.\n`,
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
  fs.writeFileSync(sidecarPath, next);
  process.stderr.write(`audio-sizes: wrote ${SIDECAR} (${count} file(s)).\n`);
}

// Only run when invoked directly, so the measurement above stays importable by the Vite plugin.
// `pathToFileURL`, not a hand-built `file://` string: `import.meta.url` is percent-encoded, so a
// project path containing a space would never match and `npm run audio-sizes` would exit 0 having
// silently done nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
