# Reading, measuring and filing source art

Everything the scaffold workflow needs for a game built around real art files: how to read a
spritesheet before you design around it (Step 1), how to file the assets into the project
(Step 4), and the optional ImageMagick tooling both lean on.

A fully procedural game needs none of this.

## Reading a spritesheet before you plan around it

**Act on the user's answer in plan mode — don't just record it.** If they gave paths, `ls` the
folder and **read the image files**; you can see them. Then play your interpretation back for
confirmation: sheet dimensions, the apparent grid / cell size, frame count, what each row appears
to be (idle, walk, death…), whether the background is transparent, the palette, and any file that
looks unusable.

A silently wrong reading of a spritesheet is the expensive failure here — it surfaces only after
the whole game is built around it. A whole sheet read at once shows you the sheet, not the
sprites, so crop individual cells out to a scratch file and look at those, and confirm the cell
size against the sheet's true pixel dimensions.

### Measure the silhouette, not just the cell

Cells carry transparent padding, so a quad sized to the cell draws art that is smaller than
intended — uniformly, across the whole game, which reads as deliberate on a monitor. Trim one
cropped cell to get the content box, and scale the quad by the inverse of the fill ratio:
`quad = intended / (content / cell)`.

```bash
magick sheet.png -crop 128x128+0+0 +repage -trim info:-   # -> 81x97 content in a 128px cell
```

So art meant to read at 72 px needs a `72 / (97/128) ≈ 95` px quad. Record the ratio per row in
the playback. See `docs/spritesheets.md`.

### Judge brightness while you look, and say so in the playback

The display is additive: black emits no light, so a near-black sprite is *invisible* on device,
and an opaque backdrop tile lights up the wearer's whole view instead of receding. Art drawn for
an opaque screen frequently has both problems. Name any asset that is too dark for its job —
above all anything the player must **dodge** — and agree the fix now (recolor / brighten / use the
lit frame / derive a transparent backdrop). See `docs/asset-loading.md` § "Art has to emit light".

### If the user gave no art

Tell them now that you can interpret a spritesheet, tileset, or character sheet and build the game
around it, and that starter art is usually worth the few minutes it takes to gather. Offer to wait
while they collect some into a folder (in the new project's directory or anywhere on disk — Step 4
files them either way). Make clear that procedural geometry is a perfectly good default if they'd
rather move on.

### What the framework does and does not do for you

The framework cuts frames for you — `atlasFrameTexture` / `atlasSprite` window a pixel rect out of
a loaded sheet — but the grid, the frame table and the quad sizing are **game code** in
`src/models.ts`, and there is no sprite-animation or atlas-packing helper. Budget for that in the
vertical slice of a sheet-heavy game. `docs/spritesheets.md` has the recipe.

## Filing the assets into the project (Step 4)

File every source asset the user provided (from Step 1, plus anything set aside in
`_incoming-assets/` in Step 3) under `public/`, which Vite copies verbatim into the build.

**Move vs. copy** — the distinction matters, because one of these is the user's only copy:

- **Already inside the project** (dropped in the project root, or in `_incoming-assets/`) →
  **`mv`** it into place.
- **Anywhere outside the project** → **`cp`** it in. Never move, rename, or delete a file the
  user keeps elsewhere; their folder must look untouched afterwards.

**Where each kind goes** (the conventions in `docs/asset-loading.md` and
`docs/project-structure.md`):

| Kind | Destination |
|------|-------------|
| Images, spritesheets, tilesets (PNG/WebP/JPG) | `public/sprites/` |
| 3D models (GLB/GLTF/FBX/OBJ) | `public/models/` |
| Audio samples (MP3/WAV/OGG) | `public/audio/` |
| Fonts | `public/fonts/` |

**Preserve the relative structure of multi-file models.** A GLB that references
`Textures/colormap.png` needs that image at `public/models/Textures/colormap.png` — bring the
referenced folder along with the model, at the path the model expects. Same for `.gltf` + `.bin` +
images and `.obj` + `.mtl`. See `docs/asset-loading.md` → "Ship external textures too".

**Delete nothing.** Leave anything you can't classify in `_incoming-assets/` and ask the user
about it rather than guessing; remove that folder only once it's empty. Whatever is still in it at
the end of the run gets named — file and reason — in your completion summary, which is what Step 7
checks for.

Then record the inventory in `docs/design.md` — each asset's path, what it is, how the game uses
it, the frame grid you read off each spritesheet in Step 1, and **any brightness fix the asset
needs**. Step 6 implements against that written interpretation instead of re-deriving it.

