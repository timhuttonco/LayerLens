/**
 * injected.js — MAIN world content script
 *
 * Runs directly inside the page's own JavaScript context at document_start,
 * before ANY page scripts execute. That timing is critical: it lets us
 * intercept window.dataLayer and window.gtag before GTM or the gtag snippet
 * initialise them, so we never miss an event.
 *
 * Architecture note
 * ─────────────────
 * Chrome extensions have two separate JS worlds:
 *   • MAIN world  – shares the page's window object (this file).
 *   • ISOLATED world – content scripts' default sandbox (content.js).
 * The two worlds cannot share variables, so they communicate via CustomEvents
 * dispatched on the shared window object.
 *
 * What we intercept
 * ─────────────────
 *   1. window.dataLayer.push  – every GTM push (including initialisation).
 *   2. window.gtag('config')  – Measurement ID registration calls.
 *   3. window.gtag('event')   – direct GA4 event calls.
 *   4. window.fetch           – GA4 hits sent via the Fetch API.
 *   5. XMLHttpRequest.send    – GA4 hits sent via XHR.
 *   6. navigator.sendBeacon   – GA4 hits sent on page unload (most common
 *                               in modern gtag.js implementations).
 */

(function () {
  'use strict';

  /**
   * All captured GTM dataLayer push objects, in order of arrival.
   * Each entry: { timestamp: number, data: object }
   * @type {Array<{timestamp: number, data: object}>}
   */
  const DL_EVENTS = [];

  /**
   * All captured GA4 events, from gtag() calls and network hits.
   * Each entry: { timestamp, source, eventName, measurementId, params, items? }
   * @type {Array<object>}
   */
  const GA4_EVENTS = [];

  /**
   * Set of Measurement IDs seen in gtag('config', …) calls on this page.
   * e.g. Set { 'G-ABC123XYZ', 'G-DEF456UVW' }
   * Used to label GA4 events with their originating property.
   * @type {Set<string>}
   */
  const MEASUREMENT_IDS = new Set();

  // ─────────────────────────────────────────────────────────────────────────
  // 1. dataLayer interception
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Wraps the push method of a dataLayer array so every future push is
   * recorded in DL_EVENTS before being forwarded to the real array.
   *
   * We deep-clone each item so later mutations to the original object don't
   * corrupt our stored copy.
   *
   * @param {Array} arr - The dataLayer array instance to wrap.
   */
  function wrapDataLayer(arr) {
    const originalPush = arr.push.bind(arr);

    arr.push = function (...items) {
      items.forEach(item => {
        try {
          DL_EVENTS.push({
            timestamp: Date.now(),
            data: deepClone(item),
          });
        } catch (_) {
          // Swallow — never break the page's own dataLayer usage.
        }
      });
      return originalPush(...items);
    };
  }

  // Snapshot any items already in window.dataLayer and wrap its push method.
  if (Array.isArray(window.dataLayer)) {
    window.dataLayer.forEach(item => {
      try { DL_EVENTS.push({ timestamp: Date.now(), data: deepClone(item) }); } catch (_) {}
    });
    wrapDataLayer(window.dataLayer);
  }

  // Watch for SPAs that reset window.dataLayer to a new array by polling on a
  // short interval. We previously used Object.defineProperty here, but that
  // conflicted with GTM's own internal queue processor which also inspects the
  // property descriptor — causing GA4 network hits to never fire.
  let _lastDataLayer = window.dataLayer;
  setInterval(() => {
    const current = window.dataLayer;
    if (current && current !== _lastDataLayer && Array.isArray(current)) {
      _lastDataLayer = current;
      current.forEach(item => {
        try { DL_EVENTS.push({ timestamp: Date.now(), data: deepClone(item) }); } catch (_) {}
      });
      wrapDataLayer(current);
    }
  }, 500);

  // ─────────────────────────────────────────────────────────────────────────
  // 2 & 3. gtag() interception — config (Measurement ID) + events
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Processes a single gtag() call, capturing both config and event calls.
   *
   * gtag() call signatures we care about:
   *   gtag('config', 'G-XXXXXXXX')        — registers a Measurement ID
   *   gtag('config', 'G-XXXXXXXX', {...}) — same with extra config params
   *   gtag('event', 'purchase', {...})    — fires a GA4 event
   *
   * Capturing 'config' calls lets us associate every subsequent 'event' call
   * with the Measurement ID(s) active on this page.
   *
   * @param {Array} args - The arguments passed to gtag().
   */
  function captureGtagCall(args) {
    try {
      if (args[0] === 'config') {
        // args[1] is the Measurement ID string (e.g. 'G-ABC123XYZ').
        // We store all IDs seen on this page so we can label events correctly
        // even on sites with multiple GA4 properties (dual-tagging setups).
        const id = args[1];
        if (id && typeof id === 'string') {
          MEASUREMENT_IDS.add(id);
        }
      }

      if (args[0] === 'event') {
        GA4_EVENTS.push({
          timestamp:     Date.now(),
          source:        'gtag',
          eventName:     args[1],                    // e.g. 'purchase', 'view_item'
          measurementId: [...MEASUREMENT_IDS].join(', ') || null, // all IDs seen so far
          params:        deepClone(args[2] || {}),   // event parameters object
        });
      }
    } catch (_) {}
  }

  // Wrap any existing gtag before overwriting it.
  const _originalGtag = window.gtag;

  // Use a classic function (not arrow/rest) so `arguments` is the native
  // Arguments object — identical to the standard gtag snippet:
  //   function gtag(){dataLayer.push(arguments);}
  // GTM's queue processor distinguishes Arguments objects from plain arrays,
  // so the fallback must push `arguments` directly, not a rest-params array.
  window.gtag = function () {
    captureGtagCall([].slice.call(arguments));
    if (typeof _originalGtag === 'function') {
      return _originalGtag.apply(this, arguments);
    } else {
      // No real gtag loaded yet — replicate standard behaviour so GTM still
      // receives the call and can fire the GA4 network hit.
      (window.dataLayer = window.dataLayer || []).push(arguments);
    }
  };

  // Watch for gtag.js loading asynchronously and replacing window.gtag.
  // We previously used Object.defineProperty here, but that conflicted with
  // GTM/gtag.js internals which inspect the property descriptor of window.gtag
  // during initialisation — causing GA4 network hits to never fire.
  let _lastGtag = window.gtag;
  setInterval(() => {
    const current = window.gtag;
    if (current && current !== _lastGtag) {
      const captured = current;
      _lastGtag = window.gtag = function () {
        captureGtagCall([].slice.call(arguments));
        return captured.apply(this, arguments);
      };
    }
  }, 200);

  // ─────────────────────────────────────────────────────────────────────────
  // 4–6. Network-level GA4 hit interception
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Decides whether a network request is a GA4 collection hit and, if so,
   * parses and stores it. Called by the fetch, XHR, and sendBeacon overrides.
   *
   * Why three tiers?
   * ─────────────────
   * Tier 1 — Google's own domain
   *   Standard gtag.js sends directly to google-analytics.com.
   *
   * Tier 2 — Server-side GTM (sGTM) on a first-party domain
   *   Enterprise sites (like Net-a-Porter, B&Q, etc.) increasingly proxy GA4
   *   hits through their own subdomain for privacy compliance and performance.
   *   The endpoint path is still /g/collect — only the domain differs.
   *   e.g. https://analytics.net-a-porter.com/g/collect
   *        https://t.example.com/g/collect
   *
   * Tier 3 — Payload fingerprint
   *   A catch-all for non-standard paths that still carry GA4 Measurement
   *   Protocol v2 payloads. We look for both `tid=G-` (GA4 Measurement ID
   *   prefix — never appears in non-GA4 requests) AND `en=` (event name) to
   *   avoid false-positives on unrelated requests that happen to share params.
   *
   * @param {string} url  - Request URL.
   * @param {string} body - Request body (query-string format), if any.
   */
  function captureGA4Hit(url, body) {
    try {
      if (!url) return;

      // ── Build the combined search string ───────────────────────────────────
      // GA4 (and sGTM) typically sends shared params (v=, tid=) in the URL
      // query string and event-specific params (en=, ep.*) in the POST body.
      // We merge them so the parser sees everything in one flat string.
      //
      // Bug fix: use '&' when the URL already contains '?' — naively appending
      // '?body' produces a double-'?' which corrupts the first query segment
      // when the URL is re-parsed, hiding 'en=' and causing '(unknown)' names.
      let combined;
      if (body) {
        combined = url.includes('?') ? `${url}&${body}` : `${url}?${body}`;
      } else {
        combined = url;
      }

      // Detect JSON bodies early — some sGTM containers accept the newer GA4
      // Measurement Protocol JSON format rather than a query string.
      const trimmedBody = body ? body.trim() : '';
      const isJsonBody  = trimmedBody.startsWith('{') || trimmedBody.startsWith('[');

      // ── Tier 1: Google's own collection endpoints ─────────────────────────
      if (url.includes('google-analytics.com/g/collect') ||
          url.includes('google-analytics.com/collect')) {
        const parsed = isJsonBody
          ? parseGA4JsonBody(trimmedBody, url)
          : parseGA4CollectUrl(combined, url);
        if (parsed) GA4_EVENTS.push(parsed);
        return;
      }

      // ── Tier 2: Server-side GTM — /g/collect path on any (first-party) domain
      let parsedUrl;
      try { parsedUrl = new URL(url); } catch (_) { return; }

      if (parsedUrl.pathname === '/g/collect' ||
          parsedUrl.pathname.endsWith('/g/collect')) {
        const parsed = isJsonBody
          ? parseGA4JsonBody(trimmedBody, url)
          : parseGA4CollectUrl(combined, url);
        if (parsed) GA4_EVENTS.push(parsed);
        return;
      }

      // ── Tier 3: GA4 payload fingerprint — any endpoint, any domain
      if (combined.includes('tid=G-') && combined.includes('en=')) {
        const parsed = isJsonBody
          ? parseGA4JsonBody(trimmedBody, url)
          : parseGA4CollectUrl(combined, url);
        if (parsed) GA4_EVENTS.push(parsed);
      }
    } catch (_) {}
  }

  /**
   * Parses a GA4 Measurement Protocol JSON body into a structured event object.
   *
   * The GA4 MP JSON format (used by some sGTM containers and the Measurement
   * Protocol HTTP API) looks like:
   *   {
   *     "client_id": "12345.67890",
   *     "tid": "G-XXXXXXXX",          // optional — may be in URL instead
   *     "events": [
   *       {
   *         "name": "view_item",
   *         "params": { "currency": "GBP", "items": [...], … }
   *       }
   *     ]
   *   }
   *
   * If the body contains multiple batched events, each is pushed to GA4_EVENTS
   * individually so they all appear in search results.
   *
   * @param {string} jsonStr - Raw JSON string (already confirmed to start with '{').
   * @param {string} srcUrl  - The request URL (used to extract a fallback hostname).
   * @returns {object|null}  - First parsed event, or null on failure.
   *                           Side-effect: additional events beyond the first are
   *                           pushed directly into GA4_EVENTS.
   */
  function parseGA4JsonBody(jsonStr, srcUrl) {
    try {
      const body = JSON.parse(jsonStr);
      const events = Array.isArray(body.events) ? body.events : [];
      if (!events.length) return null;

      // Extract Measurement ID — may be top-level in the JSON body or in the URL.
      let measurementId = body.tid || null;
      if (!measurementId) {
        try { measurementId = new URL(srcUrl).searchParams.get('tid'); } catch (_) {}
      }

      const results = events.map(ev => ({
        timestamp:     Date.now(),
        source:        'network',
        eventName:     ev.name || buildUnknownLabel(srcUrl),
        measurementId: measurementId || null,
        params:        { ...(ev.params || {}) },
        items:         Array.isArray(ev.params?.items) ? ev.params.items : [],
      }));

      // Push all events beyond the first directly — the first is returned so
      // the caller can push it via the normal path.
      results.slice(1).forEach(r => GA4_EVENTS.push(r));
      return results[0];
    } catch (_) {
      return null;
    }
  }

  /**
   * Parses a GA4 Measurement Protocol v2 collect URL (query-string format)
   * into a structured event object.
   *
   * GA4 MP parameter naming:
   *   tid         – Measurement ID (e.g. "G-ABC123XYZ")
   *   en          – event name  (GA4 MP v2)
   *   t           – hit type    (Universal Analytics fallback: 'pageview', 'event')
   *   ep.<name>   – string event parameter
   *   epn.<name>  – numeric event parameter
   *   pr<n>.<key> – product/item field (pr1.nm, pr1.pr, …)
   *
   * @param {string} rawUrl  - Merged URL+body string to parse.
   * @param {string} [srcUrl] - Original request URL (used for unknown-label fallback).
   * @returns {{timestamp, source, eventName, measurementId, params, items}|null}
   */
  function parseGA4CollectUrl(rawUrl, srcUrl) {
    let qs = rawUrl;
    try {
      const u = new URL(rawUrl.startsWith('http') ? rawUrl : `https://x.com?${rawUrl}`);
      qs = u.search.slice(1);
    } catch (_) {}

    const params = {};
    qs.split('&').forEach(part => {
      const eq = part.indexOf('=');
      if (eq === -1) return;
      try {
        params[decodeURIComponent(part.slice(0, eq))] = decodeURIComponent(part.slice(eq + 1));
      } catch (_) {
        // Malformed percent-encoding — store raw value so we don't silently drop it.
        params[part.slice(0, eq)] = part.slice(eq + 1);
      }
    });

    // Resolve event name — GA4 uses 'en'
    // If not present, fall back to a descriptive label using the
    // endpoint hostname so the user can still identify the hit's origin.
    const eventName     = params['en'] || params['t'] || buildUnknownLabel(srcUrl || rawUrl);
    const measurementId = params['tid'] || null;

    const structured = { eventName, measurementId, items: [], params: {} };
    const itemMap = {};

    const EP_RE           = /^ep\.(.+)$/;
    const EPN_RE          = /^epn\.(.+)$/;
    const ITEM_DOTTED_RE  = /^pr(\d+)\.(.+)$/;  // legacy dotted: pr1.nm=Jacket
    const COMPACT_ITEM_RE = /^pr(\d+)$/;         // modern compact: pr1=id~nm~br~...

    for (const [k, v] of Object.entries(params)) {
      if (k === 'en' || k === 'v' || k === 'tid' || k === 'gtm') continue;

      const ep = EP_RE.exec(k);
      if (ep) { structured.params[ep[1]] = v; continue; }

      const epn = EPN_RE.exec(k);
      if (epn) { structured.params[epn[1]] = isNaN(v) ? v : Number(v); continue; }

      // Legacy dotted item format: pr1.nm=Paneled leather jacket
      // Map the short code to its GA4 field name where known.
      const dotted = ITEM_DOTTED_RE.exec(k);
      if (dotted) {
        const idx = Number(dotted[1]) - 1;
        if (!itemMap[idx]) itemMap[idx] = {};
        itemMap[idx][ITEM_FIELD_MAP[dotted[2]] || dotted[2]] = v;
        continue;
      }

      // Modern compact item format: pr1=id46376~nmJacket~brVERSACE~caClothing~...
      // The entire item is serialised as a single tilde-delimited string.
      const compact = COMPACT_ITEM_RE.exec(k);
      if (compact) {
        const idx = Number(compact[1]) - 1;
        itemMap[idx] = Object.assign(itemMap[idx] || {}, parseCompactItem(v));
        continue;
      }

      structured.params[k] = v;
    }

    structured.items = Object.values(itemMap);
    return { timestamp: Date.now(), source: 'network', ...structured };
  }

  /**
   * Maps the two-letter GA4 network-payload short codes to their full GA4
   * item parameter names as documented in the GA4 ecommerce spec.
   *
   * Used when parsing both the compact tilde-delimited item format (pr1=…)
   * and the legacy dotted format (pr1.nm=…) so both produce identical,
   * human-readable field names in search results.
   *
   * Short codes that have no standard GA4 equivalent (custom event params
   * set via k<n>/v<n> pairs) are kept under the developer-supplied name.
   */
  const ITEM_FIELD_MAP = {
    'id': 'item_id',
    'nm': 'item_name',
    'br': 'item_brand',
    'ca': 'item_category',
    'c2': 'item_category2',
    'c3': 'item_category3',
    'c4': 'item_category4',
    'c5': 'item_category5',
    'va': 'item_variant',
    'pr': 'price',
    'qt': 'quantity',
    'ds': 'discount',
    'li': 'item_list_id',
    'ln': 'item_list_name',
    'lp': 'index',
    'cp': 'coupon',
    'af': 'affiliation',
    'lo': 'location_id',
  };

  /**
   * Parses a GA4 compact tilde-delimited item string into a plain object
   * with full GA4 field names.
   *
   * Format overview
   * ───────────────
   * A compact item string looks like:
   *   id46376663163047534~nmPaneled leather jacket~brVERSACE~caClothing~
   *   c2Jackets~c3Casual Jackets~vaBlack~k0item_size_local~v0not available~
   *   k1item_size_intl~v1not available~pr5530~qt1~lp1~lndesigner - versace
   *
   * Each tilde-separated segment consists of:
   *   • A known 2-char short code (id, nm, br, ca, …) — maps via ITEM_FIELD_MAP.
   *   • k<n><keyname>  — the name of a custom parameter at index n.
   *   • v<n><value>    — the value of the custom parameter at index n.
   *
   * Custom params are assembled into the item by matching k<n>/v<n> pairs.
   * For example:  k0item_size_local + v0not available  →  item_size_local: "not available"
   *
   * @param {string} raw - The raw tilde-delimited item string.
   * @returns {object}   - A flat object keyed by GA4 field names.
   */
  function parseCompactItem(raw) {
    const item       = {};
    const customKeys = {};  // index → key name
    const customVals = {};  // index → value

    raw.split('~').forEach(seg => {
      if (!seg) return;

      // Custom parameter key: k<digits><name>
      // Must check before short codes so 'k0...' isn't misread as an unknown code.
      let m = /^k(\d+)(.*)$/.exec(seg);
      if (m) { customKeys[m[1]] = m[2]; return; }

      // Custom parameter value: v<digits><value>
      // 'va' (item_variant) starts with 'v' but is followed by a letter, not a digit,
      // so /^v(\d+)/ will not match it — no conflict.
      m = /^v(\d+)(.*)$/.exec(seg);
      if (m) { customVals[m[1]] = m[2]; return; }

      // Known GA4 short code — look up the full field name.
      for (const [code, ga4Name] of Object.entries(ITEM_FIELD_MAP)) {
        if (seg.startsWith(code)) {
          item[ga4Name] = seg.slice(code.length);
          return;
        }
      }

      // Unrecognised segment — store under the raw prefix so nothing is lost.
      item[seg] = '';
    });

    // Merge custom key/value pairs by their shared index number.
    Object.keys(customKeys).forEach(idx => {
      if (customVals[idx] !== undefined) {
        item[customKeys[idx]] = customVals[idx];
      }
    });

    return item;
  }

  /**
   * Builds a human-readable fallback label for a GA4 hit whose event name
   * could not be determined from the payload parameters.
   *
   * Rather than showing the opaque string "(unknown)", we extract the hostname
   * from the endpoint URL so the user can at least identify where the hit went
   * (e.g. "[hit: analytics.net-a-porter.com]"). This makes it clear the hit
   * was captured but uses a non-standard format — giving a useful clue instead
   * of an unhelpful placeholder.
   *
   * @param {string} url - The request URL or combined query string.
   * @returns {string}
   */
  function buildUnknownLabel(url) {
    try {
      const hostname = new URL(url.startsWith('http') ? url : `https://x.com`).hostname;
      return hostname && hostname !== 'x.com' ? `[hit: ${hostname}]` : '(unknown)';
    } catch (_) {
      return '(unknown)';
    }
  }

  // ── fetch override ────────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url  = typeof input === 'string' ? input : (input?.url || '');
      const body = init?.body ? String(init.body) : '';
      captureGA4Hit(url, body);
    } catch (_) {}
    return _fetch.apply(this, arguments);
  };

  // ── XMLHttpRequest override ───────────────────────────────────────────────
  // open() captures the URL; send() captures the body. Both are needed because
  // XHR doesn't expose the URL at send() time.
  const _XHROpen = XMLHttpRequest.prototype.open;
  const _XHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__dli_url = url;
    return _XHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    try { captureGA4Hit(this.__dli_url || '', body ? String(body) : ''); } catch (_) {}
    return _XHRSend.apply(this, arguments);
  };

  // ── sendBeacon override ───────────────────────────────────────────────────
  // The most common transport for GA4 hits — fires reliably on page unload.
  const _sendBeacon = navigator.sendBeacon.bind(navigator);
  navigator.sendBeacon = function (url, data) {
    try { captureGA4Hit(url, data ? String(data) : ''); } catch (_) {}
    return _sendBeacon(url, data);
  };

  // ─────────────────────────────────────────────────────────────────────────
  // Search logic
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Recursively walks an object/array/primitive and returns every leaf whose
   * string representation contains `term` (case-insensitive).
   *
   * Returns an array of { path, value } descriptors where:
   *   path  – dot/bracket notation from root, e.g. "ecommerce.items[0].item_id"
   *   value – the actual leaf value at that path
   *
   * @param {*}      obj
   * @param {string} term
   * @param {string} path - Accumulated key path (empty string at root).
   * @returns {Array<{path: string, value: *}>}
   */
  function findPaths(obj, term, path) {
    const hits = [];
    if (obj === null || obj === undefined) return hits;
    const t = term.toLowerCase();

    if (typeof obj === 'string') {
      if (obj.toLowerCase().includes(t)) hits.push({ path, value: obj });
      return hits;
    }
    if (typeof obj === 'number' || typeof obj === 'boolean') {
      if (String(obj).toLowerCase().includes(t)) hits.push({ path, value: obj });
      return hits;
    }
    if (Array.isArray(obj)) {
      obj.forEach((v, i) => hits.push(...findPaths(v, term, `${path}[${i}]`)));
      return hits;
    }
    if (typeof obj === 'object') {
      Object.entries(obj).forEach(([k, v]) => {
        hits.push(...findPaths(v, term, path ? `${path}.${k}` : k));
      });
    }
    return hits;
  }

  /**
   * Searches all captured dataLayer events for the given term.
   *
   * @param {string} term
   * @returns {Array<{index, eventName, timestamp, paths, raw}>}
   */
  function searchDataLayer(term) {
    const results = [];
    DL_EVENTS.forEach((entry, idx) => {
      const paths = findPaths(entry.data, term, '');
      if (paths.length) {
        results.push({
          index:     idx,
          eventName: entry.data?.event || `push #${idx + 1}`,
          timestamp: entry.timestamp,
          paths,
          raw:       entry.data,
        });
      }
    });
    return results;
  }

  /**
   * Searches all captured GA4 events for the given term.
   * Items arrays are merged into the searchable object so item-level fields
   * (item_id, item_name, price, …) are found too.
   *
   * @param {string} term
   * @returns {Array<{index, eventName, measurementId, source, timestamp, paths}>}
   */
  function searchGA4(term) {
    const results = [];
    GA4_EVENTS.forEach((entry, idx) => {
      const searchable = { ...entry.params };
      if (entry.items?.length) searchable.items = entry.items;

      const paths = findPaths(searchable, term, '');
      if (paths.length) {
        results.push({
          index:         idx,
          eventName:     entry.eventName,
          measurementId: entry.measurementId || null,
          source:        entry.source,
          timestamp:     entry.timestamp,
          paths,
        });
      }
    });
    return results;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // CustomEvent bridge (MAIN world ↔ ISOLATED world)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Handles search requests from content.js.
   * Expects: { id, term, sources: ['dataLayer'?, 'ga4'?] }
   * Responds with: { id, dataLayer: Array|null, ga4: Array|null }
   */
  window.addEventListener('__dli_request__', e => {
    const { id, term, sources } = e.detail;
    const response = { id, dataLayer: null, ga4: null };

    if (sources.includes('dataLayer')) response.dataLayer = searchDataLayer(term);
    if (sources.includes('ga4'))       response.ga4       = searchGA4(term);

    window.dispatchEvent(new CustomEvent('__dli_response__', { detail: response }));
  });

  /** Responds to count requests (used to update the popup badge counts). */
  window.addEventListener('__dli_getcount__', () => {
    window.dispatchEvent(new CustomEvent('__dli_count__', {
      detail: { dl: DL_EVENTS.length, ga4: GA4_EVENTS.length },
    }));
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Utility
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Deep-clones a value via JSON round-trip.
   * Falls back to the original if serialisation fails (functions, DOM nodes, etc.)
   * @param {*} obj
   * @returns {*}
   */
  function deepClone(obj) {
    try { return JSON.parse(JSON.stringify(obj)); } catch (_) { return obj; }
  }

})();
