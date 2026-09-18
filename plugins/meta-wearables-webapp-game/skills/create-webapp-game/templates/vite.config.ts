/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';

// @ts-expect-error -- plain .mjs tooling, deliberately not part of the typechecked src/ tree.
import { audioSizes } from './scripts/vite-audio-sizes.mjs';
// @ts-expect-error -- plain .mjs tooling, deliberately not part of the typechecked src/ tree.
import { serviceWorker } from './scripts/vite-service-worker.mjs';

// Single config for both Vite (dev/build) and Vitest (unit tests).
//
// - root 'src': index.html lives next to the code it loads.
// - publicDir '../public': static assets copied verbatim into the build.
// - base './': the built index.html references assets relatively (./_vite/...), so the
//   bundle works when served from a sub-path rather than the server root.
// - build.assetsDir '_vite': the bundler's content-hashed output goes somewhere `public/` cannot
//   reach. Vite's default puts it in `assets/`, which `public/assets/...` is copied straight into,
//   so the two share a URL prefix and no cache rule can tell a hashed file from a verbatim one.
//   Separating them is what lets `vercel.json` mark `_vite/` immutable for a year.
//
// The dev server is left on Vite's default localhost-only bind: it serves the game's source
// unauthenticated, so it should stay reachable only from this machine.
export default defineConfig({
  // audioSizes keeps src/audio/audioSizes.json in step with public/assets/sounds/ (no-ops for a
  // game with no audio files). serviceWorker emits dist/sw.js, which precaches the build so a
  // second launch reads from disk; build-only, so `npm run dev` is unaffected. See
  // scripts/vite-audio-sizes.mjs, scripts/vite-service-worker.mjs and docs/offline-caching.md.
  plugins: [audioSizes(), serviceWorker()],
  root: 'src',
  publicDir: '../public',
  base: './',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    assetsDir: '_vite',
    // Vite's 500 kB default measures the chunk *uncompressed*, which Three.js alone puts a fresh
    // scaffold past: 625.93 kB raw / 165.12 kB gzip (`vite build` on an unmodified scaffold,
    // plugin 2.0.34). The budget the platform actually sets is the gzipped one — `< 500 KB
    // gzipped` in `docs/core-contract.md` — and 165 kB sits at a third of it.
    //
    // 800 kB is ~211 kB gzipped at this bundle's ratio: still well inside the platform budget,
    // but only ~175 kB of raw growth away, so a genuinely bloating bundle still trips it.
    chunkSizeWarningLimit: 800,
  },
  test: {
    environment: 'node',
    // Resolved relative to the Vite `root` ('src'), so this matches src/**/*.test.ts.
    include: ['**/*.test.ts'],
  },
});
