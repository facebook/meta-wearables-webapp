# Opting into the drag channel (the three edits)

The EMG index pinch-and-move stream is **opt-in and off by default**, and opting in is three
coordinated edits — two out of three silently does nothing. Do it **only if a drag drives
gameplay** (aim, move, look, drag-a-thing).

Never turn it on so a desktop mouse click selects: the flag opts the *device* into the pointer
stream and moves the tap source off `Enter`, so you would ship a different input contract to the
glasses to save one keystroke in Chrome. Press `Enter`. `npm run validate` fails a project that
enables the flag without consuming the drag.

Why the channel exists at all, what it delivers, and how it interacts with the D-pad:
[`game-architecture.md` § The input model](game-architecture.md#the-input-model-read-this-before-changing-input).

**1. `src/style.css`** — the device only emits the pointer stream when the page says it wants it:

```css
html,
body {
  /* Makes the glasses deliver the EMG index pinch-and-move as a relative pointer drag
     (pointerdown + pointermove w/ movementX/Y + pointerup). A desktop mouse drag is
     identical. Also disables browser touch scroll/zoom. */
  touch-action: none;
}
```

**2. `src/config/gameplayConstants.ts`** — the feel constants the framework won't own:

```ts
/** Input feel. Sensitivity scales raw pointer movement (pixels) into world units. */
export const INPUT = {
  /** Desktop mouse-drag sensitivity. */
  mouseSensitivity: 0.01,
  /** EMG pinch-and-move sensitivity on the glasses (different feel from a mouse). */
  deviceSensitivity: 0.02,
  /**
   * Max raw pixel travel during an index pinch for it to count as a SELECT (`pinchTap`).
   * Move more than this and the pinch is treated as a drag instead (no tap on release).
   */
  tapMaxTravelPx: 6,
};
```

(No `as const` — see the header of that file. Tunable blocks type their members as `number` so a
mutable field seeded from one is still assignable; only fixed device facts are frozen literals.)

**3. `src/main.ts`** — pass the flag and the tunables (the framework input class stays
config-free, so the game injects them):

```ts
import { INPUT } from '@/config/gameplayConstants';

/**
 * Whether we're running on the glasses (vs a desktop dev browser). Only used to pick the
 * movement sensitivity — a wrong guess just applies the other constant; both input paths
 * work. The Android WebView user-agent carries a `wv` token that desktop Chrome lacks.
 */
function isRunningOnGlasses(): boolean {
  const userAgent = typeof navigator !== 'undefined' ? navigator.userAgent : '';
  return /\bwv\b/.test(userAgent) && /Android/.test(userAgent);
}

const input = new PointerKeyboardInput({
  sensitivity: isRunningOnGlasses() ? INPUT.deviceSensitivity : INPUT.mouseSensitivity,
  tapMaxTravelPx: INPUT.tapMaxTravelPx,
  pointerDrag: true,
});
```

Then consume the delta in the game's `update()`:

```ts
const delta = this.input.consumeMovementDelta();
```

`delta` is the pointer movement accumulated since the last frame (already world-scaled), i.e. a
per-frame **DISPLACEMENT, not a velocity** — apply it directly. **Do NOT multiply it by `dt`**:
that would make drag gain scale with frame rate. `dt` is for genuine rate-based motion
(velocity, gravity, timers). Drag right/up moves the player right/up; invert Y, because
screen-down is world-down.

## The delta is per-frame, and unconsumed movement is dropped

`consumeMovementDelta()` returns what accumulated **since the last time it was called** and
clears it, and the framework also clears whatever is left when the pinch ends. So a drag only
delivers anything if frames run *during* the gesture — read the delta after the gesture is over
and it is always `{x: 0, y: 0}`. That is deliberate: movement from a closed pinch gate is stale,
and feeding it into a later frame would teleport the player.

It also means a drag cannot be tested by dispatching the whole gesture at a paused game. Under
[`?drive`](query-parameters.md#drive-mode-drive) use the plugin's
`cdp.mjs drag --drive`, which advances one frame after each move.

One more consequence of opting in: the pointer stream becomes the **tap source**. A zero-travel
pinch (under `tapMaxTravelPx`) fires `pinchTap`, a moved pinch fires a drag and no tap, and the
device's redundant `Enter` is ignored so the pinch never double-fires. So in a drag game a
desktop mouse click *does* select and **`Enter` stops working** — a side effect of the mode,
never a reason to enter it.

## Then fix everything that documents the controls

`touch-action: none`, `{ pointerDrag: true }` and consuming the movement delta are what make the
channel work. They also make every tap-only control
description in the project wrong, and a stale one is expensive: an agent that reads "press
`Enter`" sends `Enter` to a drag game, gets a byte-identical frame back, and concludes from that
frame that the game is fine. So finish the opt-in by re-reading, at minimum:

- the scaffold's `main.ts` header comment,
- `README.md`,
- `docs/design.md`,
- `CLAUDE.md` § Input model — the scaffolded text derives the mode by running
  `scripts/validate-drag-optin.mjs`, so it survives the switch on its own, but anything you added
  about the controls does not.

Anywhere else that names a key or a click belongs on that list too.
