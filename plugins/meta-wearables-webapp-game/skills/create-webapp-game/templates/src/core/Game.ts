/**
 * The game orchestrator. Renderer- and input-agnostic: it receives a `Renderer` and an
 * `InputManager` through its constructor and never imports `three` or touches the DOM. That
 * is what makes it unit-testable (see `Game.test.ts`, which drives it with fakes).
 *
 * The starter game: a wireframe player cube you step around with the D-pad (arrow keys on
 * desktop), which glides toward the square you aimed it at. It also shows the discrete select
 * gesture — an index tap (`pinchTap`, `Enter` on desktop) scores a point. Replace this with
 * yours.
 *
 * This game is TAP-ONLY — it uses the two channels every Meta Display Glasses game gets for free,
 * `dpadSwipe` and `pinchTap`. The index pinch-and-MOVE (drag) channel is a separate opt-in;
 * see the plugin's docs/drag-channel.md.
 */

import type { SoundId } from '@/audio/soundIds';
import { PLAYER } from '@/config/gameplayConstants';
import type { AudioPlayer } from '@/framework/audio/AudioPlayer';
import type { DpadDirection, InputManager } from '@/framework/input/InputManager';
import { Vector3, clamp } from '@/framework/math/Vector3';
import type { Renderer, RenderHandle } from '@/framework/render/Renderer';
import type { ModelId } from '@/models';

/** Unit step for each D-pad direction, in world axes (screen-up is world-up). */
const STEP: Readonly<Record<DpadDirection, { x: number; y: number }>> = {
  up: { x: 0, y: 1 },
  down: { x: 0, y: -1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};

export class Game {
  private readonly playerHandle: RenderHandle;
  private readonly playerPosition = new Vector3(0, 0, 0);
  /** Where the player is heading; `update` glides `playerPosition` toward this. */
  private readonly targetPosition = new Vector3(0, 0, 0);
  private score = 0;

  public constructor(
    private readonly renderer: Renderer<ModelId>,
    private readonly input: InputManager,
    // Typed with the game's own sound-id union (like `Renderer<ModelId>`), so `play('lazer')` is a
    // compile error. The ids come from src/audio/soundIds.ts, beside audioSettings.json.
    private readonly audio: AudioPlayer<SoundId>,
  ) {
    this.playerHandle = this.renderer.addModel('player');
    // The two channels every game gets: a D-pad swipe steps the player, an index pad-pinch tap
    // is the primary "select" action — here it scores a point.
    this.input.on('dpadSwipe', (direction) => this.onSwipe(direction));
    this.input.on('pinchTap', () => this.onSelect());
  }

  /** Current score (read by the HUD). */
  public getScore(): number {
    return this.score;
  }

  /** Advance the simulation by one frame. */
  public update(dt: number): void {
    // `moveSpeed` is a RATE (world units per second), so it is multiplied by the frame delta —
    // that is what makes the glide take the same wall-clock time at 30 fps and at 60. Only
    // rate-based motion works this way: an input-supplied per-frame displacement (the drag
    // channel's movement delta) is already frame-scoped and must NOT be multiplied by dt.
    const step = PLAYER.moveSpeed * dt;
    this.playerPosition.set(
      approach(this.playerPosition.x, this.targetPosition.x, step),
      approach(this.playerPosition.y, this.targetPosition.y, step),
      this.playerPosition.z,
    );
    this.renderer.setTransform(this.playerHandle, this.playerPosition);
  }

  /** Draw one frame. */
  public render(): void {
    this.renderer.render();
  }

  /** D-pad swipe → aim the player one step further in that direction, within bounds. */
  private onSwipe(direction: DpadDirection): void {
    const step = STEP[direction];
    this.targetPosition.set(
      clamp(this.targetPosition.x + step.x * PLAYER.stepSize, -PLAYER.bound, PLAYER.bound),
      clamp(this.targetPosition.y + step.y * PLAYER.stepSize, -PLAYER.bound, PLAYER.bound),
      this.targetPosition.z,
    );
  }

  /** Index pinch select → score a point. */
  private onSelect(): void {
    this.score += 1;
    // Play the `select` sound (an example synth definition registered in main.ts — see
    // src/audio/audioSettings.json). Pass `{ position }` to spatialize. See `docs/audio.md`.
    this.audio.play('select');
  }
}

/** Move `value` toward `target` by at most `maxStep`, never overshooting. */
function approach(value: number, target: number, maxStep: number): number {
  const remaining = target - value;
  if (Math.abs(remaining) <= maxStep) {
    return target;
  }
  return value + Math.sign(remaining) * maxStep;
}
