/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Vite plugin that keeps `src/audio/audioSizes.json` in step with the audio files under `public/`.
 *
 * `buildStart` is the hook because it fires for `vite` (dev server), `vite build`, and Vitest — one
 * place covers every way the game runs, where npm `pre*` scripts would need one hook per script and
 * still miss the test runner.
 *
 * It rewrites the sidecar whenever a file's hash no longer matches, so the numbers in a manifest are
 * measured rather than maintained. The file is committed, so the change shows up in review and a
 * fresh clone typechecks before Vite has ever run.
 *
 * See `scripts/audio-sizes.mjs` for the measurement itself and `docs/audio-banks.md` for why the
 * numbers exist.
 */

import fs from 'node:fs';
import path from 'node:path';

import { measureAudioSizes, serialize } from './audio-sizes.mjs';

const SIDECAR = 'src/audio/audioSizes.json';

export function audioSizes({ root } = {}) {
  // Taken from Vite's resolved config rather than defaulted to `process.cwd()`: this config sets
  // `root: 'src'` with `publicDir: '../public'`, so the project directory is Vite's root's parent,
  // and a run launched from anywhere else (a workspace root, an IDE-started test) would otherwise
  // look for `public/` in the wrong place, find nothing, and silently no-op. An explicit `root`
  // option still wins, for a caller that knows better.
  let projectDir = root ?? process.cwd();
  // Passed through to the measurement rather than re-derived from `projectDir`, which would
  // re-append a hard-coded `public` and so agree only while the basename is literally `public`.
  // `undefined` lets `measureAudioSizes` apply its own default.
  let publicDir;

  return {
    name: 'webapp-game-audio-sizes',
    configResolved(config) {
      if (root !== undefined) {
        return;
      }
      // Anchored on `publicDir`, because that is the tree the measurement actually scans. It is
      // not simply `root`'s child here (`root: 'src'`, `publicDir: '../public'`), so deriving the
      // project directory from anything else can disagree with what Vite resolved. This assumes
      // `publicDir` is a direct child of the project directory; a game that nests it deeper must
      // also update `PUBLIC_DIR` in `audio-sizes.mjs`, or the CLI and this plugin disagree about
      // where the sidecar lives.
      publicDir = config.publicDir || undefined;
      projectDir = config.publicDir
        ? path.dirname(config.publicDir)
        : path.resolve(config.root, '..');
    },
    buildStart() {
      const sidecarPath = path.join(projectDir, SIDECAR);
      const { sizes, unreadable, undecodable } = measureAudioSizes(projectDir, publicDir);
      const count = Object.keys(sizes).length;
      const current = fs.existsSync(sidecarPath) ? fs.readFileSync(sidecarPath, 'utf8') : null;

      if (count === 0 && current === null) {
        // A synth-only game has no audio files and needs no sidecar.
        return;
      }

      // The one serializer, shared with the CLI: `audio-sizes:check` compares this output
      // byte-for-byte, so a second copy of the format here would break the check the moment
      // either changed.
      const next = serialize(sizes);
      if (current === next) {
        return;
      }

      fs.mkdirSync(path.dirname(sidecarPath), { recursive: true });
      fs.writeFileSync(sidecarPath, next);
      this.warn(
        `${SIDECAR} was stale and has been regenerated (${count} file(s)). Commit it.` +
          (undecodable.length > 0
            ? ` No duration for: ${undecodable.join(', ')} — treated as unknown sizes.`
            : '') +
          // Distinct from the above: these produced no entry at all, so the manifest's
          // hand-written numbers for them stay unmeasured.
          (unreadable.length > 0
            ? ` Could not read: ${unreadable.join(', ')} — left unmeasured.`
            : ''),
      );
    },
  };
}
