# Layer Lens

A Chrome extension for searching for particular values in GTM dataLayer pushes and GA4 events on any website in real time.

Built for developers, analysts, and anyone who needs to quickly verify what tracking data is being collected as they browse — without opening DevTools or digging through network requests manually.

---

## Features

- **Real-time capture**: Intercepts `dataLayer.push()` calls and GA4 network hits as they happen, from page load onwards.
- **Instant search**: Search across all captured events for any value (product ID, user ID, event name, parameter value, etc.).
- **Email check**: Enter an email address to find it anywhere in captured data — in plain text or as a SHA-256 hash (as used by GA4 Enhanced Conversions). Checks all case variants automatically.
- **Smart hover-to-search**: Highlight any text and a "Search with Layer Lens" button appears. If the selected text looks like an email address, the extension automatically runs both the event search and the email PII check simultaneously.
- **GA4 ecommerce decoding**: Compact tilde-delimited GA4 item format (e.g. `pr1=id~nm~br~...`) is decoded into full, readable field names like `item_name`, `item_brand`, `item_category`.
- **Server-side GTM support**: Catches GA4 hits proxied through first-party domains (sGTM), not just `google-analytics.com`.
- **Measurement ID display**: Shows the GA4 property ID (`G-XXXXXXXX`) on each GA4 event card — handy if you have multiple Google tags or properties on a page.
- **Right-click search**: Right-click any selected text and choose "Search DataLayer for…" from the context menu.
- **Tab interface**: Switch between the Events tab and the Email Check tab; results are preserved on both tabs so you can switch back and forth without re-running searches.
- **Source filtering**: Restrict searches to dataLayer only, GA4 only, or both — available on both tabs.
- **Persistent last search**: Remembers your last search term, source selection, and last checked email address across popup opens.
- **Cohn the Layer Lens mascot icon**: One of my beloved spaniels as the icon — because who doesn't want to see a cute pup in their browser?

---

## How it works

Layer Lens injects two scripts into every page:

| Script | World | Purpose |
|---|---|---|
| `injected.js` | MAIN | Wraps `dataLayer.push`, `gtag()`, `fetch`, `XHR`, and `sendBeacon` to capture events as they fire |
| `content.js` | ISOLATED | Bridges messages between the popup and `injected.js`; renders the in-page selection tooltip |

Events are stored in memory within the page tab. When you open the popup and run a search, it queries the captured events via a message bridge and displays matching results with the exact parameter path and value highlighted.

---

## Installation

### Chrome Web Store (recommended)

Install directly from the Chrome Web Store — no setup required:

**[Install Layer Lens on the Chrome Web Store](https://chromewebstore.google.com/detail/layer-lens/fhmgghjjjfminjjobiibekgcnhggnpmb)**

---

### Developer mode (for testing local changes)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `datalayer-inspector` folder
5. The Layer Lens icon will appear in your toolbar

To update after making code changes: go back to `chrome://extensions` and click the **refresh icon** on the Layer Lens card.

#### Dev vs production icons

When testing a local build alongside the published version, you can switch to a dev icon (orange badge) so you know which one you're using:

```bash
./use-dev-icons.sh        # toggle to dev icon (orange badge)
./use-dev-icons.sh        # run again to toggle back to production icon
```

---

## Usage

### Searching for events

1. Navigate to any page you want to inspect
2. Click the Layer Lens icon in the toolbar
3. On the **Events** tab, type a search term (product name, EAN, event name, user ID — anything) and press **Search** or hit Enter
4. Results show each matching event as a card, with the exact parameter path and value where the term was found

### Email check

1. Click the **Email Check** tab in the popup
2. Enter an email address and click **Check**
3. Layer Lens searches for the email address in plain text (any case) and as a SHA-256 hash across all captured dataLayer and GA4 data
4. Results are grouped: red **⚠ Plain text** matches indicate the email is exposed unencrypted; amber **⚠ SHA-256 hash** matches indicate it is present in hashed form (common for GA4 Enhanced Conversions)
5. The last checked email is remembered so you don't have to re-enter it

### Hover-to-search

1. Highlight any text on the page with your mouse
2. A small "Search with Layer Lens" button appears above the selection
3. Click it — the popup opens and searches automatically
4. If the selected text looks like an email address, both the Events search and the Email Check run automatically and you land on the Email Check tab
5. To disable this feature, open the popup and toggle off **Hover-to-search tooltip** in the Events tab

### Right-click search

1. Select text on any page
2. Right-click → **Search DataLayer for "…"**
3. The popup opens and runs the search automatically

### Filtering by source

Use the **DataLayer** and **GA4 Events** checkboxes on either tab to narrow results to one source. At least one must remain checked.

---

## Understanding results

Each result card shows:

- **Event name**: The `event` key from a dataLayer push, or the GA4 event name (e.g. `view_item`, `purchase`)
- **Source badge**: `dataLayer` (blue) or `GA4` (aquamarine)
- **Measurement ID**: For GA4 events, the `G-XXXXXXXX` property ID the hit was sent to
- **Matched path**: The exact parameter path where your search term was found (e.g. `ecommerce.items[0].item_name`)
- **Matched value**: The actual value at that path
- **Timestamp**: When the event was captured

GA4 ecommerce items show decoded field names wherever possible (e.g. `nm` → `item_name`, `pr` → `price`).

---

## Permissions

| Permission | Why it's needed |
|---|---|
| `activeTab` | Send messages to the active tab and read its URL |
| `contextMenus` | Create the right-click "Search DataLayer for…" menu item |
| `storage` | Persist the last search term, source selection, tooltip preference, and last checked email across sessions |
| `<all_urls>` | Inject content scripts into all pages so events are captured on any site you visit |

Layer Lens does not transmit any data externally. All captured events stay in the tab's memory and are never sent anywhere. SHA-256 hashing for the email PII check is performed entirely in-browser using the Web Crypto API.

---

## File structure

```
datalayer-inspector/
├── manifest.json        — Extension manifest (Manifest V3)
├── background.js        — Service worker: context menu, popup messaging
├── injected.js          — MAIN world: dataLayer/GA4/network interception
├── content.js           — ISOLATED world: message bridge + selection tooltip
├── popup.html           — Popup UI markup
├── popup.js             — Popup UI logic
├── popup.css            — Popup styles
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── MANIFEST_NOTES.md    — Extended notes on manifest.json fields
```

---

## Compatibility

- **Chrome** 99+ (uses `chrome.action.openPopup()`)
- Manifest V3
- Does not interfere with other analytics debugging extensions (Omnibug, Tag Assistant, etc.) — all API wrappers call through to the original

---

## Licence

MIT
