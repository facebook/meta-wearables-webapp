/**
 * Entry point. Builds the Three.js renderer + pointer/keyboard input + game, mounts the DOM
 * HUD, and drives everything with the game loop.
 *
 * Controls (desktop dev): arrow keys = D-pad swipe, **Enter = index tap (select)**. On the
 * glasses these are the EMG D-pad (side of the index finger) and index pinch (pad) gestures.
 * A mouse CLICK does nothing, and that is correct — press Enter to fire the index pinch.
 *
 * This starter is TAP-ONLY: the index pinch is a discrete `pinchTap` select, with no drag or
 * pointer movement. Pinch-and-move is a separate, opt-in channel — see the plugin's
 * docs/drag-channel.md. Opt in only if the game actually uses a drag; never to make desktop
 * mouse clicks select.
 *
 * Startup order is: input -> (consent gate, only with `?logkey`) -> game. The gate runs first so
 * that no log record can leave the device before the player has agreed — see `startGame` below
 * and the plugin's docs/logging.md.
 */

// Side-effect import: initializes i18next with the game's bundled strings (src/i18n/) before
// anything renders. See the plugin's docs/localization.md.
import '@/i18n';

import { AUDIO_SETTINGS, type SoundId } from '@/audio/soundIds';
import { AUDIO, DISPLAY, LOOP } from '@/config/gameplayConstants';
import { Game } from '@/core/Game';
import { AmpAudioPlayer } from '@/framework/audio/AmpAudioPlayer';
import { muteRequested } from '@/framework/audio/AudioEngine';
import { GameLoop } from '@/framework/core/GameLoop';
import { applyStaticTranslations } from '@/framework/i18n/i18n';
import { consoleSink, captureGlobalErrors } from '@/framework/debug/Logger';
import { driveModeRequested, installDriveHarness } from '@/framework/debug/DriveHarness';
import { LogOverlay, logOverlayRequested } from '@/framework/debug/LogOverlay';
import { PerfOverlay } from '@/framework/debug/PerfOverlay';
import { statsOverlayRequested } from '@/framework/debug/PerfSampler';
import { RemoteLogSink, httpTransport, logKeyFromSearch } from '@/framework/debug/RemoteLogSink';
import { PointerKeyboardInput } from '@/framework/input/PointerKeyboardInput';
import type { InputManager } from '@/framework/input/InputManager';
import { ThreeRenderer } from '@/framework/render/ThreeRenderer';
import { registerGameServiceWorker } from '@/framework/sw/register';
import { ConsentGate, TransmissionBadge } from '@/framework/ui/ConsentGate';
import { Hud } from '@/hud/Hud';
import { t } from '@/i18n';
import { log, search } from '@/log';
import { MODELS } from '@/models';

/** The 600x600 stage. Debug overlays mount here so nothing escapes the display bounds. */
function stage(): HTMLElement | undefined {
  return document.querySelector<HTMLElement>('#game-root') ?? undefined;
}

function main(): void {
  // Fill the static DOM text (title screen, HUD labels) from the active locale before rendering.
  applyStaticTranslations();

  // Local logging first, so anything that fails during startup is captured. Nothing here leaves
  // the device: the console sink is the browser's own console, the overlay draws on screen.
  log.addSink(consoleSink());
  if (logOverlayRequested(search)) {
    log.addSink(new LogOverlay({ mount: stage() }));
  }
  captureGlobalErrors(log);

  // Precache this build so the next launch reads it off disk instead of the network. Deliberately
  // not awaited: the first launch gains nothing from it (the cache is being filled, not read), so
  // blocking startup on it would worsen the very metric it exists to improve. It no-ops in dev and
  // outside a secure context, and never rejects. `?swreset=1` wipes the worker and its caches —
  // the only way to clear a bad cache on the glasses, which have no reachable DevTools.
  // See the plugin's docs/offline-caching.md.
  void registerGameServiceWorker({ search });

  // Input is built before the consent gate, because the gate takes its interaction through the
  // InputManager (D-pad to choose, pinch to confirm) rather than through DOM listeners.
  //
  // No options: this game is tap-only, so the index pinch arrives as `Enter` -> `pinchTap` and
  // there is no pointer stream to tune. To make the index pinch-and-MOVE (drag) channel deliver
  // a movement delta, follow the plugin's docs/drag-channel.md — it is three coordinated edits
  // (this constructor, style.css, and the game's update()). Opt in only if a drag drives
  // gameplay.
  const input = new PointerKeyboardInput();
  input.attach(window);

  const logKey = logKeyFromSearch(search);
  if (logKey === null) {
    startGame(input);
    return;
  }

  // Remote logging was requested. Redact the token before anything can log the URL, then ask.
  log.addSecret(logKey);
  new ConsentGate({
    mount: stage(),
    input,
    strings: {
      title: t('logConsentTitle'),
      body: t('logConsentBody', { host: window.location.host }),
      accept: t('logConsentAccept'),
      decline: t('logConsentDecline'),
      hint: t('logConsentHint'),
    },
    onDecision: (accepted: boolean): void => {
      if (accepted) {
        armRemoteLogging(logKey);
      } else {
        // Declined: drop everything buffered so far rather than leaving it sitting in memory.
        log.clear();
        log.info('remote logging declined — logging locally only');
      }
      launch(input);
    },
  });
}

/**
 * Kick off `startGame`, reporting rather than swallowing a startup failure. It is async because
 * audio `init()` decodes the always-resident banks before the loop starts, and both call sites are
 * event callbacks that cannot await.
 */
function launch(input: InputManager): void {
  void startGame(input).catch((error: unknown) => {
    log.error('startup failed', { error: String(error) });
  });
}

