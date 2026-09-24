---
name: ai-glasses-webapp-ui
description: Install and use UI Toolkit for Meta Ray-Ban Display in React web apps. Use whenever creating or changing glasses UI, selecting toolkit components, scaffolding a new app, or migrating custom UI. The toolkit is required by default unless the user explicitly opts out.
argument-hint: "[app-directory] [new|existing]"
---

# Integrate UI Toolkit for Meta Ray-Ban Display

Use this skill with `ai-glasses-webapp-build`. The public Toolkit repository is
<https://github.com/facebook/meta-ray-ban-display-ui-toolkit-web/>. It contains
the current documentation, examples, and `llm-skills` guidance.

## Read the Toolkit guidance once

Before writing Toolkit UI, check whether the `wearables-ui-toolkit-web` skill is
already available to the current coding agent. Reuse it when present; do not
reinstall it for every app. If absent, use the official repository's Node
installer once at account scope. This plugin provides a temporary-checkout
wrapper for the currently supported clients:

```sh
node <this-skill>/scripts/install-ui-toolkit-skills.mjs \
  --client <claude-code|codex|muse-code> --account
```

The wrapper first checks the client's standard skill location, uses a temporary
GitHub checkout only when installation is needed, runs the repository's
`tools/install-skills.mjs`, and removes the checkout. Read
`wearables-ui-toolkit-web/SKILL.md` first, then only the production pattern or
direct references it selects. GitHub guidance governs components and layout;
the npm names and setup rules in this host skill override stale acquisition or
package-scope text in an older Toolkit skill installation.

After any Toolkit verifier succeeds, continue with the host sequence:
`ai-glasses-webapp-test`, the performance pass before release, and the local
preview required by `ai-glasses-webapp-build`. This is the integration exception
to Toolkit guidance that says to stop after its focused verifier.

## Install from npm

The application dependencies are:

```sh
npm install @wearables-ui-toolkit/mrbd
npm install @wearables-ui-toolkit/icons
```

For an empty destination run:

```sh
node <this-skill>/scripts/init-webapp.mjs <app-dir>
```

For an existing React application run:

```sh
node <this-skill>/scripts/install-ui-toolkit.mjs <app-dir>
```

Both commands are idempotent. They first check the app's manifest and installed
modules and skip npm when both packages are already usable. Otherwise they
check the global npm installation and attempt the one-time shared install:

```sh
npm install --global @wearables-ui-toolkit/mrbd
npm install --global @wearables-ui-toolkit/icons
```

Every app still records both registry packages in its own `package.json` and
lockfile, and materializes local `node_modules`, because Node, Vite, CI, and
Vercel do not resolve global packages as application dependencies. npm's shared
cache reuses downloaded content across apps. Never add a fixed checkout path,
`file:` dependency, source alias, or silent local-source fallback. Registry or
repository access failures are blocking setup errors.

Only an explicit user opt-out permits `--no-ui-toolkit` during initialization.
Import components from `@wearables-ui-toolkit/mrbd` and filled icon assets from
public `@wearables-ui-toolkit/icons` exports. Never use the legacy
`@meta/wearables-ui-toolkit-*` scope or import package implementation source.

## Validate

For an early structure-only check, run:

```sh
node <this-skill>/scripts/validate-ui-toolkit.mjs <app-dir>
```

The wrapper runs the licensed validator bundled with this plugin, so validation
does not depend on a machine-specific checkout or mutable network clone. Fix
every finding. Before handoff, run `ai-glasses-webapp-test`; its complete gate
invokes the same validation again.
