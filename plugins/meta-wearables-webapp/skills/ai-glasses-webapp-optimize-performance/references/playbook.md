# Optimization playbook — Meta Ray-Ban Display

The detail behind the ranked list in `SKILL.md`. Work top-down; the first two items are usually
worth more than everything below combined. Every figure here was measured on a real app under
the profile in `SKILL.md`.

### 1. Paint something from the HTML, not from your bundle

If your first paint waits on the module graph, the user stares at nothing for the entire
download-plus-parse. Put the initial frame — a logo, the app chrome, a spinner — directly in
`index.html` with inline critical CSS, and make the stylesheets non-blocking.

```html
<style>/* only what the first frame needs */</style>
<link rel="preload" as="style" href="app.css" onload="this.rel='stylesheet'">
<noscript><link rel="stylesheet" href="app.css"></noscript>
<body>
  <div id="boot">…first frame, inline…</div>
  <div id="root"></div>
```

Then remove `#boot` in a layout effect when the app mounts, so the handover is invisible.
**Measured: first paint 11,208 ms → 440 ms.** Nothing else came close.

**Do not guess which CSS is critical — measure it.** `critical-css.mjs` loads the page under
the profile, tracks which rules actually match while the first screen comes up, and writes the
used rules out ready to inline:

```bash
node <this-skill>/scripts/critical-css.mjs --url http://127.0.0.1:5173 \
  --clear-storage \
  --oracle "document.querySelector('[data-testid=primary-screen]')"
```

```
stylesheet                 used source / total source   critical%
/app.css                       18074 /   54106   33%
/wds/fonts/index.css               0 /    3366   0%
TOTAL: 18489 of 58124 source characters matched the first screen (32%).
```

Two thirds of that stylesheet has nothing to do with the first screen. The
first run is report-only. For a same-origin stylesheet whose contents and
license you own, rerun with both a new `--out critical.css` path and the exact
reported source (for example, `--owned-style /app.css`). Inline the candidate,
load the rest non-blocking, and re-measure. The tool refuses to overwrite an
existing output file and never extracts cross-origin or unselected sheets.
It also refuses to extract a selected rule with a relative `url(...)`, because
moving that rule inline would change how the asset path resolves.

For a UI Toolkit app, use this report to optimize authored shell CSS. A sheet
containing Toolkit markers is report-only and is excluded from output. Do not
extract, rewrite, or separately load installed Toolkit CSS: the Toolkit `App`
component owns that stylesheet and its load order.

Splitting CSS further is worth it when a stylesheet serves screens the user may never reach:
put per-screen rules in their own file and load them when that screen is first opened. The
`critical%` column per stylesheet tells you which files are worth splitting.

### 2. Count your bytes, then look for the same bytes twice

At 16 ms/KB, duplication is expensive and easy to miss. Fonts are the usual offender: a
toolkit that inlines faces as base64 *and* ships them as files pays for both.

```bash
node <this-skill>/scripts/measure.mjs --url … --by-type --clear-storage \
  --oracle "document.querySelector('[data-testid=primary-screen]')"
```

**Measured: removing one duplicated font set cut 518 KB and 5,326 ms.** The
script's wire field covers completed HTTP(S) responses; it rejects a run with
startup WebSocket traffic rather than presenting an incomplete total.

### 3. Do not fetch fonts from a third-party CDN

An external font host costs bytes, an extra connection, and it **fails when the glasses are
offline** — so it also breaks the app it is decorating. Serve faces from your own origin, or
use the system stack.

This rule applies to app-authored font loading. If the installed UI Toolkit
owns a documented font-registration fallback, measure and report that traffic
separately but do not override `App`, its stylesheet, or installed package code.

Beware that removing an external font often makes the browser fetch your *local* faces
instead, so the net saving is smaller than the number you removed. Measure it, don't assume:
**108 KB of third-party font removed, 79 KB of local font fetched instead, net −30 KB.**

### 4. Ship WOFF2, and only the faces you use

WOFF2 is roughly 40% of the TTF size and the saving also holds in cache. Three weights is
usually plenty. **Measured: −23 KB.**

### 5. Tree-shake the component library

