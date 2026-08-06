/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

// Snake Game — MetaDisplay Glasses Webapp
// Controls: Arrow keys / D-pad (EMG swipe gestures)

(function () {
  'use strict';

  // --- Constants ---
  const CELL = 20;
  const CANVAS_W = 560;
  const CANVAS_H = 460;
  const COLS = CANVAS_W / CELL;
  const ROWS = CANVAS_H / CELL;
  const TICK_MS = 120;
  const STORAGE_KEY = 'snake_high_scores';
  const MAX_SCORES = 10;

  // --- Colors ---
  const COLOR_BG = '#14141f';
  const COLOR_GRID = '#1a1a2e';
  const COLOR_SNAKE_HEAD = '#00ff88';
  const COLOR_SNAKE_BODY = '#00cc6a';
  const COLOR_FOOD = '#ff4466';
  const COLOR_FOOD_GLOW = 'rgba(255, 68, 102, 0.3)';

  // --- State ---
  let snake = [];
  let dir = { x: 1, y: 0 };
  let nextDir = { x: 1, y: 0 };
  let food = null;
  let score = 0;
  let running = false;
  let gameLoop = null;
  let gameStarted = false;

  // --- DOM ---
  const canvas = document.getElementById('game-canvas');
  const ctx = canvas.getContext('2d');
  const scoreDisplay = document.getElementById('score-display');
  const finalScore = document.getElementById('final-score');
  const bestScoreLabel = document.getElementById('best-score-label');
  const gameOverOverlay = document.getElementById('game-over');
  const homeScreen = document.getElementById('home');
  const scoresScreen = document.getElementById('scores');
  const scoresList = document.getElementById('scores-list');

  // --- High Scores ---
  function loadScores() {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
    } catch { return []; }
  }

  function saveScores(scores) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(scores));
  }

  function addScore(value) {
    const scores = loadScores();
    scores.push({ score: value, date: new Date().toLocaleDateString() });
    scores.sort((a, b) => b.score - a.score);
    if (scores.length > MAX_SCORES) scores.length = MAX_SCORES;
    saveScores(scores);
    return scores;
  }

  function getBestScore() {
    const scores = loadScores();
    return scores.length > 0 ? scores[0].score : 0;
  }

  // --- Rendering ---
  function drawGrid() {
    ctx.fillStyle = COLOR_BG;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.strokeStyle = COLOR_GRID;
    ctx.lineWidth = 0.5;
    for (let x = 0; x <= CANVAS_W; x += CELL) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, CANVAS_H);
      ctx.stroke();
    }
    for (let y = 0; y <= CANVAS_H; y += CELL) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(CANVAS_W, y);
      ctx.stroke();
    }
  }

  function drawSnake() {
    for (let i = snake.length - 1; i >= 0; i--) {
      const seg = snake[i];
      const isHead = i === 0;
      ctx.fillStyle = isHead ? COLOR_SNAKE_HEAD : COLOR_SNAKE_BODY;
      const pad = isHead ? 1 : 2;
      ctx.beginPath();
      ctx.roundRect(
        seg.x * CELL + pad,
        seg.y * CELL + pad,
        CELL - pad * 2,
        CELL - pad * 2,
        isHead ? 4 : 3
      );
      ctx.fill();
    }
  }

  function drawFood() {
    if (!food) return;
    const cx = food.x * CELL + CELL / 2;
    const cy = food.y * CELL + CELL / 2;
    // Glow
    ctx.fillStyle = COLOR_FOOD_GLOW;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.7, 0, Math.PI * 2);
    ctx.fill();
    // Food
    ctx.fillStyle = COLOR_FOOD;
    ctx.beginPath();
    ctx.arc(cx, cy, CELL * 0.35, 0, Math.PI * 2);
    ctx.fill();
  }

  function drawIdle() {
    drawGrid();
    // Draw a small snake in the center as preview
    const previewSnake = [
      { x: Math.floor(COLS / 2), y: Math.floor(ROWS / 2) },
      { x: Math.floor(COLS / 2) - 1, y: Math.floor(ROWS / 2) },
      { x: Math.floor(COLS / 2) - 2, y: Math.floor(ROWS / 2) },
    ];
    for (let i = 0; i < previewSnake.length; i++) {
      const seg = previewSnake[i];
      ctx.fillStyle = i === 0 ? COLOR_SNAKE_HEAD : COLOR_SNAKE_BODY;
      const pad = i === 0 ? 1 : 2;
      ctx.beginPath();
      ctx.roundRect(seg.x * CELL + pad, seg.y * CELL + pad, CELL - pad * 2, CELL - pad * 2, i === 0 ? 4 : 3);
      ctx.fill();
    }
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 18px -apple-system, BlinkMacSystemFont, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Press New Game to start', CANVAS_W / 2, ROWS * CELL - 30);
  }

  function render() {
    drawGrid();
    drawFood();
    drawSnake();
  }

  // --- Game Logic ---
  function spawnFood() {
    const occupied = new Set(snake.map(s => s.x + ',' + s.y));
    let attempts = 0;
    while (attempts < 1000) {
      const x = Math.floor(Math.random() * COLS);
      const y = Math.floor(Math.random() * ROWS);
      if (!occupied.has(x + ',' + y)) {
        food = { x, y };
        return;
      }
      attempts++;
    }
  }

  function resetGame() {
    const startX = Math.floor(COLS / 2);
    const startY = Math.floor(ROWS / 2);
    snake = [
      { x: startX, y: startY },
      { x: startX - 1, y: startY },
      { x: startX - 2, y: startY },
    ];
    dir = { x: 1, y: 0 };
    nextDir = { x: 1, y: 0 };
    score = 0;
    scoreDisplay.textContent = 'Score: 0';
    spawnFood();
  }

  function tick() {
    dir = { ...nextDir };
    const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    const willEatFood = food && head.x === food.x && head.y === food.y;

    // Wall collision
    if (head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS) {
      gameOver();
      return;
    }

    // Self collision. When not eating, the tail moves away during this tick.
    const collisionLength = willEatFood ? snake.length : snake.length - 1;
    for (let i = 0; i < collisionLength; i++) {
      if (snake[i].x === head.x && snake[i].y === head.y) {
        gameOver();
        return;
      }
    }

    snake.unshift(head);

    // Eat food
    if (willEatFood) {
      score += 10;
      scoreDisplay.textContent = 'Score: ' + score;
      spawnFood();
    } else {
      snake.pop();
    }

    render();
  }

  function startGame() {
    if (gameLoop) clearInterval(gameLoop);
    gameOverOverlay.classList.add('hidden');
    resetGame();
    running = true;
    gameStarted = true;
    render();
    gameLoop = setInterval(tick, TICK_MS);
  }

  function gameOver() {
    running = false;
    gameStarted = false;
    if (gameLoop) {
      clearInterval(gameLoop);
      gameLoop = null;
    }

    const best = getBestScore();
    if (score > 0) {
      addScore(score);
    }

    finalScore.textContent = score;
    if (score > best && score > 0) {
      bestScoreLabel.textContent = 'New High Score!';
    } else {
      bestScoreLabel.textContent = 'Best: ' + Math.max(best, score);
    }

    gameOverOverlay.classList.remove('hidden');
    // Focus play again button
    const playAgainBtn = gameOverOverlay.querySelector('[data-action="start-game"]');
    if (playAgainBtn) playAgainBtn.focus();
  }

  // --- Screen Navigation ---
  function showScreen(id) {
    [homeScreen, scoresScreen].forEach(s => s.classList.add('hidden'));
    document.getElementById(id).classList.remove('hidden');
  }

  function renderScoresList() {
    const scores = loadScores();
    scoresList.innerHTML = '';

    if (scores.length === 0) {
      scoresList.innerHTML = '<div class="empty-state">No scores yet. Play a game!</div>';
      return;
    }

    scores.forEach((entry, i) => {
      const rankClass = i === 0 ? 'gold' : i === 1 ? 'silver' : i === 2 ? 'bronze' : '';
      const item = document.createElement('button');
      item.className = 'list-item focusable';
      item.tabIndex = 0;
      item.innerHTML =
        '<span class="list-item-rank ' + rankClass + '">' + (i + 1) + '</span>' +
        '<span class="list-item-content">' +
          '<span class="list-item-title">' + entry.date + '</span>' +
        '</span>' +
        '<span class="list-item-badge">' + entry.score + '</span>';
      scoresList.appendChild(item);
    });
  }

  // --- Input ---
  document.addEventListener('keydown', function (e) {
    if (!running) return;

    switch (e.key) {
      case 'ArrowUp':
        if (dir.y !== 1) nextDir = { x: 0, y: -1 };
        e.preventDefault();
        break;
      case 'ArrowDown':
        if (dir.y !== -1) nextDir = { x: 0, y: 1 };
        e.preventDefault();
        break;
      case 'ArrowLeft':
        if (dir.x !== 1) nextDir = { x: -1, y: 0 };
        e.preventDefault();
        break;
      case 'ArrowRight':
        if (dir.x !== -1) nextDir = { x: 1, y: 0 };
        e.preventDefault();
        break;
    }
  });

  // Return to home from a sub-screen. On-glasses this is triggered by the
  // thumb + middle-finger back gesture (or Escape) — no back button needed.
  function goBack() {
    showScreen('home');
    if (gameStarted && !running) {
      // Resume if game was paused
      running = true;
      gameLoop = setInterval(tick, TICK_MS);
    } else if (!gameStarted) {
      drawIdle();
    }
  }

  // --- Actions ---
  document.addEventListener('click', function (e) {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    switch (btn.dataset.action) {
      case 'start-game':
        showScreen('home');
        startGame();
        break;
      case 'view-scores':
        if (running) {
          clearInterval(gameLoop);
          gameLoop = null;
          running = false;
        }
        renderScoresList();
        showScreen('scores');
        break;
      case 'back':
        goBack();
        break;
      case 'dismiss-overlay':
        gameOverOverlay.classList.add('hidden');
        drawIdle();
        break;
      case 'clear-scores':
        saveScores([]);
        renderScoresList();
        break;
    }
  });

  // Escape / back gesture returns from a sub-screen to home.
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    const scores = document.getElementById('scores');
    if (scores && !scores.classList.contains('hidden')) {
      e.preventDefault();
      goBack();
    }
  });

  // --- Focus management for D-pad ---
  const focusableSelector = '.focusable:not(.hidden *)';

  function getVisibleFocusables() {
    return Array.from(document.querySelectorAll(focusableSelector)).filter(function (el) {
      return el.offsetParent !== null;
    });
  }

  document.addEventListener('keydown', function (e) {
    if (running) return; // Game handles arrows when running

    const focusables = getVisibleFocusables();
    if (focusables.length === 0) return;

    const current = document.activeElement;
    const idx = focusables.indexOf(current);

    if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      const next = idx < focusables.length - 1 ? idx + 1 : 0;
      focusables[next].focus();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const prev = idx > 0 ? idx - 1 : focusables.length - 1;
      focusables[prev].focus();
    } else if (e.key === 'Enter') {
      if (current && current.click) current.click();
    }
  });

  // --- Init ---
  drawIdle();
  const firstBtn = document.querySelector('.nav-item.primary');
  if (firstBtn) firstBtn.focus();
})();
