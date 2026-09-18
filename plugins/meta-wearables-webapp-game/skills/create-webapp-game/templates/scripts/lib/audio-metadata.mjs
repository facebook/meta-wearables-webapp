/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/**
 * Read an audio file's duration and channel count straight out of its container header — the
 * deterministic core behind `audio-sizes.mjs`.
 *
 * Enough of WAV and Ogg (Vorbis and Opus) to compute a decoded size, and nothing more: no decoding,
 * no dependencies, no ffmpeg. Anything else returns `null`, which the caller treats as "unknown" —
 * and an unknown size is safe, because the audio subsystem falls back to a sequential bank swap
 * rather than trusting an estimate it does not have.
 *
 * ## Why the sample rate here is not the file's
 *
 * `decodeAudioData` resamples to the **AudioContext's** rate, so decoded size is a property of the
 * playback device, not of the file. The Meta Display Glasses WebView runs at 48 kHz (measured on
 * device during bring-up; a page can confirm it for itself with `new AudioContext().sampleRate`),
 * so {@link DECODE_SAMPLE_RATE} is what sizes are computed against. On a 44.1 kHz laptop that
 * over-estimates by ~9%, which is the safe direction for a memory budget.
 *
 * Channel count *is* a property of the file and survives decoding, so it is read from the header.
 */

/** The rate `decodeAudioData` resamples to on the target device. See the note above. */
export const DECODE_SAMPLE_RATE = 48_000;

/** The Ogg page capture pattern, hoisted so the backward scan allocates nothing per candidate. */
const OGGS_PATTERN = Buffer.from('OggS', 'latin1');

/** Bytes the whole clip occupies once decoded: `seconds x channels x rate x 4` (Float32). */
export function pcmBytesFor(durationSeconds, channels) {
  return Math.round(durationSeconds * channels * DECODE_SAMPLE_RATE * 4);
}

/**
 * `{ durationSeconds, channels }` for a supported container, else `null`.
 *
 * Dispatches on the magic bytes rather than the extension, so a mislabelled file is read correctly
 * (or reported as unsupported) instead of being parsed as the wrong format.
 */
export function audioMetadata(buffer) {
  if (buffer.length < 16) {
    return null;
  }
  const magic = buffer.toString('latin1', 0, 4);
  if (magic === 'RIFF') {
    return parseWav(buffer);
  }
  if (magic === 'OggS') {
    return parseOgg(buffer);
  }
  return null;
}

/**
 * RIFF/WAVE. Walks the chunk list for `fmt ` (channels, rate, bit depth) and `data` (byte count);
 * frames are `data bytes / block align`.
 */
function parseWav(buffer) {
  if (buffer.length < 12 || buffer.toString('latin1', 8, 12) !== 'WAVE') {
    return null;
  }
  let audioFormat = 0;
  let channels = 0;
  let sampleRate = 0;
  let bitsPerSample = 0;
  let dataBytes = 0;

  let offset = 12;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString('latin1', offset, offset + 4);
    const declared = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ' && body + 16 <= buffer.length) {
      audioFormat = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bitsPerSample = buffer.readUInt16LE(body + 14);
    } else if (id === 'data') {
      // A truncated file declares more than it holds; trust the smaller of the two.
      dataBytes = Math.min(declared, buffer.length - body);
    }
    // RIFF chunks are word-aligned: an odd size carries a pad byte the size does not count.
    offset = body + declared + (declared % 2);
  }

  // Uncompressed PCM (1) or IEEE float (3) only. The duration below divides by a frame size
  // derived from `bitsPerSample`, which describes the on-disk frame for exactly those two; for a
  // compressed WAV (ADPCM and friends) it does not, and the result would be a confidently wrong
  // duration rather than an admitted unknown. WAVE_FORMAT_EXTENSIBLE (0xFFFE) carries the real
  // tag in a sub-format GUID this parser does not read, so it is unknown here too.
  const WAVE_FORMAT_PCM = 1;
  const WAVE_FORMAT_IEEE_FLOAT = 3;
  if (audioFormat !== WAVE_FORMAT_PCM && audioFormat !== WAVE_FORMAT_IEEE_FLOAT) {
    return null;
  }

  const blockAlign = (channels * bitsPerSample) / 8;
  if (!channels || !sampleRate || !blockAlign || !dataBytes) {
    return null;
  }
  return { durationSeconds: dataBytes / blockAlign / sampleRate, channels };
}

/**
 * Ogg, carrying either Vorbis or Opus. Duration comes from the granule position on the final page —
 * the codecs' own running sample count — so it needs no decoding.
 */
