/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * The `?drive` harness: pause the game loop and advance it one explicit frame at a time from
 * outside the page.
 *
 * A game running on the animation-frame clock advances between any two commands an external
 * driver sends, so a screenshot lands at whatever simulation state the frame clock happened to
 * reach, and a before/after pixel diff of a game that animates on its own proves nothing. Under
 * `?drive` no frame runs until something calls `step()`, so both become well-defined: the state
 * is exactly the number of frames that were asked for.
 *
 * **This makes a run reproducible in TIMING, not in general.** A game calling `Math.random()`
 * still produces a different run each time; stepping does not seed anything.
 *
 * The harness deliberately exposes the LOOP only. Game state is read through the separate
 * `window.__game` handle that `main.ts` installs — keeping the two apart means this file has no
 * opinion about what a game is.
 *
 * Everything here is debug-only and reached from the console / DevTools protocol, never from
 * game code.
 */

/** Global the harness is installed on. Matches what `cdp.mjs` looks for. */
const DEFAULT_GLOBAL_NAME = '__webappGame';

/** The subset of `GameLoop` the harness drives. Structural, so tests can pass a fake. */
export interface DrivableLoop {
  step(dtSeconds?: number): boolean;
  start(): void;
  stop(): void;
  isRunning(): boolean;
  getStepSeconds(): number;
}

/** What `status()` reports: loop state and how far the driven run has advanced. */
export interface DriveStatus {
  driven: true;
  running: boolean;
  /** Frames advanced by `step()` since the harness was installed. */
  frames: number;
  /** Simulated seconds those frames added up to. */
  simSeconds: number;
  /** The default per-frame delta, i.e. what `step(n)` uses without an explicit `dt`. */
  stepSeconds: number;
}

/** The object installed on `window`. */
export interface DriveHarness {
  /**
   * Advance `frames` frames of `dtSeconds` each (default: the loop's `stepSeconds`). Returns the
   * number actually advanced — `0` when the loop is running, since a manual step and an rAF tick
   * cannot be interleaved deterministically.
   */
  step(frames?: number, dtSeconds?: number): number;
  /** Hand control back to the animation-frame clock. */
  resume(): void;
  /** Take control back. Idempotent. */
  pause(): void;
  isRunning(): boolean;
  status(): DriveStatus;
}

export interface InstallDriveHarnessOptions {
  /** Global to install on. Defaults to `globalThis`. */
  target?: Record<string, unknown>;
  /** Property name. Defaults to `__webappGame`. */
  globalName?: string;
}

/**
 * Whether drive mode was requested via the URL query string. Pass `window.location.search`.
 * Present with any value except `0` / `false` enables it (`?drive`, `?drive=1` → true;
 * `?drive=0`, `?drive=false`, absent → false). DOM-free so it is unit-testable.
 */
export function driveModeRequested(search: string): boolean {
  const value = new URLSearchParams(search).get('drive');
  if (value === null) {
    return false;
  }
  return value !== '0' && value.toLowerCase() !== 'false';
}

/**
 * Install the harness and return it. The caller is responsible for NOT having started the loop:
 * this does not stop a running one, because a game that briefly ran before being driven has
 * already advanced by an unknown amount and silently hiding that would defeat the point.
 */
export function installDriveHarness(
  loop: DrivableLoop,
  options: InstallDriveHarnessOptions = {},
): DriveHarness {
  let frames = 0;
  let simSeconds = 0;

  const harness: DriveHarness = {
    step(frameCount = 1, dtSeconds = loop.getStepSeconds()): number {
      let advanced = 0;
      for (let i = 0; i < frameCount; i++) {
        if (!loop.step(dtSeconds)) {
          break;
        }
        advanced++;
        frames++;
        simSeconds += dtSeconds;
      }
      return advanced;
    },
    resume(): void {
      loop.start();
    },
    pause(): void {
      loop.stop();
    },
    isRunning(): boolean {
      return loop.isRunning();
    },
    status(): DriveStatus {
      return {
        driven: true,
        running: loop.isRunning(),
        frames,
        simSeconds,
        stepSeconds: loop.getStepSeconds(),
      };
    },
  };

  const target = options.target ?? (globalThis as unknown as Record<string, unknown>);
  target[options.globalName ?? DEFAULT_GLOBAL_NAME] = harness;
  return harness;
}
