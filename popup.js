'use strict';

// ── DOM references ────────────────────────────────────────────────────────────

const searchInput     = document.getElementById('search-input');
const searchBtn       = document.getElementById('search-btn');
const chkDL           = document.getElementById('chk-dl');
const chkGA4          = document.getElementById('chk-ga4');
const statusEl        = document.getElementById('status');
const resultsEl       = document.getElementById('results');
const dlCountEl       = document.getElementById('dl-count');
const ga4CountEl      = document.getElementById('ga4-count');
const tooltipToggleEl = document.getElementById('chk-tooltip');

const tabEventsBtnEl  = document.getElementById('tab-events-btn');
const tabEmailBtnEl   = document.getElementById('tab-email-btn');
const panelEventsEl   = document.getElementById('panel-events');
const panelEmailEl    = document.getElementById('panel-email');

const piiEmailInput   = document.getElementById('pii-email');
const piiBtnEl        = document.getElementById('pii-btn');
const chkPiiDL        = document.getElementById('chk-pii-dl');
const chkPiiGA4       = document.getElementById('chk-pii-ga4');
const piiStatusEl     = document.getElementById('pii-status');
const piiResultsEl    = document.getElementById('pii-results');

// ── Storage keys ──────────────────────────────────────────────────────────────

const LAST_SEARCH_KEY    = 'lastSearch';
const TOOLTIP_ENABLED_KEY = 'tooltipEnabled';
const LAST_PII_EMAIL_KEY  = 'lastPiiEmail';

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(name) {
  const isEvents = name === 'events';
  panelEventsEl.hidden = !isEvents;
  panelEmailEl.hidden  = isEvents;
  tabEventsBtnEl.classList.toggle('active', isEvents);
  tabEmailBtnEl.classList.toggle('active', !isEvents);
  tabEventsBtnEl.setAttribute('aria-selected', isEvents);
  tabEmailBtnEl.setAttribute('aria-selected', !isEvents);
}

tabEventsBtnEl.addEventListener('click', () => switchTab('events'));
tabEmailBtnEl.addEventListener('click',  () => switchTab('email'));

// ── Persistent storage helpers ────────────────────────────────────────────────

function saveLastSearch(term, sources) {
  chrome.storage.local.set({ [LAST_SEARCH_KEY]: { term, sources } });
}

function loadLastSearch() {
  return new Promise(resolve => {
    chrome.storage.local.get(LAST_SEARCH_KEY, data => resolve(data[LAST_SEARCH_KEY] || null));
  });
}

function applySavedSearch(saved) {
  searchInput.value = saved.term;
  chkDL.checked     = saved.sources.includes('dataLayer');
  chkGA4.checked    = saved.sources.includes('ga4');
  if (!chkDL.checked && !chkGA4.checked) chkDL.checked = chkGA4.checked = true;
}

function loadLastPiiEmail() {
  return new Promise(resolve => {
    chrome.storage.local.get(LAST_PII_EMAIL_KEY, data => resolve(data[LAST_PII_EMAIL_KEY] || ''));
  });
}

// ── Tooltip preference ────────────────────────────────────────────────────────

function loadTooltipPreference() {
  chrome.storage.local.get(TOOLTIP_ENABLED_KEY, data => {
    tooltipToggleEl.checked = data[TOOLTIP_ENABLED_KEY] !== false;
  });
}

tooltipToggleEl.addEventListener('change', () => {
  chrome.storage.local.set({ [TOOLTIP_ENABLED_KEY]: tooltipToggleEl.checked });
});

// ── Email helper ──────────────────────────────────────────────────────────────

function looksLikeEmail(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text.trim());
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {
  const bg = await chromeMessage({ type: 'POPUP_OPENED' });

  if (bg?.pendingSearch?.email) {
    // Tooltip clicked on an email address — pre-fill both panels and run both.
    const email = bg.pendingSearch.email;
    piiEmailInput.value = email;
    searchInput.value   = email;
    switchTab('email');
    // Run both in parallel; email tab is visible so its results appear first.
    runEmailCheck();
    runSearch();

  } else if (bg?.pendingSearch?.term) {
    searchInput.value = bg.pendingSearch.term;
    // If the queued term looks like an email, silently pre-fill the email tab too.
    if (looksLikeEmail(bg.pendingSearch.term)) {
      piiEmailInput.value = bg.pendingSearch.term;
    }
  } else {
    const last = await loadLastSearch();
    if (last) applySavedSearch(last);
  }

  // Restore last-used PII email (if not already filled above).
  if (!piiEmailInput.value) {
    piiEmailInput.value = await loadLastPiiEmail();
  }

  loadTooltipPreference();
  refreshCounts();

  if (searchInput.value.trim()) runSearch();
}

// ── Counts ────────────────────────────────────────────────────────────────────