Paths passed to the loaders are `public/`-relative with **no leading `/`** — `'sprites/hero.png'`,
not `'/sprites/hero.png'`. These files are the input to the preload manifest in Step 6 (see
`docs/loading-screen.md`).

### Which copy are you editing?

Do the brightness fixes here, not later: a dark sprite is cheap to recolor now and expensive to
discover once the game is built around it — and it cannot be discovered at all without a device or
a browser. `docs/asset-loading.md` § "Art has to emit light" covers what to change.

**Before any destructive edit — recolor, brighten, downscale, convert — know which copy you are
editing**, because the move-vs-copy rule above decides that:

- **`cp`'d in from outside the project** → the file under `public/` is a copy; edit it freely, the
  user's own is untouched.
- **`mv`'d in from inside the project** → the file under `public/` is the user's **only** copy.
  Say what you want to change and get their go-ahead first, and copy the untouched file to
  `art-originals/` at the project root before you overwrite it. That directory sits outside
  `public/`, so Vite never ships it, and it makes the edit reversible.

Assets that blow the device budget (an oversized texture, dozens of loose per-frame PNGs) can be
downscaled, converted, or packed on the way in — under the same which-copy rule.

## Optional tooling: ImageMagick

**Optional — the skill works without it.** Its main use is **seeing the art better**: reading a
1024x1024 sheet of 32px sprites shows you the sheet, not the sprites. Cut a piece out to a
scratch file, read *that*, and the frame is legible. Everything below writes to a temp directory
(`SCRATCH=$(mktemp -d)`) — these are throwaway files for looking at, **never** assets you add to
the project.

- **Isolate one cell and blow it up** — nearest-neighbor keeps pixel art crisp:

  ```bash
  magick sheet.png -crop 32x32+96+32 +repage -scale 800% "$SCRATCH/cell.png"   # col 3, row 1
  ```

  Then read `$SCRATCH/cell.png`. Repeat for a few cells to identify what each row holds.
- **Make transparency visible** — an alpha background reads as nothing; flatten onto a
  contrasting color first: `magick in.png -background magenta -flatten "$SCRATCH/flat.png"`.
- **Measure, and falsify the cell size** — a UV rect built on a guessed cell size is subtly wrong
  for *every* frame, so check the number instead of eyeballing it. Divide the sheet by the guess:
  a whole number means it's plausible, a fraction means it's wrong.

  ```bash
  magick identify -format '%wx%h\n' sheet.png                      # 256x128
  magick identify -format '%[fx:w/32]x%[fx:h/32]\n' sheet.png      # 8x4  -> plausible 32px grid
  magick identify -format '%[fx:w/48]x%[fx:h/48]\n' sheet.png      # 5.33x2.67 -> not 48px
  ```

  Divisibility only rules a guess out (a 16px grid divides just as evenly), so confirm by cropping
  the cells you expect: each sprite should sit alone and uncut. A clipped edge or a neighbour
  bleeding in means the cell size or the origin is off — sheets with margins or gutters need an
  offset, not just a size.
- **Optimize on the way into `public/`** (Step 4 only) — downscale oversized textures, convert to
  WebP, trim dead transparent padding, or pack loose per-frame PNGs into one strip
  (`magick f*.png +append strip.png`, or `-append` for a column) to cut requests. Budgets:
  < 128 MB runtime memory, < 10 requests on load. Never the reverse — do **not** ship one file
  per frame; the sheet stays a single texture and frames are picked at runtime via the texture's
  UV offset/repeat. (Prefer `+append`/`-append` over `montage`, which needs a configured font and
  dies with `unable to read font` on many machines.)

**Probe before use** — ImageMagick 7 is `magick`; 6 is `convert`:

```bash
command -v magick || command -v convert || echo "ImageMagick not installed"
```

**If it's missing, ask the user to install it — never install it yourself.** It needs their own
terminal (Homebrew or `sudo`), and the sandbox this skill runs in has no network access. Detect
the platform with `uname -s` (plus `command -v brew dnf apt-get` on Linux) and quote only the
matching line:

| Platform | Command |
|----------|---------|
| macOS (Homebrew) | `brew install imagemagick` |
| Fedora / RHEL / CentOS | `sudo dnf install ImageMagick` |
| Debian / Ubuntu | `sudo apt-get install imagemagick` |
| Windows | `winget install ImageMagick.ImageMagick` (or `choco install imagemagick`) |

Then offer to continue without it rather than blocking — say what you'll lose (a close-up look at
individual frames, exact dimensions, bulk conversion) and fall back to reading the whole sheet
plus `file sheet.png`, which prints pixel dimensions on most platforms, or
`sips -g pixelWidth -g pixelHeight sheet.png` on macOS.
