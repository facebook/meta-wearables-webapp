/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * A tiny framework-free 3D vector value type. Gameplay and the renderer contract use this
 * instead of Three.js's `Vector3` so that gameplay never imports `three`. The Three.js
 * renderer converts these into its own vectors internally.
 */
export class Vector3 {
  public constructor(
    public x: number = 0,
    public y: number = 0,
    public z: number = 0,
  ) {}

  public set(x: number, y: number, z: number): this {
    this.x = x;
    this.y = y;
    this.z = z;
    return this;
  }

  public clone(): Vector3 {
    return new Vector3(this.x, this.y, this.z);
  }
}

/** Clamp `value` to the inclusive range [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }
  if (value > max) {
    return max;
  }
  return value;
}
