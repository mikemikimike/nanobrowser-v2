#!/usr/bin/env node
/**
 * The harness verdict over one run stream (the JSONL nb-run prints).
 *
 *   node scripts/harness/verdict.mjs --stream <run.jsonl> --expected <expected.json>
 *        [--hits <fixture hits.jsonl>] [--ext-log <ext.log>] [--tamper <kind>]
 *
 * Exits 0 only if every assertion holds; prints one PASS/FAIL line per assertion.
 *
 * --tamper mutates the stream in memory before judging it. The harness uses it to prove
 * the verdict rejects a wrong or empty result (each tamper must make this exit 1):
 *   wrong-stock | wrong-sku | empty-array | empty-object | prose | reordered
 *   no-handoff | status-error | click-failed | no-page-read
 */
import fs from 'node:fs';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const streamPath = flag('stream');
const expectedPath = flag('expected');
if (!streamPath || !expectedPath) {
  process.stderr.write('usage: verdict.mjs --stream <jsonl> --expected <json> [--hits <jsonl>] [--ext-log <file>] [--tamper <kind>]\n');
  process.exit(2);
}

const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

let events = readJsonl(streamPath);
const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));

/* ----------------------------------------------------------------- tamper */

const doneCall = (list) => list.findLast((e) => e.kind === 'tool.call' && e.call?.name === 'done');
function setSummary(fn) {
  const call = doneCall(events);
  if (call) call.call.args.summary = fn(call.call.args.summary);
}
const TAMPER = {
  'wrong-stock': () =>
    setSummary((s) => {
      const v = JSON.parse(s);
      v.inventory[0].stock += 1;
      return JSON.stringify(v);
    }),
  'wrong-sku': () =>
    setSummary((s) => {
      const v = JSON.parse(s);
      v.inventory[1].sku = 'ZZ-0000';
      return JSON.stringify(v);
    }),
  'empty-array': () => setSummary(() => '[]'),
  'empty-object': () => setSummary(() => '{}'),
  prose: () => setSummary(() => 'I revealed the inventory and read all three items.'),
  reordered: () =>
    setSummary((s) => {
      const v = JSON.parse(s);
      v.inventory.reverse();
      return JSON.stringify(v);
    }),
  'no-handoff': () => {
    events = events.filter((e) => e.kind !== 'handoff');
  },
  'status-error': () => {
    for (const e of events) if (e.kind === 'run.ended' || e.type === 'run.end') e.status = 'error';
  },
  'click-failed': () => {
    for (const e of events) if (e.kind === 'tool.result' && e.result?.name === 'click') e.result.ok = false;
  },
  'no-page-read': () => {
    events = events.filter((e) => !(e.call?.name === 'extract_text' || e.result?.name === 'extract_text'));
  },
};
const tamper = flag('tamper');
if (tamper) {
  if (!TAMPER[tamper]) {
    process.stderr.write(`unknown tamper ${tamper}; known: ${Object.keys(TAMPER).join(', ')}\n`);
    process.exit(2);
  }
  TAMPER[tamper]();
}

/* ------------------------------------------------------------- assertions */

