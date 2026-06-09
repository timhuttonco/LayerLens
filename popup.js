/**
 * popup.js — Extension popup UI controller
 *
 * Loaded by popup.html when the user opens the extension popup. Handles:
 *   • Pre-filling the search box with highlighted text or a queued context-menu term.
 *   • Restoring the last search term and source checkboxes from persistent storage.
 *   • Running searches via content.js → injected.js and rendering the results.
 *   • Displaying live counts of captured dataLayer and GA4 events.
 *   • UI state (loading, error, empty, results).
 */

'use strict';

// ── DOM references ────────────────────────────────────────────────────────────

/** Text input where the user types (or pastes) their search term. */
const searchInput = document.getElementById('search-input');

/** The "Search" button that triggers runSearch(). */
const searchBtn   = document.getElementById('search-btn');

/** Checkbox to include the GTM dataLayer in the search. */
const chkDL       = document.getElementById('chk-dl');

/** Checkbox to include GA4 events in the search. */
const chkGA4      = document.getElementById('chk-ga4');

/** Status bar element for informational / error / no-results messages. */
const statusEl    = document.getElementById('status');

/** Container element into which result cards are rendered. */
const resultsEl   = document.getElementById('results');

/** Number span inside the dataLayer stat card. */
const dlCountEl   = document.getElementById('dl-count');

/** Number span inside the GA4 stat card. */
const ga4CountEl  = document.getElementById('ga4-count');

/** Toggle checkbox that enables/disables the in-page hover-to-search tooltip. */
const tooltipToggleEl = document.getElementById('chk-tooltip');

// ── Persistent storage ────────────────────────────────────────────────────────

/**
 * The key used in chrome.storage.local to save and restore the last search.
 * chrome.storage.local survives browser restarts, making it the right choice
 * here (unlike session storage which clears when the browser closes).
 */
const LAST_SEARCH_KEY    = 'lastSearch';

/**
 * The key used in chrome.storage.local to persist the hover-to-search tooltip
 * preference. content.js reads this same key on load and reacts to changes via
 * chrome.storage.onChanged, so there is no need to send a runtime message.
 */
const TOOLTIP_ENABLED_KEY = 'tooltipEnabled';

/**
 * Saves the most recently executed search term and source checkbox state to
 * chrome.storage.local so it can be restored the next time the popup opens.
 *
 * Stored shape: { term: string, sources: string[] }
 * e.g. { term: "5061088861087_BQ", sources: ["dataLayer", "ga4"] }
 *
 * @param {string}   term    - The search term that was just executed.
 * @param {string[]} sources - Active sources, e.g. ['dataLayer', 'ga4'].
 */
function saveLastSearch(term, sources) {
  chrome.storage.local.set({ [LAST_SEARCH_KEY]: { term, sources } });
}

/**
 * Reads the last saved search from chrome.storage.local.
 * Returns null if nothing has been saved yet (first use).
 *
 * @returns {Promise<{term: string, sources: string[]}|null>}
 */
function loadLastSearch() {
  return new Promise(resolve => {
    chrome.storage.local.get(LAST_SEARCH_KEY, data => {
      resolve(data[LAST_SEARCH_KEY] || null);
    });
  });
}

/**
 * Applies a saved search state to the UI — restores the term in the input
 * and ticks/unticks the source checkboxes to match the saved selection.
 *
 * Always ensures at least one checkbox ends up checked (safety guard).
 *
 * @param {{term: string, sources: string[]}} saved - Saved search state.
 */
function applySavedSearch(saved) {
  searchInput.value = saved.term;
  chkDL.checked     = saved.sources.includes('dataLayer');
  chkGA4.checked    = saved.sources.includes('ga4');

  // Guard: if somehow both ended up unchecked, enable both.
  if (!chkDL.checked && !chkGA4.checked) {
    chkDL.checked = chkGA4.checked = true;
  }
}

// ── Tooltip preference ────────────────────────────────────────────────────────

/**
 * Reads the saved tooltip preference from chrome.storage.local and sets the
 * toggle checkbox to match. Defaults to `true` (enabled) if the key has never
 * been written (i.e. first install).
 */
