#!/usr/bin/env bash
# Copyright (c) Meta Platforms, Inc. and affiliates.
# All rights reserved.
#
# This source code is licensed under the BSD-style license found in the
# LICENSE file in the root directory of this source tree.

# start-chrome-cdp.sh — Launch a Chrome/Edge with remote debugging (CDP) enabled so an agent
# can drive this game over localhost. The `iterate-webapp-game` skill connects to it
# via the Chrome DevTools Protocol to load the game, screenshot it, and debug it.
#
# The agent normally runs this itself as a background task. Run it by hand — in a normal
# terminal, NOT through the agent, leaving it running while you iterate — when the agent is
# sandboxed and can't launch Chromium (Claude Code's macOS sandbox crashes it on a Mach
# bootstrap restriction). Such sandboxes can still connect to a browser you launch out here.
#
# Usage:
#   npm run chrome            # port 9222 (default)
#   npm run chrome -- 9333    # a different port
#
# A dedicated --user-data-dir is required: Chrome refuses --remote-debugging-port on your
# normal profile. This launches a real (headed) window so you can watch, and WebGL uses your
# real GPU (no software-renderer flags needed).
#
# Occlusion: on macOS a headed window that another window COVERS stops receiving
# `requestAnimationFrame` callbacks, so a free-running game loop does not advance and the `?stats`
# overlay reads zeros. Several windows at once — one Chrome per CDP port, which is how parallel
# agent runs stay off each other's browser — makes that the normal case rather than the exception.
# Four flags below are the switches this behavior is gated on, named rather than described by
# position — the exec ends with `--new-window`, so "the last four" is not them:
# `--disable-backgrounding-occluded-windows`, `--disable-renderer-backgrounding`,
# `--disable-background-timer-throttling` and `--disable-features=CalculateNativeWinOcclusion`.
#
# Measured 2026-08-28 on macOS (Darwin 25.6.0) with Google Chrome, a starter game served at
# http://127.0.0.1:5173/?stats, and a fullscreen terminal window completely covering the Chrome
# window: with only the five base flags the page ran 0 rAF callbacks in 1 second; with these four
# added, 61. The flags were the only difference between the two runs. `document.visibilityState`
# read `visible` and `document.hasFocus()` `true` in BOTH runs, so the page's own account of its
# visibility does not distinguish them — which is why `cdp.mjs foreground` counts frames.
#
# That is one machine, one macOS version, one Chrome, one covering-window arrangement.
set -euo pipefail

PORT="${1:-${CDP_PORT:-9222}}"
USER_DATA_DIR="${CDP_USER_DATA_DIR:-/tmp/webapp-game-chrome-cdp-$PORT}"

find_browser() {
  local candidates=(
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
    "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary"
    "/Applications/Chromium.app/Contents/MacOS/Chromium"
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"
    "google-chrome" "google-chrome-stable" "chromium" "chromium-browser" "microsoft-edge"
  )
  local c
  for c in "${candidates[@]}"; do
    if [[ -x "$c" ]]; then echo "$c"; return 0; fi
    if command -v "$c" >/dev/null 2>&1; then command -v "$c"; return 0; fi
  done
  return 1
}

if ! BROWSER="$(find_browser)"; then
  echo "ERROR: No Chrome/Chromium/Edge found. Install Google Chrome, then retry." >&2
  exit 1
fi

echo "Launching: $BROWSER"
echo "  CDP endpoint : http://127.0.0.1:$PORT"
echo "  user-data-dir: $USER_DATA_DIR"
echo "  verify with  : curl -s http://127.0.0.1:$PORT/json/version"
echo
echo "Leave this running (Ctrl+C to stop). The iterate-webapp-game skill connects here."
echo

exec "$BROWSER" \
  --remote-debugging-port="$PORT" \
  --user-data-dir="$USER_DATA_DIR" \
  --no-first-run \
  --no-default-browser-check \
  --disable-backgrounding-occluded-windows \
  --disable-renderer-backgrounding \
  --disable-background-timer-throttling \
  --disable-features=CalculateNativeWinOcclusion \
  --new-window "about:blank"
