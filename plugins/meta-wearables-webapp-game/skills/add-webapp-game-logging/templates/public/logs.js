/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree.
 */

/*
 * Log portal client. DEVELOPER TOOLING read on a laptop — not game code, and deliberately outside
 * the game's conventions (ordinary DOM listeners, English-only). The validators skip `public/`.
 *
 * THE ONE RULE IN THIS FILE: every value that came from a device is written with `textContent`,
 * never `innerHTML` / `insertAdjacentHTML` / `outerHTML`. Log text is attacker-influenceable
 * content arriving over the public internet, and a log viewer that interpolates it into markup is
 * the textbook XSS sink. Element structure is built with `createElement`; only text is inserted.
 *
 * Auth: the passcode is POSTed once to `/api/log-auth`, which sets an HttpOnly cookie. The
 * passcode itself is never stored here — not in a variable that outlives the request, not in
 * localStorage, not in the URL.
 */

(() => {
  'use strict';

  const POLL_MS = 1500;
  const MAX_ROWS = 3000;
  const LEVEL_RANK = { error: 1, warn: 2, info: 3, debug: 4, trace: 5 };

  const el = (id) => document.getElementById(id);
  const login = el('login');
  const app = el('app');
  const logEl = el('log');
  const emptyEl = el('empty');
  const statusEl = el('status');
  const bannerEl = el('banner');
  const sessionFilter = el('session-filter');
  const levelFilter = el('level-filter');

  /** Every entry received this session, so filters can re-render without refetching. */
  let entries = [];
  let cursor = 0;
  let paused = false;
  let timer = null;

  function show(section) {
    login.hidden = section !== 'login';
    app.hidden = section !== 'app';
  }

  function formatTime(ms) {
    const date = new Date(ms);
    const pad = (n, width = 2) => String(n).padStart(width, '0');
    return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
  }

  /** Build one row. Text-only insertion — see the note at the top of this file. */
  function renderRow(entry) {
    const row = document.createElement('div');
    row.className = `row ${entry.level}`;

    const time = document.createElement('span');
    time.className = 'time';
    time.textContent = formatTime(entry.time ?? entry.receivedAt);

    const level = document.createElement('span');
    level.className = 'level';
    level.textContent = entry.level;

    const scope = document.createElement('span');
    scope.className = 'scope';
    scope.textContent = entry.scope || '—';

    const message = document.createElement('span');
    message.className = 'message';
    message.textContent = entry.message;

    row.append(time, level, scope, message);

    if (entry.data !== undefined) {
      const data = document.createElement('span');
      data.className = 'data';
      try {
        data.textContent = JSON.stringify(entry.data);
      } catch {
        data.textContent = '[unserializable]';
      }
      row.append(data);
    }
    return row;
  }

  function visibleEntries() {
    const minRank = LEVEL_RANK[levelFilter.value] ?? 5;
    const session = sessionFilter.value;
    return entries.filter(
      (entry) =>
        (LEVEL_RANK[entry.level] ?? 3) <= minRank &&
        (session === '' || entry.sessionId === session),
    );
  }

  function render() {
    const visible = visibleEntries();
    const atBottom = window.innerHeight + window.scrollY >= document.body.scrollHeight - 60;

    logEl.replaceChildren(...visible.map(renderRow));
    emptyEl.hidden = visible.length > 0;

    // Follow the tail only if the reader was already at the bottom — don't yank them away from
    // something they scrolled up to read.
    if (atBottom) {
      window.scrollTo(0, document.body.scrollHeight);
    }
  }

  function refreshSessions() {
    const seen = [...new Set(entries.map((entry) => entry.sessionId))];
    const current = sessionFilter.value;
    const options = [{ value: '', label: 'All sessions' }].concat(
      seen.map((id) => ({ value: id, label: `session ${id}` })),
    );
    sessionFilter.replaceChildren(
      ...options.map(({ value, label }) => {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        return option;
      }),
    );
    sessionFilter.value = seen.includes(current) || current === '' ? current : '';
  }

  function setStatus(text) {
    statusEl.textContent = text;
  }

  async function poll() {
    if (paused) {
      return;
    }
    let response;
    try {
      response = await fetch(`/api/logs?since=${cursor}`, { credentials: 'same-origin' });
    } catch {
      setStatus('offline — retrying');
      return;
    }

    if (response.status === 401) {
      stopPolling();
      show('login');
      return;
    }
    if (!response.ok) {
      setStatus(`error ${response.status}`);
      return;
    }

    const body = await response.json();
    cursor = body.cursor ?? cursor;

    if (body.store?.ephemeral) {
      bannerEl.hidden = false;
      bannerEl.textContent =
        'This deployment stores logs in memory only. A cold start or a second serverless instance ' +
        'will lose records, so gaps here may not mean the game went quiet. Configure a durable ' +
        'store (see docs/logging.md) for reliable capture.';
    } else {
      bannerEl.hidden = true;
    }

    const incoming = body.entries ?? [];
    if (incoming.length > 0) {
      entries = entries.concat(incoming).slice(-MAX_ROWS);
      refreshSessions();
      render();
    }
    setStatus(`${entries.length} record(s) · ${body.store?.kind ?? 'unknown'} store`);
  }

  function startPolling() {
    if (timer === null) {
      timer = setInterval(poll, POLL_MS);
    }
    void poll();
  }

  function stopPolling() {
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function signIn() {
    const field = el('login-token');
    const errorEl = el('login-error');
    errorEl.textContent = '';

    const response = await fetch('/api/log-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ token: field.value }),
    }).catch(() => null);

    // Clear the field either way — the passcode should not sit in the DOM.
    field.value = '';

    if (response === null) {
      errorEl.textContent = 'Could not reach the server.';
      return;
    }
    if (response.status === 404) {
      errorEl.textContent =
        'Logging is not enabled on this deployment. Set the LOG_TOKEN environment variable and redeploy.';
      return;
    }
    if (!response.ok) {
      const body = await response.json().catch(() => ({}));
      errorEl.textContent = body.error ?? 'Sign-in failed.';
      return;
    }

    show('app');
    startPolling();
  }

  el('login-submit').addEventListener('click', () => void signIn());
  el('login-token').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      void signIn();
    }
  });

  el('pause').addEventListener('click', (event) => {
    paused = !paused;
    event.target.textContent = paused ? 'Resume' : 'Pause';
    if (!paused) {
      void poll();
    }
  });

  el('clear').addEventListener('click', () => {
    // Clears the VIEW only — the server keeps its buffer, and `cursor` is untouched so polling
    // continues from where it was rather than replaying everything.
    entries = [];
    render();
    setStatus('view cleared');
  });

  el('download').addEventListener('click', () => {
    const jsonl = visibleEntries()
      .map((entry) => JSON.stringify(entry))
      .join('\n');
    const url = URL.createObjectURL(new Blob([jsonl], { type: 'application/x-ndjson' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = 'game-logs.jsonl';
    anchor.click();
    // Deferred: some browsers start reading the blob after the click handler returns, and
    // revoking in the same tick gives them an empty file.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  });

  el('logout').addEventListener('click', async () => {
    stopPolling();
    await fetch('/api/log-auth', { method: 'DELETE', credentials: 'same-origin' }).catch(() => {});
    entries = [];
    cursor = 0;
    render();
    show('login');
  });

  levelFilter.addEventListener('change', render);
  sessionFilter.addEventListener('change', render);

  // An existing cookie means we can go straight to the stream; a 401 bounces back to the login.
  fetch('/api/logs?since=0', { credentials: 'same-origin' })
    .then((response) => {
      if (response.ok) {
        show('app');
        startPolling();
      } else {
        show('login');
      }
    })
    .catch(() => show('login'));
})();
