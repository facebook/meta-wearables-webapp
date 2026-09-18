/**
 * DOM HUD. Reads game state and writes the DOM overlay — it never touches Three.js. Text
 * and menus live here (not in WebGL); see the plugin's threejs-vs-dom guidance.
 *
 * User-facing text must be localized: write it with `t('key')` from `@/i18n` (add the key to
 * src/i18n/en.json), e.g. `el.textContent = t('gameOver')`. The score below is a bare number, so
 * it stays a plain `String(...)`. See the plugin's docs/localization.md.
 */

import type { Game } from '@/core/Game';

export class Hud {
  private readonly scoreEl: HTMLElement;
  private readonly titleScreen: HTMLElement | null;

  public constructor(private readonly game: Game) {
    const score = document.querySelector<HTMLElement>('#score');
    if (!score) {
      throw new Error('HUD: #score element not found.');
    }
    this.scoreEl = score;
    this.titleScreen = document.querySelector<HTMLElement>('#title-screen');
  }

  /** Hide the title screen once play starts. */
  public hideTitle(): void {
    this.titleScreen?.classList.add('hidden');
  }

  /** Reflect current game state into the DOM. Call once per frame. */
  public update(): void {
    this.scoreEl.textContent = String(this.game.getScore());
  }
}
