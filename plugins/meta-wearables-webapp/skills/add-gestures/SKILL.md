---
name: add-gestures
description: >-
  Handle EMG pinch (tap-to-activate) and opt into continuous pinch-and-drag in
  a Meta Display Glasses webapp. Use when the user wants sliders, drawing,
  maps, drag interactions, or game-style continuous input.
argument-hint: "[interaction: tap|drag]"
---

## Required reading

Before generating or modifying any code, read both:

- `../../references/display-guidelines.md`
- `../../references/performance-guidelines.md`

These define the non-negotiable display physics, input model, and performance budgets for Meta Display Glasses webapps. Do not skip — generated UI that ignores these will fail on-device.

If these reference files are unavailable in an isolated eval, do not search `/`, home directories, or unrelated workspaces. Apply the requirements already present in this skill and continue.

# Add Pinch + Drag Gestures to Meta Display Glasses WebApp

The EMG wrist band gives the wearer two interactions: a **pinch** (discrete select) and a **drag** (continuous motion). Pinch works everywhere with no code. Drag is **opt-in** at the page level and is for things that need smooth, continuous control — sliders, maps, drawing, simple games.

## Prerequisites

- Existing webapp created via `/create-webapp`

## Pinch = Activate (always on)

A pinch fires **Enter / click on the focused element** — it works like pressing Enter on the highlighted item. It is **not** a positioned click; it targets `document.activeElement`. So you don't write pinch code — you build **focusable, keyboard-activatable** UI and the pinch activates whatever has focus.

- Use real interactive elements: `<button>`, `<a href>`, or `[tabindex="0"]` with a key/click handler.
- The D-pad moves focus; the pinch activates the focused element.
- A tap on a focused **text input** opens the on-glasses composer instead of reaching the page — see `/add-text-input`.

Build these focusable elements (e.g. a `<button class="focusable" data-action="confirm">`) with `/add-ui`. That's all pinch needs — the rest of this skill is about **drag**.

## Drag = Opt In (page-level)

Continuous drag is **off by default**. Without opting in, there is **no free cursor and no drag** — EMG is D-pad focus + pinch only. To receive the sliding motion, set `touch-action: none` on the **`<body>`** in your **initial stylesheet**, then listen to Pointer events.

### ⚠️ Caveats (must-include)

- `touch-action` is read on **`<body>` only, once at page load**. Per-element values and post-load JS changes to it are **not** honored. Put it in the initial CSS that ships with the page.
- Turn drag on for the **whole page**, not per element.
- **Pointer Lock is not supported** — do **not** call `requestPointerLock`.
- The exact drag event fields (e.g. `movementX`/`movementY`) are device-side. **Verify on-device** by logging `pointermove` before relying on specific fields; prefer `clientX`/`clientY` deltas you compute yourself.
- A pinch on a focused text input opens the composer (see `/add-text-input`) rather than producing a drag.

## Steps

### 1. Enable Drag in the Initial CSS

In `styles.css` (shipped with the page — not injected later):

```css
body { touch-action: none; }
```

### 2. Handle the Pointer Stream

```javascript
var slider = document.getElementById('slider');
var dragging = false;

slider.addEventListener('pointerdown', function (e) {
  dragging = true;
  slider.setPointerCapture(e.pointerId);
});

slider.addEventListener('pointermove', function (e) {
  if (!dragging) return;
  update(e.clientX, e.clientY);     // use client coords; verify deltas on-device
});

slider.addEventListener('pointerup', function () {
  dragging = false;
});
```

### 3. Keep Pinch Activation Working

Even with drag enabled, keep your focusable elements intact so pinch-to-activate still works for buttons and links. Drag is additive, not a replacement for focus navigation.

## Patterns

### Slider

```javascript
function update(x) {
  var rect = slider.getBoundingClientRect();
  var pct = Math.max(0, Math.min(1, (x - rect.left) / rect.width));
  setValue(pct);
  // Reflect `pct` in your slider fill — see /add-ui
}
```

### Pan / Draw

```javascript
var last = null;
canvas.addEventListener('pointerdown', function (e) { last = { x: e.clientX, y: e.clientY }; });
canvas.addEventListener('pointermove', function (e) {
  if (!last) return;
  drawLine(last.x, last.y, e.clientX, e.clientY);
  last = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointerup', function () { last = null; });
```

## Verify

- [ ] Pinch activates focused elements (buttons/links work with no extra code)
- [ ] `body { touch-action: none; }` is in the **initial** stylesheet (not injected later)
- [ ] With drag enabled, the pointer stream arrives (`pointerdown`/`move`/`up`)
- [ ] Without opt-in, focus + pinch still work (no broken cursor expectation)
- [ ] No `requestPointerLock` used
- [ ] Drag event field assumptions verified on-device (logged `pointermove`)

## Related Skills

- `/add-ui` — Build the focusable elements pinch activates
- `/add-text-input` — Why a tap on a focused field opens the composer instead of dragging
