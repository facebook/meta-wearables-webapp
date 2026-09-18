/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * Framework-provided loading screen: a full-stage DOM overlay with a progress bar, shown on first
 * load while {@link preloadManifest} pulls the game's assets into memory (see
 * `docs/loading-screen.md`). Games opt in by constructing this in `main.ts` and feeding it the
 * load fraction — they never hand-write a loading UI.
 *
 * Display-only, like the game HUD and the `?stats` `PerfOverlay`: it creates elements and writes
 * `style` / `textContent` and adds **no** event listeners, so it stays within the "no input
 * through the DOM" rule. Styling is inline — `update-webapp-game-framework` re-syncs
 * only `src/framework/`, so the overlay must not depend on the game's `style.css`.
 *
 * Additive-display theme: the backdrop is pure `#000000` (opaque, so it occludes the title
 * screen / HUD beneath in DOM compositing, then reads as transparent real-world on the
 * waveguide). Only the bright label and bar emit light. Disposing it reveals the title screen
 * underneath, so the first-load order is loading -> title -> game with no `index.html` change.
 */

export interface LoadingScreenOptions {
  /** Where to append the overlay. Defaults to `document.body`; the scaffold passes `#game-root`. */
  mount?: HTMLElement;
  /**
   * The "Loading…" caption. Injected (from `main.ts` via `t('loading')`) so the framework stays
   * string-free and the text is localized. Defaults to `'Loading…'`.
   */
  label?: string;
}

const SYSTEM_FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

export class LoadingScreen {
  private readonly root: HTMLElement;
  private readonly label: HTMLElement;
  private readonly track: HTMLElement;
  private readonly fill: HTMLElement;

  public constructor(options: LoadingScreenOptions = {}) {
    const root = document.createElement('div');
    Object.assign(root.style, {
      position: 'absolute',
      inset: '0',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '16px',
      // Opaque black: occludes the title/HUD beneath in DOM compositing, and reads as transparent
      // (real world) on the additive waveguide — only the bright label and bar show.
      background: '#000000',
      color: '#ffffff',
      // 8dp safe margin so the bar isn't clipped at the stage edge on device.
      padding: '8px',
      boxSizing: 'border-box',
      textAlign: 'center',
      // Above #hud / #title-screen and the ?stats overlay (z-index 9999).
      zIndex: '10000',
      pointerEvents: 'none',
      userSelect: 'none',
    } satisfies Partial<CSSStyleDeclaration>);

    const label = document.createElement('div');
    label.textContent = options.label ?? 'Loading…';
    Object.assign(label.style, {
      fontSize: '20px',
      fontWeight: '700',
      fontFamily: SYSTEM_FONT,
    } satisfies Partial<CSSStyleDeclaration>);

    const track = document.createElement('div');
    Object.assign(track.style, {
      width: '60%',
      maxWidth: '320px',
      height: '8px',
      borderRadius: '4px',
      // Faint track (translucent white → dark gray on device); never pure black (invisible).
      background: 'rgba(255, 255, 255, 0.2)',
      overflow: 'hidden',
    } satisfies Partial<CSSStyleDeclaration>);

    const fill = document.createElement('div');
    Object.assign(fill.style, {
      width: '0%',
      height: '100%',
      background: '#ffffff',
      // Smooth the bar as discrete per-asset steps land.
      transition: 'width 120ms linear',
    } satisfies Partial<CSSStyleDeclaration>);
    track.appendChild(fill);

    root.appendChild(label);
    root.appendChild(track);
    (options.mount ?? document.body).appendChild(root);

    this.root = root;
    this.label = label;
    this.track = track;
    this.fill = fill;
  }

  /** Set the bar fill from a `0..1` load fraction (clamped). */
  public setProgress(fraction: number): void {
    const clamped = Math.max(0, Math.min(1, fraction));
    this.fill.style.width = `${clamped * 100}%`;
  }

  /**
   * Swap the bar for an error message so a failed load isn't a silent black screen. Pass a
   * localized string (e.g. `t('loadError')`).
   */
  public showError(message: string): void {
    this.track.style.display = 'none';
    this.label.textContent = message;
    this.label.style.color = '#ff6b6b';
  }

  /** Remove the loading screen from the DOM — call once assets are ready (revealing the title). */
  public dispose(): void {
    this.root.remove();
  }
}
