/**
 * background.js — Extension service worker
 *
 * In Manifest V3, the background script runs as a service worker rather than
 * a persistent background page. This means it can be terminated by Chrome at
 * any time when idle and is restarted on demand (e.g. when an event fires).
 *
 * Responsibilities
 * ────────────────
 *   1. Create the right-click context menu item so users can search for
 *      selected text without manually opening the popup.
 *   2. Handle OPEN_POPUP_WITH_TERM messages sent by the in-page selection
 *      tooltip in content.js when the user clicks "Search with DataLayer
 *      Inspector".
 *   3. For both of the above: store the search term in session storage and
 *      attempt to open the popup programmatically, falling back to a badge.
 *   4. When the popup announces it has opened (POPUP_OPENED), return any
 *      pending term, clear it from storage, and clear the badge.
 *
 * The context menu and the in-page tooltip use exactly the same storage +
 * open-popup pathway. popup.js reads from that single location (pendingSearch)
 * regardless of which trigger fired, keeping the popup code simple.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Shared helper — store a term and open the popup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Stores `term` as a pending search in chrome.storage.session so popup.js can
 * retrieve it on open, then attempts to programmatically open the popup.
 *
 * If chrome.action.openPopup() is unavailable or fails (it requires Chrome 99+
 * and the window must be in focus), a badge '!' is set on the extension icon
 * as a visual cue prompting the user to click the icon manually.
 *
 * This function is intentionally shared between the context-menu handler and
 * the OPEN_POPUP_WITH_TERM message handler so the two code paths stay in sync.
 *
 * @param {string} term  - The search term to queue.
 * @param {number} tabId - The ID of the tab the term came from (used for badge).
 */
function queueSearchAndOpenPopup(term, tabId) {
  // Persist the term so popup.js can read it during its POPUP_OPENED handshake.
  chrome.storage.session.set({ pendingSearch: { term, tabId } });

  // Attempt to open the popup programmatically (Chrome 99+).
  // Optional chaining guards against older Chrome versions where the method
  // doesn't exist. The .catch() handles cases where it exists but fails
  // (e.g. the browser window isn't currently in the foreground).
  chrome.action.openPopup?.().catch(() => {
    // openPopup failed — fall back to a badge on the icon to signal the user.
    chrome.action.setBadgeText({ text: '!', tabId });
    chrome.action.setBadgeBackgroundColor({ color: '#4f46e5', tabId });
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Context menu setup
// ─────────────────────────────────────────────────────────────────────────────

/**
 * onInstalled fires when the extension is first installed, updated, or when
 * Chrome is updated. We create the context menu item here rather than at the
 * top level: the service worker can restart at any time, and calling
 * contextMenus.create() outside onInstalled would produce a duplicate-id error
 * on restart.
 *
 * The "%s" placeholder is automatically replaced by Chrome with the selected
 * text, producing e.g. 'Search DataLayer for "EAN123456"'.
 */
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id:       'dli_search_selection',       // unique ID referenced in the click handler
    title:    'Search DataLayer for "%s"',  // %s = user's selected text
    contexts: ['selection'],                // only appears when text is selected
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Context menu click handler
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fires when the user clicks the context menu item.
 *
 * We cannot pass data directly to the popup here because popup.js hasn't
 * loaded yet at this point. Instead we use the shared queueSearchAndOpenPopup()
 * helper to store the term and attempt to open the popup. When popup.js does
 * load, it sends POPUP_OPENED to retrieve the queued term.
 *
 * @param {chrome.contextMenus.OnClickData} info
 * @param {chrome.tabs.Tab}                 tab
 */
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'dli_search_selection') return; // guard: our item only

  const term = info.selectionText?.trim();
  if (!term || !tab?.id) return;

  queueSearchAndOpenPopup(term, tab.id);
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Message listener
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Handles two message types:
 *
 * ── OPEN_POPUP_WITH_TERM (sent by content.js tooltip button) ──────────────
 * The user clicked "Search with Layer Lens" in the in-page tooltip.
 * content.js sends us the selected text and we queue + open via the same
 * shared helper used by the context menu, keeping both pathways identical.
 *
 * sender.tab.id gives us the originating tab ID for badge management.
 *
 * ── POPUP_OPENED (sent by popup.js on startup) ────────────────────────────
 * popup.js sends this on every open to collect any pending search term that
 * was queued by either the context menu or the tooltip button.
 *
 * We:
 *   a) Return the stored pendingSearch (may be null if opened without a trigger).
 *   b) Remove it from storage — it's a one-shot value.
 *   c) Clear the badge on the originating tab (if one was set as a fallback).
 *
 * `return true` is required whenever sendResponse is called inside an async
 * callback; it keeps the Chrome messaging port open until we reply.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── In-page tooltip button clicked ───────────────────────────────────────
  if (msg.type === 'OPEN_POPUP_WITH_TERM') {
    const tabId = sender.tab?.id;
    if (msg.term && tabId) {
      queueSearchAndOpenPopup(msg.term, tabId);
    }
    sendResponse({ ok: true });
    // Synchronous — no `return true` needed (sendResponse called immediately).
    return;
  }

  // ── Popup has opened — return any queued term ─────────────────────────────
  if (msg.type === 'POPUP_OPENED') {
    chrome.storage.session.get('pendingSearch', data => {
      // Reply with the stored term (or null if nothing was queued).
      sendResponse({ pendingSearch: data.pendingSearch || null });

      // One-shot: remove the entry so the next popup open doesn't reuse it.
      chrome.storage.session.remove('pendingSearch');

      // Clear the badge that was set as a fallback when openPopup() failed.
      if (data.pendingSearch?.tabId) {
        chrome.action.setBadgeText({ text: '', tabId: data.pendingSearch.tabId });
      }
    });
    return true; // async — keep port open until the storage callback fires
  }
});
