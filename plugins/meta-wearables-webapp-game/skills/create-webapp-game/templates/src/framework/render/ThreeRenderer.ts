/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * license file distributed with this framework directory.
 */

/**
 * One of three files that import `three` (the others are `render/AssetLoader.ts` and the game's
 * `src/models.ts`). Implements the `Renderer` contract with a Three.js scene: a fixed camera
 * looking down -Z, and models on a transparent (black) background so they read as bright vector
 * art on the additive display.
 *
 * The camera projection is selectable: a **perspective** camera for 3D games (the default) or an
 * **orthographic** camera for flat 2D games (no depth foreshortening) — pass `projection` in the
 * constructor options.
 *
 * This renderer is model-agnostic: it builds geometry from a `ModelCatalog` the game passes
 * in. The game declares its ids and geometry in `src/models.ts` — add models there, not here.
 *
 * Every instance owns its materials: `addModel` clones whatever the spec built before the object
 * reaches the scene, which is what lets `setOpacity` and `setFrame` change one instance without
 * touching the siblings a preloaded-and-cloned model would otherwise share a material with.
 */

import * as THREE from 'three';

import { atlasFrameTexture } from '@/framework/render/AssetLoader';
import type { AtlasFrame } from '@/framework/render/AssetLoader';
import type { Vector3 } from '@/framework/math/Vector3';
import type { RenderStats, Renderer, RenderHandle } from '@/framework/render/Renderer';

/**
 * How to build one model's Three.js object. The game supplies one spec per model id.
 * `build` receives the resolved color (the caller's override, or `defaultColor`).
 *
 * `sheet` + `frames` are what make `setFrame` work for this model: the renderer cuts one
 * windowed texture per rect when the catalog is registered, and `setFrame(handle, i)` swaps the
 * instance's `material.map` to frame `i`. Declare them together — `frames` without a `sheet`,
 * or an empty `frames`, throws at construction.
 */
export interface ModelSpec {
  build(color: number): THREE.Object3D;
  defaultColor: number;
  /** The loaded spritesheet `frames` are cut from. Required whenever `frames` is set. */
  sheet?: THREE.Texture;
  /**
   * The model's frame rects, in sheet pixels from the **top-left** (see {@link AtlasFrame}).
   * Position in this array is the index `setFrame` takes.
   */
  frames?: readonly AtlasFrame[];
}

/** The game's full model registry: one `ModelSpec` per model id. */
export type ModelCatalog<TModelId extends string> = Record<TModelId, ModelSpec>;

/**
 * Camera configuration for the renderer. Defaults suit a 3D game; set `projection:
 * 'orthographic'` for a flat 2D game (parallel projection — objects keep their size regardless
 * of depth).
 */
export interface ThreeRendererOptions {
  /** `'perspective'` (3D, default) or `'orthographic'` (2D). */
  projection?: 'perspective' | 'orthographic';
  /** Camera distance from the origin along +Z. Default 10. */
  cameraDistance?: number;
  /** Vertical field of view in degrees. Perspective only. Default 60. */
  fov?: number;
  /** Half-height of the visible area in world units. Orthographic only. Default 5. */
  viewSize?: number;
}

/** The GPU-backed resources an Object3D may own; both must be released explicitly. */
interface Disposable3D {
  geometry?: { dispose(): void };
  material?: { dispose(): void } | Array<{ dispose(): void }>;
}

/** The material slot an `Object3D` may carry — a `Mesh`, `Line`, `Points` or `Sprite` does. */
interface MaterialCarrier {
  material?: THREE.Material | THREE.Material[];
}

/** A material with a texture slot — what `setFrame` retargets. */
type TexturedMaterial = THREE.Material & { map?: THREE.Texture | null };

/**
 * Everything the renderer knows about one live instance, in a single record so that the fields
 * cannot disagree: `addModel` writes it whole and `remove` deletes it whole, which is what makes
 * "a frame-declaring instance always has a resolved target" a type rather than a convention.
 *
 * `materials` and `frames` are resolved once at spawn rather than found per call: `setOpacity` is
 * pushed from `update(dt)` for every fading instance and `setFrame` for every animating sprite,
 * and a per-call `traverse` would walk the hierarchy and allocate on a device with a 128 MB
 * budget and no headroom for GC. The set of materials on an instance is fixed for its lifetime.
 */
