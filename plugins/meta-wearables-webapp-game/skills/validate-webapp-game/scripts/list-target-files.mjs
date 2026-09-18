#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Print the project-relative paths of every file the input-handler check looks at, one per
 * line. This is the enumeration helper an orchestrator iterates: run it, then fan a subagent
 * out per line for any FUTURE validation step that needs LLM judgment. (The input-handler
 * check itself is fully scriptable — see validate-input-handlers.mjs — so it needs no
 * subagent.)
 *
 * Usage: node list-target-files.mjs [project-dir]   (defaults to the current directory)
 */

import path from 'node:path';
import { walk } from './lib/scan.mjs';

const projectDir = path.resolve(process.argv[2] ?? '.');
for (const { rel } of walk(projectDir)) {
  process.stdout.write(`${rel}\n`);
}
