/**
 * content.js — Isolated-world bridge + in-page selection tooltip
 *
 * This script runs in Chrome's default "ISOLATED" content-script world, which
 * means it shares the page's DOM but has its own separate JavaScript scope —
 * it cannot directly access variables defined by the page or by injected.js.
 *
 * Responsibilities
 * ────────────────
 * 1. Message bridge — relays chrome.runtime messages from popup.js to
 *    injected.js (MAIN world) via CustomEvents on window, and relays the
 *    responses back.
 *
 * 2. Selection tooltip — listens for text selections on the page and renders
 *    a floating "Search with Layer Lens" button above the selected
 *    text, along with Cohn, the Layer Lens mascot. Clicking it sends the 
 *    selection to background.js, which stores it as a pending search term 
 *    and programmatically opens the popup.
 *
 * Communication diagram
 * ─────────────────────
 *   popup.js  ──chrome.runtime.sendMessage──▶  content.js
 *   content.js ──CustomEvent on window──────▶  injected.js (MAIN world)
 *   injected.js ──CustomEvent on window─────▶  content.js
 *   content.js ──sendResponse───────────────▶  popup.js
 *
 *   [page selection] ──mouseup──▶ content.js (tooltip shown)
 *   [tooltip click]  ──────────▶ content.js
 *   content.js ──chrome.runtime.sendMessage──▶ background.js (OPEN_POPUP_WITH_TERM)
 *
 * Why CustomEvents for the MAIN/ISOLATED bridge?
 * Both content.js and injected.js share access to the same DOM window object,
 * making window.dispatchEvent / window.addEventListener the only reliable
 * bridge between the two worlds without injecting extra <script> tags.
 *
 * Why Shadow DOM for the tooltip?
 * The tooltip is injected into the live page DOM. Without style isolation,
 * the page's own CSS could override the tooltip's fonts, colours, and layout
 * in unpredictable ways. Attaching a Shadow root gives the tooltip a completely
 * separate style scope that the page cannot reach.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Section 1 — Message bridge (popup.js ↔ injected.js)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Map of in-flight request IDs to their resolve functions.
 * Key is either a numeric request id or the string '__count__'.
 * @type {Object.<string|number, function>}
 */
let pendingRequests = {};

/**
 * Increasing counter used to generate unique request IDs.
 * Ensures that if two search requests somehow overlap, their responses
 * are matched to the correct Promise.
 * @type {number}
 */
let requestCounter = 0;

// ── Listeners for responses arriving from injected.js (MAIN world) ───────────

/**
 * Receives search results dispatched by injected.js in response to a
 * '__dli_request__' CustomEvent. Resolves the pending Promise for this id.
 */
window.addEventListener('__dli_response__', e => {
  if (!e.detail) return;
  const { id, dataLayer, ga4 } = e.detail;
  const resolve = pendingRequests[id];
  if (resolve) {
    delete pendingRequests[id]; // clean up so the entry doesn't linger
    resolve({ dataLayer, ga4 });
  }
});

/**
 * Receives the event count dispatched by injected.js in response to a
 * '__dli_getcount__' CustomEvent. Uses the fixed key '__count__' rather than
 * a numeric id because only one count request can be in-flight at a time.
 */
window.addEventListener('__dli_count__', e => {
  if (!e.detail) return;
  const resolve = pendingRequests['__count__'];
  if (resolve) {
    delete pendingRequests['__count__'];
    resolve(e.detail); // e.detail = { dl: number, ga4: number }
  }
});

// ── Helpers for dispatching requests to injected.js ───────────────────────────

/**
 * Dispatches a CustomEvent to injected.js and returns a Promise that resolves
 * when the corresponding response CustomEvent arrives (or after a 3s timeout).
 *
 * The timeout guards against injected.js failing to load (e.g. on a page that
 * was already loaded before the extension was installed) — the popup will get
 * a null response instead of hanging indefinitely.
 *
 * @param {string} eventName - The CustomEvent name to dispatch.
 * @param {object} detail    - Payload; a numeric `id` is added automatically.
 * @returns {Promise<*>}     - Resolves with the response, or null on timeout.
 */
function sendToPage(eventName, detail) {
  return new Promise(resolve => {
    const id = requestCounter++;
    detail.id = id;                   // tag so the matching response can be found
    pendingRequests[id] = resolve;
    window.dispatchEvent(new CustomEvent(eventName, { detail }));

    // Safety timeout: unblock after 3s if injected.js never responds.
    setTimeout(() => {
      if (pendingRequests[id]) {
        delete pendingRequests[id];
        resolve(null);
      }
    }, 3000);
  });
}

/**
 * Asks injected.js for the current count of captured events.
 * Uses a shorter 1s timeout — this is a trivial, fast query.
 *
 * @returns {Promise<{dl: number, ga4: number}>}
 */
