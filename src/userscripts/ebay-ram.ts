/**
 * Bundled eBay RAM comps reader. The body of an async function: `args` and `nb`
 * come from the runner wrapper. It GETs eBay search HTML and returns JSON.
 * No button, no download, no page-world globals.
 */
export const EBAY_RAM_COMPS_CODE = `
const queries = (args && args.queries) || [
  '32GB PC4-2133P', '64GB PC4-2133P', '128GB PC4-2133P',
  '32GB PC4-2400T', '64GB PC4-2400T', '128GB PC4-2400T',
  '32GB PC4-2666V', '64GB PC4-2666V', '128GB PC4-2666V',
  '32GB PC4-2933Y', '64GB PC4-2933Y', '128GB PC4-2933Y',
  '32GB PC4-3200AA', '64GB PC4-3200AA', '128GB PC4-3200AA',
  '32GB PC5-4800B', '32GB PC5-5600B', '64GB PC5-4800B', '64GB PC5-5600B', '128GB DDR5 RDIMM',
].slice(0, args && typeof args.limitQueries === 'number' ? args.limitQueries : undefined);
// typeof, not truthiness: limitQueries 0 or pages 0 means none, not the full default.
const pages = args && typeof args.pages === 'number' ? args.pages : 4;
const perPage = 240;
const delayMs = 800;

const RETAIL = /a-tech|nemix|owc|axiom|compatible|upgrade kit|\\bfor (dell|hp|hpe|lenovo|supermicro|asus|asrock|gigabyte)\\b|replacement|memory upgrade|certified|oem equiv|v-color|proxmem|mushkin|\\bpny\\b/i;
const JUNK = /\\b(for parts|untested|as[- ]is|not working|broken|defect|will not|no post|engineering sample)\\b|\\bES\\b|\\bmixed\\b/i;
const LAPTOP = /so-?dimm|laptop|notebook|M471|M425|262-?pin|latitude|thinkpad|elitebook|zbook/i;
const UDIMM = /\\budimm\\b|unbuffered|non-?ecc|\\bdesktop\\b/i;

function textOf(node) {
  return ((node && node.textContent) || '').replace(/\\s+/g, ' ').trim();
}

function priceFrom(li) {
  const el = li.querySelector('.s-card__price, .s-item__price');
  const raw = textOf(el).replace(/,/g, '');
  const m = raw.match(/\\$(\\d+\\.\\d\\d)/);
  return m ? +m[1] : null;
}

function parseCards(html, mode, q, pg) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const out = [];
  for (const li of doc.querySelectorAll('li.s-card, li.s-item')) {
    const title = textOf(li.querySelector('.s-card__title, .s-item__title'))
      .replace('Opens in a new window or tab', '').replace(/^New Listing/i, '').trim();
    const txt = textOf(li);
    const price = priceFrom(li);
    const ship = /Free delivery|Free shipping/.test(txt) ? 0
      : +(((txt.match(/\\+\\$([\\d,.]+) (?:delivery|shipping)/) || [])[1] || '0').replace(/,/g, ''));
    const a = li.querySelector('a[href*="/itm/"]');
    const href = a ? (a.getAttribute('href') || '') : '';
    const id = (href.match(/itm\\/(\\d+)/) || [])[1] || '';
    const sold = (txt.match(/Sold\\s+(\\w{3} \\d+, \\d{4})/) || [])[1] || null;
    if (!price || !id || /Shop on eBay/.test(title)) continue;
    out.push({
      item_id: id, url: 'https://www.ebay.com/itm/' + id,
      mode: mode, query: q, page: pg, title: title, price: price, shipping: ship,
      sold_date: sold ? new Date(sold).toISOString().slice(0, 10) : null,
      located_us: /Located in United States/.test(txt),
    });
  }
  return out;
}

function parseSpec(t) {
  const out = { gen: null, speed: null, stick_gb: null, count: 1, module: null, exclude: null, retail: RETAIL.test(t) };
  if (/ddr5|pc5/i.test(t)) out.gen = 5; else if (/ddr4|pc4/i.test(t)) out.gen = 4;
  if (JUNK.test(t)) out.exclude = 'junk';
  else if (LAPTOP.test(t)) out.exclude = 'laptop';
  else if (UDIMM.test(t)) out.exclude = 'udimm';
  out.module = /lrdimm|load reduced/i.test(t) ? 'LRDIMM' : 'RDIMM';
  if (out.gen === 4) {
    const map = [[2133, /2133|17000/], [2400, /2400|19200/], [2666, /2666|21300/], [2933, /2933|23400/], [3200, /3200|25600/]];
    const hits = map.filter(function (pair) { return pair[1].test(t); }).map(function (pair) { return pair[0]; });
    out.speed = hits.length === 1 ? hits[0] : null;
  } else if (out.gen === 5) {
    const m = t.match(/(4400|4800|5200|5600|6000|6400)/);
    out.speed = /38400/.test(t) ? 4800 : /44800/.test(t) ? 5600 : /51200/.test(t) ? 6400 : m ? +m[1] : null;
  }
  const SIZES = [8, 16, 24, 32, 48, 64, 96, 128, 256];
  const gbs = [];
  for (const m of t.matchAll(/(\\d+)\\s*GB/gi)) { const n = +m[1]; if (SIZES.indexOf(n) >= 0) gbs.push(n); }
  let m;
  if ((m = t.match(/(\\d+)\\s*GB\\s*\\(\\s*(\\d+)\\s*[xX×]\\s*(\\d+)\\s*GB\\s*\\)/))) { out.count = +m[2]; out.stick_gb = +m[3]; }
  else if ((m = t.match(/\\b(\\d{1,2})\\s*[xX×]\\s*(?:[A-Za-z][\\w/-]*\\s+){0,3}(\\d+)\\s*GB/))) { out.count = +m[1]; out.stick_gb = +m[2]; }
  else if ((m = t.match(/(\\d+)\\s*GB\\s*[xX×]\\s*(\\d{1,2})\\b(?!\\s*GB)/))) { out.stick_gb = +m[1]; out.count = +m[2]; }
  else {
    out.stick_gb = gbs.length ? Math.min.apply(null, gbs) : null;
  }
  if (SIZES.indexOf(out.stick_gb) < 0 || out.count < 1 || out.count > 64) out.exclude = out.exclude || 'unparsed';
  if (!out.gen || !out.speed) out.exclude = out.exclude || 'unparsed';
  return out;
}

if (args && Array.isArray(args.titles)) {
  return { summary: [], meta: { mode: 'titles' }, log: [], rows: args.titles.map(parseSpec) };
}
if (args && typeof args.html === 'string') {
  return { summary: [], meta: { mode: 'html' }, log: [], rows: parseCards(args.html, 'bin', 'fixture', 1) };
}

// One line per comparable spec: median and low per-stick cost for sold and for
// buy-it-now. Excluded titles (junk, laptop, UDIMM, unparsed) and retail or
// compatible-brand listings stay in rows but are not comps.
function summarize(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.exclude || r.retail || r.per_stick == null) continue;
    const key = [r.mode, r.gen, r.speed, r.stick_gb, r.module].join('|');
    if (!groups.has(key)) {
      groups.set(key, { mode: r.mode, gen: r.gen, speed: r.speed, stick_gb: r.stick_gb, module: r.module, prices: [] });
    }
    groups.get(key).prices.push(r.per_stick);
  }
  const out = [];
  for (const g of groups.values()) {
    const p = g.prices.slice().sort(function (a, b) { return a - b; });
    const mid = Math.floor(p.length / 2);
    const median = p.length % 2 ? p[mid] : (p[mid - 1] + p[mid]) / 2;
    out.push({
      mode: g.mode, gen: g.gen, speed: g.speed, stick_gb: g.stick_gb, module: g.module,
      n: p.length, median_per_stick: Math.round(median * 100) / 100, min_per_stick: p[0],
    });
  }
  out.sort(function (a, b) {
    return a.gen - b.gen || a.speed - b.speed || a.stick_gb - b.stick_gb || (a.mode < b.mode ? -1 : a.mode > b.mode ? 1 : 0);
  });
  return out;
}

function finish(raw, log, stoppedEarly, reason) {
  const seen = new Map();
  for (const r of raw) {
    const k = r.mode + r.item_id + (r.sold_date || '');
    if (!seen.has(k)) seen.set(k, r);
  }
  const rows = [];
  for (const r of seen.values()) {
    const spec = parseSpec(r.title);
    const total = r.price + (r.shipping || 0);
    const per = spec.count ? total / spec.count : null;
    rows.push(Object.assign({}, r, spec, {
      total_cost: Math.round(total * 100) / 100,
      per_stick: per == null ? null : Math.round(per * 100) / 100,
    }));
  }
  return {
    summary: summarize(rows),
    meta: { source: 'ebay.com', stopped_early: stoppedEarly, reason: reason || null },
    log: log,
    rows: rows,
  };
}

const raw = [];
const log = [];
let stoppedEarly = false;
let reason = null;
for (let qi = 0; qi < queries.length && !stoppedEarly; qi++) {
  const q = queries[qi];
  for (const mode of ['sold', 'bin']) {
    if (stoppedEarly) break;
    for (let pg = 1; pg <= pages; pg++) {
      if (nb.stopped) { stoppedEarly = true; reason = 'stopped'; break; }
      const u = '/sch/i.html?_nkw=' + encodeURIComponent(q) + '&_ipg=' + perPage + '&_pgn=' + pg +
        '&LH_PrefLoc=1' + (mode === 'sold' ? '&LH_Sold=1&LH_Complete=1' : '&LH_BIN=1');
      let n = 0;
      let challenge = false;
      try {
        const h = await fetch(u, { credentials: 'include' }).then(function (r) { return r.text(); });
        challenge = /splashui\\/challenge|Pardon Our Interruption/.test(h);
        const cards = challenge ? [] : parseCards(h, mode, q, pg);
        for (const card of cards) raw.push(card);
        n = cards.length;
      } catch (e) {
        log.push({ q: q, mode: mode, pg: pg, error: String(e) });
      }
      log.push({ q: q, mode: mode, pg: pg, n: n, challenge: challenge });
      console.log(q + ' | ' + mode + ' | p' + pg + ': ' + n + (challenge ? ' (CHALLENGE)' : ''));
      nb.partial = finish(raw, log, stoppedEarly || challenge, challenge ? 'challenge' : reason);
      if (challenge) { stoppedEarly = true; reason = 'challenge'; break; }
      if (n < perPage - 40) break;
      await new Promise(function (r) { setTimeout(r, delayMs); });
    }
  }
}
return finish(raw, log, stoppedEarly, reason);
`;
