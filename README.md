# Layer Lens

A Chrome extension for searching for particular values in GTM dataLayer pushes and GA4 events on any website in real time.

Built for developers, analysts, and anyone who needs to quickly verify what tracking data is being collected as they browse — without opening DevTools or digging through network requests manually.

---

## Features

- **Real-time capture**: Intercepts `dataLayer.push()` calls and GA4 network hits as they happen, from page load onwards.
- **Instant search**: Search across all captured events for any value (product ID, user ID, event name, parameter value, etc.).
- **GA4 ecommerce decoding**: Compact tilde-delimited GA4 item format (e.g. `pr1=id~nm~br~...`) is decoded into full, readable field names like `item_name`, `item_brand`, `item_category`
- **Server-side GTM support** — catches GA4 hits proxied through first-party domains (sGTM), not just `google-analytics.com`.
- **Measurement ID display**: Shows the GA4 property ID (`G-XXXXXXXX`) on each GA4 event card. Handy if you have multiple Google tags/properties on a page.
- **Hover-to-search tooltip**: Select any text on a page and a "Search with Layer Lens" button appears above it; click to open the extension and search instantly.
- **Right-click search**: Right-click any selected text and choose "Search DataLayer for…" from the context menu.
- **Persistent last search**: Remembers your last search term and source selection across popup opens.
- **Source filtering**: Restrict searches to dataLayer only, GA4 only, or both
- **Hover-to-search toggle**: Enable or disable the in-page tooltip from the popup settings
- **Cohn the Layer Lens mascot icon**: One of my beloved spaniels as the icon; because who doesn't want to see a cute pup in their browser?

---

## How it works

Layer Lens injects two scripts into every page:

| Script | World | Purpose |
|---|---|---|
| `injected.js` | MAIN | Wraps `dataLayer.push`, `gtag()`, `fetch`, `XHR`, and `sendBeacon` to capture events as they fire |
| `content.js` | ISOLATED | Bridges messages between the popup and `injected.js`; renders the in-page selection tooltip |

Events are stored in memory within the page tab. When you open the popup and run a search, it queries the captured events via a message bridge and displays matching results with the exact parameter path and value highlighted.

---

## Installation (developer mode)

1. Clone or download this repository
2. Open Chrome and go to `chrome://extensions`
3. Enable **Developer mode** (top-right toggle)
4. Click **Load unpacked** and select the `datalayer-inspector` folder
5. The Layer Lens icon will appear in your toolbar

To update after making code changes: go back to `chrome://extensions` and click the **refresh icon** on the Layer Lens card.

---

## Usage

### Searching

1. Navigate to any page you want to inspect
2. Click the Layer Lens icon in the toolbar
3. Type a search term (product name, EAN, event name, user ID — anything) and press **Search** or hit Enter
4. Results show each matching event as a card, with the exact parameter path and value where the term was found

### Hover-to-search

1. Highlight any text on the page with your mouse
2. A small "Search with Layer Lens" button appears above the selection
3. Click it — the popup opens and searches automatically
4. To disable this feature, open the popup and toggle off **Hover-to-search tooltip**

### Right-click search

1. Select text on any page
2. Right-click → **Search DataLayer for "…"**
3. The popup opens and runs the search automatically

### Filtering by source

Use the **DataLayer** and **GA4 Events** checkboxes to narrow results to one source. At least one must remain checked.

---

## Understanding results

Each result card shows:

- **Event name**: The `event` key from a dataLayer push, or the GA4 event name (e.g. `view_item`, `purchase`)
- **Source badge**: `dataLayer` (blue) or `GA4` (aquamarine)
- **Measurement ID**: For GA4 events, the `G-XXXXXXXX` property ID the hit was sent to
- **Matched path**: The exact parameter path where your search term was found (e.g. `ecommerce.items[0].item_name`)
- **Matched value**: The actual value at that path, highlighted
- **Timestamp**: When the event was captured

GA4 ecommerce items show decoded field names wherever possible (e.g. `nm` → `item_name`, `pr` → `price`).

---

## Permissions

| Permission | Why it's needed |
|---|---|
| `activeTab` | Send messages to the active tab and read its URL |
| `scripting` | Required when using MAIN-world content scripts in Manifest V3 |
| `contextMenus` | Create the right-click "Search DataLayer for…" menu item |
| `storage` | Persist the last search term, source selection, and tooltip preference across sessions |
| `<all_urls>` | Inject content scripts into all pages so events are captured on any site you visit |

Layer Lens does not transmit any data externally. All captured events stay in the tab's memory and are never sent anywhere.

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
