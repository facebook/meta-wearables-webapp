---
name: ai-glasses-webapp-test
description: "Run the complete deterministic quality gate for a Meta Ray-Ban Display glasses web app: package/UI-toolkit checks, typecheck, production build, responsive viewport containment, local performance smoke checks, Playwright interaction, accessibility, sensors, and screenshots."
argument-hint: "[app-directory]"
---

# Test a Meta glasses web app

Run:

```sh
node <this-skill>/scripts/check-webapp.mjs <app-directory>
```

The gate verifies the locked app dependency tree and skips package installation
when it is already complete. If modules are absent, it uses `npm ci` against
the committed lockfile; it never rewrites package versions. It then typechecks,
builds, validates the two registry UI Toolkit packages/public imports and
required metadata, and runs the bundled Toolkit structure validator for
Toolkit apps. Those apps must use a
device-width viewport and a full-viewport `#root` without hardcoded device
dimensions. Explicit custom-UI opt-outs retain their generated mount contract.

Browser QA serves the production build and checks both a 600×600 device window
and a larger desktop window. A Toolkit app must fill either viewport edge to
edge without scaling from a fixed device constant. It fails on console/page errors, document overflow, clipped or
unnamed focus targets, broken directional movement/Enter/Escape focus, images
without alt text, a grossly slow local load, JavaScript that alone exhausts the
300 KB first-load budget, 15 or more initial requests, heap ≥128 MB, or
animation-frame sampling below the 30 Hz panel target. It writes
normal and additive-display screenshots under `.wearables-test/`.

These fast-host checks catch regressions; they do not emulate the device link
or CPU and cannot prove startup performance. Before release, use
`ai-glasses-webapp-optimize-performance` against a production build with a
content oracle, cold and warm runs, n ≥ 10, interleaved A/B, and a null control.

Treat every failure as blocking and fix application source—not the validator or
toolkit package. Feature scenarios remain required: sensor apps test granted,
denied, unsupported, demo, Pause/Stop, and cleanup; games test deterministic D-pad
play, Escape focus restoration, game-over, and persisted scores; network apps
test slow, empty, offline, aborted, error, stale, and recovery states.

On restricted hosts the gate tries sandboxed Chromium and Firefox. Prefer an
approved Chromium DevTools endpoint through `WEARABLES_CDP_ENDPOINT` when local
browsers cannot launch. Only after reviewing and trusting the application code
may a developer explicitly set `WEARABLES_ALLOW_UNSANDBOXED_BROWSER=1` to use
the Chromium single-process no-sandbox fallback. Browser transport never
relaxes assertions. `--static-only` is diagnostic and never counts as a full
browser/convergence pass.
