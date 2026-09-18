#!/usr/bin/env node
/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * frame-stats.mjs — Deterministic statistics over a screenshot captured by `cdp.mjs shot`.
 *
 * Two questions this answers with numbers instead of an opinion:
 *
 *   1. "Is this frame emitting light?" The Meta Display Glasses panel is ADDITIVE — black emits
 *      nothing, so a near-black sprite is invisible on device even though it looks fine on a
 *      desktop monitor. `fractionNearBlack` / `meanLuminance` / `nonBlackBBox` make that
 *      measurable, and the bbox also catches content rendered at the wrong scale or in the wrong
 *      place. Additive cuts both ways: a bright full-bleed backdrop floods the wearer's whole field
 *      of view instead of receding, and `fractionLit` measures that inverse defect.
 *   2. "Did that input change anything?" Pass `--baseline <earlier.png>` and compare frames: a
 *      `changedPixelFraction` of 0 after pressing Enter means the input did nothing.
 *
 * Reading the numbers is cheaper than reading the image: a screenshot costs image tokens on every
 * turn it stays in context. Screenshot when you need to SEE something; use this to check a value.
 *
 * Zero dependencies — a minimal PNG decoder over Node's own zlib. Chrome's
 * `Page.captureScreenshot` emits 8-bit non-interlaced PNG, which is what this supports; any other
 * variant is REJECTED rather than approximated, because a plausible-looking wrong number here is
 * worse than no number.
 *
 * Usage:
 *   node frame-stats.mjs --png <path> [--baseline <path>] [--region x,y,w,h]
 *                        [--dark-threshold 0.08] [--lit-threshold 0.5] [--diff-threshold 8]
 *   node frame-stats.mjs version | --version
 *
 * Output: machine-readable JSON on stdout; a human summary on stderr. `version` prints plain text
 * on stdout.
 * Exit codes: 0 ok; 1 the image could not be read/decoded, or the baseline doesn't match; 2 bad usage.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

/**
 * Kept equal to the plugin's `version` in `.claude-plugin/plugin.json`, and asserted equal by
 * `tests/scripts/frameStats.test.mjs`. It is a literal rather than a read of that file because
 * this script is run from copies where no plugin manifest sits above it, and a copy that cannot
 * find its version is exactly the stale copy `--version` exists to identify. Both halves of the
 * pair carry one: the mismatch this catches is a `cdp.mjs` from one plugin release driving a
 * `frame-stats.mjs` from another, which a version on only one of them cannot detect.
 */
const STATS_VERSION = '2.0.50';

/**
 * The measurements the report carries, in report order — the capability list `--version` answers
 * questions about ("does this copy measure `fractionLit`?"). Measurements only: the report also
 * echoes the inputs it was given (`png`, `region`, `baseline`, and the three thresholds), and a
 * staleness check never asks about those.
 */
const REPORT_FIELDS = [
  'pixels',
  'meanLuminance',
  'p50Luminance',
  'p95Luminance',
  'maxLuminance',
  'fractionNearBlack',
  'fractionLit',
  'nonBlackBBox',
  'changedPixelFraction',
  'meanAbsDiff',
  'changedBBox',
];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Channel count per PNG color type. Type 3 (palette) is absent on purpose — see decodePng. */
const CHANNELS_BY_COLOR_TYPE = { 0: 1, 2: 3, 4: 2, 6: 4 };

// Appended to every unsupported-variant error. `cdp.mjs shot` always produces a readable file, so
// hitting one of these means the PNG came from somewhere else — and ImageMagick's own defaults are
// a common source (it writes 16-bit for a gradient and 1-bit for a two-color image, and `-depth 8`
// alone does not override that; the PNG32: prefix does).
const CONVERT_HINT =
  ' Convert it first: `magick in.png PNG32:out.png` (forces 8-bit RGBA, non-interlaced).';

const argv = process.argv.slice(2);
const args = parseArgs(argv);

// Answered before the threshold flags below are parsed. `--version` is the staleness probe a
// caller reaches for when the script is behaving oddly, so it has to answer even when the rest of
// the command line is malformed — and `num()` exits 2 on a bad threshold value.
// `--version` parses as a flag, a bare `version` as a command token. Both spellings, so a caller
// checking this script and cdp.mjs together does not have to remember which takes which.
if (argv[0] === 'version' || args.version !== undefined) {
  printText(`frame-stats.mjs ${STATS_VERSION}\nmeasures: ${REPORT_FIELDS.join(' ')}`);
}

