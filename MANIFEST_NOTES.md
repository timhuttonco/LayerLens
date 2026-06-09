# manifest.json — field notes

JSON does not support comments, so explanations for each field live here.

## manifest_version: 3
Manifest V3 is the current Chrome extension platform. Key differences from V2:
- Background pages are replaced by **service workers** (can be terminated when idle).
- `"world": "MAIN"` in content_scripts lets a script run in the page's own JS context,
  enabling dataLayer/gtag interception.
- Stricter Content Security Policy — no inline scripts in HTML pages.

## permissions
| Permission     | Why it's needed |
|----------------|-----------------|
| `activeTab`    | Send messages to the currently active tab and read its URL. |
| `scripting`    | Required by some Chrome versions when MAIN-world content scripts are used. |
| `contextMenus` | Create the right-click "Search DataLayer for…" context menu item. |
| `storage`      | `chrome.storage.session` passes the context-menu search term from background.js to the popup. |

## host_permissions: `<all_urls>`
Allows content scripts to inject into **all** pages, not just the tab the
user explicitly interacts with. Without this, `injected.js` would miss events
fired on page load before the popup was opened.

## background.service_worker
`background.js` runs as a service worker. Chrome may terminate it when idle
and restarts it automatically when an event (e.g. `contextMenus.onClicked`) fires.

## action
Defines the toolbar button. `default_popup` is the HTML page shown on click.
`default_icon` lists PNG icons at three sizes; Chrome picks the best fit for the
display density.

## content_scripts
Two scripts are injected into every page:

### injected.js (world: MAIN)
Runs in the **page's own JavaScript context** so it can intercept
`window.dataLayer`, `window.gtag`, `fetch`, `XHR`, and `sendBeacon`.
Must run at `document_start` — before any page scripts — so that dataLayer
pushes on page load are not missed.

### content.js (world: ISOLATED — default)
Runs in Chrome's sandboxed content-script sandbox. Cannot access page
variables directly, but relays `chrome.runtime` messages from the popup to
`injected.js` via `window` CustomEvents. Also runs at `document_start`.
