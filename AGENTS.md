# Meta Wearables Web Apps

> Developer docs: https://wearables.developer.meta.com/docs/develop/webapps
> Web Apps docs MCP: https://mcp.developer.meta.com/wearables
> MCP tool: search_webapps_docs
> Auth: no auth, OAuth, tokens, or custom authorization headers are required.

If your AI tool supports MCP, configure `https://mcp.developer.meta.com/wearables` as a remote HTTP MCP server and call `search_webapps_docs` for current Web Apps documentation. If MCP is unavailable, use the developer docs URL above directly.

## Design & Performance Constraints

All webapps target the Meta Display Glasses — a 600x600dp additive waveguide display with no touchscreen.

### Display
- **Viewport:** `<meta name="viewport" content="width=600, height=600, initial-scale=1.0">`
- **Description:** `<meta name="description" content="...">` in the `<head>` with a brief, app-specific summary of what the app does.
- **MRBD identification:** `<meta name="mrbd-web-app-capable" content="yes">` in the `<head>` to positively identify the page as a Meta Display Glasses (MRBD) compatible webapp (keep `content="yes"` verbatim).
- **Additive display:** Black (#000000) is transparent. Use dark gray (#1C1E21) as background, white (#FFFFFF) for text/icons.
- **Safe zone:** 8dp margin all sides (584x584dp usable). Header: 24dp from top, 64dp tall. Button height: 88dp.
- **Typography:** H1 28dp bold, H2 22dp bold, Body 16dp, Body2 14dp, Meta 12dp. Min 14dp for interactive elements.
- **Colors:** #FFFFFF primary, #E4E6EB secondary, #B0B3B8 muted, #1C1E21 background. 4.5:1 contrast ratio minimum.

### Input
- **D-pad (captouch):** Arrow keys navigate focus between elements. Enter selects. Escape goes back.
- **No cursor, no touch:** Focus-based navigation only. All elements must be reachable via sequential D-pad navigation.
- **Interaction states:** Idle (scale 1x, 80% opacity) → Focused (scale -8dp, 100% opacity) → Pressed.
- Keep navigation shallow — 3 steps or fewer to any action.

### Performance
- **Targets:** <3s load, <500KB JS gzipped, 60fps, <128MB memory, <10 network requests.
- **Code:** Vanilla JS or lightweight frameworks. No continuous intervals when idle. CSS transitions over JS animations.
- **Assets:** Unicode/inline PNGs for icons. No external fonts. Inline assets <2KB as data URIs.
- **Offline:** Cache with Service Worker. Show UI immediately. Handle fetch failures gracefully.

## Creating a new webapp


Create complete webapps for Meta Display Glasses with EMG wrist-band input, D-pad navigation — including sensor integration and real API connections.

## Input Model

- **D-pad (Up/Down/Left/Right)**: Navigate focusable elements (EMG band or captouch)
- **Enter / Tap**: Select/activate focused element (EMG tap gesture)
- **Back / Escape**: Navigate to previous screen
- **Sensors**: Accelerometer, gyroscope, magnetometer, orientation via W3C Generic Sensor API

No touch input is available. The EMG wrist band translates gestures into D-pad events automatically.

## Related Skills

| Skill | Purpose | When to Use |
|-------|---------|-------------|
| `/add-ui` | Add screens, buttons, UI components | Expanding the app |
| `/connect-api` | Add API connection | Connect to REST/WebSocket APIs |
| `/add-device-sensors` | Add sensor data | Motion/orientation/GPS features |
| `/add-local-storage` | Add data persistence | Save settings, cache, state |

## What Gets Generated

```
<app-name>/
  index.html    # HTML structure with screens
  styles.css    # Dark theme with focus states, loading states, components
  app.js        # Logic, navigation, D-pad, APIs, SDK integration
```

## Workflow

### Device Testing Trigger

If the user says they want to "test on device", "test on the glasses", "open this on the glasses", or anything equivalent, treat that as a request to use the `/test-on-device` skill and the hosted HTTPS preview flow.

Do **not** satisfy an on-device testing request by creating only a local server (`python3 -m http.server`, `localhost`, LAN IP, etc.). A local server is fine for desktop smoke testing, but it is **not** the default path for Meta Display Glasses testing in this repo.

### Step 1: Understand the Request

If the user specified a webapp type, proceed to Step 2.

If not specified, ask what they want to build. Suggest from categories in [references/app-ideas.md](references/app-ideas.md).

### Step 2: Determine Output Location

Ask where to create the webapp, or use defaults:
- `~/meta-display-glasses-webapps/<app-name>/` for new webapps
- Current directory if already in a webapp workspace

```bash
mkdir -p ~/meta-display-glasses-webapps/<app-name>
```

### Step 3: Generate Files

Generate three files using these templates as the foundation:

1. **index.html** — Read [templates/index.html](templates/index.html) for the base HTML structure
2. **styles.css** — Read [templates/styles.css](templates/styles.css) for the complete CSS
3. **app.js** — Read [templates/app.js](templates/app.js) for the complete JS architecture

Key requirements for the HTML:
- Viewport: `width=600, height=600`
- Description: `<meta name="description" content="...">` in the `<head>` with a brief, app-specific summary of what the app does. Replace the template placeholder with real copy.
- MRBD identification: `<meta name="mrbd-web-app-capable" content="yes">` in the `<head>` to positively identify the page as a Meta Display Glasses (MRBD) compatible webapp. Keep `content="yes"` verbatim.
- All interactive elements: `class="focusable"` and `tabindex="0"` if not a button
- Button actions: `data-action="action-name"`
- Back buttons: `data-action="back"` with `&#8592;` arrow character
- Each screen is a `<div class="screen">` with a unique `id`

Customize these sections in `app.js` for each app:
- `CONFIG` — API URLs, storage key, SDK options
- `state.data` — App-specific data shape
- `handleAppAction()` — App-specific action dispatch
- `onScreenEnter()` — Screen-specific data loading/rendering

Add app-specific styles to `styles.css` as needed, building on the template foundations.

### Step 4: For API-Connected Apps

See [references/api-catalog.md](references/api-catalog.md) for free public APIs and integration patterns.

### Step 5: For Sensor Apps

Use `/add-device-sensors` to add motion, orientation, or GPS data to the webapp.

### Step 6: For UI Components

See [references/ui-components.md](references/ui-components.md) for reusable HTML component patterns (cards, lists, tabs, loading states).

### Step 7: Verify

- [ ] All screens have `.screen` class and unique `id`
- [ ] All interactive elements have `.focusable` class
- [ ] Buttons have `data-action` attributes
- [ ] Back buttons use `data-action="back"`
- [ ] Viewport is `width=600, height=600`
- [ ] `<head>` has a `<meta name="description">` tag with an app-specific summary (placeholder replaced)
- [ ] `<head>` has `<meta name="mrbd-web-app-capable" content="yes">`
- [ ] D-pad navigation works (arrow keys move focus with wrap-around)
- [ ] Enter key activates focused elements
- [ ] Escape key navigates back
- [ ] Focus ring is visible (cyan glow) on selected elements
- [ ] Loading states shown during API calls
- [ ] Error states handle API failures gracefully
- [ ] Demo mode works when sensors are unavailable
- [ ] Data persists via localStorage
- [ ] All text is readable on dark background
- [ ] Content fits within 600x600 viewport
- [ ] Scrollable lists use `overflow-y: auto` with `max-height`
- [ ] Focused elements scroll into view automatically

### Step 8: Guide Next Steps

```
Created: ~/meta-display-glasses-webapps/<app-name>/
  index.html  (screens, structure)
  styles.css  (dark theme, focus states, loading/error states)
  app.js      (D-pad nav, API calls, SDK integration)

Expand with:
  /add-ui               Add screens, buttons, UI components
  /connect-api          Connect to more APIs
  /add-device-sensors   Add motion/orientation/GPS sensors
  /add-local-storage    Add data persistence

Test locally by opening index.html in a browser and using arrow keys + Enter.
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Webapp doesn't load on device | Check browser console for JS errors |
| Focus ring not visible | Verify `.focusable` class on interactive elements |
| D-pad not navigating | Check `moveFocus()` handles the current screen |
| Enter not activating | Verify `data-action` attribute on element |
| Back button not working | Check `data-action="back"` or Escape handler |
| API calls failing | Check CORS headers, use proxy if needed |
| API data not updating | Clear cache: `state.cache = {}` |
| Sensor data not flowing | Check sensor types are valid, verify device support |
| Data not persisting | Verify `saveData()` called after state changes |
| Screen not showing | Check `hidden` class and `navigateTo()` call |
| Demo mode not working | Verify fallback code in sensor helpers |

Use browser developer tools to view console.log output for debugging.

## Adding UI components


Add screens, buttons, lists, forms, and other interactive components to an existing webapp. This skill enforces the glasses design constraints and provides implementation patterns.

## Prerequisites

- Existing webapp created via `/create-webapp`

## Design Rules

All components must follow these constraints regardless of framework:

### Viewport & Layout
- **600x600** fixed viewport — all content must fit within this area
- Dark theme background (`#0a0a0a`), light text (`#e8e8e8`)
- Use CSS variables from the theme: `--bg-primary`, `--bg-secondary`, `--bg-card`, `--text-primary`, `--text-secondary`, `--accent-primary`, `--danger`, `--success`

### D-pad Navigation
- All interactive elements must be **focusable** — keyboard-navigable via arrow keys
- Enter key activates the focused element
- Escape key navigates back
- Focus moves with **wrap-around** (last → first, first → last)
- Focused elements must scroll into view automatically
- Focus ring: cyan glow (`box-shadow: 0 0 20px rgba(0, 212, 255, 0.4)`)

### Accessibility
- Non-button interactive elements need `tabindex="0"`
- Scrollable containers use `overflow-y: auto` with constrained `max-height`
- Text must be readable on dark background (minimum contrast)

## Available Components

| Component | Purpose | When to Use |
|-----------|---------|-------------|
| Screen | Full-page view with header + content | Adding a new page/destination |
| Button | Triggers an action | Any interactive action |
| Nav Bar | Row of action buttons at bottom | Screen-level actions |
| List | Scrollable list of items | Displaying collections |
| Card | Data display block | Showing stats, values |
| Form | Input fields with submit | Collecting user input |
| Toggle | On/off setting | Boolean settings |
| Counter | +/- with value display | Numeric adjustments |

## Steps

### 1. Gather Information

Ask the user:
- **What component?** Screen, button, list, card, form, toggle, counter?
- **Where?** Which screen should it be added to (or is it a new screen)?
- **Behavior?** What happens on activation/interaction?

### 2. Add the Component

Use [Vanilla JS patterns](references/vanilla-patterns.md) for HTML structure, event handling, and state management. Always apply the design rules above.

### 3. Verify

- [ ] Component is focusable (D-pad navigable)
- [ ] Focus ring appears on the component (cyan glow)
- [ ] Enter key activates the component
- [ ] Escape key navigates back (if applicable)
- [ ] Content fits within 600x600 viewport
- [ ] Text is readable on dark background
- [ ] Scrollable content uses `overflow-y: auto` with `max-height`
- [ ] Focused elements scroll into view

## Related Skills

- `/create-webapp` — Create a new webapp from scratch
- `/connect-api` — Add API-connected actions
- `/add-device-sensors` — Add motion/orientation/GPS sensors

## Adding API connections


Add real API connections to an existing webapp. The base `app.js` template already includes `apiGet()`, `setLoading()`, `setError()`, `showToast()`, and `connectWebSocket()` helpers — this skill shows how to wire them up.

## Prerequisites

- Existing webapp created via `/create-webapp` (which includes the API/UI helpers in `app.js`)

## Steps

### 1. Gather Information

Ask the user:
- **What data?** What information should the app display?
- **Which API?** Specific API, or should we pick one?
- **Refresh behavior?** Manual, auto-refresh interval, or real-time WebSocket?
- **Offline fallback?** Should cached data be served when offline?

### 2. Choose an API

If not specified, recommend from these **free, no-key-required** APIs:

| Category | API | Base URL |
|----------|-----|----------|
| Weather | Open-Meteo | `api.open-meteo.com/v1/forecast` |
| Trivia | Open Trivia DB | `opentdb.com/api.php` |
| Crypto | CoinGecko | `api.coingecko.com/api/v3` |
| Earthquakes | USGS | `earthquake.usgs.gov/earthquakes/feed/v1.0` |
| Wikipedia | Wikipedia REST | `en.wikipedia.org/api/rest_v1` |
| Recipes | TheMealDB | `themealdb.com/api/json/v1/1` |
| Countries | REST Countries | `restcountries.com/v3.1` |
| Jokes | Official Joke API | `official-joke-api.appspot.com` |
| Pokemon | PokeAPI | `pokeapi.co/api/v2` |
| IP Location | ipapi | `ipapi.co/json/` |

### 3. Add Loading and Error UI

Add these elements inside the relevant screen in `index.html` (the CSS is already in `styles.css` from `/create-webapp`):

```html
<div id="loading" class="loading-container hidden">
  <div class="loading-spinner"></div>
  <div class="loading-text">Loading...</div>
</div>

<div id="error" class="error-container hidden">
  <div class="error-icon">&#9888;</div>
  <div class="error-message">Something went wrong</div>
  <button class="nav-item focusable" data-action="refresh">Try Again</button>
</div>
```

Add a refresh button to the nav bar:

```html
<button class="nav-item focusable" data-action="refresh">&#8635; Refresh</button>
```

### 4. Update API Configuration

In `app.js`, update the `CONFIG` object:

```javascript
api: {
  baseUrl: 'https://api.example.com',
  cacheDuration: 5 * 60 * 1000,
},
```

### 5. Add Data Fetching

Use the existing `apiGet()` helper in `onScreenEnter()`:

```javascript
function onScreenEnter(screenId) {
  switch (screenId) {
    case 'home':
      loadData();
      break;
  }
}

function loadData() {
  apiGet(CONFIG.api.baseUrl + '/endpoint', { cacheKey: 'my-data' })
    .then(function(data) {
      renderData(data);
    })
    .catch(function() {
      // Error already shown by apiGet
    });
}
```

### 6. Add Refresh Action

In `handleAppAction()`:

```javascript
case 'refresh':
  state.cache = {};
  onScreenEnter(state.currentScreen);
  break;
```

### 7. For WebSocket Connections

Use the existing `connectWebSocket()` helper:

```javascript
var ws = connectWebSocket('wss://stream.example.com/data', {
  onOpen: function() { showToast('Connected', 'success'); },
  onMessage: function(data) { updateDisplay(data); },
  onClose: function() { showToast('Reconnecting...', 'warning'); },
  onError: function() { showToast('Connection error', 'error'); },
});
```

### 8. Add Auto-Refresh (Optional)

For periodic updates:

```javascript
var refreshInterval = null;

function startAutoRefresh(intervalMs) {
  stopAutoRefresh();
  refreshInterval = setInterval(function() {
    onScreenEnter(state.currentScreen);
  }, intervalMs || 60000);
}

function stopAutoRefresh() {
  if (refreshInterval) {
    clearInterval(refreshInterval);
    refreshInterval = null;
  }
}
```

Start in `init()`: `startAutoRefresh(60000);`

## Complete Examples

### Weather API

```javascript
function loadWeather() {
  var url = 'https://api.open-meteo.com/v1/forecast' +
    '?latitude=40.71&longitude=-74.01' +
    '&current_weather=true' +
    '&daily=temperature_2m_max,temperature_2m_min,weathercode' +
    '&timezone=auto&forecast_days=5';

  apiGet(url, { cacheKey: 'weather' })
    .then(function(data) {
      var w = data.current_weather;
      document.getElementById('temp').textContent = Math.round(w.temperature) + '\u00B0';
      document.getElementById('condition').textContent = getWeatherLabel(w.weathercode);
      document.getElementById('wind').textContent = w.windspeed + ' km/h';
      renderForecast(data.daily);
    });
}
```

### Crypto Price Tracker

```javascript
function loadPrices() {
  var url = 'https://api.coingecko.com/api/v3/simple/price' +
    '?ids=bitcoin,ethereum,solana' +
    '&vs_currencies=usd&include_24hr_change=true';

  apiGet(url, { cacheKey: 'crypto', cacheDuration: 30000 })
    .then(function(data) {
      Object.keys(data).forEach(function(coin) {
        var price = data[coin].usd;
        var change = data[coin].usd_24h_change;
        document.getElementById(coin + '-price').textContent = '$' + price.toLocaleString();
        var changeEl = document.getElementById(coin + '-change');
        changeEl.textContent = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
        changeEl.className = 'badge ' + (change >= 0 ? 'badge-success' : 'badge-danger');
      });
    });
}
```

## Verify

- [ ] Loading spinner appears during API calls
- [ ] Error state appears on network failure
- [ ] Cached data is served on repeated loads
- [ ] Refresh button clears cache and fetches fresh data
- [ ] All API-rendered elements have `.focusable` class for D-pad navigation

## Related Skills

- `/add-ui` — Add screens, buttons, and components for API data

## Adding sensor data


Add IMU and GPS sensor integration to an existing webapp using standard Web APIs. No SDK required.

The glasses expose sensor data through two API families:
- **DeviceMotionEvent / DeviceOrientationEvent** — IMU data (accelerometer, gyroscope, compass heading, tilt)
- **navigator.geolocation** — GPS location from the paired companion phone

## Prerequisites

- Existing webapp created via `/create-webapp`

## Available Sensors

### Motion & Orientation (IMU)

The glasses IMU provides high-frequency updates with low latency via two event-based APIs:

**DeviceOrientationEvent** — fires continuously as the glasses rotate:

| Property | Type | Range | Description |
|----------|------|-------|-------------|
| `alpha` | number | 0–360° | Rotation around Z axis (compass heading). 0 = North. |
| `beta` | number | −180° to 180° | Rotation around X axis (front-to-back tilt). |
| `gamma` | number | −90° to 90° | Rotation around Y axis (left-to-right tilt). |
| `absolute` | boolean | — | true if orientation is relative to the Earth's coordinate frame. |

**DeviceMotionEvent** — fires at a regular interval with accelerometer and gyroscope data:

| Property | Unit | Description |
|----------|------|-------------|
| `accelerationIncludingGravity.x/y/z` | m/s² | Linear acceleration including gravitational force. |
| `acceleration.x/y/z` | m/s² | Linear acceleration with gravity removed (may be null). |
| `rotationRate.alpha/beta/gamma` | deg/s | Gyroscope rotation rate around each axis. |
| `interval` | ms | Time interval between events. |

### Geolocation (GPS)

Location is fetched from the paired companion phone — the glasses have no GPS hardware. Permission is granted automatically by the glasses host app.

| Property | Type | Description |
|----------|------|-------------|
| `latitude` | number | Latitude in decimal degrees. |
| `longitude` | number | Longitude in decimal degrees. |
| `accuracy` | number | Accuracy of lat/lon in metres. |
| `altitude` | number \| null | Altitude in metres above sea level. |
| `altitudeAccuracy` | number \| null | Accuracy of altitude in metres. |
| `speed` | number \| null | Speed in m/s. |
| `heading` | number \| null | Direction of travel in degrees from North. |

Accuracy depends on the companion phone's GPS and network fix. Expect 5–50 m typical accuracy. The first call may take several seconds while the phone acquires a fix.

## Steps

### 1. Gather Information

Ask the user:
- **Which sensors?** Motion (accelerometer/gyroscope), orientation (compass/tilt), geolocation (GPS)?
- **What for?** Compass, level tool, step counter, head tracking, spatial AR, location display?
- **Continuous or one-shot?** (for geolocation: `watchPosition` vs `getCurrentPosition`)

### 2. Add Sensor Display UI

Add to the appropriate screen in `index.html`:

```html
<div class="sensor-panel">
  <div class="data-grid">
    <div class="card">
      <div class="card-subtitle">X-Axis</div>
      <div class="card-value" id="sensor-x">0.00</div>
    </div>
    <div class="card">
      <div class="card-subtitle">Y-Axis</div>
      <div class="card-value" id="sensor-y">0.00</div>
    </div>
    <div class="card">
      <div class="card-subtitle">Z-Axis</div>
      <div class="card-value" id="sensor-z">0.00</div>
    </div>
    <div class="card">
      <div class="card-subtitle">Magnitude</div>
      <div class="card-value" id="sensor-mag">0.00</div>
    </div>
  </div>
</div>

<nav class="nav-bar">
  <button class="nav-item focusable primary" data-action="start-sensors">Start</button>
  <button class="nav-item focusable danger" data-action="stop-sensors">Stop</button>
</nav>
```

### 3. Add Motion & Orientation Listeners

In `app.js`, add listener management and action handlers:

```javascript
var motionListening = false;
var orientationListening = false;

function onDeviceMotion(e) {
  // Accelerometer (includes gravity), in m/s²
  var ax = e.accelerationIncludingGravity.x;
  var ay = e.accelerationIncludingGravity.y;
  var az = e.accelerationIncludingGravity.z;

  // Gyroscope rotation rate, in deg/s
  var rotAlpha = e.rotationRate.alpha;
  var rotBeta  = e.rotationRate.beta;
  var rotGamma = e.rotationRate.gamma;

  // Update UI
  document.getElementById('sensor-x').textContent = ax.toFixed(2);
  document.getElementById('sensor-y').textContent = ay.toFixed(2);
  document.getElementById('sensor-z').textContent = az.toFixed(2);
  var mag = Math.sqrt(ax * ax + ay * ay + az * az);
  document.getElementById('sensor-mag').textContent = mag.toFixed(2);
}

function onDeviceOrientation(e) {
  var heading = e.alpha;   // Compass heading 0–360° (0 = North)
  var tilt    = e.beta;    // Front-back tilt −180° to 180°
  var roll    = e.gamma;   // Left-right tilt −90° to 90°

  // Update compass UI
  var headingEl = document.getElementById('compass-heading');
  if (headingEl) headingEl.textContent = Math.round(heading) + '\u00B0';
  var needle = document.getElementById('compass-needle');
  if (needle) needle.style.transform = 'rotate(' + (-heading) + 'deg)';
}

async function startMotionSensors() {
  // Request permission (required on some platforms)
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    var state = await DeviceOrientationEvent.requestPermission();
    if (state !== 'granted') {
      showToast('Sensor permission denied', 'error');
      return;
    }
  }

  window.addEventListener('devicemotion', onDeviceMotion);
  motionListening = true;

  window.addEventListener('deviceorientation', onDeviceOrientation);
  orientationListening = true;
}

function stopMotionSensors() {
  if (motionListening) {
    window.removeEventListener('devicemotion', onDeviceMotion);
    motionListening = false;
  }
  if (orientationListening) {
    window.removeEventListener('deviceorientation', onDeviceOrientation);
    orientationListening = false;
  }
}
```

Action handlers in `handleAppAction()`:

```javascript
case 'start-sensors':
  startMotionSensors();
  showToast('Sensors started', 'success');
  break;

case 'stop-sensors':
  stopMotionSensors();
  showToast('Sensors stopped');
  break;
```

### 4. Add Geolocation

**One-shot position** — use a reasonable timeout (10–15 s) to account for phone GPS acquisition:

```javascript
function getLocation(callback) {
  navigator.geolocation.getCurrentPosition(
    function(position) {
      var lat = position.coords.latitude;
      var lon = position.coords.longitude;
      var acc = position.coords.accuracy;
      callback(lat, lon, acc);
    },
    function(error) {
      // error.code: 1 = PERMISSION_DENIED, 2 = POSITION_UNAVAILABLE, 3 = TIMEOUT
      showToast('Location error: ' + error.message, 'error');
    },
    { timeout: 15000 }
  );
}
```

**Continuous updates** — always call `clearWatch` when the app is no longer visible to conserve battery:

```javascript
var watchId = null;

function startLocationWatch(onUpdate) {
  watchId = navigator.geolocation.watchPosition(
    function(position) {
      onUpdate(position.coords.latitude, position.coords.longitude, position.coords.accuracy);
    },
    function(error) {
      showToast('Location error: ' + error.message, 'error');
    }
  );
}

function stopLocationWatch() {
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
  }
}
```

### 5. Clean Up on Screen Exit

Stop all sensors and location watches when leaving the sensor screen. In `navigateTo()`, before switching screens:

```javascript
stopMotionSensors();
stopLocationWatch();
```

## Sensor Patterns

### Compass

Uses `DeviceOrientationEvent.alpha` for heading:

```javascript
window.addEventListener('deviceorientation', function(e) {
  var heading = e.alpha; // 0–360°, 0 = North
  document.getElementById('compass-heading').textContent = Math.round(heading) + '\u00B0';
  document.getElementById('compass-needle').style.transform = 'rotate(' + (-heading) + 'deg)';
});
```

### Level Tool

Uses `DeviceOrientationEvent.beta` and `gamma` for tilt:

```javascript
window.addEventListener('deviceorientation', function(e) {
  var tilt = e.beta;  // front-back
  var roll = e.gamma; // left-right

  // Map tilt to bubble position (max 120px offset)
  var bubbleX = Math.max(-120, Math.min(120, roll * 4));
  var bubbleY = Math.max(-120, Math.min(120, tilt * 4));

  document.getElementById('level-bubble').style.transform =
    'translate(calc(-50% + ' + bubbleX + 'px), calc(-50% + ' + bubbleY + 'px))';

  var angle = Math.sqrt(tilt * tilt + roll * roll);
  document.getElementById('level-reading').textContent = angle.toFixed(1) + '\u00B0';
});
```

### Step Counter

Uses `DeviceMotionEvent.accelerationIncludingGravity` magnitude:

```javascript
var stepCount = 0, lastMagnitude = 0, stepThreshold = 12;

window.addEventListener('devicemotion', function(e) {
  var a = e.accelerationIncludingGravity;
  var mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  if (lastMagnitude < stepThreshold && mag >= stepThreshold) {
    stepCount++;
    document.getElementById('steps').textContent = stepCount;
  }
  lastMagnitude = mag;
});
```

### Shake Detection

```javascript
var shakeThreshold = 15, lastShakeTime = 0;

window.addEventListener('devicemotion', function(e) {
  var a = e.accelerationIncludingGravity;
  var mag = Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
  if (mag > shakeThreshold && Date.now() - lastShakeTime > 1000) {
    lastShakeTime = Date.now();
    onShake();
  }
});
```

### Tilt Control (for games)

```javascript
window.addEventListener('deviceorientation', function(e) {
  var moveX = Math.max(-1, Math.min(1, e.gamma / 30)); // left-right
  var moveY = Math.max(-1, Math.min(1, e.beta / 30));  // front-back
  updateGamePosition(moveX, moveY);
});
```

### Head Nod / Shake Detection

```javascript
var betaHistory = [], alphaHistory = [];

window.addEventListener('deviceorientation', function(e) {
  betaHistory.push(e.beta);
  alphaHistory.push(e.alpha);
  if (betaHistory.length > 30) betaHistory.shift();
  if (alphaHistory.length > 30) alphaHistory.shift();

  if (betaHistory.length >= 20) {
    var betaRange = Math.max.apply(null, betaHistory) - Math.min.apply(null, betaHistory);
    if (betaRange > 15) onHeadNod();
  }

  if (alphaHistory.length >= 20) {
    var alphaRange = Math.max.apply(null, alphaHistory) - Math.min.apply(null, alphaHistory);
    if (alphaRange > 20) onHeadShake();
  }
});
```

### Spatial App (AR overlay — fuse heading + GPS)

Combine orientation with geolocation to build AR-style spatial overlays:

```javascript
var userLat, userLon;

navigator.geolocation.getCurrentPosition(function(pos) {
  userLat = pos.coords.latitude;
  userLon = pos.coords.longitude;
}, null, { timeout: 15000 });

window.addEventListener('deviceorientation', function(e) {
  var azimuth  = e.alpha; // horizontal direction
  var altitude = e.beta;  // vertical angle (tilt up = positive)
  var roll     = e.gamma;

  var target = findNearestSkyObject(azimuth, altitude, userLat, userLon);
  renderOverlay(target);
});
```

## Specialized UI Templates

### Compass

```html
<div class="compass-container">
  <div class="compass-ring">
    <div class="compass-needle" id="compass-needle"></div>
    <div class="compass-label">N</div>
  </div>
  <div class="compass-heading" id="compass-heading">0&deg;</div>
</div>
```

```css
.compass-container { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 20px; }
.compass-ring { width: 300px; height: 300px; border: 4px solid var(--bg-tertiary); border-radius: 50%; position: relative; display: flex; align-items: center; justify-content: center; }
.compass-needle { width: 4px; height: 120px; background: linear-gradient(to top, var(--danger) 50%, var(--text-primary) 50%); border-radius: 2px; transform-origin: center bottom; position: absolute; bottom: 50%; transition: transform 0.1s ease; }
.compass-label { position: absolute; top: 12px; font-size: 20px; font-weight: 700; color: var(--danger); }
.compass-heading { font-size: 48px; font-weight: 700; color: var(--accent-primary); }
```

### Level Tool

```html
<div class="level-container">
  <div class="level-surface" id="level-surface">
    <div class="level-bubble" id="level-bubble"></div>
    <div class="level-crosshair"></div>
  </div>
  <div class="level-reading" id="level-reading">0.0&deg;</div>
</div>
```

```css
.level-container { display: flex; flex-direction: column; align-items: center; gap: 16px; padding: 20px; }
.level-surface { width: 300px; height: 300px; border: 4px solid var(--bg-tertiary); border-radius: 50%; position: relative; overflow: hidden; }
.level-bubble { width: 40px; height: 40px; border-radius: 50%; background: var(--accent-primary); position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); transition: transform 0.1s ease; box-shadow: 0 0 20px var(--focus-glow); }
.level-crosshair { position: absolute; top: 50%; left: 50%; width: 20px; height: 20px; transform: translate(-50%, -50%); border: 2px solid var(--success); border-radius: 50%; }
.level-reading { font-size: 36px; font-weight: 700; color: var(--accent-primary); }
```

## Verify

- [ ] Sensor start/stop buttons work via D-pad + Enter
- [ ] Orientation data updates smoothly (compass heading, tilt)
- [ ] Motion data updates (accelerometer values)
- [ ] Geolocation returns coordinates (may take several seconds on first call)
- [ ] Sensors stop when leaving the screen
- [ ] `clearWatch` is called when location watch is no longer needed

## Related Skills

- `/add-ui` — Add screens, buttons, and other UI components

## Adding local storage


Add client-side data persistence using the standard [W3C Web Storage API](https://www.w3.org/TR/webstorage/). Supports `localStorage` (persists across sessions) and `sessionStorage` (cleared when the session ends). No SDK required.

## Prerequisites

- Existing webapp created via `/create-webapp`

## Storage Types

| API | Persistence | Use Cases |
|-----|------------|-----------|
| `localStorage` | Persists until explicitly cleared | User settings, saved data, app state, preferences |
| `sessionStorage` | Cleared when session ends | Temporary state, form drafts, navigation context |

Both APIs share the same interface and store string key-value pairs.

## Steps

### 1. Gather Information

Ask the user:
- **What data?** Settings, preferences, app state, cached API responses?
- **Which storage?** Persistent (`localStorage`) or session-only (`sessionStorage`)?
- **Data shape?** Single values or structured objects?

### 2. Add Storage Helpers

In `app.js`, add helpers for reading and writing structured data:

```javascript
var STORAGE_KEY = 'mdg_myapp';

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function loadData() {
  try {
    var saved = localStorage.getItem(STORAGE_KEY);
    return saved ? JSON.parse(saved) : null;
  } catch (e) {
    return null;
  }
}

function clearData() {
  localStorage.removeItem(STORAGE_KEY);
}
```

### 3. Wire Up to App State

Load saved data on startup and save on changes:

```javascript
// On init
var saved = loadData();
if (saved) {
  state.data = saved;
}

// After any state change
state.data.score = 100;
saveData(state.data);
```

### 4. Add Settings UI (if needed)

For user-facing settings with persistence:

```javascript
case 'toggle-dark-mode':
  state.data.darkMode = !state.data.darkMode;
  document.body.classList.toggle('light-mode', !state.data.darkMode);
  saveData(state.data);
  break;

case 'reset-data':
  clearData();
  state.data = {};
  showToast('Data cleared');
  break;
```

## Patterns

### Save User Preferences

```javascript
function savePreference(key, value) {
  var prefs = loadData() || {};
  prefs[key] = value;
  saveData(prefs);
}

function getPreference(key, defaultValue) {
  var prefs = loadData() || {};
  return prefs[key] !== undefined ? prefs[key] : defaultValue;
}
```

### Cache API Responses

```javascript
function cacheResponse(url, data, ttlMs) {
  var entry = { data: data, timestamp: Date.now(), ttl: ttlMs };
  localStorage.setItem('cache_' + url, JSON.stringify(entry));
}

function getCachedResponse(url) {
  try {
    var entry = JSON.parse(localStorage.getItem('cache_' + url));
    if (entry && Date.now() - entry.timestamp < entry.ttl) {
      return entry.data;
    }
  } catch (e) {}
  return null;
}
```

### Session-Only State

Use `sessionStorage` for data that should not survive a restart:

```javascript
// Save temporary navigation context
sessionStorage.setItem('returnScreen', 'home');

// Restore on load
var returnTo = sessionStorage.getItem('returnScreen') || 'home';
```

## Verify

- [ ] Data persists after page refresh (localStorage)
- [ ] Session data clears when session ends (sessionStorage)
- [ ] App handles missing/corrupt stored data gracefully
- [ ] Reset/clear action works

## Related Skills

- `/add-ui` — Add settings screens and toggle buttons
- `/connect-api` — Fetch data to cache locally

## Adding passcode protection


Add a combination lock screen that gates access to your webapp during Vercel preview deployments. Since `/test-on-device` disables Vercel's deployment protection, this prevents the public from accessing your app.

## Prerequisites

- Existing webapp with `index.html` (created via `/create-webapp` or manually)
- The app directory must have `server.js` and `vercel.json` (created by `/create-webapp` or `/test-on-device`)

## Steps

### 1. Gather Information

Ask the user:
- **Passcode** — 3 digits, each 0-9 (e.g. 2-4-7)

### 2. Create `lock.html`

Read [templates/lock.html](templates/lock.html) and write it to the app directory.

Replace the two placeholder values in the `<script>` block:
- `__DIGIT_0__`, `__DIGIT_1__`, `__DIGIT_2__` — the user's chosen passcode digits (as integers)
- `__APP_NAME__` in the `STORAGE_KEY` — the project name from `package.json` with hyphens replaced by underscores (e.g. `ipl-live-scores` → `ipl_live_scores`)

### 3. Update Routing

**`server.js`** — change the root path to serve `lock.html`:

```javascript
// Find this:
var filePath = '.' + (req.url === '/' ? '/index.html' : req.url);
// Replace with:
var filePath = '.' + (req.url === '/' ? '/lock.html' : req.url);
```

**`vercel.json`** — add a rewrite rule before the catch-all:

```json
{
  "rewrites": [
    { "source": "/", "destination": "/lock.html" },
    { "source": "/(.*)", "destination": "/$1" }
  ]
}
```

### 4. Add Guard to `index.html`

Add this inline script in `<head>`, after `<meta>` tags and before any `<link>` or `<script>` tags:

```html
<script>if(localStorage.getItem('<STORAGE_KEY>')!=='1')window.location.replace('lock.html');</script>
```

Replace `<STORAGE_KEY>` with the same key used in `lock.html` (e.g. `ipl_live_scores_unlocked`).

This prevents bypassing the lock by navigating directly to `index.html`.

## Verify

- [ ] `lock.html` exists in the app directory
- [ ] Passcode digits and `STORAGE_KEY` are set correctly in `lock.html`
- [ ] `server.js` serves `lock.html` on root path `/`
- [ ] `vercel.json` has the `/` → `/lock.html` rewrite before the catch-all
- [ ] `index.html` has the localStorage guard script in `<head>`
- [ ] Correct passcode shows green digits, "Unlocked" animation, and redirects
- [ ] After unlock, refreshes and new tabs skip the lock (localStorage persists)
- [ ] Direct navigation to `/index.html` redirects back to lock if not unlocked

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Lock screen doesn't appear | Check `server.js` serves `lock.html` on `/` and `vercel.json` has the rewrite |
| Can bypass lock via `/index.html` | Ensure the localStorage guard script is in `index.html` `<head>` |
| Wrong passcode unlocks | Verify `PASSCODE` array in `lock.html` matches the user's chosen digits |
| Unlock doesn't redirect | Ensure `STORAGE_KEY` is consistent between `lock.html` and `index.html` guard |

## Related Skills

- `/test-on-device` — Calls this skill automatically before deploying
- `/create-webapp` — Create a new webapp before adding passcode protection
- `/publish-to-vercel` — May also want passcode protection for production

## Testing on device

When the user asks to test "on device", "on the glasses", or on the physical hardware, always use the `/test-on-device` skill flow in this section.

Do **not** stop at a local browser server or a LAN-only URL. The expected workflow here is a hosted HTTPS preview URL, QR code, and glasses setup flow. Local hosting may be used only as a separate desktop sanity check before deploy, not as the final answer to an on-device testing request.


Push uncommitted webapp changes to Vercel and get an HTTPS preview URL for testing directly on Meta Display Glasses — without committing code.

## Prerequisites

### 1. Vercel-Compatible Node Server

The app directory must have these three files. If they don't exist, create them before proceeding.

**`package.json`:**

```json
{
  "name": "<app-name>",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node server.js"
  }
}
```

**`server.js`** — lightweight static file server:

```javascript
var http = require('http');
var fs = require('fs');
var path = require('path');

var PORT = process.env.PORT || 3000;

var mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

var server = http.createServer(function(req, res) {
  var filePath = '.' + (req.url === '/' ? '/index.html' : req.url);
  var ext = path.extname(filePath);
  var contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, function(err, content) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>404 Not Found</h1>');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, function() {
  console.log('Server running at http://localhost:' + PORT);
});
```

**`vercel.json`:**

```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/$1" }
  ]
}
```

If a server already exists, verify Vercel compatibility:
- Port must use `process.env.PORT || 3000` (not hard-coded)
- `vercel.json` must exist with rewrites config
- Server must only serve static files (no Express routes or SSR)
- `package.json` must have a `start` script

### 2. Vercel Account and CLI

- **Vercel account** — sign up at [vercel.com](https://vercel.com) (free tier works)
- **Vercel CLI installed** — run `npm i -g vercel`
- **Vercel CLI authenticated** — run `vercel login` and follow the prompts
- **Verify setup** — run `vercel whoami` to confirm auth is working

### 3. Existing Webapp

- Existing webapp with `index.html` (created via `/create-webapp` or manually)
- Vercel project already linked (`.vercel/` directory exists) — use `/publish-to-vercel` first if not set up

## Steps

### 0. Add Passcode Lock Screen

**If the app already has `lock.html`**, skip this step — the passcode is already in place.

**If the app does not have `lock.html`**, run the `/passcode-for-testing` skill first. This will:
- Ask the user for a 3-digit passcode
- Create `lock.html`, `lock.css`, `lock.js` with a combination lock UI
- Update `server.js` and `vercel.json` routing to serve the lock screen first
- Add a session guard to `index.html` to prevent direct URL bypass

### 1. Deploy Uncommitted Changes, Disable Auth, and Alias

Deploy with `vercel` (without `--prod`), disable Vercel Authentication via CLI so the glasses browser can access it without login, then alias to a stable URL:

```bash
# Deploy and capture the preview URL
URL=$(vercel --yes)

# Disable Vercel Authentication (glasses browser can't log in)
# Safe to run every time — no-op if already disabled
PROJECT_ID=$(python3 -c "import json; print(json.load(open('.vercel/project.json'))['projectId'])")
echo '{"ssoProtection":null}' | vercel api "/v9/projects/$PROJECT_ID" -X PATCH --input - --silent

# Alias to a stable, predictable URL
vercel alias set "$URL" stage-<project-name>.vercel.app
```

Replace `<project-name>` with the actual project name (from `package.json` or the `.vercel/project.json`). For example, if the project is `my-glasses-app`, the stable URL becomes `https://stage-my-glasses-app.vercel.app`.

Do **not** use `--prod`. Preview deploys keep your production URL unaffected.

### 2. Generate QR Code for Easy Device Setup

Generate a QR code that the user can scan from their phone to automatically add the webapp — no manual URL typing needed.

The QR code data must use this deep link format:
```
fb-viewapp://web_app_deep_link?appName=stage-<app-name>&appUrl=<url-encoded-stage-url>
```

For example, if the app is called `my-glasses-app` and the stable URL is `https://stage-my-glasses-app.vercel.app`:
```
fb-viewapp://web_app_deep_link?appName=stage-my-glasses-app&appUrl=https%3A%2F%2Fstage-my-glasses-app.vercel.app
```

Use the `/qr-code` skill to generate the QR code:

```bash
python3 .claude/skills/qr-code/scripts/qr_generator.py --png <app-dir>/qr-test-on-device.png "fb-viewapp://web_app_deep_link?appName=stage-<app-name>&appUrl=<url-encoded-stage-url>"
```

The PNG is saved to the app directory. If your environment supports rendering images inline (e.g. Claude Code's Read tool), display the QR code directly. Otherwise, provide the file path and tell the user to open it and scan from their phone.

> This QR code only needs to be generated once (on first deploy). The stable URL never changes, so the same QR code works for all future deploys.

### 3. Give the User the Stable URL and Setup Instructions

After deploy, alias, and QR generation, present the user with:

**Stable URL:**
```
https://stage-<project-name>.vercel.app
```

**Option A — Scan QR code (recommended):**
Scan the generated QR code with your phone camera. It will open the Meta AI app and automatically add the webapp.

**Option B — Manual setup:**
1. Open the **Meta AI app** on your phone
2. Go to **Devices** > **Display Glasses settings**
3. Navigate to **App connections** > **Web apps**
4. Tap **Add a web app**
5. Enter the name: `stage-<app-name>`
6. Enter the URL: `https://stage-<project-name>.vercel.app`

Both options only need to be done once — the URL never changes between deploys.

### 4. Iterate

Make changes locally, then deploy, disable auth, re-alias, and regenerate the QR code every time:

```bash
# Edit code...
URL=$(vercel --yes)

# Disable auth (safe to run every time)
PROJECT_ID=$(python3 -c "import json; print(json.load(open('.vercel/project.json'))['projectId'])")
echo '{"ssoProtection":null}' | vercel api "/v9/projects/$PROJECT_ID" -X PATCH --input - --silent

# Re-alias
vercel alias set "$URL" stage-<project-name>.vercel.app

# Regenerate QR code
python3 .claude/skills/qr-code/scripts/qr_generator.py --png <app-dir>/qr-test-on-device.png "fb-viewapp://web_app_deep_link?appName=stage-<app-name>&appUrl=<url-encoded-stage-url>"
```

After each deploy, show the QR code and setup instructions (following Steps 2-3).

> **PS:** If you've already added this webapp to your glasses, no need to re-add — the stable URL automatically serves the latest deploy.

## Verification

- [ ] `vercel whoami` returns a valid user
- [ ] `package.json`, `server.js`, and `vercel.json` exist in app directory
- [ ] `.vercel/` directory exists in app folder
- [ ] Deployment Protection is disabled (ssoProtection is null)
- [ ] `vercel` (no flags) completes and returns a preview URL
- [ ] `vercel alias set` succeeds and maps to `stage-<project-name>.vercel.app`
- [ ] Stable URL is accessible in an incognito browser (no login prompt)
- [ ] Webapp loads on Meta Display Glasses via the stable URL
- [ ] Subsequent deploys + alias keep the same URL working

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Preview URL shows Vercel login page | Run: `echo '{"ssoProtection":null}' \| vercel api "/v9/projects/$PROJECT_ID" -X PATCH --input - --silent` |
| `vercel: command not found` | Run `npm i -g vercel` |
| No `.vercel/` directory | Run `/publish-to-vercel` first to set up the project |
| Glasses show blank page | Check browser console — likely a JS error. Test URL in desktop browser first |
| Old version showing on glasses | Clear the glasses browser cache or hard-refresh — the stable URL should auto-serve the latest deploy |
| Alias name taken | The `stage-<project-name>.vercel.app` subdomain may already be claimed by another Vercel user. Try a more specific name like `stage-<project-name>-<team>.vercel.app` |
| CORS errors on API calls | APIs must allow cross-origin requests. Use a proxy or CORS-friendly API |
| QR code won't scan | Ensure the deep link format is correct and the URL is properly percent-encoded. Try increasing `--scale` for a larger QR image |

## Related Skills

| Skill | Purpose | When to Use |
|-------|---------|-------------|
| `/passcode-for-testing` | Add passcode lock screen | Called automatically before first deploy to prevent public access |
| `/publish-to-vercel` | Publish to stable production URL | Shipping a ready version |
| `/create-webapp` | Create a new webapp | Before you have an app to debug |
| `/connect-api` | Add API connections | If debugging API integration issues |
| `/qr-code` | Generate QR codes | Used automatically by this skill for device setup |

## Generating QR codes


Generate QR codes locally using a pure Python script with zero external dependencies.
All data stays on the local machine — nothing is sent to any third-party service.

## When This Skill Activates

- User wants to generate a QR code for a URL, text, or any data
- User asks to create a scannable QR code image (PNG)

## How to Use

The QR generator script is at:
```
.claude/skills/qr-code/scripts/qr_generator.py
```

Run it with `python3` (macOS/Linux) or `python` (Windows).

### PNG File Output

Save the QR code as a PNG image file:

```bash
python3 .claude/skills/qr-code/scripts/qr_generator.py --png /tmp/qr_output.png "https://example.com"
```

### Options

| Flag | Description | Default |
|------|-------------|---------|
| `--png FILE` | Save as PNG to FILE | (required) |
| `--scale N` | PNG pixels per QR module | `10` |
| `--open` | Open the PNG in the OS default image viewer after saving | off |

## Workflow

1. Determine what the user wants to encode (URL, text, etc.)
2. Run the script via Bash tool with `--png <path> --open` to save as PNG and open it for scanning
3. Inform the user of the saved file path

## Limitations

- Supports QR versions 1-10 (up to ~271 characters)
- Only byte mode encoding (handles all UTF-8 text, URLs, etc.)

## Examples

Generate QR for a URL:
```bash
python3 .claude/skills/qr-code/scripts/qr_generator.py --png /tmp/link_qr.png --open "https://meta.com"
```

Generate QR for plain text:
```bash
python3 .claude/skills/qr-code/scripts/qr_generator.py --png /tmp/message_qr.png --open "Thank god it's Friday!"
```

## Publishing and hosting


Publish a Meta Display Glasses webapp to Vercel for live HTTPS hosting at a stable production URL. This enables loading the webapp directly on Meta Display Glasses, which require HTTPS URLs.

**Use this skill only when the webapp is ready to ship to everyone.** For iterating on uncommitted changes during development, use `/test-on-device` instead — it deploys to a `stage-<project-name>` URL without affecting production.

**No GitHub repo required** — code is pushed directly from local to Vercel.

## Why Vercel?

Meta Display Glasses load webapps via HTTPS URLs. Vercel provides instant static hosting with HTTPS out of the box, making it the fastest path from local development to on-device access.

## Prerequisites

### 1. Vercel-Compatible Node Server

The app directory must have these three files. If they don't exist, create them before proceeding.

**`package.json`:**

```json
{
  "name": "<app-name>",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "start": "node server.js"
  }
}
```

**`server.js`** — lightweight static file server:

```javascript
var http = require('http');
var fs = require('fs');
var path = require('path');

var PORT = process.env.PORT || 3000;

var mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
};

var server = http.createServer(function(req, res) {
  var filePath = '.' + (req.url === '/' ? '/index.html' : req.url);
  var ext = path.extname(filePath);
  var contentType = mimeTypes[ext] || 'application/octet-stream';

  fs.readFile(filePath, function(err, content) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/html' });
      res.end('<h1>404 Not Found</h1>');
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(content);
  });
});

server.listen(PORT, function() {
  console.log('Server running at http://localhost:' + PORT);
});
```

**`vercel.json`:**

```json
{
  "rewrites": [
    { "source": "/(.*)", "destination": "/$1" }
  ]
}
```

If a server already exists, verify Vercel compatibility:
- Port must use `process.env.PORT || 3000` (not hard-coded)
- `vercel.json` must exist with rewrites config
- Server must only serve static files (no Express routes or SSR)
- `package.json` must have a `start` script

### 2. Vercel Account and CLI

- **Vercel account** — sign up at [vercel.com](https://vercel.com) (free tier works)
- **Vercel CLI installed** — run `npm i -g vercel`
- **Vercel CLI authenticated** — run `vercel login` and follow the prompts
- **Verify setup** — run `vercel whoami` to confirm auth is working

### 3. Existing Webapp

- Existing webapp with `index.html` (created via `/create-webapp` or manually)

## Steps

### 1. Ensure No GitHub Repo Is Linked

This workflow pushes code directly from local to Vercel — no GitHub repo needed.

If a Vercel project was previously linked to GitHub, disconnect it:

```bash
vercel git disconnect --yes
```

### 2. Create Vercel Project and Publish

For a first-time publish, run from the app directory:

```bash
vercel --yes --prod
```

This will:
1. Create a new Vercel project (auto-named from directory)
2. Upload all files directly
3. Build and deploy to production
4. Output the live HTTPS URL

The project will be linked locally via a `.vercel/` directory (auto-added to `.gitignore`).

### 3. Disable Deployment Protection

Immediately after the first deploy, disable Vercel Authentication so the glasses browser can access the URL without login:

```bash
PROJECT_ID=$(python3 -c "import json; print(json.load(open('.vercel/project.json'))['projectId'])")
echo '{"ssoProtection":null}' | vercel api "/v9/projects/$PROJECT_ID" -X PATCH --input - --silent
```

> This is safe to run on every deploy — it's a no-op if already disabled.

### 4. Alias to a Stable Production URL

After deploying, alias the deployment to a predictable `<project-name>` URL:

```bash
URL=$(vercel --prod)
vercel alias set "$URL" <project-name>.vercel.app
```

Replace `<project-name>` with the actual project name (from `package.json` or `.vercel/project.json`). For example, if the project is `my-glasses-app`, the stable URL becomes `https://my-glasses-app.vercel.app`.

This is the URL to share with everyone. It never changes between deploys.

### 5. Generate QR Code for Easy Device Setup

Generate a QR code that users can scan from their phone to automatically add the webapp — no manual URL typing needed.

The QR code data must use this deep link format:
```
fb-viewapp://web_app_deep_link?appName=<app-name>&appUrl=<url-encoded-prod-url>
```

For example, if the app is called `my-glasses-app` and the stable URL is `https://my-glasses-app.vercel.app`:
```
fb-viewapp://web_app_deep_link?appName=my-glasses-app&appUrl=https%3A%2F%2Fmy-glasses-app.vercel.app
```

Use the `/qr-code` skill to generate the QR code:

```bash
python3 .claude/skills/qr-code/scripts/qr_generator.py --png <app-dir>/qr-publish.png "fb-viewapp://web_app_deep_link?appName=<app-name>&appUrl=<url-encoded-prod-url>"
```

The PNG is saved to the app directory. If your environment supports rendering images inline (e.g. Claude Code's Read tool), display the QR code directly. Otherwise, provide the file path and tell the user to open it and scan from their phone.

### 6. Give the User the Stable URL and Setup Instructions

After deploy, alias, and QR generation, present the user with:

**Stable URL:**
```
https://<project-name>.vercel.app
```

**Option A — Scan QR code (recommended):**
Scan the generated QR code with your phone camera. It will open the Meta AI app and automatically add the webapp.

**Option B — Manual setup:**
1. Open the **Meta AI app** on your phone
2. Go to **Devices** > **Display Glasses settings**
3. Navigate to **App connections** > **Web apps**
4. Tap **Add a web app**
5. Enter the name: `<app-name>`
6. Enter the URL: `https://<project-name>.vercel.app`

### 7. After Each Update — Republish

After making changes, republish, re-alias, and regenerate the QR code every time:

```bash
URL=$(vercel --prod)
vercel alias set "$URL" <project-name>.vercel.app

# Regenerate QR code
python3 .claude/skills/qr-code/scripts/qr_generator.py --png <app-dir>/qr-publish.png "fb-viewapp://web_app_deep_link?appName=<app-name>&appUrl=<url-encoded-prod-url>"
```

The stable URL automatically serves the latest version. No `git push` needed — Vercel receives the files directly.

After each republish, show the QR code and setup instructions (following Steps 5-6).

> **PS:** If the user has already added this webapp to their glasses, no need to re-add — the stable URL automatically serves the latest deploy.

## Verification

- [ ] `vercel whoami` returns a valid user
- [ ] `package.json`, `server.js`, and `vercel.json` exist in app directory
- [ ] `server.js` uses `process.env.PORT`
- [ ] `vercel --prod` completes successfully
- [ ] `vercel alias set` succeeds and maps to `<project-name>.vercel.app`
- [ ] Stable URL returns the app (check in browser)
- [ ] URL uses HTTPS (required for Meta Display Glasses)
- [ ] App loads correctly on device via the stable URL
- [ ] Subsequent deploys + alias keep the same URL working

## Troubleshooting

| Issue | Solution |
|-------|----------|
| `vercel: command not found` | Run `npm i -g vercel` |
| Auth error | Run `vercel login` |
| GitHub link error on deploy | Run `vercel git disconnect --yes` first |
| 404 on sub-pages | Check `vercel.json` rewrites config |
| Old version still showing | Run `vercel --prod --force` to skip cache, then re-alias |
| Alias name taken | The `<project-name>.vercel.app` subdomain may already be claimed. Try a more specific name like `<project-name>-<team>.vercel.app` |
| Permission denied on `gh` config | Ignore — this workflow doesn't need GitHub |
| QR code won't scan | Ensure the deep link format is correct and the URL is properly percent-encoded. Try increasing `--scale` for a larger QR image |

## Related Skills

| Skill | Purpose | When to Use |
|-------|---------|-------------|
| `/test-on-device` | Preview uncommitted changes on glasses | Quick iteration without committing |
| `/create-webapp` | Create a new webapp | Before first publish |
| `/add-ui` | Add screens, buttons, components | Adding UI before republish |
| `/connect-api` | Add API connections | Adding data sources before republish |
| `/qr-code` | Generate QR codes | Used automatically by this skill for device setup |