// Luminance below this counts as "not emitting light" (0..1). 0.08 is ~20/255 — dark enough that
// the additive display shows essentially nothing, but above the dithering noise of a black page.
const darkThreshold = clamp01(num(args['dark-threshold'], 0.08, '--dark-threshold'));
// Luminance at or above this counts as "lit" (0..1) — bright rather than dim detail. 0.5 is the
// level the slab rule in `../references/verification-pass.md` is calibrated against; that doc
// carries the measurements behind it. Clamped to 0..1 like the dark threshold: outside that range
// every pixel is trivially lit or trivially unlit, which reads as a real result rather than a
// mistake.
const litThreshold = clamp01(num(args['lit-threshold'], 0.5, '--lit-threshold'));
// Per-channel 0..255 delta a pixel must exceed to count as changed. 8 absorbs antialiasing and
// video-memory noise between two captures of a static frame. Clamped to the channel range: a
// negative value would mark every pixel changed, which reads as a real result rather than a
// mistake.
const diffThreshold = clamp(num(args['diff-threshold'], 8, '--diff-threshold'), 0, 255);

function main() {
  const pngPath = str(args.png);
  if (!pngPath) {
    fail(2, '`frame-stats` requires --png <path> (the file written by `cdp.mjs shot`).');
  }

  const image = readImage(pngPath);
  const region = parseRegion(args.region, image, '--region');
  const stats = regionStats(image, region);

  const report = {
    ok: true,
    png: pngPath,
    width: image.width,
    height: image.height,
    region,
    darkThreshold: round(darkThreshold, 4),
    litThreshold: round(litThreshold, 4),
    ...stats,
  };

  const lines = [
    `${pngPath}: ${image.width}x${image.height}` +
      (isWholeImage(region, image) ? '' : ` (region ${region.x},${region.y} ${region.width}x${region.height})`),
    `  luminance   mean ${report.meanLuminance}  p50 ${report.p50Luminance}  p95 ${report.p95Luminance}  max ${report.maxLuminance}`,
    `  near-black  ${pct(report.fractionNearBlack)} of pixels at or below ${round(darkThreshold, 4)}`,
    `  lit pixels  ${pct(report.fractionLit)} of pixels at or above ${round(litThreshold, 4)}`,
    `  lit content ${describeBox(report.nonBlackBBox, 'none (every pixel is near-black)')}`,
  ];

  const baselinePath = str(args.baseline);
  if (baselinePath) {
    const baseline = readImage(baselinePath);
    // Labelled distinctly: the two images can differ in size, so "falls outside the WxH image"
    // is ambiguous unless it says which one it measured.
    const baselineRegion = parseRegion(args.region, baseline, '--region (against --baseline)');
    if (baselineRegion.width !== region.width || baselineRegion.height !== region.height) {
      fail(
        1,
        `Baseline region is ${baselineRegion.width}x${baselineRegion.height} but --png's is ` +
          `${region.width}x${region.height}. Compare captures of the same size (both frames should ` +
          `come from the same viewport, and --full changes the height).`,
      );
    }
    report.baseline = baselinePath;
    report.diffThreshold = diffThreshold;
    Object.assign(report, diffStats(image, region, baseline, baselineRegion));
    lines.push(
      `  vs baseline ${pct(report.changedPixelFraction)} of pixels changed by >${diffThreshold}/255` +
        ` (mean abs diff ${report.meanAbsDiff}/255)`,
      `  changed box ${describeBox(report.changedBBox, 'none (no pixel changed)')}`,
    );
  }

  done(0, report, lines.join('\n'));
}

// ============================ statistics ============================

/**
 * Relative luminance (Rec. 709) of one pixel, 0..1, composited over BLACK.
 *
 * Two deliberate choices:
 *  - Alpha is MULTIPLIED IN rather than ignored. The page background is black and the display is
 *    additive, so a half-transparent pixel emits half the light — treating it as opaque would
 *    report a transparent sprite as bright.
 *  - The coefficients are applied to the gamma-encoded sRGB values, NOT to linearized ones. That
 *    keeps `--dark-threshold` intuitive (0.08 ~ a channel value of 20/255, what you'd read off a
 *    color picker) at the cost of not being physically linear light. Use it to compare frames and
 *    to catch invisible art, not as a photometric measurement.
 */
function luminanceAt(data, index, channels) {
  let r;
  let g;
  let b;
  let a = 255;
  if (channels <= 2) {
    r = data[index];
    g = r;
    b = r;
    if (channels === 2) {
      a = data[index + 1];
    }
  } else {
    r = data[index];
    g = data[index + 1];
    b = data[index + 2];
    if (channels === 4) {
      a = data[index + 3];
    }
  }
  return ((0.2126 * r + 0.7152 * g + 0.0722 * b) / 255) * (a / 255);
}

