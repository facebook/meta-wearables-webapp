---
name: ai-glasses-webapp-build
description: Create, redesign, or extend a web app for Meta Ray-Ban Display glasses. Use for application architecture, screens, routes, state, API-backed UI, persistence, offline behavior, or any product change; pair with ai-glasses-webapp-ui for toolkit setup and component composition. A complete initial app build includes a running local production preview and its URL.
argument-hint: "[app-name-or-feature] [app-directory]"
---

# Build a Meta glasses web app

Use normal React knowledge for APIs, storage, routing, and service workers, then
apply the glasses-specific contract below. Use `ai-glasses-webapp-ui` for every new
application and UI change unless the user explicitly opts out of the toolkit.

## Start or inspect

For an empty destination, run the initializer from `ai-glasses-webapp-ui` before
writing application source. It creates the required React/Vite/TypeScript app
and installs the public npm packages only when they are not already usable. For
an existing app, inspect and preserve its working toolchain, then use the UI
skill's idempotent existing-app installer when the toolkit is absent. Never
introduce a machine-specific checkout, source alias, or `file:` dependency.

## Viewport and Toolkit authority

For a Toolkit application, use viewport `width=device-width,
initial-scale=1.0` (with `viewport-fit=cover` when appropriate), an app-specific
description, and `mrbd-web-app-capable=yes`. Give `html`, `body`, and `#root`
full available width and height. Derive layout from available space with
shrinkable grid/flex tracks; never hardcode device or viewport dimensions or
branch on them. Use `var(--uit-color-background-window)` for the whole window.

Before editing Toolkit application UI, read its
installed `wearables-ui-toolkit-web/SKILL.md` entrypoint, then load only the
production pattern or direct references it selects. The public repository at
<https://github.com/facebook/meta-ray-ban-display-ui-toolkit-web/> contains the
documentation and LLM skills. Its UI guidance is authoritative for component
choice, route geometry, typography, and verification; the npm acquisition and
package-scope rules in `ai-glasses-webapp-ui` take precedence over stale setup
text. An explicit custom-UI opt-out keeps the custom scaffold's own mount
contract.

## Input and state

There is no free cursor or touchscreen. Directional input moves focus and
Select/EMG pinch activates the focused semantic control. Keep every command
reachable, preserve visible focus, and restore the originating control and
scroll position after Escape/Back, route return, or modal dismissal. Do not add
an in-app Back button.

Use stable geometry for loading, empty, stale, offline, denied, error, active,
and completion states that genuinely apply. Ordinary REST/WebSocket/storage/
offline code needs no separate skill: render a useful shell first, abort stale
work, close polling/sockets when hidden, and never bundle secrets.

## Composition boundaries

Follow the selected Toolkit pattern instead of imposing a host-specific screen
blueprint. In particular, keep exactly one vertical owner per route; never put
`ListItem` in `ScrollView` or nest `VerticalList` inside it. Keep a page-level
`Panel width="100%"` directly inside `ScrollView` when the selected pattern uses
one. When page commands exist, place them in a sibling bottom `ButtonRail` or
`ButtonGroup` dock with a shrinkable content track. Use action-less rows as
ordinary text rather than focus stops.

`TextStyle` members are exactly `NUMERAL1`, `NUMERAL2`, `DISPLAY1`, `HEADING1`,
`HEADING2`, `BODY1`, `BODY1_EMPHASIZED`, `BODY2`, `BODY2_EMPHASIZED`, `LABEL`,
`LABEL_EMPHASIZED`, `META1`, `META1_EMPHASIZED`, `META2`,
`META2_EMPHASIZED`, and `META3`. Routine product copy should stay at `BODY2`
or below; use larger roles only when the selected Toolkit pattern calls for
them.

## Performance and completion

Use `ai-glasses-webapp-optimize-performance` before release and whenever an app
is slow or its startup payload grows. Under its device profile, target first
paint under 1 second, usable content under 5 seconds, total first-load transfer
under 300 KB, warm launch under 2 seconds with 0 transferred bytes, fewer than
15 initial requests, and under 128 MB heap. The display is 30 Hz, so the frame
budget is 33 ms; never add a 60 fps loop for this panel.

Run timers, animation frames, sensors, polling, and sockets only while needed;
stop them on pause, hide, route exit, and unmount. Use local assets and bundled
icons; do not download icon packs.

Use `ai-glasses-webapp-device` for sensors or glasses-specific input. Invoke
`ai-glasses-webapp-test` after implementation and fix every failure. Before a
release, complete the performance pass and rerun that gate. For Toolkit apps,
the gate runs the official structure validator and requires zero findings.

## Local preview completion contract

When the user's prompt asks for a complete app to be created or substantially
redesigned, the goal is not complete when the files and tests are finished.
After `ai-glasses-webapp-test` passes, start a separate production preview from
the app directory in a persistent terminal session:

```sh
npm run preview -- --host 127.0.0.1 --port 4173
```

The test gate's own preview is temporary and does not satisfy this requirement.
Keep the new preview process running, wait for its ready message, and verify the
reported loopback URL responds. Port 4173 is preferred, but when it is occupied,
use the actual fallback port printed by the server. If a preview of an older
build is running, stop it and start the newly validated build.

The final response must include a clickable local URL such as
`http://127.0.0.1:4173/`, tell the user the app is ready for local review, and
state that the server remains running until stopped. Do not claim the initial
app-build goal is complete without that URL. If the environment cannot keep a
local server running, report that limitation and provide the exact preview
command instead.

This local preview is not publishing. Never invoke Vercel or
`ai-glasses-webapp-publish` unless the user later explicitly asks to make the
app publicly accessible.
