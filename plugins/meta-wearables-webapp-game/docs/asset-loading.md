# Loading assets — 2D textures & 3D models

The scaffold's starter game is procedural (geometry built in code), but real games load art:
images for 2D sprites, mesh files for 3D. This framework ships a small managed loader —
`src/framework/render/AssetLoader.ts` — wrapping the standard Three.js loaders. This doc covers
the basics: where assets live, which formats work, how to load them without breaking the
synchronous render contract, the 2D-vs-3D camera, and disposal.

Scope is intentionally basic. Skeletal animation has a **documented recipe** rather than a
subsystem: clips are returned and rigged models clone correctly, but you own the `AnimationMixer`
(below). Spritesheets get a helper for the windowing half only — `atlasFrameTexture` /
`atlasSprite` cut a frame out of a packed sheet, while the grid, the frame table and the quad
sizing stay game code (see [`spritesheets.md`](spritesheets.md)); there is no atlas-packing or
sprite-animation subsystem. Still **out of scope** (not wired up): morph-target animation,
DRACO / KTX2 / Basis-compressed meshes and textures, and HDR / environment maps.

## Where assets live (Vite conventions)

Put art files in a **`public/`** directory at the project root (create it if it doesn't exist).
Vite copies `public/` verbatim into the build output, so `public/models/ship.glb` ships as
`ship.glb` under the deployed base. This is the standard Vite convention for files you load by
URL at runtime (as opposed to files you `import` and let the bundler hash).

```
my-game/
  public/
    sprites/hero.png
    models/ship.glb
  src/
    ...
```

The scaffold sets `base: './'` in `vite.config.ts` so the build works when it is served from a
sub-path rather than the server root. Because of that, **never hardcode a leading `/`** in an
asset path — pass the
`public/`-relative path to the loader and it resolves the URL for you (via
`import.meta.env.BASE_URL`). So `loadTexture('sprites/hero.png')`, not `'/sprites/hero.png'`.

## Art has to emit light (the additive display, applied to sprites)

**Judge every source asset's brightness before you build the game around it.** The display is an
additive waveguide: emitted light adds to the real world, `#000000` emits nothing and is
therefore fully transparent (see [`display-guidelines.md`](display-guidelines.md)). That rule is
usually explained for CSS surfaces, but it governs **every pixel the game draws** — sprites,
textures, particles. Art is where it is easiest to forget, because art is authored on an opaque
monitor where dark pixels are still perfectly visible.

Four consequences, in the order they bite:

- **A near-black sprite is invisible on the glasses.** Not "low contrast" — no light is emitted
  there, and the wearer looks through it at the room. This is worst for the object you can least
  afford to lose: a charcoal bomb, a dark enemy, a shadowed obstacle. **Whatever the player must
  react to, and above all whatever they must dodge, has to be among the brightest things you
  draw.** On an emissive screen a dark hazard on a bright field reads perfectly; here the field
  is what disappears, so the hazard is what has to glow.
- **Inspect the art, don't assume the palette works.** Sprite sheets drawn for an opaque screen
  routinely carry their whole silhouette in a near-black outline, and lose their read when that
  stroke stops emitting. Crop a few frames out and look at them (see *Optional tooling:
  ImageMagick* in `create-webapp-game`). Treat "too dark" as a defect to fix —
  recolor, brighten, or add an emissive rim — not a style to preserve.
- **An opaque backdrop tile does not become a sky.** A full-bleed background image emits across
  the whole 600x600 canvas, lighting up the wearer's entire view instead of receding behind the
  action. Either drop the backdrop, or derive a sparse version from it — keep the bright motif,
  make the fill transparent — so the negative space stays black and the real world shows through.
- **Where art ships multiple states, brightness beats semantics.** If an object has a dim
  "inactive" frame and a lit "active" frame, anything gameplay-critical should use the lit frame
  in both states and signal the difference some other way (scale, motion, a badge). A state the
  player cannot see is not a state.

Black is still a **tool**: use it deliberately for everything that should disappear —
backgrounds, negative space, the gaps between elements. The discipline applies to the pixels
that carry meaning — so this is **not** "brighten everything". In particular, leave the
renderer's clear color alone: `ThreeRenderer` sets `setClearColor(0x000000, 0)` on purpose, and
that transparency (with the black page background) is what lets the wearer see the room through
the canvas at all.

No static check can catch this — `npm run validate` sees the page background and font sizes, not
what a PNG looks like. It is caught by looking at the art, or on the device.

## Ship external textures too (GLB/GLTF often don't embed them)

A GLB *can* embed its textures, but many exports (including a lot of free asset packs) reference
them **externally** — the mesh file points at a sibling image like `Textures/colormap.png` rather
than baking it in. GLTF (`.gltf` + `.bin` + images) and OBJ (`.obj` + `.mtl` + images) are *always*
multi-file. In every case you must copy the referenced files into `public/` too, preserving the
**relative path the model expects** — the loader resolves image URIs relative to the model's own
URL. So a `models/hero.glb` that references `Textures/colormap.png` needs the image at
`public/models/Textures/colormap.png`:

```
my-game/public/models/
  hero.glb                 # references "Textures/colormap.png"
  Textures/colormap.png    # <- must ship alongside it, at the path the GLB expects
```

**Symptom if you forget:** models render flat white / untextured and the console shows
`THREE.GLTFLoader: Couldn't load texture Textures/colormap.png` (the image 404s). **To check what
a model references** before shipping, inspect its `images`: an `images[].uri` is an external file
you must copy; an `images[].bufferView` is embedded (nothing to copy). For a GLB you can read the
JSON chunk directly, or just open it once and watch the console.

## Supported formats

| Kind | Formats | Loader (via `AssetLoader`) |
|------|---------|----------------------------|
| 2D texture (image) | PNG, WebP, JPG | `loadTexture(path)` → `THREE.TextureLoader` |
| 3D model | GLB, GLTF | `loadModel(path)` → `GLTFLoader` |
| 3D model | FBX | `loadModel(path)` → `FBXLoader` |
| 3D model | OBJ | `loadModel(path)` → `OBJLoader` |

All of these ship with the `three` package (the model loaders live under
`three/examples/jsm/loaders/`), so **no extra dependencies are needed**. `loadModel` picks the
loader from the file extension and imports it dynamically, so a game that loads only textures
never pulls the (large) model loaders into its main bundle.

**Prefer GLB** for 3D: it's a single binary file (mesh + materials, and *optionally* embedded
textures — see the external-textures note above), smaller and faster to load than FBX or OBJ. OBJ
carries no guaranteed materials/textures.

