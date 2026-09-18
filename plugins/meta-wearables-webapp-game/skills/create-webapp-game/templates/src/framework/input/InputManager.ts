/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * The gameplay-facing input contract. Gameplay reads input ONLY through this interface and
 * never touches the DOM directly, so the same game runs on desktop (mouse + keyboard) and
 * on the glasses (EMG Neural Band + D-pad). No DOM types appear here.
 *
 * Input arrives as TWO EMG gesture families (a desktop mouse + keyboard reproduce both, so
 * one code path serves dev and device):
 *
 *  - INDEX family — thumb to the *pad* of the index finger (a "pinch"):
 *      • a quick pinch is a discrete SELECT → `pinchTap` (the device emits this as `Enter`).
 *      • a pinch-and-MOVE is a relative drag → `pinchBegin`/`pinchEnd` + an accumulated
 *        movement delta. This channel is OPT-IN: the page must set `touch-action: none` AND
 *        the input must be constructed with `{ pointerDrag: true }`. Tap-only games skip it,
 *        and should — opt in only if a drag drives gameplay, never to make a desktop mouse
 *        click select (on the desktop, `Enter` is the index pinch).
 *  - D-PAD family — thumb to the *side* of the index finger:
 *      • a directional swipe → `dpadSwipe(direction)` (the device emits arrow keys).
 *
 * NOTE: there is no discrete D-pad center ("thumb tap") gesture. The device emits
 * `key="Unidentified"` for BOTH swipes and side taps, so a center tap cannot be told apart
 * from a swipe — it is not exposed as an input event. Use `pinchTap` for a discrete select.
 */

/** D-pad direction (EMG side-swipe on device; arrow keys on desktop). */
export type DpadDirection = 'up' | 'down' | 'left' | 'right';

/** Accumulated 2D movement since the last poll. Plain {x,y} to stay framework-free. */
export interface MovementDelta {
  x: number;
  y: number;
}

/**
 * Discrete input events (`void` = no payload):
 * - `pinchBegin` / `pinchEnd` — an index pinch-and-move drag started / ended (drag opt-in).
 * - `pinchTap` — an index pad-pinch SELECT (a quick pinch / Enter / a zero-travel click).
 * - `dpadSwipe` — a single D-pad swipe in `direction`.
 */
export interface InputEventMap {
  pinchBegin: void;
  pinchEnd: void;
  pinchTap: void;
  dpadSwipe: DpadDirection;
}

export type InputEventName = keyof InputEventMap;

export type InputEventHandler<EventName extends InputEventName> = (
  payload: InputEventMap[EventName],
) => void;

export interface InputManager {
  /** Subscribe to a discrete input event. */
  on<EventName extends InputEventName>(
    event: EventName,
    handler: InputEventHandler<EventName>,
  ): void;

  /** Unsubscribe a previously registered handler. */
  off<EventName extends InputEventName>(
    event: EventName,
    handler: InputEventHandler<EventName>,
  ): void;

  /** Whether an index pinch-and-move drag is currently held (always false if not opted in). */
  isPinchActive(): boolean;

  /**
   * Return the movement delta accumulated since the last call and clear the accumulator.
   * Returns {x:0,y:0} when no drag is active (always, for a tap-only game).
   */
  consumeMovementDelta(): MovementDelta;
}

/**
 * Minimal typed event emitter used by InputManager implementations. Keeps the on/off/emit
 * plumbing in one place, fully type-checked against the event map.
 */
export class TypedEventEmitter<EventMap> {
  private readonly handlersByEvent = new Map<
    keyof EventMap,
    Set<(payload: never) => void>
  >();

  public on<EventName extends keyof EventMap>(
    event: EventName,
    handler: (payload: EventMap[EventName]) => void,
  ): void {
    let handlers = this.handlersByEvent.get(event);
    if (!handlers) {
      handlers = new Set();
      this.handlersByEvent.set(event, handlers);
    }
    handlers.add(handler as (payload: never) => void);
  }

  public off<EventName extends keyof EventMap>(
    event: EventName,
    handler: (payload: EventMap[EventName]) => void,
  ): void {
    this.handlersByEvent.get(event)?.delete(handler as (payload: never) => void);
  }

  public emit<EventName extends keyof EventMap>(
    event: EventName,
    payload: EventMap[EventName],
  ): void {
    const handlers = this.handlersByEvent.get(event);
    if (!handlers) {
      return;
    }
    // Copy so a handler that unsubscribes mid-dispatch doesn't disturb iteration.
    for (const handler of [...handlers]) {
      (handler as (payload: EventMap[EventName]) => void)(payload);
    }
  }
}
