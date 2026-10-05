# Step Counter — Meta Display Glasses Webapp

A real-time step counter app built for Meta Display Glasses using accelerometer data. Track daily steps, set fitness goals, and monitor distance and calories burned.

## Features

- **Real-Time Step Tracking** — Accelerometer-based step detection via DeviceMotionEvent API
- **Daily Goals** — Set personalized daily step targets (adjustable in settings)
- **Fitness Metrics** — Automatic calculation of distance (based on 0.762m/step) and calories
- **7-Day History** — Track progress over time with historical data storage
- **Data Persistence** — All data saved locally via localStorage (no network required)
- **D-Pad Navigation** — Full control via arrow keys and Enter key
- **Dark Theme** — Optimized for Meta Display Glasses 600x600 additive display
- **Demo Mode** — Manual step increment for testing without active motion

## How to Run

### Local Desktop Testing
Open `index.html` in a modern browser:
```bash
# Option 1: Direct file open
open index.html

# Option 2: Local server (recommended)
npx serve .
# or
python3 -m http.server 8000
```

Then use arrow keys (↑↓ for navigation, Enter to select, Esc to go back).

### On Meta Display Glasses
1. Deploy to Vercel (see Deployment section)
2. Open the stable URL on your glasses
3. Press the Start button to begin tracking

## Controls

| Key | Action |
|-----|--------|
| **Arrow Up/Down** | Navigate between buttons |
| **Enter** | Select button / Activate |
| **Escape** | Go back to previous screen |
| **D-Pad (device)** | Same as arrow keys + Enter on device |

## Screens

### Home
- Live step count with progress ring
- Current goal, distance, and calories
- Start/Stop sensor button
- Quick access to Settings and History

### Settings
- Adjust daily goal (+/− buttons)
- Toggle distance units (km/mi)
- Clear all data
- Sensor info and demo mode note

### History
- Last 7 days of step data
- Goal achievement percentage per day
- Visual trend tracking

## Technical Details

### Step Detection Algorithm
```
threshold = 12 m/s² (gravity ≈ 9.8 m/s²)
hysteresis = 200ms (prevents double-counting)
step++ when: lastMag < 12 AND currentMag >= 12
```

### Data Storage (localStorage)
```json
{
  "todayDate": "2026-08-01",
  "todaySteps": 1247,
  "goal": 8000,
  "unit": "km",
  "history": [
    {"date": "2026-08-01", "steps": 1247},
    {"date": "2026-07-31", "steps": 5420}
  ]
}
```

### Formulas
- **Distance (km)** = steps × 0.762 / 1000
- **Calories** = steps × 0.04 (simplified)
- **Goal Progress** = todaySteps / goal × 100%

## File Structure
```
step-counter/
  ├── index.html      # HTML structure (4 screens + overlays)
  ├── styles.css      # Dark theme, focus states, responsive
  ├── app.js          # State, step detection, storage, navigation
  └── README.md       # This file
```

## Browser & Device Compatibility

✅ **Supported:**
- Chrome/Chromium (desktop, device)
- Safari (iOS 13+)
- Edge (desktop)
- Firefox (desktop)

✅ **Features:**
- DeviceMotionEvent (required for accelerometer)
- localStorage (required for persistence)
- ES6 JavaScript

❌ **Not supported:**
- Internet Explorer
- Very old Android browsers

## Demo Mode

If sensors are unavailable on desktop testing:
1. Go to Settings
2. Use the increment buttons to manually add steps
3. Or navigate to Demo screen to quickly add 10/50/100 steps

## Performance
- <3s load time
- <200KB gzipped
- No external dependencies
- 60fps capable on glasses
- Minimal battery drain (event-based, no continuous polling)

## Notes
- **Sensor Permission:** On iOS and some Android versions, permission must be granted via system settings
- **Accuracy:** Accelerometer accuracy depends on device motion (not GPS-based)
- **Date Rollover:** Automatically saves yesterday's steps to history at midnight
- **Offline:** Fully functional offline; no network required
- **Privacy:** All data stored locally; never sent to any server

## Customization

### Change Default Goal
Edit `app.js`:
```javascript
const CONFIG = {
  DEFAULT_GOAL: 10000,  // Change this value
  ...
};
```

### Adjust Step Threshold
Edit `app.js`:
```javascript
const CONFIG = {
  STEP_THRESHOLD: 12,  // Sensitivity (lower = more sensitive)
  ...
};
```

### Modify Colors
Edit `styles.css`:
```css
:root {
  --accent-primary: #00d4ff;  /* Main accent color */
  --accent-secondary: #00ff88; /* Secondary accent */
  ...
}
```

## Known Limitations
1. **Accelerometer only** — No GPS integration (stationary stepping won't register)
2. **Simplified calorie** — Uses average (0.04 kcal/step); doesn't account for weight/speed
3. **7-day history** — Older data is not archived
4. **No cloud sync** — Data only stored locally

## Future Enhancements
- [ ] Weekly/monthly trends
- [ ] Goal reminders & notifications
- [ ] Weight-based calorie calculation
- [ ] Integration with health apps
- [ ] Leaderboards (optional, local)
- [ ] Voice announcements

## Dependencies
**Zero external dependencies** — pure HTML/CSS/JavaScript

## License
See [LICENSE](../../LICENSE) in repository root

## Support
For issues, questions, or feature requests, open an issue in the repository.
