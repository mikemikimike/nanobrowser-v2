/**
 * Independent eBay ground truth, run inside the results page via agent-browser eval.
 *
 * This is deliberately NOT the bundled ebay-search-extract userscript: the verdict
 * compares what the agent reported against what is actually in the DOM, so the two
 * extractors must not share code. It handles the same two markups (.s-card and the
 * legacy .s-item) and returns [{title, price}] for every real listing card.
 *
 * Usage from the harness:
 *   agent-browser --session "$S" eval "$(cat scripts/harness/ebay-extract.js)"
 */
(() => {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const out = [];
  for (const card of document.querySelectorAll('li.s-card, li.s-item')) {
    const isLegacy = card.classList.contains('s-item');
    const titleEl = isLegacy
      ? card.querySelector('.s-item__title')
      : card.querySelector('.s-card__title');
    const priceEl = isLegacy ? card.querySelector('.s-item__price') : card.querySelector('.s-card__price');
    const title = clean(titleEl ? titleEl.textContent : '');
    const price = clean(priceEl ? priceEl.textContent : '');
    if (!title || title === 'Shop on eBay') continue;
    out.push({ title, price });
  }
  return JSON.stringify(out);
})()
