/**
 * Bundled example userscripts. `seedDefaults()` installs these once, on an empty
 * catalog, so a fresh install has something real to run and debug (R-09/R-10).
 *
 * The observers read the DOM and return JSON. `ebay-ram-comps` is the exception:
 * it GETs eBay search HTML and returns JSON. It does not write the DOM.
 *
 * The wrapper in `runner.ts` runs a script as the body of an async function, so a
 * script hands its result back with a top-level `return`.
 */
import type { Userscript } from '@/src/messaging';
import { EBAY_RAM_COMPS_CODE } from './ebay-ram';
import { DEFAULT_PROBE_GLOBALS, buildProbeCode } from './i03';

/** A bundled example, before the catalog stamps `updatedAt` on it.
 *
 * The `id` is pinned, not generated: the Follower prompt names each available
 * userscript by id, and that prompt is part of the cassette key, so a random id
 * per install would make a cassette recorded in one profile miss in another.
 * Stable ids are what make "record once, replay anywhere" true. */
export type UserscriptSeed = Omit<Userscript, 'updatedAt'>;

/**
 * Reads the Hyperagent thread list and reports each thread's title and status
 * badge. Purely observational: no DOM writes, no fetch, no cross-origin access.
 * Allow-listed to Hyperagent, and it re-checks the host itself before reading.
 */
const HYPERAGENT_OBSERVE_CODE = `// hyperagent-observe — read-only thread-list observer.
// Collects thread titles and status badges from the page DOM and returns them as
// JSON. Performs no DOM writes and no network requests of any kind.
const ALLOWED_HOSTS = ['hyperagent.com', 'www.hyperagent.com'];
const host = location.hostname.toLowerCase();
if (ALLOWED_HOSTS.indexOf(host) === -1) {
  return { scriptId: 'hyperagent-observe', ok: false, reason: 'host-not-allowed', host: host };
}

const clean = (node) => (node && node.textContent ? node.textContent.replace(/\\s+/g, ' ').trim() : '');

const threadIdFrom = (container) => {
  const explicit = container.getAttribute && container.getAttribute('data-thread-id');
  if (explicit) return explicit;
  const link = container.matches && container.matches('a[href*="/thread/"]')
    ? container
    : container.querySelector('a[href*="/thread/"]');
  const href = link && link.getAttribute('href');
  const found = href && href.match(/\\/thread\\/([^/?#]+)/);
  return found ? found[1] : null;
};

const titleFrom = (container) =>
  clean(container.querySelector('[data-thread-title], .thread-title, a[href*="/thread/"], h1, h2, h3'));

const statusFrom = (container) => {
  const badge = container.querySelector('[data-status], .status-badge, .badge');
  if (!badge) return null;
  return (badge.getAttribute('data-status') || clean(badge)) || null;
};

const candidates = document.querySelectorAll('[data-thread-id], li.thread-row, a[href*="/thread/"]');
const seen = new Set();
const threads = [];
for (const candidate of candidates) {
  const container =
    (candidate.closest && candidate.closest('[data-thread-id], li, tr, article')) || candidate;
  const id = threadIdFrom(container);
  const key = id || titleFrom(container);
  if (!key || seen.has(key)) continue;
  seen.add(key);
  threads.push({ id: id, title: titleFrom(container) || null, status: statusFrom(container) });
}

return {
  scriptId: 'hyperagent-observe',
  ok: true,
  readOnly: true,
  host: host,
  path: location.pathname,
  threadCount: threads.length,
  threads: threads,
};
`;

export const HYPERAGENT_OBSERVE: UserscriptSeed = {
  id: 'bundled-hyperagent-observe',
  name: 'hyperagent-observe',
  matches: ['*://hyperagent.com/*', '*://www.hyperagent.com/*'],
  code: HYPERAGENT_OBSERVE_CODE,
};

/**
 * Reads an eBay search-results page (current offerings or sold/completed) and
 * returns every real listing as structured JSON. Purely observational: no DOM
 * writes, no fetch, no navigation. Handles both the current `.s-card` markup and
 * the legacy `.s-item` markup eBay still serves to some buckets, and skips the
 * "Shop on eBay" filler cards both markups carry.
 */
