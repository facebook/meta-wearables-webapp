---
name: add-offline
description: >-
  Make a Meta Display Glasses webapp work offline with a Service Worker +
  Cache API (precache the app shell, cache-first fetch, online/offline UI).
  Use when the user wants offline support or resilience to flaky Wi-Fi.
argument-hint: "[strategy: app-shell|cache-first]"
---

## Required reading

Before generating or modifying any code, read both:

- `../../references/display-guidelines.md`
- `../../references/performance-guidelines.md`

These define the non-negotiable display physics, input model, and performance budgets for Meta Display Glasses webapps. Do not skip — generated UI that ignores these will fail on-device.

If these reference files are unavailable in an isolated eval, do not search `/`, home directories, or unrelated workspaces. Apply the requirements already present in this skill and continue.

# Add Offline Support to Meta Display Glasses WebApp

Make a webapp keep working when the glasses lose Wi-Fi, using a standard **Service Worker** + **Cache API**. Precache the app shell on install, serve cache-first on fetch, clean old caches on activate, and reflect online/offline state in the UI. No SDK required.

The base offline Service Worker snippet already lives in `../../references/performance-guidelines.md` — reuse it as your starting point.

## Prerequisites

- Existing webapp created via `/create-webapp`
- **Served over HTTPS** — Service Workers and the Cache API only run in a secure context. `file://` will **not** work. Use `/publish-to-vercel` for an HTTPS URL.

## How It Works

1. The app shell registers `sw.js`.
2. On `install`, the worker precaches `index.html`, `app.js`, `styles.css`, and any other shell assets.
3. On `fetch`, the worker serves cache-first (cached response, falling back to network).
4. On `activate`, it deletes stale caches when you bump the cache version.
5. The page reflects `navigator.onLine` and the `online` / `offline` events in the UI.

## ⚠️ Caveats (must-include)

- **HTTPS-only** (secure context). No exceptions.
- **Precache real subresource URLs.** List the actual files the page loads — don't assume the app's request interceptor will serve Service-Worker-originated fetches.
- Decide **what should be available offline.** Anything that needs fresh data from the internet won't work offline — show a friendly "offline" message in that case rather than failing silently.
- Storage is **per-app.** Pair this with `/add-local-storage` so the wearer's settings/notes persist between sessions, not just the app shell.
- Bump `CACHE` version when shell assets change, or wearers get stale files.

## Steps

### 1. Register the Service Worker

In `app.js` (or an inline `<script>` in the shell):

```javascript
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function (e) {
      console.warn('SW registration failed', e);   // app still works online
    });
  });
}
```

### 2. Create `sw.js` at the App Root

```javascript
const CACHE = 'app-v1';
const FILES = ['/', '/index.html', '/app.js', '/styles.css', '/favicon.png'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(FILES); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.filter(function (k) { return k !== CACHE; })
                            .map(function (k) { return caches.delete(k); }));
    })
  );
});

self.addEventListener('fetch', function (e) {
  e.respondWith(
    caches.match(e.request).then(function (cached) {
      return cached || fetch(e.request);
    })
  );
});
```

### 3. Reflect Online / Offline in the UI

Show or hide an offline indicator (e.g. `#offline-banner`) from `navigator.onLine` — build the indicator itself with `/add-ui`.

```javascript
function updateOnlineUI() {
  var offline = !navigator.onLine;
  // Show/hide your offline indicator based on `offline` — see /add-ui
}
window.addEventListener('online', updateOnlineUI);
window.addEventListener('offline', updateOnlineUI);
updateOnlineUI();
```

### 4. Handle Data That Needs the Network

For screens that require fresh data, detect offline and show a message instead of a broken state:

```javascript
if (!navigator.onLine) {
  showToast('No connection — showing last saved data', 'error');
  renderFromCache();   // e.g. /add-local-storage
  return;
}
```

## Verify

- [ ] App is served over HTTPS
- [ ] `navigator.serviceWorker.register` resolves (check DevTools / console)
- [ ] App shell (`index.html`, `app.js`, `styles.css`) is precached on install
- [ ] Reloading offline still renders the app shell
- [ ] Old caches are cleaned when `CACHE` version bumps (activate handler)
- [ ] Offline banner / message appears when connection drops
- [ ] Network-dependent screens degrade gracefully offline

## Related Skills

- `/add-local-storage` — Persist the wearer's data so it survives offline sessions
- `/connect-api` — Add cache-aware fallbacks around API calls
- `/add-ui` — Add the offline indicator
