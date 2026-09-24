# Meta Wearables Web App AI Toolkit

An AI toolkit that helps you build Web Apps for Meta Ray-Ban Display glasses. It contains plugins for Muse Code, Claude Code, Codex, and Cursor.

## What are Web Apps for Meta Ray-Ban Display glasses?

Web Apps are standard HTML/CSS/JavaScript applications rendered on Meta Ray-Ban Display (MRBD) glasses — an easy and familiar way to build experiences for the glasses, especially with AI-assisted coding tools. See the full [Web Apps developer documentation](https://wearables.developer.meta.com/docs/develop/webapps) on the Wearables Developer Center for capabilities, design constraints, and best practices.

## Live Documentation MCP

MCP-capable tools can query current Web Apps docs through the shared public Wearables MCP server:

```text
https://mcp.developer.meta.com/wearables
```

Use the `search_webapps_docs` tool for Web Apps questions. The server does not require auth, OAuth, tokens, or custom authorization headers.

If your AI tool supports MCP, configure this remote HTTP server and call `search_webapps_docs` for current Web Apps documentation. If your tool does not support MCP, use the developer docs URL above directly.

## Quick Start

### 1. Install AI Skills

#### Option A — Plugin Marketplace (recommended for Muse Code, Claude Code, and Codex)

**Muse Code:**

```bash
# Add the marketplace (one-time, run in your terminal)
muse plugins marketplace add meta-wearables https://github.com/facebook/meta-wearables-webapp

# Install the plugin
muse plugins install meta-wearables-webapp@meta-wearables

# Building a game? Also install the companion game plugin
muse plugins install meta-wearables-webapp-game@meta-wearables

# Refresh the marketplace source
muse plugins marketplace update meta-wearables
```

**Claude Code:**

```bash
# Add the marketplace (one-time)
/plugin marketplace add https://github.com/facebook/meta-wearables-webapp

# Install the plugin
/plugin install meta-wearables-webapp@meta-wearables

# Building a game? Also install the companion game plugin
/plugin install meta-wearables-webapp-game@meta-wearables

# Update plugin
/plugin marketplace update meta-wearables && /plugin update meta-wearables-webapp@meta-wearables
```

**Codex CLI:**

```bash
# Add the marketplace (one-time, run in your terminal)
codex plugin marketplace add https://github.com/facebook/meta-wearables-webapp
```

Start Codex, and type `/plugins` → tab to **[Meta Wearables]** → install.

```bash
# Refresh the marketplace source
codex plugin marketplace upgrade meta-wearables
```

Then inside Codex: go to `/plugins` — if a newer version is available, select the option to update.

#### Option B — Install Script (all tools)

```bash
# Clone this repo and Install for your preferred tool
git clone https://github.com/facebook/meta-wearables-webapp.git
cd meta-wearables-webapp
./install-skills.sh claude    # Claude Code
./install-skills.sh cursor    # Cursor
./install-skills.sh all       # All tools + AGENTS.md

# Or remote install (no clone needed)
curl -sL https://raw.githubusercontent.com/facebook/meta-wearables-webapp/main/install-skills.sh | bash
```

### 2. Build a Web App

Open your project in an AI-assisted editor and describe what you want:

> "Create a weather app that shows the 5-day forecast with D-pad navigation"

The AI scaffolds a React + Vite + TypeScript app built on [UI Toolkit for Meta Ray-Ban Display](https://github.com/facebook/meta-ray-ban-display-ui-toolkit-web/) (`@wearables-ui-toolkit/mrbd` and `@wearables-ui-toolkit/icons` from npm), implements your request, runs the quality gate, and starts a local production preview at a URL like `http://127.0.0.1:4173/` for you to review.

**Building a game?** Real-time gameplay — a game loop, scoring, physics, collision, sprites,
enemies, or levels — belongs in the companion `meta-wearables-webapp-game` plugin, which scaffolds
a Vite + TypeScript + Three.js project instead. A leaderboard, a scoreboard, or a button-advanced
quiz is a normal web app; build those here.

### 3. Test in Browser

Ask the AI to test the app, or run the `ai-glasses-webapp-test` quality gate yourself. It typechecks, builds, and drives the production build in a headless browser at 600×600 and desktop sizes, checking D-pad focus, accessibility, and performance budgets. To try the app by hand, run `npm run preview` in the app directory and open the printed URL in your desktop browser. Use arrow keys to simulate D-pad input and Enter for pinch/Select.

To test sensor data like geolocation or IMU sensors:

1. Open **Chrome DevTools** (F12)
2. Click the **⋮** (three-dot menu) in the top-right of DevTools
3. Go to **More tools** → **Sensors**
4. Override **Location** with custom latitude/longitude and change **Orientation** as needed

### 4. Deploy to Glasses

Your web app must be hosted at a **publicly available HTTPS URL**. The `ai-glasses-webapp-publish` skill deploys to [Vercel](https://vercel.com) production (it needs an authenticated Vercel CLI), but Vercel is just one option — you can use any hosting provider as long as the result is a publicly accessible HTTPS URL. Before release, ask the AI to run the `ai-glasses-webapp-optimize-performance` pass.

Once deployed, add the web app to your glasses:

**Option A — QR code (recommended):**

The `ai-glasses-webapp-publish` skill writes a `qr-publish.png` QR code after deploying. Scan it with your phone to deep link directly into the Meta AI app and add the web app to your glasses.

**Option B — Manual setup:**

1. Open the **Meta AI app** on your phone
2. Go to **Devices** → **Display Glasses settings**
3. Navigate to **App connections** → **Web apps**
4. Tap **Add a web app**
5. Enter the app name and your deployed URL

## Design Constraints

| Constraint | Reason |
|-----------|--------|
| 600×600 display, responsive layout | Fill the available viewport; never hardcode device dimensions |
| D-pad focus navigation, pinch/Enter to activate | No cursor or touchscreen; the EMG wristband drives focus and Select |
| UI Toolkit window background and components | Black is transparent on the additive display; the Toolkit handles contrast and focus states |
| Startup budget: under 300 KB first load, fewer than 15 requests | The glasses have a slow link (1 KB ≈ 16 ms) and a slower CPU |
| 30 Hz panel | 33 ms frame budget; no 60 fps loops |

## UI Toolkit for Meta Ray-Ban Display

Apps built with these skills use [UI Toolkit for Meta Ray-Ban Display](https://github.com/facebook/meta-ray-ban-display-ui-toolkit-web), a React library of components, materials, motion, semantic design tokens, accessibility behavior, and directional focus navigation designed to work together on the glasses. The toolkit lives in its own repository; follow the instructions there for install and setup.

## Skills Included

| Skill | Description |
|-------|-------------|
| `ai-glasses-webapp-build` | Create, redesign, or extend an app: screens, routes, state, APIs, persistence, and offline behavior, ending with a local preview URL |
| `ai-glasses-webapp-ui` | Scaffold new apps and install and use UI Toolkit for Meta Ray-Ban Display for all glasses UI |
| `ai-glasses-webapp-device` | Motion, orientation, compass, step detection, geolocation, pinch/drag, D-pad game controls, and handwriting/voice text input |
| `ai-glasses-webapp-test` | Deterministic quality gate: Toolkit checks, typecheck, build, viewport, focus, accessibility, performance smoke checks, and screenshots |
| `ai-glasses-webapp-optimize-performance` | Measure and speed up startup over the Chrome DevTools Protocol under a glasses network/CPU profile, no device required |
| `ai-glasses-webapp-publish` | Deploy to Vercel production, confirm public HTTPS access, and generate the add-to-glasses QR code |

## Game Skills (companion plugin)

Real-time games need a game loop, a renderer, input management, audio, and preloaded assets —
none of which the skills above provide. They live in a second plugin,
`meta-wearables-webapp-game`, which builds on this one and **requires it to be installed**.

Install both. Tools that read the Claude manifest resolve the dependency for you, but not every
tool does — install the base plugin explicitly and the game plugin works the same everywhere:

Muse Code:

```bash
muse plugins install meta-wearables-webapp@meta-wearables
muse plugins install meta-wearables-webapp-game@meta-wearables
```

Claude Code:

```bash
/plugin install meta-wearables-webapp@meta-wearables
/plugin install meta-wearables-webapp-game@meta-wearables
```

| Skill | Description |
|-------|-------------|
| `create-webapp-game` | Scaffold a 2D or 3D game project (Vite + TypeScript + Three.js + Vitest) |
| `webapp-game-director` | Critique and iterate a game against a quality rubric, milestone by milestone |
| `iterate-webapp-game` | Drive the running game in a real browser over CDP — screenshot, input, inspect state |
| `validate-webapp-game` | Check a game against the project rules (input, localization, layering, assets) |
| `update-webapp-game-framework` | Re-sync `src/framework/` in an existing game to the latest version |
| `add-webapp-game-logging` | Add a log sink and a passcode-gated `/logs` portal for on-glasses debugging |
| `read-webapp-game-docs` | Read the platform and framework documentation |

## Display Simulator Chrome Extension

The **Meta Ray-Ban Display Simulator** is a Chrome extension that recreates the 600×600 display surface of Meta Ray-Ban Display glasses in your browser — additive blending, environment backgrounds, D-pad input, display tuning, and recording — so you can preview and QA your web app without the hardware.

### Install

1. Install the [Meta Ray-Ban Display Simulator](https://chromewebstore.google.com/detail/jpjlmmodokemlepklkdbimceggpbjcll) from the Chrome Web Store.
2. Navigate to your web app and click the extension icon to toggle the simulator on.

### Features

- **600×600 display frame** — Exact glasses resolution with optional frame overlay and additive blending.
- **Environment backgrounds** — Built-in scenes, custom image upload, animated backgrounds, and live webcam for real-world blending preview.
- **D-pad input** — On-screen directional buttons and Select that dispatch keyboard events. Physical arrow keys and Enter work too.
- **Display settings** — App brightness, background brightness, background blur, and auto-dimming controls.
- **Viewport recorder** — Record the simulator viewport as a downloadable WebM video for demos or bug reports.
- **View on Glasses QR** — Generate a deep link QR code to add the web app on your glasses, or share it with others so they can add it too.
- **QA checklist** — Automated checks for viewport meta, favicon, D-pad focusable elements, horizontal overflow, and visible focus styles.

## Examples

See the `examples/` directory for sample apps:

- **Snake** — Classic snake game with D-pad controls and high scores

## Multi-Tool Support

Skills are authored once in `plugins/<plugin>/skills/` and distributed via:

- **Muse Code** — Plugin marketplace (recommended) or `AGENTS.md` via `install-skills.sh agents`
- **Claude Code** — Plugin marketplace (recommended) or `install-skills.sh claude`
- **Codex CLI** — Plugin marketplace (recommended) or `install-skills.sh agents`
- **Cursor** — Cursor plugin via `install-skills.sh cursor` (installs to `~/.cursor/plugins/local/`, single source of truth with Claude/Codex)
- **Gemini CLI / Windsurf / Devin** — `AGENTS.md` via `install-skills.sh agents`

## License

This project is licensed under the BSD License — see [LICENSE](LICENSE) for details.
