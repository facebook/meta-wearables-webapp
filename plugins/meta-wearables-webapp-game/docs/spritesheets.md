# Spritesheets & texture atlases

A spritesheet packs many frames into one image, so the game issues one network request and the
GPU holds one texture — which is how a sprite-heavy game stays inside the device's load budget
(see [`performance-guidelines.md`](performance-guidelines.md)). `AssetLoader` loads the sheet as a
single `THREE.Texture`; **`atlasFrameTexture` / `atlasSprite` cut a frame out of it**. Deciding
which pixels each frame covers, and how big to draw it, is still game code in `src/models.ts` —
and that is where the three mistakes live that make a sheet-backed game look broken while
`typecheck`, `test`, `build` and `validate` all pass.

**To animate a sprite, declare its frames on the model and call
[`setFrame`](#animating-a-sprite-setframe)** — that is the whole mechanism, and the rest of this
doc is the machinery underneath it plus the two sizing traps that no static check catches.

Read [`asset-loading.md`](asset-loading.md) first for where art files live, the preload-then-clone
pattern, and why art has to emit light on the additive display.

## Cutting a frame: `atlasFrameTexture` / `atlasSprite`

```ts
import { atlasFrameTexture, atlasSprite } from '@/framework/render/AssetLoader';
import type { AtlasFrame } from '@/framework/render/AssetLoader';

// A cloned texture windowed to the frame — use it to build your own mesh, or to swap an existing
// sprite's `material.map` between preallocated frames.
atlasFrameTexture(sheet: THREE.Texture, frame: AtlasFrame): THREE.Texture;

// The quad: atlasFrameTexture + createTexturedPlane, with the same TexturedPlaneOptions.
atlasSprite(sheet: THREE.Texture, frame: AtlasFrame, options?: TexturedPlaneOptions): THREE.Mesh;

interface AtlasFrame { x: number; y: number; w: number; h: number }  // pixels, from the top-left
```

```ts
const coin = atlasSprite(sheet, { x: 128, y: 0, w: 128, h: 128 }, { width: 1, height: 1 });
```

The rect is in **pixels from the sheet's top-left** — what an image editor, a packer's JSON, and
`magick -crop` all report. The sheet's own size comes from the texture, and the helper **throws**
rather than emit a bad window: if the sheet has no decoded image yet (a `loadTexture` that wasn't
awaited), or if the rect is not a finite rect inside it. A wrong window is silent in every static
check, so failing loudly is the point.

Cut each frame **once**, when the model catalog is built — not inside `build()`, which runs per
instance. For a model that animates, don't cut them yourself at all: declare the rects and let
the renderer do it, next.

## Animating a sprite: `setFrame`

A model that animates declares its sheet and its frame rects on its `ModelSpec`, and gameplay
picks a frame by index:

```ts
// src/models.ts — declaration order IS the index setFrame() takes.
const heroFrames = [
  { x: 0, y: 0, w: 128, h: 128 },
  { x: 128, y: 0, w: 128, h: 128 },
  { x: 256, y: 0, w: 128, h: 128 },
];
// Cut once, out here — build() runs per instance, and setFrame replaces this map on the first
// call anyway. Reuse frames[0] rather than restating the rect.
const heroFirstFrame = atlasFrameTexture(sheet, heroFrames[0]);
const hero: ModelSpec = {
  defaultColor: 0xffffff,
  sheet,
  frames: heroFrames,
  build: () => createTexturedPlane(heroFirstFrame, { width: 1, height: 1 }),
};
export const HERO_FRAME_COUNT = heroFrames.length;
```

```ts
// src/core/ — gameplay, which never imports three. Advance the index from update(dt).
// Take the modulus from the declared list, not from a hand-written count: an index past the end
// throws, so a second constant is a runtime exception waiting for someone to add a frame.
this.walkClock += dt;
const frame = Math.floor(this.walkClock / SECONDS_PER_FRAME) % HERO_FRAME_COUNT;
this.renderer.setFrame?.(this.heroHandle, frame);
```

`ThreeRenderer` cuts one windowed texture per declared rect **when it is constructed**, and
`setFrame` only reassigns `material.map` — so a swap allocates nothing, re-uploads nothing, and
costs the same whether the sheet has four frames or forty. Two instances of one model can sit on
different frames; the renderer gives every instance its own material in `addModel` precisely so
they can. An index outside the declared list, or a model that declares no frames, **throws** —
same reasoning as the rect check above.

There is no playback clock in the framework: no frame duration, no loop mode, no
play/stop. The game owns the timing, as in the snippet above.

## What the helper does, and why

You need this if you debug your own atlas code, extend the helper, or read a game that predates it.

### It clones the texture, not just the material

A frame is a rectangular window into the sheet, expressed as `offset` + `repeat`. **Both live on
`THREE.Texture`, not on the material** — the sampled coordinate is `uv * repeat + offset`
(`Texture.updateMatrix` → `Matrix3.setUvTransform`), so two materials that share one `Texture`
also share one window.

`createTexturedPlane` (`src/framework/render/AssetLoader.ts`) does not clone anything:

```ts
export function createTexturedPlane(
  texture: THREE.Texture,
  { width = 1, height = 1, transparent = true }: TexturedPlaneOptions = {},
): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(width, height);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent });
  return new THREE.Mesh(geometry, material);
}
```

So calling it directly with the sheet gives every plane the *same* `THREE.Texture` instance in
`material.map`, and setting `material.map.offset` per sprite writes to that one shared object.
**Symptom:** every sprite cut from the sheet displays whichever frame was set last — a screen of
identical tiles where there should be coins, bombs, hearts and enemies. Nothing static catches
this; it only shows up in a rendered frame.

`atlasFrameTexture` is that clone-and-window step:

```ts
const texture = sheet.clone();
texture.offset.set(x / sheetWidth, 1 - (y + h) / sheetHeight);
texture.repeat.set(w / sheetWidth, h / sheetHeight);
```

The `1 - (y + h) / sheetHeight` term converts a top-down pixel row to a bottom-up V coordinate.
`TextureLoader` leaves `flipY` at its default `true`, which uploads the image with
`UNPACK_FLIP_Y_WEBGL`, so **V = 1 is the sheet's top row** and V = 0 its bottom. The frame's
bottom edge — pixel row `y + h` from the top — is therefore at `1 - (y + h) / sheetHeight`, and
`offset` is the window's lower-left corner. U needs no flip. `PlaneGeometry` puts UV `v = 1` at
the quad's top edge, so the frame lands right way up.

### Cloning per frame does not duplicate the sheet on the GPU

`Texture.copy` assigns `this.source = source.source`, and the renderer caches one `WebGLTexture`
per `Source` per sampler-parameter set — `offset` and `repeat` are not part of that cache key
(`WebGLTextures.initTexture` / `getTextureCacheKey`, three 0.184.0). A forty-frame sheet cut this
way is forty small `Texture` objects over one upload of the image.

**Dispose the frames, not just the sheet.** That one upload is reference-counted per (`Source`,
sampler-parameter) pair — `usedTimes`, incremented in `WebGLTextures.initTexture` and decremented
in `deallocateTexture` (three 0.184.0) — so disposing one frame does **not** pull the image out
from under its siblings; the `WebGLTexture` is deleted only when the last frame using it goes.
The converse is the trap: disposing only the sheet frees nothing if the sheet itself was never
rendered, because `deallocateTexture` returns early for a texture with no `__webglInit`. So on
teardown, dispose the frame textures the catalog holds (see
[`asset-loading.md` § Disposal](asset-loading.md#disposal)).

### Three related notes

- **Don't set `needsUpdate` to re-window.** `Texture.copy` already sets it on the clone, and
  `offset` / `repeat` changes need it not at all: they feed `texture.matrix`, which the renderer
  refreshes every frame while `matrixAutoUpdate` is on (the default). Setting `needsUpdate = true`
  in an animation loop re-uploads the whole sheet each frame.
- **Clone the material yourself only for a build-time edit** (tinting a `cloneModel` clone, say):
  the renderer's own per-instance clone happens *after* `build()` returns, so a mutation inside
  `build()` still lands on whatever material the spec shares. Everything after that — `setFrame`,
  `setOpacity`, `remove()`'s disposal — is already per instance. See
  [`asset-loading.md` § Disposal](asset-loading.md#disposal).
- **Windowing does not confine filtering to the window.** The clone shares the sheet's `Source`,
  so mipmaps are built from the whole sheet and lower levels average across frame boundaries;
  bilinear sampling at the window's edge reaches the same way. Minified frames then show a rim of
  the neighbouring cell. On a 600x600 orthographic stage sprites are drawn at roughly 1:1, so the
  cheap fix is to turn minification filtering off on the sheet *before* cloning —
  `sheet.generateMipmaps = false; sheet.minFilter = THREE.LinearFilter;` — which the clones
  inherit, keeping them on one sampler-parameter set and therefore one GPU upload. Set it before
  the sheet's first render — sampler parameters are applied at upload, so a later change does
  nothing until the sheet is re-uploaded. It fixes the mipmap half only: `magFilter` stays
  `LinearFilter`, so a frame drawn above 1:1 still interpolates across its outer half-texel. Where
  that shows, or in a scene that genuinely minifies, inset the window by half a texel on each side
  instead.

## Read the sheet's real dimensions from the texture

`atlasFrameTexture` derives the sheet size from `sheet.image.width` / `sheet.image.height` —
`Texture.image` is the decoded `HTMLImageElement` the loader produced (`Texture` exposes it as a
getter over `source.data`). **Never hard-code it**, in a frame table or anywhere else.

Every term in both `offset` and `repeat` is divided by these numbers, so a sheet size that is
wrong by even one pixel shifts and rescales *every* frame on that sheet — sprites drift a
fraction of a cell off-register, and edges of neighbouring frames bleed in. A constant table
transcribed by hand from a pack's docs or from eyeballing a thumbnail is the usual source: a
`1170` where the file is `1169`, a `1028x771` where the file is `1027x1027`. Reading the value
from the texture cannot be wrong, and costs nothing.

If you need the dimensions before load time (to lay out a frame table), get them from the file
rather than from memory:

```bash
magick identify -format '%wx%h\n' sheet.png
```

## Measure the silhouette, not just the cell

The helper cannot fix this one: it windows the rect you give it, and sizes the quad to the
`width` / `height` you ask for.

A sheet's **cell** is the grid step. The **silhouette** is the non-transparent art inside it —
usually smaller, because packers and artists leave padding so neighbouring frames don't bleed.
Size the quad to the cell and the art comes out smaller than asked for by exactly the padding
fraction, on every sprite in the game. That uniformity is what hides the bug: nothing looks out
of proportion relative to anything else, so on a monitor it reads as a deliberate style, and only
a rendered frame measured against the 600x600 stage shows the art is undersized.

Measure the content box by trimming the transparent border off one cropped cell:

```bash
magick sheet.png -crop 128x128+0+0 +repage -trim info:-
# sheet.png PNG 81x97 128x128+21+18 8-bit sRGB ...
```

The first `WxH` is the silhouette, the second is the cell you cropped, and the `+21+18` is where
the art sits inside it. Here the art fills 97 of the cell's 128 pixels vertically — a quad sized
to the cell draws it 24% short.

To make the art appear at an intended on-screen size, scale the quad up by the inverse of that
fill ratio — the quad still covers the whole cell, padding included, so the silhouette lands at
the size you asked for:

```
quad = intended / (content / cell)
```

For a hero meant to read at 72 px in a 128 px cell whose art measures 97 px tall, the quad is
`72 / (97 / 128) ≈ 95` px. A quad built at 72 px instead draws a `72 * 97 / 128 ≈ 55` px hero.

Apply the ratio on the axis your intended size refers to (usually height), then derive the other
side from the **cell's** aspect, not the silhouette's, or the sprite stretches:

```ts
const quadH = intendedH / (contentH / cellH);
const quadW = quadH * (cellW / cellH);
```

Padding is per-frame, not per-sheet: a wide frame and a tall frame in the same grid fill their
cells differently. Measure each frame whose size matters, or at least one frame per row, rather
than applying one ratio to everything.

`-trim` keys off the transparent border, so it reports the cell itself for art on an opaque
background — in that case the cell *is* the silhouette and no correction applies. For installing
`magick`, and for cropping cells out to look at them, see *Optional tooling: ImageMagick* in
`create-webapp-game`.

## Putting it together

Several **distinct models** cut from one sheet — a hero and a coin, each with its own id and its
own measured size. Cutting the frame yourself is right here because nothing animates; a model
whose frames are alternatives for one instance declares `frames` and uses
[`setFrame`](#animating-a-sprite-setframe) instead.

```ts
import * as THREE from 'three';

import { atlasFrameTexture, createTexturedPlane } from '@/framework/render/AssetLoader';
import type { ModelCatalog, ModelSpec } from '@/framework/render/ThreeRenderer';

const CELL_W = 128;
const CELL_H = 128;
/** How tall the art itself should read, in world units. */
const INTENDED_HEIGHT = 1;
/** Frame rects in cell coordinates, and each frame's measured content height in pixels. */
const FRAMES = {
  hero: { col: 0, row: 0, contentH: 97 },
  coin: { col: 1, row: 0, contentH: 84 },
} as const;

export function buildModels(sheet: THREE.Texture): ModelCatalog<keyof typeof FRAMES> {
  // Before any cloning, so every frame inherits it: keeps a minified frame from sampling the
  // neighbouring cell. See "Windowing does not confine filtering to the window" above.
  sheet.generateMipmaps = false;
  sheet.minFilter = THREE.LinearFilter;

  const specs = {} as Record<keyof typeof FRAMES, ModelSpec>;
  for (const [id, frame] of Object.entries(FRAMES)) {
    // One texture per frame, cut once here — not inside build(), which runs per instance.
    const tex = atlasFrameTexture(sheet, {
      x: frame.col * CELL_W,
      y: frame.row * CELL_H,
      w: CELL_W,
      h: CELL_H,
    });
    const quadH = INTENDED_HEIGHT / (frame.contentH / CELL_H);
    const quadW = quadH * (CELL_W / CELL_H);
    specs[id as keyof typeof FRAMES] = {
      // These sprites are not tinted, so `build` ignores its `color` argument and the sheet's own
      // colors come through. To tint per instance, clone the material and apply it — see
      // `asset-loading.md`.
      defaultColor: 0xffffff,
      build: () => createTexturedPlane(tex, { width: quadW, height: quadH }),
    };
  }
  return specs;
}
```

Frames that animate swap between those preallocated textures by assigning `material.map`, which is
safe because the material is per instance and the textures are not mutated.

Re-setting `offset` on an instance's texture is the other way to animate, but it needs a texture
this catalog does not produce: the cut above is shared by every instance of a model id, so writing
`material.map.offset` on one instance moves them all — the shared-texture collapse this doc opens
with. Take that route only if `build()` also calls `atlasFrameTexture(...)` per instance, and
accept one `Texture` object per live sprite plus a re-upload of the
whole sheet per clone: `Texture.copy` sets `needsUpdate`, and that setter also marks the shared
`Source` dirty (`Texture.js`, three 0.184.0). Cutting at catalog-build time pays that once;
cloning during gameplay pays it every time.