## The preload-then-clone pattern

Loaders are **async**, but the `Renderer` contract (`addModel` → `ModelSpec.build`) is
**synchronous** — the game loop can't await mid-frame. The idiomatic fix: load each asset
**once** at startup, then have `build()` **clone** the preloaded object per instance.

Keep gameplay renderer-agnostic — assets are Three.js objects, so all `three` usage stays in
`src/models.ts` (and the framework). Gameplay still only ever refers to a `ModelId`.

**`src/models.ts`** — preload, then build catalog entries that clone the loaded assets:

```ts
import * as THREE from 'three';

import type { ModelCatalog, ModelSpec } from '@/framework/render/ThreeRenderer';
import { cloneModel, createTexturedPlane, loadModel, loadTexture } from '@/framework/render/AssetLoader';

export type ModelId = 'player' | 'enemy';

/** Loaded-once source objects the catalog clones per instance. */
export interface LoadedAssets {
  heroTexture: THREE.Texture;
  shipModel: THREE.Object3D;
}

/** Load every asset the game needs. Called once, awaited, before the loop starts. */
export async function loadAssets(): Promise<LoadedAssets> {
  const [heroTexture, shipModel] = await Promise.all([
    loadTexture('sprites/hero.png'),
    loadModel('models/ship.glb'),
  ]);
  return { heroTexture, shipModel };
}

/** Build the model catalog from the preloaded assets. `build()` clones — never re-loads. */
export function buildModels(assets: LoadedAssets): ModelCatalog<ModelId> {
  // 2D: a textured sprite. createTexturedPlane builds a fresh material per call, so the tint
  // lands on this instance only.
  const player: ModelSpec = {
    defaultColor: 0xffffff,
    build(color: number): THREE.Object3D {
      const sprite = createTexturedPlane(assets.heroTexture, { width: 1, height: 1 });
      (sprite.material as THREE.MeshBasicMaterial).color.setHex(color);
      return sprite;
    },
  };

  // 3D: clone the loaded mesh hierarchy per instance. Use cloneModel (SkeletonUtils), NOT
  // Object3D.clone() — a rigged model cloned with .clone() won't follow its transform or animate
  // (see "Rigged & animated models" below). A cloneModel clone shares the SOURCE's material, so
  // clone the material yourself before mutating it inside build(); the renderer's own
  // per-instance clone happens after build() returns.
  const enemy: ModelSpec = {
    defaultColor: 0xffffff,
    build(): THREE.Object3D {
      return cloneModel(assets.shipModel);
    },
  };

  return { player, enemy };
}
```