interface Instance<TModelId extends string> {
  object: THREE.Object3D;
  modelId: TModelId;
  /** Every material on the instance, cloned per-instance by `takeOwnershipOfMaterials`. */
  materials: THREE.Material[];
  /** Present exactly when the model declares frames — the cut textures and the material to swap. */
  frames?: { textures: THREE.Texture[]; target: TexturedMaterial };
}

export class ThreeRenderer<TModelId extends string = string>
  implements Renderer<TModelId>
{
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  private readonly viewSize: number;
  private readonly instances = new Map<number, Instance<TModelId>>();
  /**
   * One windowed texture per declared frame, cut once here and reused for the renderer's whole
   * life — `setFrame` only reassigns `material.map`, so a frame swap allocates nothing.
   */
  private readonly frameTextures = new Map<TModelId, THREE.Texture[]>();
  private nextHandle = 1;

  public constructor(
    canvas: HTMLCanvasElement,
    private readonly catalog: ModelCatalog<TModelId>,
    options: ThreeRendererOptions = {},
  ) {
    const { projection = 'perspective', cameraDistance = 10, fov = 60, viewSize = 5 } = options;
    this.viewSize = viewSize;

    // alpha:true keeps the page's black background showing through (transparent on device).
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);

    // Aspect is corrected in resize(); start at 1 (the 600x600 stage is square anyway).
    if (projection === 'orthographic') {
      this.camera = new THREE.OrthographicCamera(
        -viewSize,
        viewSize,
        viewSize,
        -viewSize,
        0.1,
        100,
      );
    } else {
      this.camera = new THREE.PerspectiveCamera(fov, 1, 0.1, 100);
    }
    this.camera.position.set(0, 0, cameraDistance);
    this.camera.lookAt(0, 0, 0);

    this.cutFrames();
  }

  public addModel(modelId: TModelId, color?: number): RenderHandle {
    const spec = this.catalog[modelId];
    const object = spec.build(color ?? spec.defaultColor);
    // The clone pass already visits every material carrier, so it collects the instance's
    // materials on the way rather than traversing the hierarchy a second time to find them.
    const materials = this.takeOwnershipOfMaterials(object);

    // Resolved before anything is registered: `resolveFrameTarget` throws for a model that
    // declares frames it cannot animate, and an entry written first would outlive the throw —
    // reachable by neither the caller (who never receives the handle) nor `remove()`.
    const textures = this.frameTextures.get(modelId);
    const frames = textures
      ? { textures, target: this.resolveFrameTarget(modelId, materials) }
      : undefined;

    const handle = this.nextHandle++;
    this.instances.set(handle, { object, modelId, materials, frames });
    this.scene.add(object);
    return handle as RenderHandle;
  }

  /**
   * The single material `setFrame` will retarget on this instance.
   *
   * Resolved once per instance rather than once per swap, and therefore reported here: whether a
   * model builds exactly one textured material is a property of the model, so a game that gets it
   * wrong should fail when it spawns the thing, not on whichever later frame first animates it.
   */
  private resolveFrameTarget(modelId: TModelId, materials: THREE.Material[]): TexturedMaterial {
    // `material.map != null`, not `'map' in material`: every standard Three material declares
    // `map` and initialises it to `null`, so the `in` test counts an untextured shadow or glow
    // quad as a second textured material (rejecting a legal model with a message that is false
    // for it), and passes a lone material carrying no texture at all.
    const mapped = materials.filter(
      (material): material is TexturedMaterial => (material as TexturedMaterial).map != null,
    );
    if (mapped.length === 0) {
      throw new Error(
        `addModel: model "${modelId}" declares frames, but nothing it builds has a material with ` +
          'a texture map, so setFrame() would have nothing to animate. Build it from ' +
          'atlasSprite() or createTexturedPlane().',
      );
    }
    if (mapped.length > 1) {
      throw new Error(
        `addModel: model "${modelId}" declares frames but builds ${mapped.length} materials with ` +
          'a texture map, so which one setFrame() animates is ambiguous. A frame-declaring model ' +
          'is one textured quad — give a separate textured part (a shadow, a glow) its own model.',
      );
    }
    return mapped[0];
  }

  public setTransform(handle: RenderHandle, position: Vector3): void {
    const instance = this.instances.get(handle);
    if (instance) {
      instance.object.position.set(position.x, position.y, position.z);
    }
  }

  public setRotation(handle: RenderHandle, radians: number): void {
    const instance = this.instances.get(handle);
    if (instance) {
      instance.object.rotation.z = radians;
    }
  }

  public setScale(handle: RenderHandle, scale: number | Vector3): void {
    const instance = this.instances.get(handle);
    if (!instance) {
      return;
    }
    const { object } = instance;
    // Same rule as `setOpacity` below, for the same reason: a non-finite factor propagates into
    // the world matrix and the instance disappears with no error anywhere. A scale pulsed from
    // `dt` can go non-finite exactly the way a fade can.
    if (typeof scale === 'number') {
      if (!Number.isFinite(scale)) {
        throw new Error(`setScale: scale must be a finite number (got ${scale}).`);
      }
      object.scale.setScalar(scale);
    } else {
      if (!Number.isFinite(scale.x) || !Number.isFinite(scale.y) || !Number.isFinite(scale.z)) {
        throw new Error(
          `setScale: scale components must be finite (got ${scale.x}, ${scale.y}, ${scale.z}).`,
        );
      }
      object.scale.set(scale.x, scale.y, scale.z);
    }
  }

  public setOpacity(handle: RenderHandle, opacity: number): void {
    // Collected in addModel, so this is a lookup rather than a traversal — see `Instance`.
    // A fade is pushed every frame for every fading instance.
    const instance = this.instances.get(handle);
    if (!instance) {
      return;
    }
    const { materials } = instance;
    if (!Number.isFinite(opacity)) {
      // A `NaN` opacity makes the sprite vanish with no error anywhere — always a bug upstream
      // (an uninitialised fade timer, a divide by zero), and unrecoverable here.
      throw new Error(`setOpacity: opacity must be a finite number 0..1 (got ${opacity}).`);
    }
    // Out-of-range is clamped, not thrown: a fade accumulating `dt` routinely overshoots the ends
    // by a fraction of a frame, and crashing a game for that would be worse than the wrong-looking
    // material an unclamped value gives Three.
    const alpha = Math.min(1, Math.max(0, opacity));
    for (const material of materials) {
      // `transparent` feeds the OPAQUE shader define and the program cache key
      // (`WebGLPrograms.getProgramCacheKeyBooleans`, three 0.184.0), so a change needs a
      // recompile. It is only ever turned ON: clearing it at opacity 1 would strip the alpha
      // channel from a sprite whose material was built transparent to show its cutout.
      if (alpha < 1 && !material.transparent) {
        material.transparent = true;
        material.needsUpdate = true;
      }
      material.opacity = alpha;
    }
  }

  public setFrame(handle: RenderHandle, frame: number): void {
    const instance = this.instances.get(handle);
    if (!instance) {
      return;
    }
    const { modelId, frames: animation } = instance;
    if (!animation) {
      throw new Error(
        `setFrame: model "${modelId}" declares no frames. Give its ModelSpec a "sheet" and a ` +
          '"frames" array of pixel rects (see docs/spritesheets.md).',
      );
    }
    const { textures, target } = animation;
    // Checked before the lookup so the two defects get their own message: `textures[1.5]` is
    // `undefined` just as `textures[9]` is, and reporting a fractional index as "outside the
    // declared frames" sends the reader looking for a range bug that isn't there. Matches
    // `FakeRenderer.setFrame`, so a game hits the same diagnosis in a test and on device.
    if (!Number.isInteger(frame) || frame < 0) {
      throw new Error(`setFrame: frame must be a non-negative integer (got ${frame}).`);
    }
    const texture = textures[frame];
    if (!texture) {
      throw new Error(
        `setFrame: frame ${frame} is outside model "${modelId}"'s ${textures.length} declared ` +
          'frame(s).',
      );
    }

    // `resolveFrameTarget` only ever picks a material that already carries a map, so a swap needs
    // no recompile (USE_MAP is already defined) and re-uploads nothing (the frames share the
    // sheet's Source).
    target.map = texture;
  }

  public setVisible(handle: RenderHandle, visible: boolean): void {
    const instance = this.instances.get(handle);
    if (instance) {
      instance.object.visible = visible;
    }
  }

  public remove(handle: RenderHandle): void {
    const instance = this.instances.get(handle);
    if (instance) {
      const { object } = instance;
      this.scene.remove(object);
      // Three.js does not free GPU geometry/material when an object leaves the scene;
      // dispose them explicitly or they leak for the lifetime of the WebGL context.
      this.disposeObject(object);
      this.instances.delete(handle);
    }
  }

  public resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    const aspect = width / height;
    if (this.camera instanceof THREE.OrthographicCamera) {
      this.camera.left = -this.viewSize * aspect;
      this.camera.right = this.viewSize * aspect;
      this.camera.top = this.viewSize;
      this.camera.bottom = -this.viewSize;
    } else {
      this.camera.aspect = aspect;
    }
    this.camera.updateProjectionMatrix();
  }

  public render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Snapshot GPU work for the `?stats` overlay. `info.render.*` is per-frame — Three.js
   * resets it at the start of each `render()` (`info.autoReset` defaults on) — so this
   * reflects the frame just drawn only when called after `render()`. `info.memory.*` are
   * live resource gauges.
   */
  public getStats(): RenderStats {
    const { render, memory } = this.renderer.info;
    return {
      drawCalls: render.calls,
      triangles: render.triangles,
      points: render.points,
      lines: render.lines,
      geometries: memory.geometries,
      textures: memory.textures,
    };
  }

  /**
   * Cut one windowed texture per declared frame, for every model in the catalog that declares
   * any. Runs once, at construction: the sheet is already decoded by then (the game preloads its
   * art and builds the catalog before constructing the renderer), and cutting here keeps
   * `setFrame` allocation-free.
   *
   * These textures live as long as the renderer and are not disposed with the instances that use
   * them — `remove()` frees per-instance geometry and materials only. They share the sheet's
   * `Source`, so they hold no GPU memory of their own, but a game that constructs a second
   * renderer (a level reload) leaves the first one's `THREE.Texture` objects behind along with
   * the rest of it. Reuse one renderer for the session rather than rebuilding it.
   */
  private cutFrames(): void {
    for (const modelId of Object.keys(this.catalog) as TModelId[]) {
      const { sheet, frames } = this.catalog[modelId];
      if (!frames) {
        // `sheet` is read nowhere else, so one without `frames` is a half-written declaration
        // (`frame:` for `frames:`, say) that would otherwise surface in-page as
        // `setFrame: model "x" declares no frames` on the first animation call.
        if (sheet) {
          throw new Error(
            `Model "${modelId}" declares a "sheet" but no "frames" to cut from it. Set both, or ` +
              'neither.',
          );
        }
        continue;
      }
      if (frames.length === 0) {
        throw new Error(
          `Model "${modelId}" declares an empty "frames" array. Drop the field, or list the ` +
            'frame rects setFrame() should index.',
        );
      }
      if (!sheet) {
        throw new Error(
          `Model "${modelId}" declares "frames" but no "sheet" to cut them from. Set both, or ` +
            'neither.',
        );
      }
      this.frameTextures.set(
        modelId,
        frames.map((frame) => atlasFrameTexture(sheet, frame)),
      );
    }
  }

  /**
   * Replace every material on a freshly built instance with a per-instance clone, so that
   * `setOpacity` / `setFrame` change one instance and not its siblings. A spec that builds by
   * cloning a preloaded object (the pattern in `docs/asset-loading.md`) hands out objects that
   * SHARE one material — `Object3D.clone()` and `SkeletonUtils.clone` both copy the reference —
   * and one shared material is one fade for every instance at once.
   *
   * Cloning here, before the object is added to the scene, is also what makes `remove()`'s
   * disposal safe: it frees a material this instance alone uses. The replaced original has never
   * been rendered, so it holds no GPU program and is plain garbage. The clone shares the
   * original's textures by reference, so per-instance materials cost no extra GPU memory.
   *
   * Returns the clones it assigned, in traversal order, so `addModel` gets the instance's
   * material list without a second walk of the same hierarchy.
   */
  private takeOwnershipOfMaterials(object: THREE.Object3D): THREE.Material[] {
    const owned: THREE.Material[] = [];
    object.traverse((node) => {
      const carrier = node as unknown as MaterialCarrier;
      const { material } = carrier;
      if (Array.isArray(material)) {
        const clones = material.map((entry) => entry.clone());
        carrier.material = clones;
        for (const clone of clones) {
          owned.push(clone);
        }
      } else if (material) {
        const clone = material.clone();
        carrier.material = clone;
        owned.push(clone);
      }
    });
    return owned;
  }

  /** Free the GPU geometry + material owned by an object and all its descendants. */
  private disposeObject(object: THREE.Object3D): void {
    object.traverse((node) => {
      const { geometry, material } = node as unknown as Disposable3D;
      geometry?.dispose();
      if (Array.isArray(material)) {
        for (const entry of material) {
          entry.dispose();
        }
      } else {
        material?.dispose();
      }
    });
  }
}