/**
 * Attach the remote sink AFTER consent. Records buffered during startup are backfilled, so the
 * developer still sees the boot sequence, and the badge stays up for the rest of the session so
 * the transmission never becomes invisible.
 */
function armRemoteLogging(logKey: string): void {
  const sink = new RemoteLogSink({
    sessionId: log.sessionId,
    transport: httpTransport(logKey),
    redact: (text: string): string => log.redact(text),
    onDisabled: (reason: string): void => {
      badge.dispose();
      log.warn(`remote logging stopped: ${reason}`);
    },
  });
  const badge = new TransmissionBadge(t('logConsentBadge'), stage());

  log.addSink(sink);
  sink.backfill(log.getRecent());

  // A crashing or backgrounded page kills an in-flight fetch; sendBeacon survives it, so the last
  // records before a failure — the interesting ones — still arrive.
  window.addEventListener('pagehide', () => sink.flushFinal());
}

async function startGame(input: InputManager): Promise<void> {
  const canvas = document.querySelector<HTMLCanvasElement>('#game-canvas');
  if (!canvas) {
    throw new Error('Could not find #game-canvas element.');
  }

  const renderer = new ThreeRenderer(canvas, MODELS);
  renderer.resize(DISPLAY.width, DISPLAY.height);

  // Audio. The sound catalog is src/audio/audioSettings.json (designer-owned); the engine
  // tunables — voice cap, memory budget, spatial model, starting mix — come from the AUDIO config
  // block, so the framework stays config-free. The AudioContext is created lazily and starts
  // suspended (browser autoplay policy); it is unlocked by `audio.resume()` on the first pinch
  // below.
  //
  // `init()` resolves once the always-resident banks are decoded. The starter's sounds are all
  // synthesized, so there is nothing to decode and it returns immediately. Once the game has real
  // recorded audio, its bytes arrive through the preload manifest (an `{ type: 'audio', bank: … }`
  // entry per clip) and `init({ initialBanks: [...] })` decodes the first level behind the loading
  // screen. See docs/audio.md, docs/audio-banks.md and docs/loading-screen.md.
  const audio = new AmpAudioPlayer<SoundId>(AUDIO_SETTINGS, {
    ...AUDIO,
    mutedByDefault: AUDIO.mutedByDefault || muteRequested(search),
  });
  await audio.init();

  const game = new Game(renderer, input, audio);
  const hud = new Hud(game);

  // Dev-only debug handle. Reading state over the DevTools protocol
  // (`cdp.mjs eval --expr "window.__game.state"`) is unambiguous where comparing two
  // screenshots is not, and it costs no image tokens. Stripped from a production build.
  if (import.meta.env.DEV) {
    (window as unknown as { __game?: Game }).__game = game;
  }

  // Hide the title screen and unlock audio on the first discrete input (index tap). Browsers
  // start the AudioContext suspended until a user gesture, so the first `resume()` must come from
  // an input handler like this. These are registered only now, after any consent gate has
  // resolved, so the pinch that answered the gate doesn't also skip the title screen.
  input.on('pinchTap', () => hud.hideTitle());
  input.on('pinchTap', () => audio.resume());

  // Opt-in perf HUD: load the game with `?stats` to overlay live FPS / CPU / draw-call /
  // triangle / GPU-memory numbers. Off (and zero cost) otherwise. Handy on the glasses,
  // where there's no logcat or console. Mount inside the 600x600 stage.
  const perf = statsOverlayRequested(search)
    ? new PerfOverlay(renderer, { mount: stage(), audio })
    : null;

  const loop = new GameLoop(
    {
      update: (dt: number): void => {
        perf?.beginFrame();
        game.update(dt);
      },
      render: (): void => {
        game.render();
        // Close the CPU-ms measurement here, before the HUD refresh, so it covers only
        // game update() + render() (as PerfSampler documents) and not the DOM HUD write.
        perf?.endFrame();
        hud.update();
      },
    },
    { maxFrameMs: LOOP.maxFrameMs, stepSeconds: LOOP.stepSeconds },
  );

  // Opt-in drive mode: load the game with `?drive` and the loop never starts itself. Frames come
  // from `window.__webappGame.step(n)` instead, so an external driver knows exactly what state a
  // screenshot was taken at. Off (and zero cost) otherwise. See docs/query-parameters.md.
  const driven = driveModeRequested(search);
  if (driven) {
    installDriveHarness(loop);
    log.info('drive mode: loop paused; advance it with window.__webappGame.step(n)');
  } else {
    loop.start();
  }

  // Stop the loop while the app is backgrounded so no work runs when it isn't visible (per
  // the performance guidelines). rAF already throttles hidden desktop tabs, but a
  // backgrounded device WebView can keep servicing frames. start() re-stamps the frame clock,
  // so resuming never produces a huge catch-up delta.
  //
  // Whether to restart is decided by whether the loop was actually running when the tab went
  // away, not by `driven`: under `?drive` the loop is normally paused and must stay that way,
  // but `window.__webappGame.resume()` can hand it back to rAF, and that game should keep running
  // across a background/refocus cycle.
  let wasRunning = false;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      wasRunning = loop.isRunning();
      loop.stop();
      // Suspend audio too, so a backgrounded app draws no audio-thread power.
      audio.suspend();
      // Hand off anything queued: a backgrounded app may never come back.
      log.flush();
    } else {
      if (wasRunning) {
        loop.start();
      }
      // Only resume an already-unlocked context. Before the first pinch there's no context yet;
      // calling resume() here would construct one outside a user gesture and trip the autoplay
      // policy (console warning + rejected resume). The first pinch (above) does the unlock.
      if (audio.getContext()) {
        audio.resume();
      }
    }
  });
}

main();