**`src/main.ts`** — make `main` async and await the preload before wiring the renderer:

```ts
async function main(): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
  if (!canvas) throw new Error('Could not find #game-canvas element.');

  const assets = await loadAssets();               // one-time preload
  const renderer = new ThreeRenderer(canvas, buildModels(assets));
  renderer.resize(DISPLAY.width, DISPLAY.height);
  // ...wire input, Game, Hud, GameLoop exactly as the starter does...
}

main().catch((err) => {
  // Surface a load failure instead of a silent black screen.
  console.error('Failed to start game:', err);
});
```

A game with no assets keeps the original synchronous `main()` — this pattern is only for games
that load files.

**Want a progress bar while this runs?** Instead of awaiting a hand-written `loadAssets()`,
declare a manifest and load it with the framework's `preloadManifest` + `LoadingScreen` — a
size-weighted progress bar shown before the title screen, with no per-game loading UI. The manifest
also handles **audio** (an `{ type: 'audio' }` entry decodes to an `AudioBuffer` for the framework
`AudioPlayer`; with a `bank` it is stored compressed and decoded later — see
[`audio-banks.md`](audio-banks.md)) and arbitrary files (JSON/binary) via a `raw` entry.
See [`loading-screen.md`](loading-screen.md).

## Lighting & unlit materials (3D models)

The renderer's scene has **no lights** — correct for the additive display, where only emitted
color is visible. But most GLB/FBX models ship **lit** materials (`MeshStandardMaterial` /
`MeshPhongMaterial`), which render **black** without a light. Two options:

- **Convert to unlit (recommended for the additive display):** swap each material for an unlit
  `MeshBasicMaterial`, keeping the texture `map` (and `vertexColors`), so the model shows at full
  brightness like the rest of the scene. Do this once on the loaded source, before cloning:

```ts
function toUnlit(object: THREE.Object3D): THREE.Object3D {
  object.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    const convert = (m: THREE.Material) => {
      const lit = m as THREE.MeshStandardMaterial;
      const basic = new THREE.MeshBasicMaterial({ map: lit.map ?? null, vertexColors: lit.vertexColors });
      m.dispose();
      return basic;
    };
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
  });
  return object;
}
```

  `MeshBasicMaterial` still supports skinning, so this is safe for animated characters.
- **Or add lights:** register a light as a "model" (its `build()` returns a `THREE.AmbientLight` /
  `DirectionalLight`) so lit materials shade normally. On the additive display, flat unlit color is
  usually what you want.

## Rigged & animated models (skeletal animation)

Rigged models (characters, creatures) carry a **skeleton** and named **animation clips**. Two
things differ from static props:

1. **Clone with `cloneModel`.** `Object3D.clone()` does not rebind a `SkinnedMesh` to a cloned
   skeleton — the clone stays driven by the *source* skeleton, so it renders at the source's
   position and won't follow its own transform or animate independently. `cloneModel`
   (SkeletonUtils under the hood) clones the rig correctly. **Symptom of the bug:** the model
   shows up but never moves when you `setTransform` it (gameplay logic runs; the mesh just sits).

