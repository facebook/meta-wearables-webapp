/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Variable-timestep game loop. Advances the simulation once per animation frame using the
 * real elapsed frame delta, and renders right after. A variable timestep keeps gameplay
 * smooth across varying framerates and forward-compatible with devices that refresh at
 * different rates. Stops cleanly so no work runs when the app is backgrounded (per the
 * performance guidelines — no continuous work when idle).
 *
 * Projects that need deterministic physics can swap this for a fixed-timestep accumulator.
 *
 * `step()` is the manual alternative to the rAF schedule: one frame of an explicit delta, run
 * when the caller says so. It backs the `?drive` harness (`framework/debug/DriveHarness.ts`),
 * which pauses the loop so a screenshot lands at a known simulation state rather than wherever
 * the frame clock happened to be.
 */

/** Fallback frame-delta cap (ms) used when the caller doesn't pass one. */
const DEFAULT_MAX_FRAME_MS = 250;

/** Fallback delta (seconds) for a manual `step()` when neither the call nor the options set one. */
const DEFAULT_STEP_SECONDS = 1 / 60;

export interface Updatable {
  update(dt: number): void;
  render(): void;
}

export interface GameLoopOptions {
  /**
   * Cap on a single frame's delta (ms) so a long pause doesn't produce a huge jump. Passed
   * in (not imported) so the framework stays free of game-owned config. Defaults to
   * `DEFAULT_MAX_FRAME_MS`.
   */
  maxFrameMs?: number;
  /**
   * Delta (SECONDS) a `step()` with no explicit argument advances the simulation by. Passed in
   * (not imported) so the framework stays free of game-owned config. Defaults to
   * `DEFAULT_STEP_SECONDS`.
   */
  stepSeconds?: number;
}

export class GameLoop {
  private running = false;
  private rafId = 0;
  private lastTime = 0;
  private readonly maxFrameMs: number;
  private readonly stepSeconds: number;
  private readonly frame: (now: number) => void;

  public constructor(
    private readonly game: Updatable,
    options: GameLoopOptions = {},
  ) {
    this.maxFrameMs = options.maxFrameMs ?? DEFAULT_MAX_FRAME_MS;
    this.stepSeconds = options.stepSeconds ?? DEFAULT_STEP_SECONDS;
    this.frame = (now: number): void => this.tick(now);
  }

  public isRunning(): boolean {
    return this.running;
  }

  /** The delta a `step()` uses when the caller doesn't pass one. */
  public getStepSeconds(): number {
    return this.stepSeconds;
  }

  /**
   * Advance the simulation by exactly one frame of `dtSeconds`, off the animation-frame clock
   * entirely — the caller decides both when a frame happens and how long it was. That makes a
   * driven run reproducible in TIMING (it does not make it reproducible in general: a game
   * calling `Math.random()` still diverges run to run).
   *
   * Returns `false` and does nothing while the loop is running, because interleaving manual
   * steps with rAF ticks reproduces neither schedule. Stop the loop first.
   */
  public step(dtSeconds: number = this.stepSeconds): boolean {
    if (this.running) {
      return false;
    }
    this.game.update(dtSeconds);
    this.game.render();
    return true;
  }

  public start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.lastTime = performance.now();
    this.rafId = requestAnimationFrame(this.frame);
  }

  public stop(): void {
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }

  private tick(now: number): void {
    if (!this.running) {
      return;
    }
    // Clamp the frame delta so a long pause (e.g. backgrounding) doesn't produce a huge
    // jump that teleports objects across the world.
    const dtMs = Math.min(now - this.lastTime, this.maxFrameMs);
    this.lastTime = now;

    this.game.update(dtMs / 1000);
    this.game.render();
    this.rafId = requestAnimationFrame(this.frame);
  }
}