function getCount() {
  return new Promise(resolve => {
    pendingRequests['__count__'] = resolve;
    window.dispatchEvent(new CustomEvent('__dli_getcount__', { detail: {} }));

    setTimeout(() => {
      if (pendingRequests['__count__']) {
        delete pendingRequests['__count__'];
        resolve({ dl: 0, ga4: 0 }); // safe default if injected.js is silent
      }
    }, 1000);
  });
}

// ── chrome.runtime message listener (receives requests from popup.js) ─────────

/**
 * Handles message types sent by popup.js:
 *
 *   SEARCH        – Forward a search to injected.js; return the results.
 *   GET_COUNT     – Return how many events have been captured so far.
 *   GET_SELECTION – Return whatever text the user currently has highlighted.
 *
 * Note: `return true` is required by the Chrome API whenever sendResponse will
 * be called inside an async callback; otherwise the port closes first.
 */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'SEARCH') {
    sendToPage('__dli_request__', { term: msg.term, sources: msg.sources })
      .then(results => sendResponse({ ok: true, results }))
      .catch(err   => sendResponse({ ok: false, error: String(err) }));
    return true; // async — keep port open
  }

  if (msg.type === 'GET_COUNT') {
    getCount()
      .then(counts => sendResponse({ ok: true, counts }))
      .catch(()    => sendResponse({ ok: true, counts: { dl: 0, ga4: 0 } }));
    return true; // async — keep port open
  }

  if (msg.type === 'GET_SELECTION') {
    // window.getSelection() reads the live text selection; available in the
    // isolated world without needing to touch the MAIN world at all.
    sendResponse({ text: window.getSelection()?.toString()?.trim() || '' });
    // Synchronous — no `return true` needed.
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Section 2 — In-page selection tooltip
// ─────────────────────────────────────────────────────────────────────────────
//
// When the user finishes selecting text on any page, a small floating button
// appears above the selection reading "Search with Layer Lens" and Cohn.
// Clicking it stores the selection as a pending search term and asks
// background.js to open the extension popup.
//
// Key implementation decisions:
//
//   Shadow DOM — The tooltip host element lives in the page's DOM but its
//   internals (button, styles) are inside a shadow root. This means the page's
//   CSS cannot cascade into it, preventing any site from inadvertently breaking
//   the tooltip's appearance.
//
//   position: fixed on the host — Range.getBoundingClientRect() returns
//   viewport-relative coordinates, so a fixed-position element can be placed
//   directly using those values without scroll-offset arithmetic.
//
//   pointer-events: none on the host — Makes the host element "transparent"
//   to mouse events everywhere except the inner button (which restores
//   pointer-events: auto). This means the tooltip never blocks clicks on the
//   page behind it.
//
//   Lazy creation — The tooltip DOM is only created when the user first makes
//   a selection. On pages where no selection is ever made, no extra DOM nodes
//   are added at all.

// ── Tooltip enabled/disabled preference ──────────────────────────────────────

/**
 * Whether the hover-to-search tooltip is currently active.
 *
 * Defaults to true — matches the popup's default checked state. This value is
 * kept in sync with chrome.storage.local (key: 'tooltipEnabled') so that:
 *   • On load: the saved preference is applied immediately.
 *   • While running: the popup's toggle takes effect in real time without
 *     requiring a page reload, via the chrome.storage.onChanged listener below.
 *
 * @type {boolean}
 */
let tooltipEnabled = true;

// Read the persisted preference on load.
chrome.storage.local.get('tooltipEnabled', data => {
  // Treat an absent key (first install) the same as true.
  tooltipEnabled = data.tooltipEnabled !== false;
  // If the user had the tooltip disabled and it somehow appeared, hide it now.
  if (!tooltipEnabled) hideTooltip();
});

// React immediately whenever the popup's toggle changes the stored value.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !('tooltipEnabled' in changes)) return;
  tooltipEnabled = changes.tooltipEnabled.newValue !== false;
  // If the feature was just turned off, dismiss any visible tooltip right away.
  if (!tooltipEnabled) hideTooltip();
});

/**
 * The host element appended to document.documentElement.
 * Created once on first selection; re-used for all subsequent selections.
 * @type {HTMLElement|null}
 */
let tooltipHost = null;

/**
 * The wrapper div inside the shadow root. Positioned via `transform` relative
 * to the host's top-left corner (which tracks the selection).
 * @type {HTMLElement|null}
 */
let tooltipWrapper = null;

/**
 * Creates the tooltip host and its Shadow DOM the first time it is needed.
 * Subsequent calls are no-ops because tooltipHost is already set.
 */