function regionStats(image, region) {
  const { data, channels } = image;
  // 256-bucket histogram rather than a sorted array of every luminance: O(n) with no allocation
  // proportional to the image, and 1/255 granularity is finer than any decision made from these
  // percentiles. The mean is accumulated exactly, not derived from the buckets.
  const histogram = new Uint32Array(256);
  let sum = 0;
  let max = 0;
  let nearBlack = 0;
  let lit = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (let y = region.y; y < region.y + region.height; y++) {
    const rowStart = y * image.width * channels;
    for (let x = region.x; x < region.x + region.width; x++) {
      const lum = luminanceAt(data, rowStart + x * channels, channels);
      sum += lum;
      histogram[Math.min(255, Math.round(lum * 255))]++;
      if (lum > max) {
        max = lum;
      }
      // Counted before the near-black branch below returns early, so the two fractions stay
      // independent measurements even when the thresholds are set to overlap.
      if (lum >= litThreshold) {
        lit++;
      }
      if (lum <= darkThreshold) {
        nearBlack++;
        continue;
      }
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  const total = region.width * region.height;
  return {
    pixels: total,
    meanLuminance: round(total ? sum / total : 0, 4),
    p50Luminance: percentile(histogram, total, 0.5),
    p95Luminance: percentile(histogram, total, 0.95),
    maxLuminance: round(max, 4),
    fractionNearBlack: round(total ? nearBlack / total : 0, 4),
    fractionLit: round(total ? lit / total : 0, 4),
    nonBlackBBox: boxOf(minX, minY, maxX, maxY),
  };
}

// Scratch buffers for the diff loop, which samples two pixels per iteration. Returning a fresh
// array instead would allocate ~720k of them across a 600x600 frame, against the same
// no-allocation-per-pixel rule regionStats already follows.
const SAMPLE_A = new Float64Array(3);
const SAMPLE_B = new Float64Array(3);

function diffStats(image, region, baseline, baselineRegion) {
  let changed = 0;
  let absSum = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  // Compare the visible (over-black) color, so a change in alpha alone still registers and two
  // encodings of the same rendered pixel don't read as different.
  for (let row = 0; row < region.height; row++) {
    for (let col = 0; col < region.width; col++) {
      sampleRgbInto(image, region.x + col, region.y + row, SAMPLE_A);
      sampleRgbInto(baseline, baselineRegion.x + col, baselineRegion.y + row, SAMPLE_B);
      const dr = Math.abs(SAMPLE_A[0] - SAMPLE_B[0]);
      const dg = Math.abs(SAMPLE_A[1] - SAMPLE_B[1]);
      const db = Math.abs(SAMPLE_A[2] - SAMPLE_B[2]);
      absSum += (dr + dg + db) / 3;
      if (Math.max(dr, dg, db) > diffThreshold) {
        changed++;
        const x = region.x + col;
        const y = region.y + row;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  const total = region.width * region.height;
  return {
    changedPixelFraction: round(total ? changed / total : 0, 4),
    meanAbsDiff: round(total ? absSum / total : 0, 2),
    changedBBox: boxOf(minX, minY, maxX, maxY),
  };
}

/** Write the pixel as it appears over a black page — RGB with alpha multiplied in — into `out`. */
function sampleRgbInto(image, x, y, out) {
  const { data, channels } = image;
  const i = (y * image.width + x) * channels;
  if (channels <= 2) {
    const a = channels === 2 ? data[i + 1] / 255 : 1;
    out[0] = data[i] * a;
    out[1] = out[0];
    out[2] = out[0];
    return;
  }
  const a = channels === 4 ? data[i + 3] / 255 : 1;
  out[0] = data[i] * a;
  out[1] = data[i + 1] * a;
  out[2] = data[i + 2] * a;
}

function percentile(histogram, total, fraction) {
  if (!total) {
    return 0;
  }
  const target = fraction * total;
  let seen = 0;
  for (let bucket = 0; bucket < histogram.length; bucket++) {
    seen += histogram[bucket];
    if (seen >= target) {
      return round(bucket / 255, 4);
    }
  }
  return 1;
}

function boxOf(minX, minY, maxX, maxY) {
  if (!Number.isFinite(minX)) {
    return null;
  }
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

// ============================ PNG decoding ============================

function readImage(filePath) {
  let buffer;
  try {
    buffer = fs.readFileSync(filePath);
  } catch (err) {
    fail(1, `Could not read ${filePath}: ${err.message}`);
  }
  try {
    return decodePng(buffer);
  } catch (err) {
    fail(1, `Could not decode ${filePath}: ${err.message}`);
  }
}

/**
 * Decode an 8-bit, non-interlaced PNG to raw samples.
 *
 * Scope is deliberately narrow — this exists to read `Page.captureScreenshot` output, which is
 * always 8-bit non-interlaced. Anything else (16-bit, interlaced, palette) THROWS instead of being
 * approximated: silently mis-decoding a frame would produce confident, wrong brightness numbers.
 */
function decodePng(buffer) {
  if (buffer.length < 8 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new Error('not a PNG file (bad signature)');
  }

  let header = null;
  let hasTransparency = false;
  const idatParts = [];
  let offset = 8;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buffer.length) {
      throw new Error(`truncated ${type} chunk`);
    }
    if (type === 'IHDR') {
      header = {
        width: buffer.readUInt32BE(dataStart),
        height: buffer.readUInt32BE(dataStart + 4),
        bitDepth: buffer[dataStart + 8],
        colorType: buffer[dataStart + 9],
        interlace: buffer[dataStart + 12],
      };
    } else if (type === 'tRNS') {
      hasTransparency = true;
    } else if (type === 'IDAT') {
      idatParts.push(buffer.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataEnd + 4; // skip the CRC
  }

  if (!header) {
    throw new Error('no IHDR chunk');
  }
  if (header.bitDepth !== 8) {
    throw new Error(
      `unsupported bit depth ${header.bitDepth} (only 8-bit is supported; Chrome screenshots are 8-bit).${CONVERT_HINT}`,
    );
  }
  if (header.interlace !== 0) {
    throw new Error(
      `interlaced PNGs are not supported (Chrome screenshots are not interlaced).${CONVERT_HINT}`,
    );
  }
  const channels = CHANNELS_BY_COLOR_TYPE[header.colorType];
  if (!channels) {
    throw new Error(
      `unsupported color type ${header.colorType} (supported: 0 gray, 2 RGB, 4 gray+alpha, 6 RGBA).${CONVERT_HINT}`,
    );
  }
  // Color types 0 and 2 carry no alpha channel; a tRNS chunk is the only way they express
  // transparency, and this decoder does not read it. Since luminance MULTIPLIES alpha in, an
  // ignored tRNS would report transparent pixels as fully lit — exactly the confident wrong
  // number the narrow scope exists to avoid. (Types 4 and 6 have real alpha; tRNS is illegal on
  // them, and type 3 is already rejected above.)
  if (hasTransparency && (header.colorType === 0 || header.colorType === 2)) {
    throw new Error(
      `color type ${header.colorType} with a tRNS transparency chunk is not supported (its ` +
        `transparent pixels would be measured as fully lit).${CONVERT_HINT}`,
    );
  }
  if (!idatParts.length) {
    throw new Error('no IDAT chunk');
  }

  const raw = zlib.inflateSync(Buffer.concat(idatParts));
  const stride = header.width * channels;
  const expected = (stride + 1) * header.height;
  if (raw.length < expected) {
    throw new Error(`IDAT is short: ${raw.length} bytes, expected ${expected}`);
  }

  return {
    width: header.width,
    height: header.height,
    channels,
    data: unfilter(raw, header.height, stride, channels),
  };
}

/** Undo the five PNG scanline filters in place, returning contiguous pixel rows. */
function unfilter(raw, height, stride, bpp) {
  const out = Buffer.alloc(stride * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[src++];
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= bpp ? out[rowStart + i - bpp] : 0; // left
      const b = y > 0 ? out[prevStart + i] : 0; // above
      const c = y > 0 && i >= bpp ? out[prevStart + i - bpp] : 0; // above-left
      let value;
      switch (filter) {
        case 0:
          value = x;
          break;
        case 1:
          value = x + a;
          break;
        case 2:
          value = x + b;
          break;
        case 3:
          value = x + ((a + b) >> 1);
          break;
        case 4:
          value = x + paeth(a, b, c);
          break;
        default:
          throw new Error(`unknown scanline filter ${filter} on row ${y}`);
      }
      out[rowStart + i] = value & 0xff;
    }
    src += stride;
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) {
    return a;
  }
  return pb <= pc ? b : c;
}

// ============================ region ============================

function parseRegion(spec, image, flag) {
  const whole = { x: 0, y: 0, width: image.width, height: image.height };
  if (spec == null) {
    return whole;
  }
  // A bare `--region` parses as `true`. Measuring the whole image instead would hand back
  // full-frame statistics indistinguishable from a successful regional measurement — the same
  // reason `str()` turns a bare `--png` into a usage error.
  if (spec === true || spec === '') {
    fail(2, `${flag} requires a value "x,y,width,height" (it was passed with none).`);
  }
  const parts = String(spec).split(',').map(part => Number(part.trim()));
  if (parts.length !== 4 || parts.some(part => !Number.isInteger(part))) {
    fail(2, `${flag} must be four integers "x,y,width,height" (got ${JSON.stringify(String(spec))}).`);
  }
  const [x, y, width, height] = parts;
  if (width <= 0 || height <= 0) {
    fail(2, `${flag} width and height must be positive (got ${width}x${height}).`);
  }
  if (x < 0 || y < 0 || x + width > image.width || y + height > image.height) {
    fail(
      2,
      `${flag} ${x},${y} ${width}x${height} falls outside the ${image.width}x${image.height} image.`,
    );
  }
  return { x, y, width, height };
}

function isWholeImage(region, image) {
  return region.x === 0 && region.y === 0 && region.width === image.width && region.height === image.height;
}

// `empty` is per call site: an absent box means "nothing is lit" for the luminance bbox but
// "nothing moved" for the diff bbox, and one wording would state the wrong condition on the
// other line.
function describeBox(box, empty) {
  return box ? `${box.width}x${box.height} at ${box.x},${box.y}` : empty;
}

// ============================ utils ============================

function parseArgs(a) {
  const o = {};
  for (let i = 0; i < a.length; i++) {
    if (!a[i].startsWith('--')) {
      continue;
    }
    // `--key=value` binds the value unambiguously — the only way to pass a value that itself
    // starts with `--` (e.g. a negative region offset), since a following `--…` token is
    // otherwise read as the next flag. Same convention as cdp.mjs.
    const eq = a[i].indexOf('=');
    if (eq !== -1) {
      o[a[i].slice(2, eq)] = a[i].slice(eq + 1);
      continue;
    }
    const k = a[i].slice(2);
    o[k] = i + 1 < a.length && !a[i + 1].startsWith('--') ? a[++i] : true;
  }
  return o;
}

// A value-expecting flag passed bare (`--png` with no value) parses as `true`, not a string. Treat
// that as absent so the caller fails with a clear usage error instead of a downstream TypeError.
function str(v) {
  return typeof v === 'string' && v !== '' ? v : undefined;
}
// A threshold that silently didn't take effect is the worst failure this script has: the run
// succeeds and the numbers look real, so nothing tells the caller they measured against the
// default. Anything unparseable is a usage error instead — including the empty string, which
// `Number` would read as 0 and thereby invert `--diff-threshold`'s meaning.
function num(v, d, flag) {
  if (v == null) {
    return d;
  }
  if (v === true || v === '') {
    fail(2, `${flag} requires a number (e.g. \`${flag} ${d}\`).`);
  }
  const n = Number(v);
  if (!Number.isFinite(n)) {
    fail(2, `${flag} must be a number (got ${JSON.stringify(String(v))}).`);
  }
  return n;
}
function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}
function clamp01(v) {
  return clamp(v, 0, 1);
}
function round(v, digits) {
  const factor = 10 ** digits;
  return Math.round(v * factor) / factor;
}
function pct(fraction) {
  return `${round(fraction * 100, 2)}%`;
}

// `fs.writeSync`, not `process.stdout.write`: writes to a PIPE are asynchronous in Node, and the
// `process.exit()` below can discard whatever is still queued — truncating the JSON report exactly
// when it is being captured by another process, which is how this script is normally run.
function emit(fd, text) {
  fs.writeSync(fd, text);
}
// `version` answers a human or a capability check (`--version | grep fractionLit`), so it prints
// plain text on stdout rather than the JSON report every measurement produces.
function printText(text) {
  emit(1, `${text}\n`);
  process.exit(0);
}
function done(code, obj, summary) {
  emit(1, `${JSON.stringify(obj, null, 2)}\n`);
  if (summary) {
    emit(2, `${summary}\n`);
  }
  process.exit(code);
}
function fail(code, message) {
  emit(1, `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`);
  emit(2, `${message}\n`);
  process.exit(code);
}

// Invoked last, after every module-level declaration is initialized — `diffStats` reads the
// SAMPLE_* scratch buffers declared further down, which are still in the temporal dead zone
// while the file is executing top to bottom. Same convention as cdp.mjs.
main();
