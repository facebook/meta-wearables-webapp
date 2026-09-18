/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Desktop + glasses implementation of `InputManager` over DOM Pointer + keyboard events.
 *
 * Maps the two EMG gesture families (see InputManager.ts) to the contract:
 *
 *   D-pad swipe   ← Arrow keys              → `dpadSwipe(direction)`
 *   Index select  ← `Enter` / a click       → `pinchTap`
 *   Index drag    ← primary-button pointer drag (OPT-IN) → `pinchBegin`/`pinchEnd` + delta
 *
 * ## Why two channels for the index pinch, and how we avoid double-firing
 *
 * On the glasses the index pinch is delivered on TWO channels: the device ALWAYS emits an
 * `Enter` keydown for the pinch (the "select"), and — only when the page sets
 * `touch-action: none` — it ALSO delivers a relative pointer drag (`pointerdown` →
 * `pointermove` with `movementX/Y` → `pointerup`). A desktop mouse reproduces the pointer
 * channel; the desktop `Enter` key reproduces the select.
 *
 * So whether the index pinch's discrete tap should come from `Enter` or from the pointer
 * stream depends on whether the game opted into drag — that's the `pointerDrag` flag:
 *
 *   - `pointerDrag: false` (default — tap-only games): pointer events are not even wired up.
 *     The index select is the `Enter` keydown → `pinchTap`. Simple; no drag, no movement.
 *   - `pointerDrag: true` (games that want drag; also set `touch-action: none`): the pointer
 *     stream is the source of truth — a zero-travel pinch → `pinchTap`, a moved pinch → a
 *     drag (no tap). The redundant `Enter` is IGNORED, so the pinch never double-fires.
 *
 * Because the tap source switches with the mode, there is no need for the timing/dedup
 * heuristics an Enter-vs-pointer reconciliation would otherwise require.
 *
 * `pointerDrag` is a GAMEPLAY decision, not a dev-ergonomics one: turn it on only if a drag
 * drives gameplay. In particular, never turn it on so that a desktop mouse CLICK selects while
 * iterating in a browser — `Enter` is the index pinch on the desktop just as it is on the
 * device. Enabling the flag changes what the glasses deliver.
 *
 * The handler methods take minimal event-shaped objects (not concrete DOM types) so the
 * mapping is unit-testable in a plain `node` Vitest environment. `attach()` wires the real
 * DOM listeners (which structurally satisfy those shapes) to the handlers.
 */

import {
  type DpadDirection,
  type InputEventHandler,
  type InputEventMap,
  type InputEventName,
  type InputManager,
  type MovementDelta,
  TypedEventEmitter,
} from '@/framework/input/InputManager';

/** Fallback desktop mouse-drag sensitivity used when the caller doesn't pass one. */
const DEFAULT_SENSITIVITY = 0.01;
/** Fallback max raw pixel travel for a pinch to count as a tap (select). */
const DEFAULT_TAP_MAX_TRAVEL_PX = 6;

/** Just the bits of a KeyboardEvent the handlers read. */
export interface KeyEventLike {
  readonly key: string;
  readonly code: string;
  readonly repeat: boolean;
  preventDefault(): void;
}

/** Just the bits of a pointerdown/pointerup PointerEvent the handlers read. */
export interface PointerButtonLike {
  readonly button: number;
  preventDefault(): void;
}

/** Just the bits of a pointermove PointerEvent the handlers read. */
export interface PointerMoveLike {
  readonly movementX: number;
  readonly movementY: number;
  /** Bitmask of held buttons (bit 0 = primary). */
  readonly buttons: number;
}

