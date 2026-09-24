---
name: ai-glasses-webapp-device
description: "Add Meta Ray-Ban Display glasses-specific sensors and input behavior: motion, orientation, compass, step detection, geolocation, neural-band activation/drag, D-pad game controls, or handwriting/voice text composition."
argument-hint: "[sensors|gestures|game-controls|text-input]"
---

# Add glasses device capabilities

Use standard browser APIs. This skill covers only behavior that differs on the
glasses; use `ai-glasses-webapp-build` for the screen and UI toolkit shell.

## Sensors and location

- Request motion/orientation/location from an explicit Start or Enable action.
  Await `DeviceMotionEvent.requestPermission()` and
  `DeviceOrientationEvent.requestPermission()` where present.
- Use `devicemotion` for acceleration/rotation,
  `deviceorientation`/`deviceorientationabsolute` for heading/tilt, and
  `navigator.geolocation.watchPosition()` for position and speed.
- Treat nullable, denied, revoked, stale, inaccurate, and unsupported readings
  as ordinary states. Never present demo values as live data.
- Keep stable listener functions and watch IDs. Stop them exactly once on
  Pause/Stop, visibility loss, route exit, and unmount. A resumable session
  preserves accumulated metrics and elapsed time while releasing resources.
- Process raw motion only when required and throttle React/UI commits to
  10–30 Hz. Step counting should filter acceleration magnitude and reject
  implausibly rapid peaks. Label steps as estimated.
- Use reported geolocation speed when accurate. Otherwise derive distance/speed
  only from accurate timestamped positions.
- Provide deterministic injection for tests and, when useful, a clearly labeled
  desktop Demo action that never requests device permission.

## D-pad, pinch, and continuous gestures

Pinch and Enter already map to `onClick` on a focused toolkit `Button`. Supply
one `onClick` handler only. Do not add `onActivate` handlers that synthesize a
second click or time-based click debouncing; both create stale or ignored state
transitions. Pinch is not a positioned pointer event.

For continuous drag only, put `touch-action: none` on `body` in the initial
stylesheet, use Pointer Events with pointer capture and client-coordinate
deltas, and cancel on pointer cancellation, hide, route exit, and unmount.
Pointer Lock is unsupported. Do not enable `touch-action: none` for apps that do
not use continuous drag.

For games, focus the canvas only after Play. While playing, arrow keys control
the game and prevent page navigation. Escape pauses/exits, stops the loop, and
restores focus to the initiating toolkit action. Keep score/status available as
ordinary accessible text. Commit an accepted direction to the observable game
state immediately; deterministic/test modes may freeze board advancement, so a
direction snapshot must not depend on a later animation tick.

## Text composition

Standard text-like `<input>` and `<textarea>` controls open the glasses
handwriting/voice composer after wearer focus and activation. No proprietary
SDK call is needed. Read committed text from `input` or `change`; programmatic
focus does not open the composer. Use clear labels and keep essential flows
usable when composition is unavailable. Do not build a custom keyboard.

Run `ai-glasses-webapp-test` with granted, denied, unsupported, active, paused,
hidden-page, cleanup, and deterministic demo scenarios that apply.
