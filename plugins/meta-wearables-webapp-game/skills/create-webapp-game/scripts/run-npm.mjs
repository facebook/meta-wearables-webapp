/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Spawning npm portably.
 *
 * Its own module so that `init-game.mjs` can stay a pure executable: a test that needs `runNpm`
 * imports this instead, which is what lets that script call `main()` unconditionally rather than
 * guarding on whether it is the entry point. A guard like that is a branch which silently does
 * nothing when it misfires, and the only reason to carry one was to survive being imported.
 */

import { spawnSync } from 'node:child_process';

/** cmd.exe's exit code for a command it cannot resolve — its equivalent of a POSIX `ENOENT`. */
const CMD_NOT_FOUND = 9009;

/**
 * Run npm. On Windows npm is `npm.cmd`, which Node refuses to exec directly, so only a shell can
 * resolve it — and with `shell: true` an args array is DEP0190-deprecated and gets concatenated
 * unescaped anyway, so pass one pre-joined string instead. Every token callers pass here is a
 * fixed literal; that has to stay true, or the join below becomes an injection point.
 *
 * Going through a shell also hides the one failure the caller most needs to name. cmd.exe reports
 * an unresolvable `npm` as its own exit 9009, not as a spawn error, so the missing-npm case would
 * be indistinguishable from npm running and failing — on the very platform this branch exists for.
 * Normalizing it back to the POSIX shape (`status: null` plus an `error`) keeps the caller's
 * diagnostic platform-agnostic.
 *
 * 9009 alone does not prove that, though: npm exits with its child's code, so a lifecycle script
 * that calls a missing binary produces a 9009 from an npm that resolved perfectly well. Rewriting
 * that one would invert the diagnostic in the other direction and, in the gate path, report a real
 * failure as `exited null`. So the code is only a hint, and `npm --version` settles it — one extra
 * spawn, reached only on a 9009, and never on the happy path.
 *
 * The probe inherits the caller's options so it resolves npm under the same `cwd` and `env` as the
 * command it is adjudicating. Probing the ambient environment instead would let it reach the
 * opposite conclusion from the real call, which is the misdiagnosis this whole path exists to
 * prevent. Only `stdio` is overridden — the version string is noise.
 */
export function runNpm(args, options) {
  if (process.platform !== 'win32') return spawnSync('npm', args, options);

  const result = spawnSync(['npm', ...args].join(' '), { ...options, shell: true });
  if (result.status !== CMD_NOT_FOUND || result.error) return result;

  const probe = spawnSync('npm --version', { ...options, shell: true, stdio: 'ignore' });
  return probe.status === CMD_NOT_FOUND || probe.error
    ? { ...result, status: null, error: new Error("'npm' is not recognized by cmd.exe") }
    : result;
}