function loadTooltipPreference() {
  chrome.storage.local.get(TOOLTIP_ENABLED_KEY, data => {
    // If the key is absent (undefined), fall back to true — on by default.
    const enabled = data[TOOLTIP_ENABLED_KEY] !== false;
    tooltipToggleEl.checked = enabled;
  });
}

/**
 * Listens for changes to the tooltip toggle and persists the new value to
 * chrome.storage.local. content.js listens to chrome.storage.onChanged so it
 * reacts immediately — no separate runtime message is required.
 */
tooltipToggleEl.addEventListener('change', () => {
  chrome.storage.local.set({ [TOOLTIP_ENABLED_KEY]: tooltipToggleEl.checked });
});

// ── Initialisation ────────────────────────────────────────────────────────────

/**
 * Runs once when the popup opens.
 *
 * Pre-fill priority (highest → lowest):
 *   1. A term stored by background.js from a right-click context menu action
 *      or from the in-page selection tooltip button.
 *   2. Text currently selected (highlighted) on the active tab.
 *   3. The last search term and source state from chrome.storage.local.
 *   4. Empty — user types their own term.
 *
 * After pre-filling, the search is run automatically so the user sees results
 * immediately without having to press a button.
 */
async function init() {
  // Notify background.js we're open; it replies with any pending search term
  // queued from a right-click context menu or an in-page tooltip button click.
  const bg = await chromeMessage({ type: 'POPUP_OPENED' });

  if (bg?.pendingSearch?.term) {
    // Case 1: term was explicitly queued from outside the popup.
    // Don't restore checkbox state here — the user's active source selection
    // from the last search still applies.
    searchInput.value = bg.pendingSearch.term;

  } else {
    // Case 2: try to read whatever text is highlighted on the active tab right now.
    const sel = await contentMessage({ type: 'GET_SELECTION' });

    if (sel?.text) {
      searchInput.value = sel.text;
    } else {
      // Case 3: no contextual term available — restore the last saved search,
      // including the source checkbox state.
      const last = await loadLastSearch();
      if (last) applySavedSearch(last);
    }
  }

  // Restore the tooltip toggle to its last-saved state.
  loadTooltipPreference();

  // Show live event counts while the user reads the UI.
  refreshCounts();

  // Auto-search whenever a term is present so the user sees results immediately.
  if (searchInput.value.trim()) runSearch();
}

/**
 * Asks content.js (→ injected.js) for the current number of captured events
 * and updates the count badges in the header bar.
 */
async function refreshCounts() {
  const resp = await contentMessage({ type: 'GET_COUNT' });
  const c = resp?.counts;
  if (c) {
    // Write the bare number — the static HTML label (e.g. "dataLayer pushes")
    // is already in the .count-label span below it.
    dlCountEl.textContent  = c.dl;
    ga4CountEl.textContent = c.ga4;
  }
}

// ── Search ────────────────────────────────────────────────────────────────────

/**
 * Reads the search term and selected sources, sends a SEARCH message to
 * content.js, waits for results, then delegates to renderResults().
 *
 * Guards against:
 *   • Empty search term.
 *   • No sources selected (at least one checkbox must be checked).
 *   • content.js not responding (e.g. on a chrome:// page).
 *
 * On success, saves the term and source state to chrome.storage.local so
 * the next popup open can restore it automatically.
 */
async function runSearch() {
  const term = searchInput.value.trim();
  if (!term) {
    showStatus('Type a search term above.', 'info');
    return;
  }

  // Collect which sources to search based on checkbox state.
  const sources = [];
  if (chkDL.checked)  sources.push('dataLayer');
  if (chkGA4.checked) sources.push('ga4');
  if (!sources.length) {
    showStatus('Select at least one source.', 'info');
    return;
  }

  // Show loading state.
  searchBtn.disabled    = true;
  searchBtn.textContent = 'Searching…';
  hideStatus();
  resultsEl.innerHTML   = '';

  const resp = await contentMessage({ type: 'SEARCH', term, sources });

  // Restore button regardless of outcome.
  searchBtn.disabled    = false;
  searchBtn.textContent = 'Search';

  if (!resp?.ok) {
    // content.js didn't respond — likely because the extension isn't injected
    // on this page (e.g. chrome:// URLs, extension pages, or new tab).
    showStatus('Could not reach the page. Try reloading.', 'error');
    return;
  }

  // Persist this search so the next popup open can restore it automatically.
  saveLastSearch(term, sources);

  renderResults(resp.results, term);

  // Refresh counts in case new events arrived during the search.
  refreshCounts();
}