const EBAY_SEARCH_EXTRACT_CODE = `// ebay-search-extract — read-only eBay search-results scraper.
// Extracts title/price/condition/format/shipping/location/seller/feedback/sold-count/
// sold-date/url/itemId from every real result card on an eBay /sch/ search page.
// Performs no DOM writes and no network requests of any kind.

const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();

function parsePrice(raw) {
  const text = clean(raw);
  if (!text) return { price: null, priceValue: null, currency: null };
  const m = text.match(/^([^\\d]*)([\\d,.]+)/);
  if (!m) return { price: text, priceValue: null, currency: null };
  const currency = clean(m[1]) || null;
  const value = parseFloat(m[2].replace(/,/g, ''));
  return { price: text, priceValue: isNaN(value) ? null : value, currency: currency };
}

function itemIdFrom(href) {
  const m = href && href.match(/\\/itm\\/(\\d+)/);
  return m ? m[1] : null;
}

// Classifies one leaf attribute-span's text into the running per-card state.
// "seller" is whatever unclassified span sat immediately before the feedback
// span, per the live-probe DOM order: price, format, shipping, location,
// [urgency], [quantity sold], seller, seller feedback.
function classify(text, state) {
  if (!text) return;
  if (/^Buy It Now$/i.test(text)) { state.buyingFormat = 'Buy It Now'; return; }
  let m = text.match(/^(\\d+)\\s*bids?$/i);
  if (m) { state.bids = parseInt(m[1], 10); return; }
  if (/^Free\\s+(delivery|shipping)$/i.test(text) || /^\\+.*\\b(?:delivery|shipping)\\b/i.test(text)) {
    state.shipping = text;
    return;
  }
  m = text.match(/^Located in (.+)$/);
  if (m) { state.location = clean(m[1]); return; }
  m = text.match(/^(\\d+)\\s*sold$/i);
  if (m) { state.quantitySold = parseInt(m[1], 10); return; }
  m = text.match(/Sold\\s+([A-Z][a-z]{2}\\s+\\d{1,2},\\s*\\d{4})/);
  if (m) { state.soldDate = m[1]; return; }
  if (/%\\s*positive/i.test(text)) {
    state.sellerFeedback = text;
    if (state.pendingSeller) state.seller = state.pendingSeller;
    return;
  }
  state.pendingSeller = text;
}

function newState() {
  return {
    buyingFormat: null, bids: null, shipping: null, location: null,
    seller: null, sellerFeedback: null, quantitySold: null, soldDate: null,
    pendingSeller: null,
  };
}

function extractCard(card) {
  const isLegacy = card.classList.contains('s-item');
  const titleEl = isLegacy
    ? card.querySelector('.s-item__title')
    : card.querySelector('.s-card__title .su-styled-text.primary.default');
  const linkEl = isLegacy
    ? card.querySelector('a.s-item__link[href*="/itm/"]')
    : card.querySelector('a.s-card__link[href*="/itm/"]');
  const title = clean(titleEl ? titleEl.textContent : '');
  if (!title || title === 'Shop on eBay') return null;

  const conditionEl = isLegacy
    ? card.querySelector('.s-item__subtitle .SECONDARY_INFO, .s-item__subtitle')
    : card.querySelector('.s-card__subtitle .su-styled-text');
  const priceEl = isLegacy ? card.querySelector('.s-item__price') : card.querySelector('.s-card__price');
  const parsedPrice = parsePrice(priceEl ? priceEl.textContent : '');

  const state = newState();
  if (isLegacy) {
    const legacySelectors = [
      '.s-item__caption--signal', '.s-item__bidCount', '.s-item__shipping',
      '.s-item__location', '.s-item__seller-info-text',
    ];
    for (const sel of legacySelectors) {
      for (const el of card.querySelectorAll(sel)) classify(clean(el.textContent), state);
    }
  } else {
    const attrs = card.querySelectorAll('.su-card-container__attributes .su-styled-text');
    for (const el of attrs) {
      if (el.closest('.s-card__price')) continue; // already handled above
      classify(clean(el.textContent), state);
    }
  }

  const href = linkEl ? linkEl.getAttribute('href') : null;

  return {
    title: title,
    price: parsedPrice.price,
    priceValue: parsedPrice.priceValue,
    currency: parsedPrice.currency,
    condition: conditionEl ? clean(conditionEl.textContent) : null,
    buyingFormat: state.buyingFormat,
    bids: state.bids,
    shipping: state.shipping,
    location: state.location,
    seller: state.seller,
    sellerFeedback: state.sellerFeedback,
    quantitySold: state.quantitySold,
    soldDate: state.soldDate,
    url: href,
    itemId: itemIdFrom(href),
  };
}

const cards = document.querySelectorAll('li.s-card, li.s-item');
const results = [];
for (const card of cards) {
  const item = extractCard(card);
  if (item) results.push(item);
}
return results;
`;

export const EBAY_SEARCH_EXTRACT: UserscriptSeed = {
  id: 'bundled-ebay-search-extract',
  name: 'ebay-search-extract',
  matches: ['*://www.ebay.com/sch/*', '*://ebay.com/sch/*'],
  code: EBAY_SEARCH_EXTRACT_CODE,
};

/**
 * The I-03 capability probe, bundled so it is actually reachable.
 *
 * I-03 asks "whether R-09/R-10 can route around R-13 entirely by calling the page's
 * own APIs instead of synthesizing input", and `src/userscripts/i03.ts` is the
 * executable half of the answer. It was exported and covered by tests but wired to
 * nothing -- no panel button, no agent tool -- so the one instrument that can tell
 * anyone what a userscript reaches on a given site could not be run on one. As a
 * bundled script it shows up in the catalog like any other, for the panel and for
 * `run_userscript` alike.
 *
 * The allow-list below is an any-host http/https pattern rather than `<all_urls>`.
 * The probe does have to be runnable on a site nobody has characterised yet, so it is
 * broad on purpose -- but Chrome's `<all_urls>` also covers `file:` and `ftp:`, and an
 * adversarial review pointed out that this one bundled script would then be an
 * agent-reachable way onto `file:///…`. Restricting it to the two web schemes still
 * covers every site the probe has any business on.
 *
 * Being broad at all is a privilege the rails in `authoring.ts` deny to scripts the
 * *agent* writes. That asymmetry is the point: this code is ours and is right here to
 * read, it only reads, and `sameOriginFetch` is baked to false at seed time so the
 * probe issues no request at all.
 */
export const EBAY_RAM_COMPS: UserscriptSeed = {
  id: 'bundled-ebay-ram-comps',
  name: 'ebay-ram-comps',
  matches: ['*://www.ebay.com/*', '*://ebay.com/*'],
  code: EBAY_RAM_COMPS_CODE,
};

export const I03_PAGE_ACCESS: UserscriptSeed = {
  id: 'bundled-i03-page-access',
  name: 'i03-page-access',
  matches: ['*://*/*'],
  code: buildProbeCode(DEFAULT_PROBE_GLOBALS, false),
};

/** Everything `seedDefaults()` installs into an empty catalog. */
export const BUNDLED_USERSCRIPTS: readonly UserscriptSeed[] = [
  HYPERAGENT_OBSERVE,
  EBAY_SEARCH_EXTRACT,
  EBAY_RAM_COMPS,
  I03_PAGE_ACCESS,
];