let failed = 0;
function check(name, ok, detail = '') {
  if (!ok) failed += 1;
  process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}\n`);
}

const byKind = (kind) => events.filter((e) => e.kind === kind);
const resultFor = (callEvent) =>
  events.find((e) => e.kind === 'tool.result' && e.result?.callId === callEvent.call.callId);
const okCalls = (role, name) =>
  byKind('tool.call').filter((c) => c.role === role && c.call?.name === name && resultFor(c)?.result?.ok === true);

check('the first event is run.started', events[0]?.kind === 'run.started', `first: ${events[0]?.kind ?? events[0]?.type}`);

const ended = byKind('run.ended').at(-1);
const hostEnd = events.filter((e) => e.type === 'run.end').at(-1);
check(
  'terminal status is done (run.ended and the host run.end agree)',
  ended?.status === 'done' && hostEnd?.status === 'done',
  `run.ended=${ended?.status ?? '<none>'} run.end=${hostEnd?.status ?? '<none>'}${ended?.message ? ` message=${JSON.stringify(ended.message)}` : ''}`,
);

const handoffs = byKind('handoff');
const toFollower = handoffs.filter((h) => h.from === 'leader' && h.to === 'follower');
const toLeader = handoffs.filter((h) => h.from === 'follower' && h.to === 'leader');
check('the Leader handed off to the Follower', toFollower.length >= 1, `${toFollower.length} leader->follower`);
check(
  'the Follower returned to the Leader and was handed back (a real replan)',
  toLeader.length >= 1 && toFollower.length >= 2,
  `${toLeader.length} follower->leader, ${toFollower.length} leader->follower`,
);

const clicks = okCalls('follower', 'click');
check('the Follower clicked on the fixture page and the click succeeded', clicks.length >= 1, `${clicks.length} ok click(s)`);

const reads = okCalls('follower', 'extract_text');
const readSaw = reads.some((c) => expected.some((row) => String(resultFor(c)?.result?.summary ?? '').includes(row.sku)));
check(
  'the Follower read the revealed rows off the page (extract_text result names a fixture SKU)',
  reads.length >= 1 && readSaw,
  `${reads.length} ok extract_text, saw a fixture SKU: ${readSaw}`,
);

const leaderReads = okCalls('leader', 'leader_snapshot');
check('the Leader pulled evidence from the page before re-planning', leaderReads.length >= 1, `${leaderReads.length} ok leader_snapshot`);

const done = doneCall(events);
check('the Follower called done', Boolean(done) && done.role === 'follower');
const summary = done?.call?.args?.summary;
process.stdout.write(`        done summary: ${summary === undefined ? '<none>' : summary}\n`);

/**
 * The fixture's result schema: exactly {inventory, count}; inventory is exactly the
 * fixture's rows, each exactly {sku, name, stock}, in page order; count agrees.
 */
function schemaProblems(raw) {
  let v;
  try {
    v = JSON.parse(raw);
  } catch {
    return ['summary is not JSON'];
  }
  const problems = [];
  const keys = (o) => Object.keys(o).sort().join(',');
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return ['summary is not a JSON object'];
  if (keys(v) !== 'count,inventory') problems.push(`top-level keys are {${keys(v)}}, want {count,inventory}`);
  if (!Array.isArray(v.inventory)) return [...problems, 'inventory is not an array'];
  if (v.inventory.length !== expected.length) problems.push(`inventory has ${v.inventory.length} rows, want ${expected.length}`);
  v.inventory.forEach((row, i) => {
    if (row === null || typeof row !== 'object') return problems.push(`row ${i} is not an object`);
    if (keys(row) !== 'name,sku,stock') problems.push(`row ${i} keys are {${keys(row)}}, want {name,sku,stock}`);
    if (typeof row.sku !== 'string' || !/^[A-Z]{2}-\d{4}$/.test(row.sku)) problems.push(`row ${i} sku ${JSON.stringify(row.sku)} is not AA-0000`);
    if (typeof row.name !== 'string' || !row.name.trim()) problems.push(`row ${i} name is empty`);
    if (!Number.isInteger(row.stock) || row.stock < 0) problems.push(`row ${i} stock ${JSON.stringify(row.stock)} is not a non-negative integer`);
    const want = expected[i];
    if (want && (row.sku !== want.sku || row.name !== want.name || row.stock !== want.stock)) {
      problems.push(`row ${i} is ${JSON.stringify(row)}, the page shows ${JSON.stringify(want)}`);
    }
  });
  if (v.count !== v.inventory.length) problems.push(`count ${JSON.stringify(v.count)} disagrees with ${v.inventory.length} rows`);
  return problems;
}
const problems = typeof summary === 'string' ? schemaProblems(summary) : ['no done summary'];
check('the done summary matches the fixture schema and the page\'s actual rows', problems.length === 0, problems.join('; '));

const hitsPath = flag('hits');
if (hitsPath) {
  const hits = fs.existsSync(hitsPath) ? readJsonl(hitsPath) : [];
  const pages = hits.filter((h) => h.path === '/').length;
  const api = hits.filter((h) => h.path === '/api/inventory').length;
  check('the fixture server served the page and saw the click handler\'s /api/inventory fetch', pages >= 1 && api >= 1, `GET / x${pages}, GET /api/inventory x${api}`);
}

const extLogPath = flag('ext-log');
if (extLogPath) {
  const lines = fs.existsSync(extLogPath) ? readJsonl(extLogPath) : [];
  const errors = lines.filter((l) => l.level === 'error');
  check(
    'the extension forwarded no errors to ext.log during the run',
    errors.length === 0,
    errors.length ? errors.slice(0, 3).map((e) => e.message).join(' | ') : `${lines.length} line(s), none at error`,
  );
}

process.stdout.write(`  ${failed === 0 ? 'VERDICT PASS' : `VERDICT FAIL (${failed} assertion(s))`}\n`);
process.exit(failed === 0 ? 0 : 1);
