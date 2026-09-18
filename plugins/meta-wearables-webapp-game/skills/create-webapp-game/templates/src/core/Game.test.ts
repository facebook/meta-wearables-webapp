/**
 * Example unit test for the STARTER game. Because `Game` depends only on the `Renderer`,
 * `InputManager`, and `AudioPlayer` INTERFACES, it can be driven with tiny fakes in a plain
 * `node` environment — no GPU, no DOM. Write tests like this for all non-trivial game logic.
 *
 * These particular cases test the starter's tap-and-glide toy, so **replace this file wholesale
 * when you replace `Game.ts`** — but keep importing the fakes from `@/framework/testing/fakes`
 * rather than writing your own.
 */

import { describe, expect, it } from 'vitest';

import { PLAYER } from '@/config/gameplayConstants';
import { Game } from '@/core/Game';
import { FakeAudioPlayer, FakeInput, FakeRenderer } from '@/framework/testing/fakes';
import type { ModelId } from '@/models';

/** Position of the single player model the game registers. */
function playerPosition(renderer: FakeRenderer<ModelId>): { x: number; y: number; z: number } {
  const [position] = [...renderer.positions.values()];
  return position;
}

describe('Game', () => {
  it('glides the player toward the square a D-pad swipe aimed at', () => {
    const renderer = new FakeRenderer<ModelId>();
    const input = new FakeInput();
    const game = new Game(renderer, input, new FakeAudioPlayer());

    input.fire('dpadSwipe', 'right');
    // A frame short of the full step, so the player is still on the way.
    const dt = (PLAYER.stepSize / PLAYER.moveSpeed) / 2;
    game.update(dt);

    const position = playerPosition(renderer);
    expect(position.x).toBeCloseTo(PLAYER.moveSpeed * dt);
    expect(position.x).toBeLessThan(PLAYER.stepSize);
    expect(position.y).toBe(0);
  });

  it('stops exactly on the target instead of overshooting it', () => {
    const renderer = new FakeRenderer<ModelId>();
    const input = new FakeInput();
    const game = new Game(renderer, input, new FakeAudioPlayer());

    input.fire('dpadSwipe', 'up');
    game.update(10);
    game.update(10);

    expect(playerPosition(renderer).y).toBe(PLAYER.stepSize);
  });

  it('travels the same distance per second at any frame rate', () => {
    // `moveSpeed` is a rate, so one 0.5s frame must cover the same ground as five 0.1s frames.
    // Aim at the far bound so neither run reaches the target and saturates the comparison.
    const run = (frames: number, dt: number): number => {
      const renderer = new FakeRenderer<ModelId>();
      const input = new FakeInput();
      const game = new Game(renderer, input, new FakeAudioPlayer());
      for (let swipe = 0; swipe < 100; swipe++) {
        input.fire('dpadSwipe', 'right');
      }
      for (let frame = 0; frame < frames; frame++) {
        game.update(dt);
      }
      return playerPosition(renderer).x;
    };

    const oneLongFrame = run(1, 0.5);
    expect(oneLongFrame).toBeLessThan(PLAYER.bound); // still in flight, not clamped
    expect(oneLongFrame).toBeCloseTo(run(5, 0.1));
  });

  it('clamps the player within bounds however many swipes it gets', () => {
    const renderer = new FakeRenderer<ModelId>();
    const input = new FakeInput();
    const game = new Game(renderer, input, new FakeAudioPlayer());

    for (let swipe = 0; swipe < 100; swipe++) {
      input.fire('dpadSwipe', 'right');
    }
    game.update(100);

    expect(playerPosition(renderer).x).toBe(PLAYER.bound);
  });

  it('scores a point on an index pinch tap', () => {
    const renderer = new FakeRenderer<ModelId>();
    const input = new FakeInput();
    const game = new Game(renderer, input, new FakeAudioPlayer());

    expect(game.getScore()).toBe(0);
    input.fire('pinchTap', undefined);
    expect(game.getScore()).toBe(1);
  });

  it('plays a select sound on an index pinch tap', () => {
    const input = new FakeInput();
    const audio = new FakeAudioPlayer();
    new Game(new FakeRenderer<ModelId>(), input, audio);

    expect(audio.count('select')).toBe(0);
    input.fire('pinchTap', undefined);
    expect(audio.count('select')).toBe(1);
  });
});
