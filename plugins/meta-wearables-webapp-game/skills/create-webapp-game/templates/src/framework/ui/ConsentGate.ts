/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Consent gate for remote logging. When a session is launched with `?logkey=` — meaning log
 * records would be sent off the device to the game's backend — this screen is shown FIRST, before
 * preload and before the title screen, and the player must explicitly choose. It is a gate, not a
 * notification: there is no timeout, no auto-dismiss, and no way past it except a decision.
 *
 * Why it is built this way:
 *
 * - **Nothing transmits before acceptance.** `main.ts` attaches the `RemoteLogSink` to the logger
 *   only in the accept branch, so the sink is structurally incapable of sending early. Records
 *   produced in the meantime sit in the `Logger`'s ring buffer; accepting backfills them, and
 *   declining calls `logger.clear()` so they are dropped rather than lingering.
 * - **Declining is a real option**, not a nag to dismiss — the game runs normally with local
 *   logging only (console and the `?logview` overlay still work).
 * - **Focus starts on decline.** An accidental pinch on a screen the player hasn't read must not
 *   opt them into transmission; opting in should cost a deliberate D-pad move.
 * - **The decision is not persisted.** The gate appears every session that requests remote
 *   logging. A remembered opt-in is exactly the state in which someone forgets they are
 *   transmitting.
 * - **No DOM event listeners.** Input arrives through the framework `InputManager` (D-pad moves
 *   focus, pinch activates), which is both the "no input through the DOM" rule and the platform's
 *   actual input model — see `docs/display-guidelines.md`.
 *
 * Strings are injected, not looked up, so the framework stays string-free and the text is
 * localized by the game — the same contract as `LoadingScreen`'s `label`.
 */

import type { DpadDirection, InputManager } from '@/framework/input/InputManager';

const SYSTEM_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

export interface ConsentGateStrings {
  /** Short heading, e.g. "Debug logging". */
  title: string;
  /** What will be sent and where. Name the destination host — vagueness defeats the point. */
  body: string;
  /** The opt-in choice, e.g. "Enable debug logging". */
  accept: string;
  /** The opt-out choice, e.g. "Play without logging". */
  decline: string;
  /** Hint line describing the controls, e.g. "▲▼ choose · tap to confirm". */
  hint: string;
}

export interface ConsentGateOptions {
  /** Where to append the overlay. Defaults to `document.body`; the scaffold passes `#game-root`. */
  mount?: HTMLElement;
  strings: ConsentGateStrings;
  /** The game's input manager — the gate's only input source. */
  input: InputManager;
  /** Called exactly once with the player's decision; the gate removes itself first. */
  onDecision: (accepted: boolean) => void;
}

export class ConsentGate {
  private readonly root: HTMLElement;
  private readonly optionElements: HTMLElement[] = [];
  private readonly options: ConsentGateOptions;
  /** Options are ordered [decline, accept] so index 0 — the initial focus — is the safe one. */
  private focusIndex = 0;
  private resolved = false;

  public constructor(options: ConsentGateOptions) {
    this.options = options;

    const root = document.createElement('div');
    Object.assign(root.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '12px',
      // Opaque black: occludes everything beneath in DOM compositing, and reads as transparent
      // real world on the additive waveguide, so only the text emits light.
      background: '#000000',
      color: '#ffffff',
      padding: '16px',
      boxSizing: 'border-box',
      textAlign: 'center',
      fontFamily: SYSTEM_FONT,
      // Above the LoadingScreen (10000) — this gate precedes preload and must never be covered.
      zIndex: '10001',
      pointerEvents: 'none',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    const title = document.createElement('div');
    title.textContent = options.strings.title;
    Object.assign(title.style, {
      fontSize: '20px',
      fontWeight: '700',
    } satisfies Partial<CSSStyleDeclaration>);

    const body = document.createElement('div');
    body.textContent = options.strings.body;
    Object.assign(body.style, {
      fontSize: '13px',
      lineHeight: '1.4',
      maxWidth: '440px',
      color: '#d0d0d0',
    } satisfies Partial<CSSStyleDeclaration>);

    root.appendChild(title);
    root.appendChild(body);

    for (const label of [options.strings.decline, options.strings.accept]) {
      const option = document.createElement('div');
      option.textContent = label;
      Object.assign(option.style, {
        fontSize: '15px',
        fontWeight: '600',
        padding: '8px 16px',
        borderRadius: '6px',
        minWidth: '220px',
      } satisfies Partial<CSSStyleDeclaration>);
      this.optionElements.push(option);
      root.appendChild(option);
    }

    const hint = document.createElement('div');
    hint.textContent = options.strings.hint;
    Object.assign(hint.style, {
      fontSize: '11px',
      color: '#9aa0a6',
      marginTop: '4px',
    } satisfies Partial<CSSStyleDeclaration>);
    root.appendChild(hint);

    (options.mount ?? document.body).appendChild(root);
    this.root = root;
    this.paintFocus();

    options.input.on('dpadSwipe', this.onDpadSwipe);
    options.input.on('pinchTap', this.onPinchTap);
  }

  /** Up/down (or left/right) moves between the two options. */
  private readonly onDpadSwipe = (direction: DpadDirection): void => {
    const delta = direction === 'up' || direction === 'left' ? -1 : 1;
    const count = this.optionElements.length;
    this.focusIndex = (this.focusIndex + delta + count) % count;
    this.paintFocus();
  };

  private readonly onPinchTap = (): void => {
    this.resolve(this.focusIndex === 1);
  };

  private paintFocus(): void {
    this.optionElements.forEach((element, index) => {
      const focused = index === this.focusIndex;
      // Focus is shown by inverting: a filled white chip is unmistakable on the additive display,
      // where a thin outline can wash out.
      element.style.background = focused ? '#ffffff' : 'transparent';
      element.style.color = focused ? '#000000' : '#ffffff';
      element.style.outline = focused ? 'none' : '1px solid rgba(255, 255, 255, 0.35)';
    });
  }

  private resolve(accepted: boolean): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    this.dispose();
    this.options.onDecision(accepted);
  }

  /** Detach input handlers and remove the overlay. Safe to call more than once. */
  public dispose(): void {
    this.options.input.off('dpadSwipe', this.onDpadSwipe);
    this.options.input.off('pinchTap', this.onPinchTap);
    this.root.remove();
  }
}

/**
 * Small persistent indicator shown for the whole session while records are being transmitted.
 * Consent given once at startup is easy to forget ten minutes into a play session; this keeps the
 * fact visible without occupying the display.
 */
export class TransmissionBadge {
  private readonly root: HTMLElement;

  public constructor(label: string, mount?: HTMLElement) {
    const root = document.createElement('div');
    root.textContent = `● ${label}`;
    Object.assign(root.style, {
      position: 'absolute',
      top: '4px',
      right: '4px',
      padding: '2px 6px',
      borderRadius: '4px',
      background: 'rgba(20, 20, 20, 0.72)',
      color: '#ff6b6b',
      font: '10px/1.3 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      pointerEvents: 'none',
      userSelect: 'none',
      zIndex: '9999',
    } satisfies Partial<CSSStyleDeclaration>);
    (mount ?? document.body).appendChild(root);
    this.root = root;
  }

  public dispose(): void {
    this.root.remove();
  }
}