// ── Rendering ─────────────────────────────────────────────────────────────────

/**
 * Renders the search results object returned by injected.js into the results
 * container. Groups results under "DataLayer" and "GA4 Events" section headings.
 *
 * If there are no matches at all, shows a status message instead.
 *
 * @param {{dataLayer: Array|null, ga4: Array|null}} results - Search results from injected.js.
 * @param {string} term - The search term (used in the "no results" message).
 */
function renderResults({ dataLayer, ga4 }, term) {
  const dlHits  = dataLayer || [];
  const ga4Hits = ga4 || [];
  const total   = dlHits.length + ga4Hits.length;

  if (!total) {
    showStatus(`No matches for "${esc(term)}" in selected sources.`, 'none');
    return;
  }

  hideStatus();

  // DataLayer section
  if (dlHits.length) {
    const heading = document.createElement('div');
    heading.className   = 'section-heading';
    heading.textContent = `DataLayer (${dlHits.length} event${dlHits.length > 1 ? 's' : ''})`;
    resultsEl.appendChild(heading);
    dlHits.forEach(hit => resultsEl.appendChild(makeCard(hit, 'dl')));
  }

  // GA4 Events section
  if (ga4Hits.length) {
    const heading = document.createElement('div');
    heading.className   = 'section-heading';
    heading.textContent = `GA4 Events (${ga4Hits.length} event${ga4Hits.length > 1 ? 's' : ''})`;
    resultsEl.appendChild(heading);
    ga4Hits.forEach(hit => resultsEl.appendChild(makeCard(hit, 'ga4')));
  }
}

/**
 * Builds a collapsible result card DOM element for a single matched event.
 *
 * Card structure:
 *   ┌── result-card ────────────────────────────────────────────┐
 *   │  [header]  event name · MID badge · source badge · time · ▶ │  ← click to toggle
 *   │  [body]    path → value                                    │  ← one row per hit
 *   │            path → value                                    │
 *   └────────────────────────────────────────────────────────────┘
 *
 * Source badge variants:
 *   "dataLayer" (blue)       – GTM dataLayer push
 *   "GA4"       (aquamarine) – GA4 event (gtag() call or network hit)
 *
 * Measurement ID badge (GA4 cards only):
 *   Shown when a Measurement ID was captured from a gtag('config', …) call
 *   or from the `tid` parameter in a network hit. Displays the GA4 property
 *   ID (e.g. G-ABC123XYZ) so you can tell which property the event belongs
 *   to on multi-tag pages.
 *
 * All user-derived strings are HTML-escaped via esc() before insertion.
 *
 * @param {object} hit  - A single result entry from searchDataLayer() or searchGA4().
 * @param {string} type - 'dl' for dataLayer hits, 'ga4' for GA4 hits.
 * @returns {HTMLElement} The card element, ready to append.
 */
