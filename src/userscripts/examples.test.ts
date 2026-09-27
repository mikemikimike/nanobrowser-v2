// @vitest-environment jsdom
// @vitest-environment-options { "url": "https://hyperagent.com/threads" }
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { isReadOnlyScript } from '@/src/agent/policy';
import { EBAY_RAM_COMPS, EBAY_SEARCH_EXTRACT, HYPERAGENT_OBSERVE, I03_PAGE_ACCESS } from './examples';
import { matchesAny } from './match-pattern';
import { resetWorldConfiguration, runUserscript } from './runner';
import { vmUserScriptsApi } from './testing';

const CURRENT_FIXTURE = resolve(process.cwd(), 'tests/fixtures/ebay-ddr5-current.html');
const SOLD_FIXTURE = resolve(process.cwd(), 'tests/fixtures/ebay-ddr5-sold.html');
const CURRENT_URL = 'https://www.ebay.com/sch/i.html?_nkw=ddr5&_sacat=0&_ipg=60';
const SOLD_URL = 'https://www.ebay.com/sch/i.html?_nkw=ddr5&LH_Sold=1&LH_Complete=1';

/** A thread list shaped like the page the example observes. */
const THREAD_LIST = `
<main>
  <ul class="thread-list">
    <li class="thread-row" data-thread-id="t-1">
      <a class="thread-title" href="/thread/t-1">Refactor the parser</a>
      <span class="status-badge" data-status="running">running (agent)</span>
    </li>
    <li class="thread-row" data-thread-id="t-2">
      <a class="thread-title" href="/thread/t-2">Ship   the   side panel</a>
      <span class="status-badge" data-status="waiting">waiting for you</span>
    </li>
    <li class="thread-row" data-thread-id="t-3">
      <a class="thread-title" href="/thread/t-3">Nightly crawl</a>
      <span class="badge">idle</span>
    </li>
  </ul>
</main>
`;

const observe = {
  id: HYPERAGENT_OBSERVE.id,
  name: HYPERAGENT_OBSERVE.name,
  matches: [...HYPERAGENT_OBSERVE.matches],
  code: HYPERAGENT_OBSERVE.code,
  updatedAt: 0,
};

describe('bundled hyperagent-observe example', () => {
  beforeEach(() => {
    resetWorldConfiguration();
    document.body.innerHTML = THREAD_LIST;
  });

  it('returns every thread title and status badge as JSON', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: observe,
      url: 'https://hyperagent.com/threads',
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.value).toEqual({
      scriptId: 'hyperagent-observe',
      ok: true,
      readOnly: true,
      host: 'hyperagent.com',
      path: '/threads',
      threadCount: 3,
      threads: [
        { id: 't-1', title: 'Refactor the parser', status: 'running' },
        { id: 't-2', title: 'Ship the side panel', status: 'waiting' },
        // No data-status: the badge's own text is the status.
        { id: 't-3', title: 'Nightly crawl', status: 'idle' },
      ],
    });
  });

  it('writes nothing to the page and logs nothing', async () => {
    const before = document.body.innerHTML;
    const result = await runUserscript({
      tabId: 1,
      script: observe,
      url: 'https://hyperagent.com/threads',
      api: vmUserScriptsApi(),
    });

    expect(document.body.innerHTML).toBe(before);
    expect(result.console).toEqual([]);
  });

  it('reports an empty thread list rather than failing', async () => {
    document.body.innerHTML = '<main><p>No threads yet.</p></main>';
    const result = await runUserscript({
      tabId: 1,
      script: observe,
      url: 'https://hyperagent.com/threads',
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({ ok: true, threadCount: 0, threads: [] });
  });

  it('is allow-listed to hyperagent.com only', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: observe,
      url: 'https://example.com/threads',
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this script's allow-list/);
  });
});

const ebaySearchExtract = {
  id: EBAY_SEARCH_EXTRACT.id,
  name: EBAY_SEARCH_EXTRACT.name,
  matches: [...EBAY_SEARCH_EXTRACT.matches],
  code: EBAY_SEARCH_EXTRACT.code,
  updatedAt: 0,
};

interface EbayResult {
  title: string;
  price: string | null;
  priceValue: number | null;
  currency: string | null;
  condition: string | null;
  buyingFormat: string | null;
  bids: number | null;
  shipping: string | null;
  location: string | null;
  seller: string | null;
  sellerFeedback: string | null;
  quantitySold: number | null;
  soldDate: string | null;
  url: string | null;
  itemId: string | null;
}

