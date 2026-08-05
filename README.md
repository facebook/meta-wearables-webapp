# Meta Wearables Web App AI Toolkit

An AI toolkit that helps you build Web Apps for Meta Ray-Ban Display glasses. It contains plugins for Claude Code, Codex, Cursor, and GitHub Copilot.

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

#### Option A — Plugin Marketplace (recommended for Claude Code and Codex)

**Claude Code:**

```bash
# Add the marketplace (one-time)
/plugin marketplace add https://github.com/facebookincubator/meta-wearables-webapp

# Install the plugin
/plugin install meta-wearables-webapp@meta-wearables

# Update plugin
/plugin marketplace update meta-wearables && /plugin update meta-wearables-webapp@meta-wearables
```

**Codex CLI:**

```bash
# Add the marketplace (one-time, run in your terminal)
codex plugin marketplace add https://github.com/facebookincubator/meta-wearables-webapp
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
git clone https://github.com/facebookincubator/meta-wearables-webapp.git
cd meta-wearables-webapp
./install-skills.sh claude    # Claude Code
./install-skills.sh cursor    # Cursor
./install-skills.sh copilot   # GitHub Copilot
./install-skills.sh all       # All tools + AGENTS.md

# Or remote install (no clone needed)
curl -sL https://raw.githubusercontent.com/facebookincubator/meta-wearables-webapp/main/install-skills.sh | bash
```

### 2. Build a Web App

Open your project in an AI-assisted editor and describe what you want:

> "Create a weather app that shows the 5-day forecast with D-pad navigation"

The AI will scaffold `index.html`, `styles.css`, and `app.js` following the display glasses design system.

### 3. Test in Browser

Start your web app locally however your project requires (e.g., open `index.html` directly, run a dev server, `npm run dev`, etc.) and open it in your desktop browser. Use arrow keys to simulate D-pad input.

To test sensor data like geolocation or IMU sensors:

1. Open **Chrome DevTools** (F12)
2. Click the **⋮** (three-dot menu) in the top-right of DevTools
3. Go to **More tools** → **Sensors**
4. Override **Location** with custom latitude/longitude and change **Orientation** as needed

### 4. Deploy to Glasses

Your web app must be hosted at a **publicly available HTTPS URL**. This plugin supports deploying to [Vercel](https://vercel.com), but Vercel is just one option — you can use any hosting provider as long as the result is a publicly accessible HTTPS URL.

Once deployed, add the web app to your glasses:

**Option A — QR code (recommended):**

Use the plugin's publish skill to generate a QR code. Scan it with your phone to deep link directly into the Meta AI app and add the web app to your glasses.

**Option B — Manual setup:**

1. Open the **Meta AI app** on your phone
2. Go to **Devices** → **Display Glasses settings**
3. Navigate to **App connections** → **Web apps**
4. Tap **Add a web app**
5. Enter the app name and your deployed URL

## Design Constraints

| Constraint | Reason |
|-----------|--------|
| 600x600px viewport | Display size |
| D-pad navigation only | EMG wristband translates gestures to arrow keys |
| Dark backgrounds | Black is transparent on the additive display |
| High contrast elements | Readability on a small transparent display |
| `.focusable` class on interactive elements | D-pad focus management |

## Skills Included

| Skill | Description |
|-------|-------------|
| `create-webapp` | Scaffold a new web app from scratch |
| `add-ui` | Add or refine display-friendly UI |
| `connect-api` | Connect to REST/WebSocket APIs |
| `add-device-sensors` | Accelerometer, gyroscope, compass, GPS, and geolocation |
| `add-local-storage` | Add persistent browser storage |
| `test-on-device` | Test and debug on desktop and glasses |
| `publish-to-vercel` | Deploy to a public HTTPS URL |
| `qr-code` | Generate add-to-glasses QR codes |
| `passcode-for-testing` | Add a lightweight test passcode gate |

## Display Simulator Chrome Extension

The **Meta Ray-Ban Display Web App Simulator** is a Chrome extension that recreates the 600×600 display surface of Meta Ray-Ban Display glasses in your browser — additive blending, environment backgrounds, D-pad input, display tuning, and recording — so you can preview and QA your web app without the hardware.

### Install

1. Install the [Meta Ray-Ban Display Web App Simulator](https://chromewebstore.google.com/detail/jpjlmmodokemlepklkdbimceggpbjcll) from the Chrome Web Store.
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

Skills are authored once in `plugins/meta-wearables-webapp/skills/` and distributed via:

- **Claude Code** — Plugin marketplace (recommended) or `install-skills.sh claude`
- **Codex CLI** — Plugin marketplace (recommended) or `install-skills.sh agents`
- **Cursor** — Cursor plugin via `install-skills.sh cursor` (installs to `~/.cursor/plugins/local/`, single source of truth with Claude/Codex)
- **GitHub Copilot** — `.github/copilot-instructions.md` via `install-skills.sh copilot`
- **Gemini CLI / Windsurf / Devin** — `AGENTS.md` via `install-skills.sh agents`

## License

This project is licensed under the BSD License — see [LICENSE](LICENSE) for details.
