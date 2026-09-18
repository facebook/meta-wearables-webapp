/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

import type { Plugin } from 'vite';

/**
 * Type declarations for `vite-log-api.mjs`.
 *
 * The scaffold's `tsconfig.json` has `"include": ["src", "vite.config.ts"]`, and Step 4 of this
 * skill imports `logApiPlugin` into `vite.config.ts`. Without these declarations the very first
 * `npm run typecheck` after adding remote logging fails with
 * `TS7016: Could not find a declaration file for module './scripts/vite-log-api.mjs'`.
 *
 * Keep this file next to the `.mjs` it describes: under `moduleResolution: "bundler"` TypeScript
 * resolves it by the `.d.mts` sibling convention.
 */
export declare function logApiPlugin(): Plugin;

/** Merge `<dir>/.env` into `env`, filling only keys not already present. */
export declare function loadDotEnvInto(
  dir: string,
  env?: NodeJS.ProcessEnv,
): void;

/** The logging-enabled game URL and the portal URL, or `null` without a token. */
export declare function logUrlsFor(
  baseUrl: string,
  token: string | undefined,
): { game: string; portal: string } | null;