async function runEbayExtract(url: string): Promise<EbayResult[]> {
  const result = await runUserscript({
    tabId: 1,
    script: ebaySearchExtract,
    url,
    api: vmUserScriptsApi(),
  });
  expect(result.ok).toBe(true);
  expect(result.error).toBeUndefined();
  return result.value as EbayResult[];
}

function byItemId(results: EbayResult[], itemId: string): EbayResult {
  const found = results.find((r) => r.itemId === itemId);
  if (!found) throw new Error(`no result with itemId ${itemId}`);
  return found;
}

describe('bundled ebay-search-extract example: current offerings (.s-card)', () => {
  beforeEach(() => {
    resetWorldConfiguration();
    document.body.innerHTML = readFileSync(CURRENT_FIXTURE, 'utf8');
  });

  it('extracts all 60 real listings, skipping the two "Shop on eBay" placeholders', async () => {
    const results = await runEbayExtract(CURRENT_URL);
    expect(results).toHaveLength(60);
    expect(results.some((r) => r.title === 'Shop on eBay')).toBe(false);
  });

  it('matches the first live-probe example exactly (card 0)', async () => {
    const results = await runEbayExtract(CURRENT_URL);
    expect(byItemId(results, '158192070642')).toEqual({
      title: 'Corsair Vengeance 16GB DDR5 5200 Desktop Memory',
      price: '$250.00',
      priceValue: 250,
      currency: '$',
      condition: 'Brand New',
      buyingFormat: 'Buy It Now',
      bids: null,
      shipping: 'Free delivery',
      location: 'United States',
      seller: 'wojiapanpan_4',
      sellerFeedback: '100% positive (1.3K)',
      quantitySold: 36,
      soldDate: null,
      url: 'https://www.ebay.com/itm/158192070642?_trkparms=pageci%3A0',
      itemId: '158192070642',
    });
  });

  it('matches the second live-probe example exactly (card 5)', async () => {
    const results = await runEbayExtract(CURRENT_URL);
    expect(byItemId(results, '158192070647')).toEqual({
      title: 'SK hynix 96GB (2x48GB) DDR5 5200 Desktop Memory',
      price: '$399.99',
      priceValue: 399.99,
      currency: '$',
      condition: 'Brand New',
      buyingFormat: 'Buy It Now',
      bids: null,
      shipping: '+$14.07 delivery',
      location: 'United States',
      seller: 'components4you',
      sellerFeedback: '100% positive (71)',
      quantitySold: null,
      soldDate: null,
      url: 'https://www.ebay.com/itm/158192070647?_trkparms=pageci%3A5',
      itemId: '158192070647',
    });
  });

  it('reads bids instead of Buy It Now, and quantitySold/seller/feedback together', async () => {
    const results = await runEbayExtract(CURRENT_URL);
    expect(byItemId(results, '158192070662')).toMatchObject({
      buyingFormat: null,
      bids: 11,
      shipping: '+$5.45 delivery',
      location: 'United States',
      quantitySold: 60,
      seller: 'memory-outlet',
      sellerFeedback: '95% positive (252)',
    });
  });

  it('reports null for absent fields rather than guessing', async () => {
    const results = await runEbayExtract(CURRENT_URL);
    // Card 27: no location, no seller, no feedback, no sold count on this card.
    expect(byItemId(results, '158192070669')).toMatchObject({
      location: null,
      seller: null,
      sellerFeedback: null,
      quantitySold: null,
      soldDate: null,
    });
  });

  it('writes nothing to the page and logs nothing', async () => {
    const before = document.body.innerHTML;
    const result = await runUserscript({ tabId: 1, script: ebaySearchExtract, url: CURRENT_URL, api: vmUserScriptsApi() });
    expect(document.body.innerHTML).toBe(before);
    expect(result.console).toEqual([]);
  });

  it('is allow-listed to eBay search pages only', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: ebaySearchExtract,
      url: 'https://example.com/sch/i.html?_nkw=ddr5',
      api: vmUserScriptsApi(),
    });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not in this script's allow-list/);
  });
});

