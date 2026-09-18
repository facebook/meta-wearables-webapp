# Troubleshooting a scaffolded game

| Issue | Solution |
|-------|----------|
| `npm install` hangs with no output | The tool sandbox has no network. Kill it and use `npm ci --offline` — the template ships `package-lock.json`, and a warm `~/.npm/_cacache` installs in seconds. `init-game.mjs` already does this. If offline install also fails, ask the user to run `npm install` in their own terminal. |
| `tsc` can't find `three` types | Ensure `npm install` completed; `@types/three` is a devDep |
| `@/...` import not resolved | Check `paths` in `tsconfig.json` and the alias in `vite.config.ts` |
| Tests not found | Vitest `include` is `src/**/*.test.ts` (in `vite.config.ts`) |
| Black screen on device | Page background must be `#000000`; bounded surfaces (cards, panels, modals) dark gray, not black. The always-on HUD stays unfilled — text over the black page |
| A mouse click does nothing | Expected — a tap-only game wires no pointer listeners, and the glasses have no cursor. Press **Enter** (the index pinch). Do NOT add `pointerDrag` to make clicks work; it changes what the device delivers, and `npm run validate` fails it. |
| Drag does nothing | First: did this game opt in? All three of `touch-action: none`, `{ pointerDrag: true }`, and consuming the delta are required — see `docs/drag-channel.md`. Then confirm the input is `attach()`-ed. |
| Index tap does nothing | It maps to pinchTap (from Enter, or a zero-travel pointer in drag mode). Check the on('pinchTap', ...) binding. |
| Trying to detect a D-pad center / "thumb" tap | Not supported — the device emits key="Unidentified" for both swipes and side taps, so it's ambiguous and ignored. Use pinchTap (index tap) for a discrete select. |
| Build has no `dist/` | `build` runs `tsc --noEmit && vite build`; fix type errors first |
| 3D model renders flat white / console `Couldn't load texture Textures/...` | The GLB/GLTF references an **external** texture; copy the referenced image folder into `public/` next to the model, preserving the relative path (e.g. `public/models/Textures/colormap.png`). See `docs/asset-loading.md` → "Ship external textures too". |
| 3D model appears but never moves/animates when transformed | It's a **rigged/skinned** model cloned with `Object3D.clone()`, which leaves it bound to the source skeleton. Clone with `cloneModel` (SkeletonUtils) from `AssetLoader`. See `docs/asset-loading.md` → "Rigged & animated models". |
| Loaded 3D model renders solid black | Its lit material (`MeshStandardMaterial`) needs a light, but the scene has none. Convert materials to unlit `MeshBasicMaterial` (keeping `map`) or add a light. See `docs/asset-loading.md` → "Lighting & unlit materials". |
| Every route 404s on Vercel (`<h1>404 Not Found</h1>`, no `x-vercel-error` header) | A `server.js`/`package.json` `start` script is being run. Delete them, deploy from the project root, and redeploy with `vercel --prod --force`. Diagnose with `curl -sS -i <url> \| head` |