Importing a whole UI toolkit to use six components is the biggest avoidable chunk in most
apps. Use declared per-component subpath imports and let the bundler drop the rest.
**Measured: −72 KB and −1,754 ms.**

For Meta Wearables UI Toolkit, use only subpaths declared by the installed
package's `exports` map. Keep runtime constants and enums on the package root
when Toolkit guidance requires it, and never import from `dist` or source paths.
The installed Toolkit manifest owns its `sideEffects` metadata and is immutable;
change that field only for an app-owned library or package.

### 6. Downscale images to a safe rendered target, then re-encode as WebP

The display is **600x600 at DPR 1**, so high-DPR source assets are usually wasteful. Preserve
the pixels required by `object-fit: cover`, however; a cropped panorama may still need a
source dimension larger than its box.

```bash
node <this-skill>/scripts/audit-images.mjs --url http://127.0.0.1:5173 \
  --clear-storage \
  --oracle "document.querySelector('[data-testid=primary-screen]')"
```

It reports every image's bytes, intrinsic size, the box it is drawn into, and what resizing
would save. On a deliberately bad test page:

```
  bytes   intrinsic     drawn      waste  image
 596738     800x800   120x120  ~583311 B  /big.png
Resizing to the box would save ~583311 B (~9333 ms of link time).
```

Then:

```bash
cwebp -q 78 -resize <boxWidth> 0 in.png -o out.webp
```

First confirm `cwebp` is available. If it is not, use an already approved image
pipeline that can produce the same measured WebP output, or report the missing
tool; do not install system software without the user's approval.

- **Resize first, re-encode second.** Use only a target the audit reports as safe. It accounts
  for every `<img>` use and `object-fit`; ambiguous background sizing remains unmeasured.
- **Quality 75-80 is the sweet spot.** On a 600x600 panel viewed at arm's length, the
  difference between q78 and q95 is invisible and roughly doubles the file.
- **WebP is typically 25-35% smaller than PNG/JPEG** at matched quality. Lossless WebP is worth
  it only for flat UI graphics with few colours; photographs always want lossy.
- **Prefer no image at all.** A CSS gradient, a Unicode glyph or an inline SVG costs a few
  hundred bytes against tens of kilobytes. Inline anything under ~2 KB as a data URI so it does
  not cost a round trip.
- Always set explicit `width`/`height` so the image cannot shift layout when it lands.

### 7. Declare the module graph so it is not discovered one hop at a time

At 150 ms RTT, a dependency chain discovered serially costs a round trip per hop. Add
`<link rel="modulepreload">` for the modules you know you need. **Measured: −312 ms.**

### 8. Do not start a splash hold from when your JavaScript runs

If you hold a splash for a minimum duration to avoid a flash, start counting from when the
splash *appeared* (in the HTML), not from when the framework mounted. Otherwise you add the
whole startup time to the hold. **Measured: −609 ms** — and see trap 2, because a DOM-only
oracle cannot see this at all.

### 9. Respect the 30 Hz panel

The frame budget is 33 ms. Do not run a 60 fps animation loop — it costs battery and buys
nothing on a 30 Hz display. Stop `requestAnimationFrame` loops when the screen they belong to
is not visible.

### 10. Smaller tricks that still paid for themselves

- **Subset your fonts to the characters you actually render.** Collect the app's real charset
  (walk the rendered DOM text, plus any glyphs in CSS `content`) and subset to it — but verify
  the subset covers everything, including symbols like `¢` and `●` that are easy to miss. A
  missing glyph is a visible tofu box, so assert coverage rather than trusting the tool.
- **`font-display: swap`** so text paints in a fallback instead of waiting on the face.
- **More parallel requests do not mean more throughput.** On one connection at 500 Kbps, N
  concurrent downloads each get roughly 1/N of the pipe — splitting a bundle into eight chunks
  that all start at once does not make it arrive sooner, it just delays all of them equally.
  Fetch what the first screen needs, and defer the rest until after paint.
- **Nothing render-blocking in `<head>` except the inline critical CSS.** Any `<script>`
  without `defer`/`async`, and any stylesheet `<link>` you have not made non-blocking, stops
  the parser.
- **Drop `preconnect`/`dns-prefetch` hints for origins you no longer use.** They cost a
  handshake to nowhere.