describe('bundled ebay-search-extract example: sold/completed (.s-card and legacy .s-item)', () => {
  beforeEach(() => {
    resetWorldConfiguration();
    document.body.innerHTML = readFileSync(SOLD_FIXTURE, 'utf8');
  });

  it('extracts every real listing from both markups, skipping both "Shop on eBay" placeholders', async () => {
    const results = await runEbayExtract(SOLD_URL);
    expect(results).toHaveLength(7);
    expect(results.some((r) => r.title === 'Shop on eBay')).toBe(false);
  });

  it('parses a sold .s-card with bids and a sold date', async () => {
    const results = await runEbayExtract(SOLD_URL);
    expect(byItemId(results, '226534891201')).toMatchObject({
      title: 'Corsair Vengeance 32GB (2x16GB) DDR5 6000 CL30 Desktop Memory',
      condition: 'Pre-Owned',
      price: '$104.99',
      priceValue: 104.99,
      currency: '$',
      shipping: '+$5.45 shipping',
      bids: 3,
      soldDate: 'Aug 30, 2026',
    });
  });

  it('parses a "US $" currency prefix', async () => {
    const results = await runEbayExtract(SOLD_URL);
    expect(byItemId(results, '145998877665')).toMatchObject({
      price: 'US $62.00',
      priceValue: 62,
      currency: 'US $',
      soldDate: 'Aug 27, 2026',
    });
  });

  it('takes the lower bound of a price range as priceValue, keeping the full string as price', async () => {
    const results = await runEbayExtract(SOLD_URL);
    expect(byItemId(results, '335544332211')).toMatchObject({
      price: '$38.50 to $74.00',
      priceValue: 38.5,
      currency: '$',
    });
  });

  it('parses a legacy .s-item card: title, condition, shipping and sold date', async () => {
    const results = await runEbayExtract(SOLD_URL);
    expect(byItemId(results, '186655443322')).toMatchObject({
      title: 'Crucial Pro 96GB (2x48GB) DDR5-5600 UDIMM Desktop RAM',
      condition: 'Brand New',
      price: '$248.00',
      priceValue: 248,
      currency: '$',
      shipping: 'Free shipping',
      soldDate: 'Aug 24, 2026',
    });
  });

  it('parses legacy bids, a "+C $" shipping prefix and a "£" price', async () => {
    const results = await runEbayExtract(SOLD_URL);
    expect(byItemId(results, '204411223344')).toMatchObject({
      price: 'C $41.25',
      priceValue: 41.25,
      currency: 'C $',
      bids: 5,
      shipping: '+C $9.50 shipping',
      soldDate: 'Aug 22, 2026',
    });
    expect(byItemId(results, '256677889900')).toMatchObject({
      price: '£188.00',
      priceValue: 188,
      currency: '£',
      condition: 'Parts Only',
      soldDate: 'Aug 21, 2026',
    });
  });
});

describe('bundled i03-page-access probe', () => {
  beforeEach(() => {
    resetWorldConfiguration();
    document.head.innerHTML = '';
    document.body.innerHTML = '<main>threads</main>';
  });

  /**
   * The point of bundling it: `probePageAccess()` was exported, tested, and
   * reachable from nowhere. As a catalog entry the panel can run it, and so can
   * `run_userscript`.
   */
  it('runs from the catalog entry and reports what the world reaches', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: { ...I03_PAGE_ACCESS, updatedAt: 0 },
      url: 'https://hyperagent.com/threads',
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      origin: 'https://hyperagent.com',
      world: 'USER_SCRIPT',
      domVisible: true,
      // Not asked for, so not performed: the probe issues no request unless told to.
      sameOriginFetch: null,
    });
  });

  it('is reachable on the web and nowhere else', () => {
    expect(matchesAny(I03_PAGE_ACCESS.matches, 'https://chatgpt.com/c/1')).toBe(true);
    expect(matchesAny(I03_PAGE_ACCESS.matches, 'http://example.com/')).toBe(true);
    // `<all_urls>` would also cover these two; it is not used, deliberately.
    expect(matchesAny(I03_PAGE_ACCESS.matches, 'file:///home/coldaine/.ssh/id_rsa')).toBe(false);
    expect(matchesAny(I03_PAGE_ACCESS.matches, 'ftp://ftp.example.com/x')).toBe(false);
  });

  it('reads only: it logs nothing and leaves the DOM as it found it', async () => {
    const before = document.body.innerHTML;
    const result = await runUserscript({
      tabId: 1,
      script: { ...I03_PAGE_ACCESS, updatedAt: 0 },
      url: 'https://hyperagent.com/threads',
      api: vmUserScriptsApi(),
    });

    expect(result.console).toEqual([]);
    expect(document.body.innerHTML).toBe(before);
  });
});

