/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * The gameplay-facing rendering contract. All gameplay code talks to this interface and
 * never imports Three.js directly — the Three.js implementation lives in `ThreeRenderer.ts`.
 * This keeps the renderer swappable and gameplay unit-testable (a fake Renderer drives
 * tests with no GPU). Types here are framework-free: positions use the project `Vector3`,
 * colors are 0xRRGGBB numbers, instances are opaque handles.
 *
 * The contract is generic over the game's model-id union (`TModelId`). The game declares its
 * ids and geometry in `src/models.ts`; the framework stays agnostic to which models exist.
 */

import type { Vector3 } from '@/framework/math/Vector3';

/** Opaque reference to a rendered instance. The brand makes it distinct from a number. */
export type RenderHandle = number & { readonly __brand: 'RenderHandle' };

/**
 * Backend-agnostic snapshot of GPU work, read by the `?stats` debug overlay. Framework-free
 * (plain numbers, no `three` types) so gameplay and the overlay never import Three.js. The
 * three per-frame counters (`drawCalls`, `triangles`, `points`, `lines`) reflect the *last*
 * rendered frame, so read them **after** `render()`. `geometries` / `textures` are live
 * gauges (total resources currently held), not per-frame counts.
 */
export interface RenderStats {
  drawCalls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
}

export interface Renderer<TModelId extends string = string> {
  /** Instantiate a model, add it to the scene, return a handle. */
  addModel(modelId: TModelId, color?: number): RenderHandle;

  /** Position an instance. */
  setTransform(handle: RenderHandle, position: Vector3): void;

  /**
   * Rotate an instance about the view axis (Z). Angle in radians. Framework extension for 2D
   * games that need spin (rolling ball, swinging flippers, spinning pickups). The base contract
   * documents that rotation is an opt-in impl extension — this is that extension.
   */
  setRotation(handle: RenderHandle, radians: number): void;

  /**
   * Resize an instance: one factor applied to all three axes, or a `Vector3` for per-axis
   * squash and stretch. Composes with `setTransform` / `setRotation` rather than replacing them.
   *
   * A bare number carries the cues a 2D game actually needs — a pickup pulsing, a hazard growing
   * as it arms, a hit popping — and reads at the call site as what it is. The `Vector3` form
   * exists for the one case a single factor cannot express: squash and stretch, where the axes
   * have to diverge.
   *
   * **Optional**, like `getStats` — see the note under {@link setFrame}. Gameplay calls it as
   * `renderer.setScale?.(handle, 1.2)`.
   *
   * This is a channel, not an animation system. There is no tween, easing curve or timeline
   * anywhere in this contract: a game that wants a pulse computes the factor in its own
   * `update(dt)` and pushes it here each frame.
   */
  setScale?(handle: RenderHandle, scale: number | Vector3): void;

  /**
   * Fade an instance: `1` fully opaque, `0` fully invisible. Applies to every material the
   * instance carries, so a multi-material 3D model fades as one object. For hiding something
   * outright, `setVisible` is cheaper; opacity is for the in-between — fading in and out, damage
   * flashes, ghosting a preview of where a piece would land.
   *
   * Fades are **per instance**: an implementation must be able to fade one instance of a model
   * without touching its siblings, however it shares GPU resources between them.
   *
   * **Optional**, like `getStats` — see the note under {@link setFrame}.
   *
   * A value outside `0..1` is clamped, because a fade accumulating `dt` overshoots the ends by a
   * fraction of a frame as a matter of course. A non-finite one **throws**: `NaN` makes the
   * instance vanish with no error anywhere, and it is never anything but a bug upstream.
   *
   * A channel, not an animation system: the game drives the value from its own `update(dt)`.
   */
  setOpacity?(handle: RenderHandle, opacity: number): void;

  /**
   * Show frame `frame` of the instance's model — the 2D sprite-animation channel. A model
   * declares its frames in the game's catalog (for the Three.js backend, `ModelSpec.sheet` plus
   * `ModelSpec.frames`); `frame` indexes that list from 0, in declaration order. Per instance,
   * like {@link setOpacity}: two instances of one model can show different frames.
   *
   * Calling it on a model that declares no frames, or with an index outside its list, is a
   * programming error and **throws**. Silently showing the wrong art is the failure this channel
   * exists to prevent, and it survives every static check.
   *
   * A frame-declaring model must build **exactly one** material with a texture map, or there is
   * no unambiguous thing to animate. That is a property of the model rather than of any one call,
   * so an implementation is expected to check it when the instance is created and throw there —
   * `ThreeRenderer` does, from `addModel`, which is why the error arrives when the game spawns
   * the object rather than on whichever later frame first animates it.
   *
   * **Optional** on the interface: a backend that cannot offer a channel omits it (as `getStats`
   * does), and making these required would turn a framework re-sync into a compile error in any
   * game that wrote its own `Renderer`. Both shipped implementations — `ThreeRenderer` and
   * `FakeRenderer` — provide all three, so `renderer.setFrame?.(handle, i)` never silently
   * no-ops in a scaffolded game.
   *
   * Which frame to show when is the game's business: no playback clock, per-frame duration or
   * loop mode lives here. Advance the index from `update(dt)`.
   */
  setFrame?(handle: RenderHandle, frame: number): void;

  /** Show / hide an instance. */
  setVisible(handle: RenderHandle, visible: boolean): void;

  /** Destroy an instance. */
  remove(handle: RenderHandle): void;

  /** Resize the drawing surface. */
  resize(width: number, height: number): void;

  /** Render one frame (the camera is owned by the renderer). */
  render(): void;

  /**
   * Optional per-frame GPU stats for the `?stats` debug overlay. Undefined when a backend
   * (or a test fake) can't report them; the overlay degrades gracefully. Call after
   * `render()` — the per-frame counters describe the frame just drawn.
   */
  getStats?(): RenderStats;
}
