#!/usr/bin/env node
/**
 * The harness's only web page: a local HTTP fixture with a known DOM.
 *
 *   node scripts/harness/fixture-server.mjs --seed <n> --out <dir> [--port <p>]
 *
 * The inventory rows are generated from the seed and are NOT in the initial HTML: they
 * reach the DOM only after the "Reveal inventory" button's click handler fetches
 * /api/inventory. So a run can only report the right rows if a click really landed on
 * this page and a later page read really saw the result.
 *
 * Writes into <dir>:
 *   expected.json   the rows a correct run must report, in page order
 *   hits.jsonl      one line per request ({at, method, path, ua})
 *   ready.json      {port, url} once listening -- the harness waits on this file
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const seed = Number(flag('seed', '1'));
const outDir = flag('out');
const port = Number(flag('port', '0'));
if (!outDir || !Number.isFinite(seed)) {
  process.stderr.write('usage: fixture-server.mjs --seed <n> --out <dir> [--port <p>]\n');
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

function mulberry32(a) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = mulberry32(seed);
const pick = (list) => list[Math.floor(rand() * list.length)];
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const ADJECTIVES = ['Copper', 'Walnut', 'Cobalt', 'Granite', 'Saffron', 'Indigo', 'Birch', 'Obsidian'];
const NOUNS = ['widget', 'bracket', 'gasket', 'lantern', 'spindle', 'coupler', 'valve', 'hinge'];

const rows = [];
const seen = new Set();
while (rows.length < 3) {
  const sku = `${pick(LETTERS)}${pick(LETTERS)}-${String(1000 + Math.floor(rand() * 9000))}`;
  if (seen.has(sku)) continue;
  seen.add(sku);
  rows.push({ sku, name: `${pick(ADJECTIVES)} ${pick(NOUNS)}`, stock: Math.floor(rand() * 100) });
}
fs.writeFileSync(path.join(outDir, 'expected.json'), JSON.stringify(rows, null, 2) + '\n');

const PAGE = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Harness inventory</title></head>
<body>
  <main>
    <h1>Harness inventory fixture</h1>
    <p id="status">The inventory is hidden until you reveal it.</p>
    <button id="reveal" type="button">Reveal inventory</button>
    <ul id="inventory" aria-label="Inventory"></ul>
  </main>
  <script>
    document.getElementById('reveal').addEventListener('click', async () => {
      const res = await fetch('/api/inventory', { cache: 'no-store' });
      const items = await res.json();
      const list = document.getElementById('inventory');
      list.replaceChildren(...items.map((it) => {
        const li = document.createElement('li');
        li.dataset.sku = it.sku;
        li.textContent = it.sku + ' \\u00b7 ' + it.name + ' \\u00b7 ' + it.stock + ' in stock';
        return li;
      }));
      document.getElementById('status').textContent = 'Inventory revealed: ' + items.length + ' items.';
    });
  </script>
</body>
</html>
`;

const hits = fs.createWriteStream(path.join(outDir, 'hits.jsonl'), { flags: 'a' });

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://fixture');
  hits.write(
    JSON.stringify({ at: Date.now(), method: req.method, path: url.pathname, ua: req.headers['user-agent'] ?? '' }) + '\n',
  );
  const headers = { 'cache-control': 'no-store' };
  if (url.pathname === '/') {
    res.writeHead(200, { ...headers, 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  } else if (url.pathname === '/api/inventory') {
    res.writeHead(200, { ...headers, 'content-type': 'application/json' });
    res.end(JSON.stringify(rows));
  } else {
    res.writeHead(404, headers);
    res.end();
  }
});

server.listen(port, '127.0.0.1', () => {
  const { port: bound } = server.address();
  const ready = { port: bound, url: `http://127.0.0.1:${bound}/` };
  fs.writeFileSync(path.join(outDir, 'ready.json'), JSON.stringify(ready) + '\n');
  process.stdout.write(`fixture listening on ${ready.url} (seed ${seed})\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => server.close(() => process.exit(0)));
