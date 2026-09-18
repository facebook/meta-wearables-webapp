/**
 * Centralized tunable constants. Every gameplay number lives here as a named export —
 * never inline magic numbers in gameplay code. Tuning the game is then a single-file edit.
 *
 * Tunable blocks are deliberately NOT `as const`: their members type as `number`, so a mutable
 * field seeded from one stays assignable (`private timeLeft = ROUND.duration` infers `number`,
 * not the literal `60`). Only fixed device facts — `DISPLAY` — keep `as const`. New blocks you
 * add here are tunables: leave `as const` off them.
 */

/** Fixed 600x600 Meta Display Glasses canvas. Device fact, not a tunable. */
export const DISPLAY = {
  width: 600,
  height: 600,
} as const;

/** Variable-timestep game loop. */
export const LOOP = {
  /** Cap on a single frame's delta (ms) so a long pause doesn't produce a huge jump. */
  maxFrameMs: 250,
  /**
   * Delta (SECONDS) one manual frame advances the simulation by under `?drive`. Only the
   * driven path reads this; normal play uses the real elapsed frame time.
   */
  stepSeconds: 1 / 60,
};

/*
 * There is no INPUT block here: a tap-only game has nothing to tune. The pointer-drag
 * sensitivity / tap-travel constants belong to the opt-in drag channel — see the plugin's
 * docs/drag-channel.md, which ships them ready to paste.
 */

/** 0xRRGGBB colors for the game scene (2D or 3D). Bright colors read best on the additive display. */
export const COLORS = {
  player: 0x00d4ff,
};

/**
 * Audio *engine* tunables — the mix, the voice pool, the spatial model, and the memory budget.
 * Injected into the framework `AmpAudioPlayer` (the framework never imports this).
 *
 * What a sound IS lives in `src/audio/audioSettings.json`, which a designer owns. What belongs
 * here is what the *device* dictates: how many voices its CPU can carry, how much decoded audio
 * its memory can hold, and the starting mix. This block is the only place the bus mix is
 * configured; change it at runtime with the player's `setBusVolume`.
 * See `docs/audio.md`.
 */
export const AUDIO = {
  /** Master bus volume. Linear `0..1`. */
  masterVolume: 0.8,
  /** SFX bus volume. */
  sfxVolume: 1.0,
  /** Music bus volume. */
  musicVolume: 0.7,
  /** Start muted (e.g. for demos/tests). The `?mute` query flag also forces mute at startup. */
  mutedByDefault: false,
  /**
   * Size of the preallocated channel-strip pool — the hard ceiling on simultaneous voices, and
   * what protects the mobile-grade CPU. `globalVoiceLimit` (in the JSON, and settable at runtime
   * for on-device profiling) is a soft cap clamped to this.
   */
  maxVoices: 16,
  /**
   * Budget for **decoded** audio, in bytes. Decoded PCM is roughly 30x the size of the Ogg it came
   * from (~0.37 MB per second of stereo 48 kHz), so this — not download size — is what a bank
   * lifecycle manages. 24 MB is about 65 seconds of audio resident at once, a conservative slice of
   * the platform's < 128 MB app budget (see docs/performance-guidelines.md); raise it for a game
   * whose levels genuinely need more. Loading past it is refused with a warning rather than risking
   * an out-of-memory kill of the WebView. See `docs/audio-banks.md`.
   */
  maxResidentBytes: 24 * 1024 * 1024,
  /** World half-width mapped to full left/right stereo pan (spatial sounds). */
  panRange: 6,
  /** Distance (world units) at/inside which a spatial sound is at full volume. */
  refDistance: 1,
  /** How sharply a spatial sound attenuates past `refDistance`. */
  rolloffFactor: 1,
  /** Distance (world units) at/beyond which a spatial sound is silent. */
  maxDistance: 20,
};

/** Player movement. */
export const PLAYER = {
  /** How far one D-pad swipe advances the player's target (world units). */
  stepSize: 1,
  /**
   * Glide speed toward the target, in world units per SECOND. A rate, so gameplay multiplies
   * it by the frame delta — the glide then takes the same wall-clock time at any frame rate.
   */
  moveSpeed: 6,
  /** Clamp on how far the player can move from center on each axis (world units). */
  bound: 4,
};