2. **Own an `AnimationMixer` and tick it.** The `Renderer` contract has no per-frame animation
   hook (it's intentionally animation-agnostic), so the game drives animation. Load with
   `loadModelWithAnimations` to keep the clips, make one `AnimationMixer` per animated instance in
   `src/models.ts`, and advance them each frame from the loop.

`src/models.ts` — load clips, and set up a mixer when building an instance:

```ts
import * as THREE from 'three';
import { cloneModel, loadModelWithAnimations } from '@/framework/render/AssetLoader';
import type { ModelCatalog, ModelSpec } from '@/framework/render/ThreeRenderer';

export type ModelId = 'hero';

const mixers: THREE.AnimationMixer[] = [];
/** Advance every character animation. Call once per frame from the loop. */
export function updateMixers(dt: number): void {
  for (const mixer of mixers) mixer.update(dt);
}

export async function loadAssets() {
  return { hero: await loadModelWithAnimations('models/hero.glb') };
}

export function buildModels(assets: Awaited<ReturnType<typeof loadAssets>>): ModelCatalog<ModelId> {
  const hero: ModelSpec = {
    defaultColor: 0xffffff,
    build(): THREE.Object3D {
      const object = cloneModel(assets.hero.object);   // clone the RIG correctly
      const mixer = new THREE.AnimationMixer(object);
      const clip = THREE.AnimationClip.findByName(assets.hero.animations, 'idle');
      if (clip) mixer.clipAction(clip).play();
      mixers.push(mixer);
      return object;
    },
  };
  return { hero };
}
```

`src/main.ts` — advance the mixers in the loop's `update` (dt is seconds):

```ts
const loop = new GameLoop({
  update: (dt) => { game.update(dt); updateMixers(dt); },
  render: () => { game.render(); hud.update(); },
});
```

Tips:
- **Keep gameplay `three`-free.** The mixer lives in `models.ts`; if animation should react to
  gameplay (play `walk` while moving, `idle` at rest), expose a plain boolean from the game
  (`game.isMoving()`) and switch clips in a small controller in `models.ts` — don't import `three`
  into `core/`.
- **Blend** idle<->walk by playing both actions and cross-fading their `setEffectiveWeight`, so
  each keeps its own phase.
- **Root motion:** most clips are *in-place* (no root translation) and won't fight a position-based
  move. A clip that translates the root will drift against `setTransform` — pick an in-place clip
  or strip the root track.

## 2D vs 3D camera

The renderer's camera projection is selectable via `ThreeRenderer`'s options:

```ts
// 3D (default): perspective camera — depth foreshortening.
new ThreeRenderer(canvas, models);

// 2D: orthographic camera — parallel projection, objects keep size regardless of depth.
// `viewSize` is the half-height of the visible area in world units (so ~10 units tall here).
new ThreeRenderer(canvas, models, { projection: 'orthographic', viewSize: 5 });
```

For a 2D game, use `createTexturedPlane(texture, { width, height })` to make sprites and place
them on the z=0 plane (positions still use the framework `Vector3` — set `z = 0`). The plane
uses an unlit material, correct for the additive display (the scene has no lights), so the
texture shows at full brightness.

Where the sprites come from one packed image, use `atlasSprite(sheet, { x, y, w, h }, { width,
height })` instead — it clones the `THREE.Texture` (not just the material) so each frame gets its
own window. Sizing the quad from the art's measured silhouette rather than its cell is still on
you: see [`spritesheets.md`](spritesheets.md).

## Disposal

GPU resources aren't freed by garbage collection — they must be disposed explicitly.

- **Per-instance:** `ThreeRenderer.remove(handle)` disposes the geometry and materials of the
  object it removes. **Materials are safe**: `addModel` replaced them with per-instance clones
  before the object reached the scene (which is also what makes `setOpacity` / `setFrame`
  per-instance), so `remove()` frees a material nothing else uses. **Geometry is not.** A
  `cloneModel` clone shares the source's geometry (like `Object3D.clone()`), so removing one
  instance of a preloaded-and-cloned model disposes geometry its siblings are still drawing —
  give each clone its own geometry, or keep those instances for the session and dispose the
  source on teardown.
- **Shared preloaded assets:** the source `Texture` / `Object3D` returned by `loadTexture` /
  `loadModel` are owned by the game, not by any instance. Dispose them on teardown (e.g. when
  leaving the game): call `.dispose()` on textures, and traverse a loaded model disposing each
  mesh's geometry/material.
- **Spritesheet frames:** the textures `atlasFrameTexture` / `atlasSprite` return are clones
  sharing the sheet's `Source`, and the GPU upload is reference-counted across them. Dispose the
  frame textures the catalog holds, not only the sheet — disposing a sheet the renderer never drew
  frees nothing. See [`spritesheets.md`](spritesheets.md).

## Performance

The device budget (see `performance-guidelines.md`) applies to assets too:

- **Bundle (< 500 KB gzipped JS):** the model loaders are code-split, so unused ones don't count
  — but a large mesh/texture *file* still counts against load time and memory.
- **Memory (< 128 MB):** keep textures small; use power-of-two dimensions where you can.
- **Network (< ~10 requests on load):** prefer a single GLB over multi-file formats; batch loads
  with `Promise.all`.
- Prefer GLB over FBX/OBJ, and compress source textures before shipping them.
