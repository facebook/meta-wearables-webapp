// Step Counter App — Meta Display Glasses Webapp
// Accelerometer-based step tracking with D-pad navigation

(function () {
  'use strict';

  // --- Configuration ---
  const CONFIG = {
    STORAGE_KEY: 'step_counter_data',
    DEFAULT_GOAL: 8000,
    STEPS_PER_KM: 1300,
    METERS_PER_STEP: 0.762,
    CALORIES_PER_STEP: 0.04,
    STEP_THRESHOLD: 12,
    HYSTERESIS_TIME_MS: 200,
    AUTO_SAVE_INTERVAL: 10,
    DEMO_MODE: false,
  };

  // --- State ---
  const state = {
    currentScreen: 'home',
    todayDate: getDateString(new Date()),
    todaySteps: 0,
    goal: CONFIG.DEFAULT_GOAL,
    unit: 'km',
    history: [],
    sensorsActive: false,
    lastMagnitude: 0,
    lastStepTime: 0,
    screenHistory: [],
    demoMode: CONFIG.DEMO_MODE,
  };

  // --- DOM References ---
  const screens = {};
  const elements = {
    stepCount: null,
    goalDisplay: null,
    distanceDisplay: null,
    caloriesDisplay: null,
    progressBar: null,
    progressPercent: null,
    goalStatus: null,
    statusMessage: null,
    progressFill: null,
    headerDate: null,
    goalInput: null,
    historyList: null,
    noHistoryMsg: null,
  };

  // --- Initialization ---
  function init() {
    loadState();
    cacheDOM();
    attachEventListeners();
    navigateTo('home');
    updateDisplay();
    requestSensorPermissions();
    startMotionListener();
    updateDate();
    setInterval(updateDate, 60000);
  }

  function cacheDOM() {
    document.querySelectorAll('.screen').forEach(screen => {
      screens[screen.id] = screen;
    });

    elements.stepCount = document.getElementById('step-count');
    elements.goalDisplay = document.getElementById('goal-display');
    elements.distanceDisplay = document.getElementById('distance-display');
    elements.caloriesDisplay = document.getElementById('calories-display');
    elements.progressBar = document.getElementById('progress-bar');
    elements.progressPercent = document.getElementById('progress-percent');
    elements.goalStatus = document.getElementById('goal-status');
    elements.statusMessage = document.getElementById('status-message');
    elements.progressFill = document.getElementById('progress-fill');
    elements.headerDate = document.getElementById('header-date');
    elements.goalInput = document.getElementById('goal-input');
    elements.historyList = document.getElementById('history-list');
    elements.noHistoryMsg = document.getElementById('no-history-msg');
  }

  // --- Event Listeners ---
  function attachEventListeners() {
    // D-Pad / Keyboard Navigation
    document.addEventListener('keydown', handleKeyPress);

    // Action Handlers
    document.addEventListener('click', function(e) {
      const action = e.target.closest('[data-action]')?.dataset.action;
      if (action) handleAction(action);
    });

    // Prevent focus on non-focusable elements
    document.addEventListener('focus', function(e) {
      if (!e.target.classList.contains('focusable') && e.target.tagName !== 'INPUT') {
        const firstFocusable = document.querySelector('.screen:not(.hidden) .focusable');
        if (firstFocusable) firstFocusable.focus();
      }
    }, true);
  }

  // --- Navigation & D-Pad Handling ---
  function handleKeyPress(e) {
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveFocusPrevious();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveFocusNext();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      document.activeElement.click();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      handleAction('back');
    }
  }

  function moveFocusNext() {
    const current = document.activeElement;
    const focusables = Array.from(
      document.querySelector('.screen:not(.hidden)').querySelectorAll('.focusable')
    );
    const idx = focusables.indexOf(current);
    const next = focusables[(idx + 1) % focusables.length];
    if (next) {
      next.focus();
      next.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function moveFocusPrevious() {
    const current = document.activeElement;
    const focusables = Array.from(
      document.querySelector('.screen:not(.hidden)').querySelectorAll('.focusable')
    );
    const idx = focusables.indexOf(current);
    const prev = focusables[(idx - 1 + focusables.length) % focusables.length];
    if (prev) {
      prev.focus();
      prev.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  function navigateTo(screenId) {
    Object.values(screens).forEach(screen => screen.classList.add('hidden'));
    screens[screenId].classList.remove('hidden');
    state.currentScreen = screenId;
    state.screenHistory.push(screenId);

    // Focus first focusable element
    const firstFocusable = screens[screenId].querySelector('.focusable');
    if (firstFocusable) setTimeout(() => firstFocusable.focus(), 100);

    // Call screen-specific handlers
    onScreenEnter(screenId);
  }

  function onScreenEnter(screenId) {
    switch (screenId) {
      case 'home':
        updateDisplay();
        break;
      case 'settings':
        elements.goalInput.value = state.goal;
        updateUnitButtons();
        break;
      case 'history':
        renderHistory();
        break;
    }
  }

  // --- Action Handlers ---
  function handleAction(action) {
    switch (action) {
      case 'start-sensors':
        startMotionListener();
        elements.statusMessage.textContent = 'Listening for steps...';
        break;

      case 'view-settings':
        navigateTo('settings');
        break;

      case 'view-history':
        navigateTo('history');
        break;

      case 'back':
        navigateBack();
        break;

      case 'increase-goal':
        state.goal = Math.min(state.goal + 1000, 50000);
        elements.goalInput.value = state.goal;
        saveState();
        break;

      case 'decrease-goal':
        state.goal = Math.max(state.goal - 1000, 1000);
        elements.goalInput.value = state.goal;
        saveState();
        break;

      case 'set-unit-km':
        state.unit = 'km';
        updateUnitButtons();
        saveState();
        updateDisplay();
        break;

      case 'set-unit-mi':
        state.unit = 'mi';
        updateUnitButtons();
        saveState();
        updateDisplay();
        break;

      case 'reset-data':
        if (confirm('Clear all step data? This cannot be undone.')) {
          state.history = [];
          state.todaySteps = 0;
          state.todayDate = getDateString(new Date());
          saveState();
          navigateTo('home');
          updateDisplay();
          showMessage('Data cleared');
        }
        break;

      case 'add-demo-steps-10':
        addDemoSteps(10);
        break;

      case 'add-demo-steps-50':
        addDemoSteps(50);
        break;

      case 'add-demo-steps-100':
        addDemoSteps(100);
        break;

      case 'dismiss-overlay':
        document.getElementById('error-overlay').classList.add('hidden');
        break;
    }
  }

  function navigateBack() {
    if (state.screenHistory.length > 1) {
      state.screenHistory.pop();
      const prevScreen = state.screenHistory[state.screenHistory.length - 1];
      Object.values(screens).forEach(screen => screen.classList.add('hidden'));
      screens[prevScreen].classList.remove('hidden');
      state.currentScreen = prevScreen;
      onScreenEnter(prevScreen);

      const firstFocusable = screens[prevScreen].querySelector('.focusable');
      if (firstFocusable) setTimeout(() => firstFocusable.focus(), 100);
    }
  }

  // --- Step Detection via Accelerometer ---
  function requestSensorPermissions() {
    if (typeof DeviceOrientationEvent !== 'undefined' && 
        typeof DeviceOrientationEvent.requestPermission === 'function') {
      DeviceOrientationEvent.requestPermission()
        .then(permission => {
          if (permission === 'granted') {
            elements.statusMessage.textContent = 'Ready. Press Start to begin tracking.';
          }
        })
        .catch(err => {
          elements.statusMessage.textContent = 'Sensor permission denied.';
          console.warn('Sensor permission:', err);
        });
    } else {
      elements.statusMessage.textContent = 'Ready. Press Start to begin tracking.';
    }
  }

  function startMotionListener() {
    if (state.sensorsActive) return;

    window.addEventListener('devicemotion', onDeviceMotion);
    state.sensorsActive = true;
    elements.statusMessage.textContent = '✓ Tracking steps...';
  }

  function onDeviceMotion(e) {
    if (!state.sensorsActive) return;

    const accel = e.accelerationIncludingGravity;
    if (!accel) return;

    // Calculate magnitude: sqrt(x² + y² + z²)
    const mag = Math.sqrt(accel.x ** 2 + accel.y ** 2 + accel.z ** 2);

    // Step detection: crossing threshold with hysteresis
    const now = Date.now();
    if (state.lastMagnitude < CONFIG.STEP_THRESHOLD && 
        mag >= CONFIG.STEP_THRESHOLD &&
        now - state.lastStepTime > CONFIG.HYSTERESIS_TIME_MS) {
      state.todaySteps++;
      state.lastStepTime = now;

      // Auto-save every N steps
      if (state.todaySteps % CONFIG.AUTO_SAVE_INTERVAL === 0) {
        saveState();
        updateDisplay();
      } else {
        updateStepDisplay();
      }
    }

    state.lastMagnitude = mag;
  }

  function addDemoSteps(count) {
    state.todaySteps += count;
    saveState();
    updateDisplay();
    showMessage(`Added ${count} demo steps`);
  }

  // --- Display Updates ---
  function updateDisplay() {
    checkDateRollover();
    updateStepDisplay();
    updateStats();
    updateProgress();
  }

  function updateStepDisplay() {
    elements.stepCount.textContent = state.todaySteps;
  }

  function updateStats() {
    elements.goalDisplay.textContent = state.goal;

    const distance = state.todaySteps * CONFIG.METERS_PER_STEP / 1000;
    const displayDistance = state.unit === 'km' 
      ? distance.toFixed(2) + ' km'
      : (distance * 0.621371).toFixed(2) + ' mi';
    elements.distanceDisplay.textContent = displayDistance;

    const calories = Math.round(state.todaySteps * CONFIG.CALORIES_PER_STEP);
    elements.caloriesDisplay.textContent = calories;
  }

  function updateProgress() {
    const percent = Math.min(100, (state.todaySteps / state.goal) * 100);
    elements.progressBar.style.width = percent + '%';
    elements.progressPercent.textContent = Math.round(percent) + '%';
    elements.goalStatus.textContent = state.todaySteps + ' / ' + state.goal;

    // Update SVG circle progress
    const circumference = 565.48;
    const offset = circumference * (1 - percent / 100);
    elements.progressFill.style.strokeDashoffset = offset;
  }

  function updateUnitButtons() {
    document.querySelectorAll('.unit-btn').forEach(btn => {
      btn.classList.remove('active');
    });
    const activeUnit = state.unit === 'km' 
      ? document.querySelector('[data-action="set-unit-km"]')
      : document.querySelector('[data-action="set-unit-mi"]');
    if (activeUnit) activeUnit.classList.add('active');
  }

  function updateDate() {
    const date = new Date();
    const today = date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    elements.headerDate.textContent = today;
  }

  function renderHistory() {
    if (state.history.length === 0) {
      elements.historyList.style.display = 'none';
      elements.noHistoryMsg.style.display = 'block';
      return;
    }

    elements.historyList.style.display = 'flex';
    elements.noHistoryMsg.style.display = 'none';
    elements.historyList.innerHTML = '';

    state.history.slice().reverse().forEach(record => {
      const item = document.createElement('div');
      item.className = 'history-item focusable';
      item.tabIndex = 0;
      const goalPercent = Math.round((record.steps / state.goal) * 100);
      item.innerHTML = `
        <div>
          <div class="history-date">${formatDate(record.date)}</div>
          <div class="history-meta">${goalPercent}% of goal</div>
        </div>
        <div class="history-steps">${record.steps}</div>
      `;
      elements.historyList.appendChild(item);
    });
  }

  // --- Data Persistence ---
  function loadState() {
    try {
      const saved = localStorage.getItem(CONFIG.STORAGE_KEY);
      if (saved) {
        const data = JSON.parse(saved);
        state.todayDate = getDateString(new Date());
        state.todaySteps = data.todayDate === state.todayDate ? data.todaySteps : 0;
        state.goal = data.goal || CONFIG.DEFAULT_GOAL;
        state.unit = data.unit || 'km';
        state.history = data.history || [];

        // Date rollover: if today's date changed, save yesterday's count to history
        if (data.todayDate && data.todayDate !== state.todayDate && data.todaySteps > 0) {
          state.history.push({
            date: data.todayDate,
            steps: data.todaySteps,
          });
        }
      }
    } catch (err) {
      console.error('Failed to load state:', err);
    }
  }

  function saveState() {
    try {
      localStorage.setItem(CONFIG.STORAGE_KEY, JSON.stringify({
        todayDate: state.todayDate,
        todaySteps: state.todaySteps,
        goal: state.goal,
        unit: state.unit,
        history: state.history,
      }));
    } catch (err) {
      console.error('Failed to save state:', err);
    }
  }

  function checkDateRollover() {
    const today = getDateString(new Date());
    if (today !== state.todayDate) {
      if (state.todaySteps > 0) {
        state.history.push({
          date: state.todayDate,
          steps: state.todaySteps,
        });
      }
      state.todayDate = today;
      state.todaySteps = 0;
      saveState();
    }
  }

  // --- Utilities ---
  function getDateString(date) {
    return date.toISOString().split('T')[0];
  }

  function formatDate(dateStr) {
    const date = new Date(dateStr + 'T00:00:00');
    return date.toLocaleDateString('en-US', { 
      weekday: 'short', 
      month: 'short', 
      day: 'numeric' 
    });
  }

  function showMessage(msg) {
    elements.statusMessage.textContent = msg;
    setTimeout(() => {
      elements.statusMessage.textContent = '✓ Tracking steps...';
    }, 2000);
  }

  // --- Launch ---
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