async function refreshCounts() {
  const resp = await contentMessage({ type: 'GET_COUNT' });
  const c = resp?.counts;
  if (c) {
    dlCountEl.textContent  = c.dl;
    ga4CountEl.textContent = c.ga4;
  }
}

// ── Events search ─────────────────────────────────────────────────────────────

async function runSearch() {
  const term = searchInput.value.trim();
  if (!term) { showStatus('Type a search term above.', 'info'); return; }

  const sources = [];
  if (chkDL.checked)  sources.push('dataLayer');
  if (chkGA4.checked) sources.push('ga4');
  if (!sources.length) { showStatus('Select at least one source.', 'info'); return; }

  searchBtn.disabled    = true;
  searchBtn.textContent = 'Searching…';
  hideStatus();
  resultsEl.innerHTML   = '';

  const resp = await contentMessage({ type: 'SEARCH', term, sources });

  searchBtn.disabled    = false;
  searchBtn.textContent = 'Search';

  if (!resp?.ok) { showStatus('Could not reach the page. Try reloading.', 'error'); return; }

  saveLastSearch(term, sources);
  renderResults(resp.results, term);
  refreshCounts();
}

// ── Email PII check ───────────────────────────────────────────────────────────

async function sha256hex(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function mergeResults(base, incoming) {
  const seen = new Set(base.map(r => r.index));
  (incoming || []).forEach(r => { if (!seen.has(r.index)) { seen.add(r.index); base.push(r); } });
}

async function runEmailCheck() {
  const email = piiEmailInput.value.trim();
  if (!email) { showPiiStatus('Enter an email address to check.', 'info'); return; }

  piiBtnEl.disabled    = true;
  piiBtnEl.textContent = 'Checking…';
  hidePiiStatus();
  piiResultsEl.innerHTML = '';

  const sources = [];
  if (chkPiiDL.checked)  sources.push('dataLayer');
  if (chkPiiGA4.checked) sources.push('ga4');
  if (!sources.length) {
    showPiiStatus('Select at least one source.', 'info');
    piiBtnEl.disabled = false;
    piiBtnEl.textContent = 'Check';
    return;
  }

  const plainResp = await contentMessage({ type: 'SEARCH', term: email, sources });

  if (!plainResp?.ok) {
    showPiiStatus('Could not reach the page. Try reloading.', 'error');
    piiBtnEl.disabled = false;
    piiBtnEl.textContent = 'Check';
    return;
  }

  const rawHashes = await Promise.all([
    sha256hex(email),
    sha256hex(email.toLowerCase()),
    sha256hex(email.toUpperCase()),
  ]);
  const uniqueHashes = [...new Set(rawHashes)];

  const hashDL  = [];
  const hashGA4 = [];
  for (const hash of uniqueHashes) {
    const resp = await contentMessage({ type: 'SEARCH', term: hash, sources });
    if (resp?.ok) {
      mergeResults(hashDL,  resp.results?.dataLayer);
      mergeResults(hashGA4, resp.results?.ga4);
    }
  }

  piiBtnEl.disabled    = false;
  piiBtnEl.textContent = 'Check';

  // Remember the email for next time.
  chrome.storage.local.set({ [LAST_PII_EMAIL_KEY]: email });

  renderEmailResults(
    { dataLayer: plainResp?.results?.dataLayer || [], ga4: plainResp?.results?.ga4 || [] },
    { dataLayer: hashDL, ga4: hashGA4 },
    email
  );

  refreshCounts();
}

// ── Rendering — events ────────────────────────────────────────────────────────

function renderResults({ dataLayer, ga4 }, term) {
  const dlHits  = dataLayer || [];
  const ga4Hits = ga4 || [];
  if (!dlHits.length && !ga4Hits.length) {
    showStatus(`No matches for "${esc(term)}" in selected sources.`, 'none');
    return;
  }
  hideStatus();
  if (dlHits.length) {
    const h = document.createElement('div');
    h.className = 'section-heading';
    h.textContent = `DataLayer (${dlHits.length} event${dlHits.length > 1 ? 's' : ''})`;
    resultsEl.appendChild(h);
    dlHits.forEach(hit => resultsEl.appendChild(makeCard(hit, 'dl')));
  }
  if (ga4Hits.length) {
    const h = document.createElement('div');
    h.className = 'section-heading';
    h.textContent = `GA4 Events (${ga4Hits.length} event${ga4Hits.length > 1 ? 's' : ''})`;
    resultsEl.appendChild(h);
    ga4Hits.forEach(hit => resultsEl.appendChild(makeCard(hit, 'ga4')));
  }
}

// ── Rendering — email PII ─────────────────────────────────────────────────────

function renderEmailResults(plainResults, hashResults, email) {
  const plainTotal = plainResults.dataLayer.length + plainResults.ga4.length;
  const hashTotal  = hashResults.dataLayer.length  + hashResults.ga4.length;

  if (!plainTotal && !hashTotal) {
    const el = document.createElement('div');
    el.className   = 'pii-clear-heading';
    el.textContent = `No plain-text or SHA-256 matches found for ${email}`;
    piiResultsEl.appendChild(el);
    return;
  }

  if (plainTotal) {
    const h = document.createElement('div');
    h.className   = 'pii-plain-heading';
    h.textContent = `Plain text — email exposed (${plainTotal} event${plainTotal > 1 ? 's' : ''})`;
    piiResultsEl.appendChild(h);
    plainResults.dataLayer.forEach(hit => piiResultsEl.appendChild(makeCard(hit, 'dl')));
    plainResults.ga4.forEach(hit       => piiResultsEl.appendChild(makeCard(hit, 'ga4')));
  }

  if (hashTotal) {
    const h = document.createElement('div');
    h.className   = 'pii-hash-heading';
    h.textContent = `SHA-256 hash found (${hashTotal} event${hashTotal > 1 ? 's' : ''})`;
    piiResultsEl.appendChild(h);
    hashResults.dataLayer.forEach(hit => piiResultsEl.appendChild(makeCard(hit, 'dl')));
    hashResults.ga4.forEach(hit       => piiResultsEl.appendChild(makeCard(hit, 'ga4')));
  }
}

// ── Result card ───────────────────────────────────────────────────────────────

function makeCard(hit, type) {
  const card = document.createElement('div');
  card.className = 'result-card';

  const sourceLabel = type === 'dl'
    ? '<span class="event-source source-dl">dataLayer</span>'
    : '<span class="event-source source-ga4">GA4</span>';

  const midBadge = (type === 'ga4' && hit.measurementId)
    ? `<span class="event-mid" title="GA4 Measurement ID">${esc(hit.measurementId)}</span>`
    : '';

  const time = hit.timestamp
    ? new Date(hit.timestamp).toLocaleTimeString([], { hour12: false })
    : '';

  card.innerHTML = `
    <div class="result-card-header">
      <div class="card-header-main">
        <span class="event-name">${esc(hit.eventName)}</span>
        <span class="chevron">▶</span>
      </div>
      <div class="card-header-meta">
        ${midBadge}
        ${sourceLabel}
        ${time ? `<span class="event-time">${esc(time)}</span>` : ''}
      </div>
    </div>
    <div class="result-card-body">
      ${hit.paths.map(p => `
        <div class="hit-row">
          <span class="hit-path">${esc(p.path || '(root)')}</span>
          <span class="hit-arrow">→</span>
          <span class="hit-value">${esc(String(p.value))}</span>
        </div>
      `).join('')}
    </div>
  `;

  card.querySelector('.result-card-header').addEventListener('click', () => {
    card.classList.toggle('open');
  });
  card.classList.add('open');
  return card;
}

// ── Status helpers ────────────────────────────────────────────────────────────

function showStatus(msg, type = 'info') {
  statusEl.className = `status ${type}`;
  statusEl.innerHTML = msg;
}
function hideStatus() {
  statusEl.className   = 'status hidden';
  statusEl.textContent = '';
}

function showPiiStatus(msg, type = 'info') {
  piiStatusEl.className = `status ${type}`;
  piiStatusEl.innerHTML = msg;
}
function hidePiiStatus() {
  piiStatusEl.className   = 'status hidden';
  piiStatusEl.textContent = '';
}

// ── Chrome messaging helpers ──────────────────────────────────────────────────

function chromeMessage(msg) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage(msg, resp => resolve(resp || null)); }
    catch (_) { resolve(null); }
  });
}

async function contentMessage(msg) {
  return new Promise(resolve => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const tab = tabs?.[0];
        if (!tab?.id) return resolve(null);
        chrome.tabs.sendMessage(tab.id, msg, resp => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp || null);
        });
      });
    } catch (_) { resolve(null); }
  });
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Event listeners ───────────────────────────────────────────────────────────

searchBtn.addEventListener('click', runSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') runSearch(); });

piiBtnEl.addEventListener('click', runEmailCheck);
piiEmailInput.addEventListener('keydown', e => { if (e.key === 'Enter') runEmailCheck(); });

[chkDL, chkGA4].forEach(chk => {
  chk.addEventListener('change', () => {
    if (!chkDL.checked && !chkGA4.checked) chk.checked = true;
  });
});

[chkPiiDL, chkPiiGA4].forEach(chk => {
  chk.addEventListener('change', () => {
    if (!chkPiiDL.checked && !chkPiiGA4.checked) chk.checked = true;
  });
});

// ── Entry point ───────────────────────────────────────────────────────────────

init();