function makeCard(hit, type) {
  const card = document.createElement('div');
  card.className = 'result-card';

  // All GA4 events (whether captured via gtag() or network interception) show
  // a single "GA4" badge — the distinction isn't useful to the end user.
  const sourceLabel = type === 'dl'
    ? '<span class="event-source source-dl">dataLayer</span>'
    : '<span class="event-source source-ga4">GA4</span>';

  // Measurement ID badge — only shown on GA4 cards when an ID is known.
  // On pages with multiple GA4 properties, the ID helps identify which
  // property fired the event.
  const midBadge = (type === 'ga4' && hit.measurementId)
    ? `<span class="event-mid" title="GA4 Measurement ID">${esc(hit.measurementId)}</span>`
    : '';

  // Format the capture timestamp as HH:MM:SS for a compact display.
  const time = hit.timestamp
    ? new Date(hit.timestamp).toLocaleTimeString([], { hour12: false })
    : '';

  // Build the card HTML. innerHTML is used for conciseness; all dynamic
  // values are passed through esc() to prevent XSS from page data.
  //
  // The header uses a two-row layout:
  //   Row 1 (card-header-main):  event name (full width) + chevron
  //   Row 2 (card-header-meta):  MID badge (if present) + source badge + time
  //
  // Keeping the event name on its own row means it is never squeezed by
  // a long Measurement ID string, regardless of how many IDs are active.
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

  // Toggle the card body open/closed when the header is clicked.
  card.querySelector('.result-card-header').addEventListener('click', () => {
    card.classList.toggle('open');
  });

  // Start all cards expanded so the user immediately sees the matched paths.
  card.classList.add('open');

  return card;
}

// ── Status helpers ────────────────────────────────────────────────────────────

/**
 * Displays a status message bar with a given visual style.
 *
 * @param {string} msg  - HTML string to display (safe to pass escaped strings).
 * @param {'info'|'error'|'none'} type - Controls the colour scheme via CSS class.
 */
function showStatus(msg, type = 'info') {
  statusEl.className = `status ${type}`;
  statusEl.innerHTML = msg;
}

/** Hides the status bar without removing it from the DOM layout. */
function hideStatus() {
  statusEl.className   = 'status hidden';
  statusEl.textContent = '';
}

// ── Chrome messaging helpers ──────────────────────────────────────────────────

/**
 * Sends a message to the extension service worker (background.js) and returns
 * a Promise that resolves with the response.
 *
 * Wraps the callback-based chrome.runtime.sendMessage in a Promise so it can
 * be awaited. Resolves with null on any error (e.g. no background page).
 *
 * @param {object} msg - Message payload.
 * @returns {Promise<*>}
 */
function chromeMessage(msg) {
  return new Promise(resolve => {
    try {
      chrome.runtime.sendMessage(msg, resp => resolve(resp || null));
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * Sends a message to content.js running in the currently active tab and
 * returns a Promise that resolves with the response.
 *
 * Must query for the active tab first because the popup has no direct
 * reference to which tab it was opened on.
 *
 * Resolves with null if:
 *   • No active tab is found.
 *   • content.js has not loaded (e.g. chrome:// page, extension page).
 *   • chrome.runtime.lastError is set (suppresses uncaught error in console).
 *
 * @param {object} msg - Message payload.
 * @returns {Promise<*>}
 */
async function contentMessage(msg) {
  return new Promise(resolve => {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        const tab = tabs?.[0];
        if (!tab?.id) return resolve(null);

        chrome.tabs.sendMessage(tab.id, msg, resp => {
          // Accessing lastError suppresses the "Could not establish connection"
          // error that Chrome logs when no listener is present on the other end.
          if (chrome.runtime.lastError) return resolve(null);
          resolve(resp || null);
        });
      });
    } catch (_) {
      resolve(null);
    }
  });
}

/**
 * Escapes a string for safe insertion into innerHTML, preventing XSS from
 * values that originated in the page's own dataLayer or GA4 events.
 *
 * @param {string} str - Raw string to escape.
 * @returns {string} HTML-safe string.
 */
function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Event listeners ───────────────────────────────────────────────────────────

/** Trigger search when the Search button is clicked. */
searchBtn.addEventListener('click', runSearch);

/** Allow the user to submit the search by pressing Enter in the text field. */
searchInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') runSearch();
});

/**
 * Prevent both checkboxes from being unchecked simultaneously.
 * If the user unchecks one and the other is already unchecked, the one they
 * just clicked is immediately re-checked, maintaining at least one active source.
 */
[chkDL, chkGA4].forEach(chk => {
  chk.addEventListener('change', () => {
    if (!chkDL.checked && !chkGA4.checked) {
      chk.checked = true; // re-check the one the user just unchecked
    }
  });
});

// ── Entry point ───────────────────────────────────────────────────────────────

init();