function parseOgg(buffer) {
  const head = oggPageBody(buffer, 0);
  if (!head) {
    return null;
  }

  let channels;
  let granuleRate;
  let preSkip = 0;
  if (head.length >= 19 && head.toString('latin1', 0, 8) === 'OpusHead') {
    channels = head.readUInt8(9);
    preSkip = head.readUInt16LE(10);
    // Opus granule positions are always in 48 kHz units, whatever the original input rate was.
    granuleRate = 48_000;
  } else if (head.length >= 16 && head.readUInt8(0) === 1 && head.toString('latin1', 1, 7) === 'vorbis') {
    channels = head.readUInt8(11);
    granuleRate = head.readUInt32LE(12);
  } else {
    return null;
  }

  // Bytes 14-17 of a page header identify its logical stream. A multiplexed or chained Ogg has
  // pages from other streams after this one, whose granule counters are unrelated to this one's
  // and would otherwise be read as this stream's sample count.
  const granule = lastOggGranulePosition(buffer, buffer.readUInt32LE(14));
  if (granule === null || !channels || !granuleRate) {
    return null;
  }
  // Opus pre-skip is decoder priming that is discarded on playback, so it is not audible length.
  const frames = Math.max(0, granule - preSkip);
  return { durationSeconds: frames / granuleRate, channels };
}

/** The payload of the Ogg page starting at `offset`, or `null` if the page is malformed. */
function oggPageBody(buffer, offset) {
  if (offset + 27 > buffer.length || buffer.toString('latin1', offset, offset + 4) !== 'OggS') {
    return null;
  }
  const segments = buffer.readUInt8(offset + 26);
  const tableEnd = offset + 27 + segments;
  if (tableEnd > buffer.length) {
    return null;
  }
  let bodyLength = 0;
  for (let i = 0; i < segments; i++) {
    bodyLength += buffer.readUInt8(offset + 27 + i);
  }
  return buffer.subarray(tableEnd, Math.min(tableEnd + bodyLength, buffer.length));
}

/**
 * The granule position of the last page in the file — the total sample count. Scans backwards for
 * the capture pattern, because the page list cannot be walked from the end.
 */
function lastOggGranulePosition(buffer, serial) {
  let found = null;
  let foreignSerial = false;
  if (buffer.length < 27) {
    return null;
  }
  // `lastIndexOf` runs the capture-pattern search natively. A JS-level compare per byte over a
  // multi-MB music track dominated the whole measurement pass, and the plugin re-runs it on every
  // `vite`, `vite build` and `vitest` start. The walk still covers the entire file, because
  // `foreignSerial` can only be ruled out by reaching offset 0.
  let offset = buffer.lastIndexOf(OGGS_PATTERN, buffer.length - 27);
  while (offset >= 0) {
    if (isOggPageHeader(buffer, offset)) {
      if (buffer.readUInt32LE(offset + 14) !== serial) {
        foreignSerial = true;
      } else {
        const granule = buffer.readBigUInt64LE(offset + 6);
        // -1 marks a page whose packet is unfinished; keep scanning back for a real value.
        if (granule !== 0xffff_ffff_ffff_ffffn && found === null) {
          found = Number(granule);
        }
      }
    }
    if (offset === 0) {
      break;
    }
    offset = buffer.lastIndexOf(OGGS_PATTERN, offset - 1);
  }
  // Any page from another logical stream means this file is multiplexed or chained, and the two
  // are not cheaply distinguishable here. For a chained file (`cat a.ogg b.ogg`) this stream's
  // granule counts only the first chain, so the duration — and `pcmBytes` with it — would come
  // out too SMALL, the unsafe direction for a memory budget everything else over-estimates for.
  // Report unknown instead: the audio subsystem falls back to a sequential bank swap.
  return foreignSerial ? null : found;
}

/**
 * Whether the `OggS` at `offset` is a real page header rather than four bytes that happen to spell
 * it inside a page's payload.
 *
 * Compressed audio is effectively random, so the pattern can occur in the body — and because the
 * scan above runs backwards and takes the first hit, such a match sits at a HIGHER offset than the
 * genuine final header and would win. The granule read out of it would then be arbitrary payload
 * bytes, producing a wildly wrong duration with nothing to flag it. These three checks are what a
 * page header can be verified by without decoding: a fixed version byte, no undefined bits in the
 * header type, and a segment table that fits in the file.
 */
function isOggPageHeader(buffer, offset) {
  if (offset + 27 > buffer.length) {
    return false;
  }
  const version = buffer.readUInt8(offset + 4);
  const headerType = buffer.readUInt8(offset + 5);
  const segments = buffer.readUInt8(offset + 26);
  // Only continuation (0x01), first-page (0x02) and last-page (0x04) are defined.
  return version === 0 && (headerType & 0b1111_1000) === 0 && offset + 27 + segments <= buffer.length;
}