function ensureTooltip() {
  if (tooltipHost) return;

  // ── Host element ───────────────────────────────────────────────────────
  // fixed positioning + zero size: the host itself takes up no space.
  // The visible tooltip is rendered inside the shadow root using absolute
  // positioning relative to this host anchor point.
  tooltipHost = document.createElement('div');
  tooltipHost.setAttribute('id', '__dli_tooltip_host__');
  Object.assign(tooltipHost.style, {
    position:      'fixed',
    top:           '0',
    left:          '0',
    width:         '0',
    height:        '0',
    overflow:      'visible',
    zIndex:        '2147483647', // maximum possible z-index — above everything
    pointerEvents: 'none',      // host is invisible to clicks
    display:       'none',      // hidden until a selection is made
  });

  // ── Shadow root ────────────────────────────────────────────────────────
  // mode:'closed' — the shadow root is not accessible via element.shadowRoot,
  // giving a minor layer of protection against page scripts inspecting it.
  const shadow = tooltipHost.attachShadow({ mode: 'closed' });

  // ── Scoped styles ──────────────────────────────────────────────────────
  // These rules apply only inside this shadow root — the page cannot see or
  // override them.
  const style = document.createElement('style');
  style.textContent = `
    /*
     * .wrapper is absolutely positioned relative to the host anchor.
     * transform centres it horizontally and lifts it above the selection.
     * The 8px gap between tooltip and selection gives visual breathing room.
     *
     * Colours match the popup light theme:
     *   Navy  #1a3a5c — border, arrow
     *   Aqua  #0d9488 — icon stroke
     *   White #ffffff — button background
     */
    .wrapper {
      position:       absolute;
      top:            0;
      left:           0;
      transform:      translate(-50%, calc(-100% - 8px));
      pointer-events: auto;
      white-space:    nowrap;
    }

    /* Fade + rise animation on show */
    @keyframes dli-appear {
      from { opacity: 0; transform: translate(-50%, calc(-100% - 2px)); }
      to   { opacity: 1; transform: translate(-50%, calc(-100% - 8px)); }
    }
    .wrapper { animation: dli-appear 0.14s ease; }

    /* The visible pill button — white bg, navy border */
    button {
      display:       flex;
      align-items:   center;
      gap:           6px;
      padding:       6px 12px 6px 9px;
      background:    #ffffff;
      border:        1.5px solid #1a3a5c;
      border-radius: 20px;
      cursor:        pointer;
      color:         #0f2d4a;
      font-family:   -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      font-size:     12px;
      font-weight:   500;
      line-height:   1;
      box-shadow:    0 3px 12px rgba(26, 58, 92, 0.18), 0 1px 3px rgba(26, 58, 92, 0.12);
      transition:    background 0.12s, box-shadow 0.12s;
    }
    button:hover {
      background:  #f0f6fb;
      box-shadow:  0 4px 16px rgba(26, 58, 92, 0.25), 0 1px 4px rgba(26, 58, 92, 0.15);
    }
    button:active { background: #e4eef8; }

    /* Dog icon — sized to sit neatly beside the button text */
    img.dli-icon {
      width:        20px;
      height:       20px;
      object-fit:   contain;
      flex-shrink:  0;
      border-radius: 2px;
    }

    /* Downward-pointing arrow in navy, connecting the button to the selection */
    .wrapper::after {
      content:    '';
      position:   absolute;
      top:        100%;
      left:       50%;
      transform:  translateX(-50%);
      border:     5px solid transparent;
      border-top: 5px solid #1a3a5c;
    }
  `;

  // ── Button ─────────────────────────────────────────────────────────────
  const btn = document.createElement('button');
  btn.setAttribute('type', 'button');

  // Use chrome.runtime.getURL() to get the correct extension-internal URL for
  // the icon image — direct paths don't work inside Shadow DOM content scripts.
  const iconUrl = chrome.runtime.getURL('icons/icon48.png');
  btn.innerHTML = `
    <img class="dli-icon" src="${iconUrl}" alt="">
    Search with Layer Lens
  `;
  btn.addEventListener('click', onTooltipClick);

  // ── Assemble ───────────────────────────────────────────────────────────
  tooltipWrapper = document.createElement('div');
  tooltipWrapper.className = 'wrapper';
  tooltipWrapper.appendChild(btn);

  shadow.appendChild(style);
  shadow.appendChild(tooltipWrapper);

  // Append to <html> rather than <body> so it survives DOM reconstructions
  // that some SPAs perform on the <body> element during navigation.
  document.documentElement.appendChild(tooltipHost);
}

/**
 * Moves the tooltip anchor to the given viewport coordinates and makes it
 * visible. The tooltip's transform then positions it centred above that point.
 *
 * Horizontal clamping prevents the tooltip overflowing the left or right edge
 * of the viewport. We estimate the tooltip width as ~240px (measured manually);
 * half that is used as the minimum margin from each side.
 *
 * @param {number} x - Horizontal centre of the selection (viewport coords).
 * @param {number} y - Top edge of the selection (viewport coords).
 */
