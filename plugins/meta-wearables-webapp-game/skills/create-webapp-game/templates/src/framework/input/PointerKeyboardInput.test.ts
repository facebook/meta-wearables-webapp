/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Unit tests for the pointer/keyboard input mapping. The handler methods accept minimal
 * event-shaped objects (not concrete DOM types), so the gesture mapping is testable in a
 * plain `node` environment with no DOM.
 *
 * These lock in the EMG gesture-family mapping that is easy to regress:
 *  - the index pad-pinch SELECT (`Enter`) → `pinchTap`;
 *  - `key="Unidentified"` is ignored (ambiguous: the device emits it for both swipes and
 *    side taps), so there is no discrete D-pad center gesture;
 *  - in a drag game the redundant `Enter` is ignored so an index pinch never double-fires.
 */

import { describe, expect, it } from 'vitest';

import type { InputEventName } from '@/framework/input/InputManager';
import { PointerKeyboardInput } from '@/framework/input/PointerKeyboardInput';

const noop = (): void => {};

/** Tap/drag threshold used by the drag-channel tests (passed explicitly to the input). */
const TAP_MAX_TRAVEL_PX = 6;

/** Count how many times each discrete event fires. */
function trackEvents(input: PointerKeyboardInput): Record<string, number> {
  const counts: Record<string, number> = {};
  const events: InputEventName[] = [
    'pinchBegin',
    'pinchEnd',
    'pinchTap',
    'dpadSwipe',
  ];
  for (const event of events) {
    counts[event] = 0;
    input.on(event, () => {
      counts[event] += 1;
    });
  }
  return counts;
}

describe('PointerKeyboardInput key mapping (gesture families)', () => {
  it('maps the index pad-pinch select (Enter) to pinchTap', () => {
    const input = new PointerKeyboardInput(); // tap-only (default)
    const counts = trackEvents(input);

    input.handleKeyDown({ key: 'Enter', code: '', repeat: false, preventDefault: noop });

    expect(counts.pinchTap).toBe(1);
  });

  it('ignores Unidentified — the ambiguous key emitted by both swipes and side taps', () => {
    const input = new PointerKeyboardInput();
    const counts = trackEvents(input);

    input.handleKeyDown({
      key: 'Unidentified',
      code: '',
      repeat: false,
      preventDefault: noop,
    });

    expect(counts.pinchTap).toBe(0);
    expect(counts.dpadSwipe).toBe(0);
    expect(counts.pinchBegin).toBe(0);
  });

  it('maps arrow keys to dpadSwipe', () => {
    const input = new PointerKeyboardInput();
    const counts = trackEvents(input);
    const seen: string[] = [];
    input.on('dpadSwipe', (d) => seen.push(d));

    input.handleKeyDown({ key: 'ArrowUp', code: 'ArrowUp', repeat: false, preventDefault: noop });
    input.handleKeyDown({ key: 'ArrowLeft', code: 'ArrowLeft', repeat: false, preventDefault: noop });

    expect(counts.dpadSwipe).toBe(2);
    expect(seen).toEqual(['up', 'left']);
  });
});

describe('PointerKeyboardInput drag channel (pointerDrag: true)', () => {
  it('emits pinchTap for a zero-travel pinch (the index select via the pointer channel)', () => {
    const input = new PointerKeyboardInput({ pointerDrag: true });
    const counts = trackEvents(input);

    input.handlePointerDown({ button: 0, preventDefault: noop });
    input.handlePointerUp({ button: 0, preventDefault: noop });

    expect(counts.pinchBegin).toBe(1);
    expect(counts.pinchEnd).toBe(1);
    expect(counts.pinchTap).toBe(1);
  });

  it('treats a pinch that moves past the threshold as a drag (no pinchTap)', () => {
    const input = new PointerKeyboardInput({
      pointerDrag: true,
      tapMaxTravelPx: TAP_MAX_TRAVEL_PX,
    });
    const counts = trackEvents(input);

    input.handlePointerDown({ button: 0, preventDefault: noop });
    input.handlePointerMove({ movementX: TAP_MAX_TRAVEL_PX + 10, movementY: 0, buttons: 1 });
    input.handlePointerUp({ button: 0, preventDefault: noop });

    expect(counts.pinchEnd).toBe(1);
    expect(counts.pinchTap).toBe(0);
  });

  it('ignores the redundant Enter in drag mode so an index pinch fires pinchTap only once', () => {
    const input = new PointerKeyboardInput({ pointerDrag: true });
    const counts = trackEvents(input);

    // Device index tap in drag mode: a zero-travel pointer gesture PLUS a stray Enter.
    input.handlePointerDown({ button: 0, preventDefault: noop });
    input.handleKeyDown({ key: 'Enter', code: '', repeat: false, preventDefault: noop });
    input.handlePointerUp({ button: 0, preventDefault: noop });

    expect(counts.pinchTap).toBe(1);
  });

  it('accumulates the sensitivity-scaled movement delta during a drag', () => {
    const sensitivity = 0.01;
    const input = new PointerKeyboardInput({ sensitivity, pointerDrag: true });

    input.handlePointerDown({ button: 0, preventDefault: noop });
    input.handlePointerMove({ movementX: 30, movementY: -10, buttons: 1 });

    const delta = input.consumeMovementDelta();
    expect(delta.x).toBeCloseTo(30 * sensitivity);
    expect(delta.y).toBeCloseTo(-10 * sensitivity);
    // Consuming clears the accumulator.
    expect(input.consumeMovementDelta()).toEqual({ x: 0, y: 0 });
  });

  it('ends a stranded pinch when a later move reports the button released (missed pointerup)', () => {
    const input = new PointerKeyboardInput({ pointerDrag: true });

    input.handlePointerDown({ button: 0, preventDefault: noop });
    // pointerup was dropped; the next move shows the primary button is no longer held.
    input.handlePointerMove({ movementX: 0, movementY: 0, buttons: 0 });
    expect(input.isPinchActive()).toBe(false);

    // Subsequent buttonless moves must not feed phantom movement.
    input.handlePointerMove({ movementX: 50, movementY: 50, buttons: 0 });
    expect(input.consumeMovementDelta()).toEqual({ x: 0, y: 0 });
  });

  it('does not emit a phantom pinchTap when detached mid-pinch', () => {
    const fakeTarget: EventTarget = {
      addEventListener: noop,
      removeEventListener: noop,
      dispatchEvent: () => true,
    };
    const input = new PointerKeyboardInput({ pointerDrag: true });
    const counts = trackEvents(input);

    input.attach(fakeTarget);
    input.handlePointerDown({ button: 0, preventDefault: noop });
    expect(counts.pinchBegin).toBe(1);

    input.detach();
    expect(counts.pinchEnd).toBe(0);
    expect(counts.pinchTap).toBe(0);
  });
});
