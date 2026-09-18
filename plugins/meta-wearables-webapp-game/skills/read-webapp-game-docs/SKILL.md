---
name: read-webapp-game-docs
description: >-
  Discover documentation about building games on the Meta Display Glasses platform — platform
  capabilities (600x600 additive display, CPU/GPU/memory budgets, EMG/D-pad input model and
  latency, refresh rate) and the meta-wearables-webapp-game framework code (renderer/input-agnostic
  architecture, project structure/tooling, Three.js-vs-DOM rendering split, 2D/3D asset loading,
  audio, localization, and logging/debugging on a device with no console).
  Invoke this when the user
  explicitly asks for it, when the create-webapp-game skill runs (it reads these
  docs before scaffolding), or when a project's CLAUDE.md or similar directive instructs the
  agent to consult the Meta Display Glasses platform / meta-wearables-webapp-game framework docs before
  planning or writing code. Do not auto-trigger merely because a project looks like a
  Meta Display Glasses app — a create-webapp-game project opts in via its own CLAUDE.md.
allowed-tools: Read, Glob
---

# Read the webapp game docs

This plugin bundles the reference documentation for building games on Meta Display Glasses —
both the platform's fixed constraints and the conventions of the game framework scaffolded by
`create-webapp-game`.

## When this runs

This skill is invoked manually by the user, or by an AI agent when it is instructed to —
either directly by the user, by a `CLAUDE.md` or similar directive in the project being worked
on, or as a step within the `create-webapp-game` skill. It does not fire
automatically just because the current project is a Meta Display Glasses app.

## How to use it

1. **Read the index first:** `${CLAUDE_PLUGIN_ROOT}/docs/README.md`. It lists every doc,
   grouped into **Platform knowledge** and **Framework knowledge**, with a one-line summary of
   each.
2. **Open only what's relevant.** From the index, follow the links to the specific docs that
   answer the question at hand — this is progressive disclosure, so don't read everything up
   front. All docs live in `${CLAUDE_PLUGIN_ROOT}/docs/`.
3. **Traverse further as needed.** The docs cross-reference each other and the plugin's skills;
   follow those pointers when a question spans more than one doc.

## What's covered

- **Platform:** resolution and additive-display physics, color/contrast and layout, the
  EMG/D-pad input model, performance budgets (frame rate, memory, bundle size, network).
- **Framework:** project structure and tooling, the renderer- and input-agnostic architecture,
  the Three.js-vs-DOM rendering split, asset loading (2D textures + 3D models, and the
  2D-orthographic vs 3D-perspective camera), audio, localization, testing, the URL flags, and
  logging (including how to read logs off a device that has no console).

Answer the user's question from these docs; quote and cite the specific file you drew from.