describe('ebay-ram-comps seed', () => {
  const ram = { ...EBAY_RAM_COMPS, updatedAt: 0 };

  it('accepts the seed as a read-only script and leaves no button', () => {
    expect(isReadOnlyScript(EBAY_RAM_COMPS.code).ok).toBe(true);
    expect(EBAY_RAM_COMPS.code).not.toContain('.click(');
    expect(EBAY_RAM_COMPS.code).not.toContain('download');
  });

  it('parses kit, lot, SODIMM, retail, and for-parts titles', async () => {
    const result = await runUserscript({
      tabId: 1,
      script: ram,
      url: 'https://www.ebay.com/sch/i.html',
      args: {
        titles: [
          '32GB (4x8GB) DDR4 3200 RDIMM',
          '4x 32GB DDR4 3200 RDIMM',
          '32GB DDR4 3200 SODIMM',
          '32GB DDR4 3200 compatible',
          '32GB DDR4 3200 for parts',
        ],
      },
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(true);
    const rows = (result.value as { rows: Array<{ exclude: string | null; stick_gb: number | null; count: number; retail: boolean }> }).rows;
    expect(rows[0]).toMatchObject({ stick_gb: 8, count: 4, exclude: null });
    expect(rows[1]).toMatchObject({ stick_gb: 32, count: 4, exclude: null });
    expect(rows[2]).toMatchObject({ exclude: 'laptop' });
    expect(rows[3]).toMatchObject({ retail: true, exclude: null });
    expect(rows[4]).toMatchObject({ exclude: 'junk' });
  });

  it('reads the price element when an earlier dollar amount is in the card', async () => {
    const html = `<li class="s-card"><span class="s-card__title">32GB DDR4 3200 RDIMM</span><span>$1.00</span><span class="s-card__price">$40.00</span><a href="https://www.ebay.com/itm/1234567890">x</a></li>`;
    const result = await runUserscript({
      tabId: 1,
      script: ram,
      url: 'https://www.ebay.com/',
      args: { html },
      api: vmUserScriptsApi(),
    });

    expect(result.ok).toBe(true);
    const value = result.value as { summary: unknown; rows: Array<{ price: number }> };
    expect(value.summary).toEqual([]);
    expect(value.rows[0]?.price).toBe(40);
    expect(document.querySelector('button')).toBeNull();
  });

  it('summarises comparable listings by spec and leaves retail and excluded titles out', async () => {
    const card = (id: string, title: string, price: string) =>
      `<li class="s-card"><span class="s-card__title">${title}</span><span class="s-card__price">$${price}</span><a href="https://www.ebay.com/itm/${id}">x</a></li>`;
    const html = [
      card('1', '32GB DDR4 3200 RDIMM', '40.00'),
      card('2', '32GB DDR4 3200 RDIMM Samsung', '60.00'),
      card('3', '32GB DDR4 3200 compatible', '20.00'),
      card('4', '32GB DDR4 3200 for parts', '5.00'),
    ].join('');
    const previous = globalThis.fetch;
    globalThis.fetch = (async () => new Response(html)) as typeof fetch;
    try {
      const result = await runUserscript({
        tabId: 1,
        script: ram,
        url: 'https://www.ebay.com/',
        args: { queries: ['32GB PC4-3200AA'], pages: 1 },
        api: vmUserScriptsApi(),
      });

      expect(result.ok).toBe(true);
      const value = result.value as { summary: Array<Record<string, unknown>>; rows: unknown[] };
      expect(value.rows).toHaveLength(8);
      expect(value.summary).toEqual([
        { mode: 'bin', gen: 4, speed: 3200, stick_gb: 32, module: 'RDIMM', n: 2, median_per_stick: 50, min_per_stick: 40 },
        { mode: 'sold', gen: 4, speed: 3200, stick_gb: 32, module: 'RDIMM', n: 2, median_per_stick: 50, min_per_stick: 40 },
      ]);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('treats limitQueries 0 as no queries rather than the full list', async () => {
    const urls: string[] = [];
    const previous = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return new Response('');
    }) as typeof fetch;
    try {
      const result = await runUserscript({
        tabId: 1,
        script: ram,
        url: 'https://www.ebay.com/',
        args: { limitQueries: 0 },
        api: vmUserScriptsApi(),
      });
      expect(result.ok).toBe(true);
      expect(urls).toEqual([]);
      expect((result.value as { rows: unknown[] }).rows).toEqual([]);
    } finally {
      globalThis.fetch = previous;
    }
  });

  it('refuses to run on a page that is not eBay before any fetch', async () => {
    const api = vmUserScriptsApi();
    const result = await runUserscript({
      tabId: 1,
      script: ram,
      url: 'https://example.com/',
      api,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain('example.com');
    expect(api.injections).toHaveLength(0);
  });
});