export interface PointerKeyboardInputOptions {
  /** Multiplier on raw movementX/Y. Defaults to `DEFAULT_SENSITIVITY`. */
  sensitivity?: number;
  /**
   * Max raw pixel travel during an index pinch for it to count as a SELECT (`pinchTap`).
   * Move more than this and the pinch is treated as a drag instead (no tap on release).
   * Passed in (not imported) so the framework stays free of game-owned config. Only used
   * when the drag channel is opted into. Defaults to `DEFAULT_TAP_MAX_TRAVEL_PX`.
   */
  tapMaxTravelPx?: number;
  /**
   * Opt into the EMG index pinch-and-MOVE channel (the relative pointer drag). Leave false
   * for a tap-only game (the common case) — the index pinch is then a discrete select only.
   * When true, ALSO set `touch-action: none` on `<body>` so the device delivers the pointer
   * stream (the two must agree). See the input-model notes in CLAUDE.md.
   *
   * Set this ONLY if a drag drives gameplay — never to make a desktop mouse click select.
   */
  pointerDrag?: boolean;
}

const ARROW_KEY_DIRECTIONS: Readonly<Record<string, DpadDirection>> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
};

const PRIMARY_BUTTON = 0;
const PRIMARY_BUTTON_MASK = 1;

export class PointerKeyboardInput implements InputManager {
  private readonly emitter = new TypedEventEmitter<InputEventMap>();
  private readonly sensitivity: number;
  private readonly tapMaxTravelPx: number;
  private readonly pointerDrag: boolean;
  private pinchActive = false;
  private accumulatedX = 0;
  private accumulatedY = 0;
  private pinchTravelPx = 0;
  private target: EventTarget | null = null;

  private readonly onKeyDown = (event: Event): void =>
    this.handleKeyDown(event as unknown as KeyEventLike);
  private readonly onKeyUp = (event: Event): void =>
    this.handleKeyUp(event as unknown as KeyEventLike);
  private readonly onPointerDown = (event: Event): void =>
    this.handlePointerDown(event as unknown as PointerButtonLike);
  private readonly onPointerUp = (event: Event): void =>
    this.handlePointerUp(event as unknown as PointerButtonLike);
  private readonly onPointerMove = (event: Event): void =>
    this.handlePointerMove(event as unknown as PointerMoveLike);

  public constructor(options: PointerKeyboardInputOptions = {}) {
    this.sensitivity = options.sensitivity ?? DEFAULT_SENSITIVITY;
    this.tapMaxTravelPx = options.tapMaxTravelPx ?? DEFAULT_TAP_MAX_TRAVEL_PX;
    this.pointerDrag = options.pointerDrag ?? false;
  }

  public on<EventName extends InputEventName>(
    event: EventName,
    handler: InputEventHandler<EventName>,
  ): void {
    this.emitter.on(event, handler);
  }

  public off<EventName extends InputEventName>(
    event: EventName,
    handler: InputEventHandler<EventName>,
  ): void {
    this.emitter.off(event, handler);
  }

  public isPinchActive(): boolean {
    return this.pinchActive;
  }

  public consumeMovementDelta(): MovementDelta {
    const delta = { x: this.accumulatedX, y: this.accumulatedY };
    this.accumulatedX = 0;
    this.accumulatedY = 0;
    return delta;
  }

  /** Wire DOM listeners onto `target` (defaults to window). */
  public attach(target: EventTarget = window): void {
    if (this.target) {
      this.detach();
    }
    this.target = target;
    target.addEventListener('keydown', this.onKeyDown);
    target.addEventListener('keyup', this.onKeyUp);
    // Pointer (drag) listeners are wired only when the game opts into the drag channel.
    if (this.pointerDrag) {
      target.addEventListener('pointerdown', this.onPointerDown);
      target.addEventListener('pointerup', this.onPointerUp);
      target.addEventListener('pointermove', this.onPointerMove);
    }
  }

  /** Remove DOM listeners and reset transient state. */
  public detach(): void {
    if (!this.target) {
      return;
    }
    this.target.removeEventListener('keydown', this.onKeyDown);
    this.target.removeEventListener('keyup', this.onKeyUp);
    this.target.removeEventListener('pointerdown', this.onPointerDown);
    this.target.removeEventListener('pointerup', this.onPointerUp);
    this.target.removeEventListener('pointermove', this.onPointerMove);
    this.target = null;
    // Reset silently — firing a synthetic pinchEnd/pinchTap on teardown would register a
    // phantom select.
    this.resetPinch();
  }