function positionAndShow(x, y) {
  ensureTooltip();

  // Clamp so the centred tooltip stays within the viewport horizontally.
  const halfWidth  = 120; // ~half of the rendered tooltip width
  const clampedX   = Math.max(halfWidth, Math.min(window.innerWidth - halfWidth, x));

  tooltipHost.style.left    = `${clampedX}px`;
  tooltipHost.style.top     = `${y}px`;
  tooltipHost.style.display = 'block';

  // Re-trigger the appear animation each time the tooltip is shown by briefly
  // removing and re-adding the wrapper element's animation class.
  if (tooltipWrapper) {
    tooltipWrapper.style.animation = 'none';
    // Force a reflow so the browser registers the animation removal.
    void tooltipWrapper.offsetWidth; // eslint-disable-line no-void
    tooltipWrapper.style.animation = '';
  }
}

/** Hides the tooltip without removing it from the DOM. */
function hideTooltip() {
  if (tooltipHost) tooltipHost.style.display = 'none';
}

/**
 * Called when the user clicks the "Search with Layer Lens" button.
 *
 * Captures the current selection, hides the tooltip, then sends an
 * OPEN_POPUP_WITH_TERM message to background.js. Background.js stores the
 * term as a pendingSearch entry and attempts to programmatically open the
 * popup — the same pathway used by the right-click context menu.
 *
 * @param {MouseEvent} e
 */
function looksLikeEmail(text) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text.trim());
}

function onTooltipClick(e) {
  e.preventDefault();
  e.stopPropagation();

  const text = window.getSelection()?.toString()?.trim();
  if (!text) return;

  hideTooltip();

  // If the selected text looks like an email, open the popup in email-check mode
  // so both the Email PII tab and Events tab are pre-filled and searched.
  if (looksLikeEmail(text)) {
    chrome.runtime.sendMessage({ type: 'OPEN_POPUP_WITH_EMAIL', email: text });
  } else {
    chrome.runtime.sendMessage({ type: 'OPEN_POPUP_WITH_TERM', term: text });
  }
}

// ── Selection event listeners ─────────────────────────────────────────────────

/**
 * Shows the tooltip after a mouse-driven selection is completed (mouseup).
 *
 * We use mouseup rather than selectionchange because selectionchange fires
 * continuously while the user is dragging — we only want to show the tooltip
 * once they have finished selecting.
 *
 * A minimal setTimeout(0) delay lets the browser finalise window.getSelection()
 * after the mouseup event fires, ensuring the selection is non-empty when we
 * check it.
 */
document.addEventListener('mouseup', e => {
  // If the feature has been disabled via the popup toggle, do nothing.
  if (!tooltipEnabled) return;

  // Ignore mouseup events that originated inside our own tooltip button —
  // those are handled by onTooltipClick and must not trigger a re-check.
  if (tooltipHost?.contains(e.target)) return;

  setTimeout(() => {
    // Re-check inside the timeout in case the setting changed during the delay.
    if (!tooltipEnabled) return;

    const selection = window.getSelection();
    const text      = selection?.toString()?.trim();

    if (!text) {
      hideTooltip();
      return;
    }

    try {
      // getBoundingClientRect() on the range gives viewport-relative coordinates
      // of the selected text — perfect for a fixed-position tooltip.
      const range = selection.getRangeAt(0);
      const rect  = range.getBoundingClientRect();

      // A zero-size rect means the selection is collapsed (no visible text).
      if (!rect.width && !rect.height) {
        hideTooltip();
        return;
      }

      // Anchor the tooltip at the horizontal mid-point of the selection,
      // at the top edge (so it appears above the selected text).
      positionAndShow(rect.left + rect.width / 2, rect.top);
    } catch (_) {
      hideTooltip();
    }
  }, 0);
});

/**
 * Hides the tooltip when the user starts a new mouse press anywhere on the
 * page (except on the tooltip button itself, which handles its own clicks).
 * This covers the case where the user clicks away to deselect.
 */
document.addEventListener('mousedown', e => {
  if (tooltipHost?.contains(e.target)) return;
  hideTooltip();
});

/**
 * Hides the tooltip whenever the selection is programmatically cleared — e.g.
 * the user presses Escape in a text field, or JavaScript calls
 * window.getSelection().removeAllRanges(). Also covers keyboard navigation
 * that clears a selection without producing a mousedown event.
 */
document.addEventListener('selectionchange', () => {
  const text = window.getSelection()?.toString()?.trim();
  if (!text) hideTooltip();
});
