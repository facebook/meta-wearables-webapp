/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Vite plugin that emits `dist/sw.js` — the service worker that precaches the build so a second
 * launch reads from disk instead of the network. See `docs/offline-caching.md` for the whole
 * feature and `src/framework/sw/precache.ts` for the caching logic itself.
 *
 * The precache list is derived by **scanning the finished build**, not by reading the game's
 * `preloadManifest` asset manifest. That manifest is opt-in, lives at a path only convention fixes,
 * and never covers the app shell (`index.html` and the hashed bundle) — which is most of a cold
 * start. Everything Vite copied from `public/` is already in `dist/`, so scanning it yields a strict
 * superset of the manifest, works for a game that declares no manifest at all, and gives a real
 * content hash per file. That hash is the point: it is what lets a republished build re-download
 * only the files that actually changed (see `installPrecache`).
 *
 * `closeBundle` is the hook because the precache list has to be hashes of the bytes actually
 * written, which only exist once the main build has finished writing them.
 *
 * The worker is bundled by invoking **Vite's own `build()`** rather than reaching for a bundler
 * directly. Vite is the one build dependency every scaffolded game is guaranteed to have, and which
 * bundler backs it has already changed once (Vite 8 ships rolldown where earlier versions used
 * esbuild) — going through the public API keeps this working across that. `configFile: false` stops
 * the nested build from loading this config and re-applying this plugin.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const SW_OUTPUT = 'sw.js';
const SW_ENTRY = 'src/framework/sw/service-worker.ts';

/** Short content hash. 16 hex chars is 64 bits — collision-free at any plausible file count. */
function hash(input) {
  return createHash('sha256').update(input).digest('hex').slice(0, 16);
}

function walk(dir, base = dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full, base));
    } else if (entry.isFile()) {
      out.push(path.relative(base, full).split(path.sep).join('/'));
    }
  }
  return out;
}

/**
 * Every file in `distDir` as a `{ url, rev, shell }` precache entry, sorted by URL so the emitted
 * worker is byte-stable for an unchanged build. The worker itself is excluded — it cannot precache
 * the file that contains its own precache list.
 *
 * `shell` marks the entry HTML and the bundler's hashed output: the things the game cannot boot
 * without, and so the only ones whose failure should fail the install.
 */
export function collectPrecacheEntries(distDir, { assetsDir = '_vite', exclude = [] } = {}) {
  const skip = new Set([SW_OUTPUT, `${SW_OUTPUT}.map`, ...exclude]);
  return walk(distDir)
    .filter((url) => !skip.has(url))
    .sort()
    .map((url) => ({
      url,
      rev: hash(fs.readFileSync(path.join(distDir, url))),
      ...(url === 'index.html' || url.startsWith(`${assetsDir}/`) ? { shell: true } : {}),
    }));
}

/**
 * Identity of a whole build, and the name of its cache. Derived from the entries so that any
 * content change alters it — which alters `sw.js`'s bytes, which is what makes the browser's
 * byte-comparison update check fire.
 */
export function buildId(entries) {
  return hash(JSON.stringify(entries));
}

/**
 * @param {{ entry?: string, fileName?: string, exclude?: string[] }} [options]
 *   `entry` is the worker source, project-relative. `exclude` lists build-relative URLs to leave
 *   out of the precache list (e.g. a large optional download a game fetches on demand).
 */
export function serviceWorker(options = {}) {
  const { entry = SW_ENTRY, fileName = SW_OUTPUT, exclude = [] } = options;
  let projectDir;
  let distDir;
  let assetsDir;

  return {
    name: 'webapp-game-service-worker',
    // Build only: a service worker alongside Vite's HMR produces stale-module bugs that read as
    // build failures, which is also why `registerGameServiceWorker` no-ops in dev.
    apply: 'build',
    configResolved(config) {
      // This config sets `root: 'src'` with `build.outDir: '../dist'`, so the project directory is
      // Vite's root's parent and the output directory resolves against the root, not the cwd.
      projectDir = path.dirname(config.root);
      distDir = path.resolve(config.root, config.build.outDir);
      assetsDir = config.build.assetsDir;
    },
    async closeBundle() {
      if (!fs.existsSync(distDir)) {
        return;
      }
      const entryPath = path.resolve(projectDir, entry);
      if (!fs.existsSync(entryPath)) {
        this.warn(`no service worker entry at ${entry}; skipping ${fileName}`);
        return;
      }

      const entries = collectPrecacheEntries(distDir, { assetsDir, exclude });
      const build = buildId(entries);

      const { build: viteBuild } = await import('vite');
      await viteBuild({
        configFile: false,
        root: projectDir,
        logLevel: 'warn',
        define: {
          __GAME_PRECACHE__: JSON.stringify(entries),
          __GAME_BUILD__: JSON.stringify(build),
        },
        build: {
          outDir: distDir,
          // The main build already wrote everything; wiping it here would delete the very files
          // this worker was just told to precache.
          emptyOutDir: false,
          target: 'es2022',
          copyPublicDir: false,
          lib: {
            entry: entryPath,
            // A classic (non-module) worker: module service workers are still unevenly supported,
            // and the worker has no reason to be one.
            formats: ['iife'],
            name: 'gameServiceWorker',
            fileName: () => fileName,
          },
        },
      });

      this.info?.(`${fileName}: ${entries.length} file(s) precached, build ${build}`);
    },
  };
}