  // --- Handlers (testable; accept event-shaped objects) --------------------

  public handleKeyDown(event: KeyEventLike): void {
    // Prefer `key` so the device's synthetic events (empty `code`) still resolve.
    const identifier = event.key || event.code;

    // INDEX SELECT — the EMG index pad-pinch emits `Enter`; on desktop press Enter. In a
    // drag game the pointer stream is the tap source, so this redundant copy is ignored.
    if (identifier === 'Enter') {
      event.preventDefault();
      if (!this.pointerDrag && !event.repeat) {
        this.emitter.emit('pinchTap', undefined);
      }
      return;
    }

    // `key="Unidentified"` is INTENTIONALLY IGNORED — the device emits it for BOTH D-pad
    // swipes and side ("thumb") taps, so it can't reliably mean a discrete center tap. There
    // is no D-pad center gesture; use `Enter` → `pinchTap` for a discrete select instead.

    // D-PAD SWIPE — EMG side-swipe emits arrow keys; arrow keys on desktop.
    const direction = ARROW_KEY_DIRECTIONS[identifier];
    if (direction) {
      event.preventDefault();
      if (!event.repeat) {
        this.emitter.emit('dpadSwipe', direction);
      }
    }
  }

  public handleKeyUp(_event: KeyEventLike): void {
    // No held-key state to release in the default mapping.
  }

  public handlePointerDown(event: PointerButtonLike): void {
    if (event.button === PRIMARY_BUTTON) {
      event.preventDefault();
      this.beginPinch();
    }
  }

  public handlePointerUp(event: PointerButtonLike): void {
    if (event.button === PRIMARY_BUTTON) {
      event.preventDefault();
      this.endPinch();
    }
  }

  public handlePointerMove(event: PointerMoveLike): void {
    // Keep the gate in sync with the real button state so a missed pointerdown/pointerup
    // can't strand it: open when the primary button is held, close when it is not. Without
    // the close side, a dropped pointerup would leave the pinch active forever, feeding
    // phantom movement from every later move.
    const primaryHeld =
      (event.buttons & PRIMARY_BUTTON_MASK) === PRIMARY_BUTTON_MASK;
    if (primaryHeld && !this.pinchActive) {
      this.beginPinch();
    } else if (!primaryHeld && this.pinchActive) {
      this.endPinch();
    }
    if (!this.pinchActive) {
      return;
    }
    // Raw pixel travel (pre-sensitivity) classifies the pinch as a tap (select) vs a drag.
    this.pinchTravelPx += Math.abs(event.movementX) + Math.abs(event.movementY);
    this.accumulatedX += event.movementX * this.sensitivity;
    this.accumulatedY += event.movementY * this.sensitivity;
  }

  private beginPinch(): void {
    if (this.pinchActive) {
      return;
    }
    this.pinchActive = true;
    this.pinchTravelPx = 0;
    this.emitter.emit('pinchBegin', undefined);
  }

  private endPinch(): void {
    if (!this.pinchActive) {
      return;
    }
    const wasTap = this.pinchTravelPx <= this.tapMaxTravelPx;
    this.resetPinch();
    this.emitter.emit('pinchEnd', undefined);
    if (wasTap) {
      // A zero-travel pinch is the index SELECT delivered via the pointer channel.
      this.emitter.emit('pinchTap', undefined);
    }
  }

  /** Clear in-progress pinch state without emitting any events. */
  private resetPinch(): void {
    this.pinchActive = false;
    this.pinchTravelPx = 0;
    // Drop movement accumulated but not yet consumed; it is invalid once the gate closes.
    this.accumulatedX = 0;
    this.accumulatedY = 0;
  }
}
