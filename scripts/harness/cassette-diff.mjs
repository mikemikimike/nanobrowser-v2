#!/usr/bin/env node
/**
 * Explains cassette replay misses: for every model request a replay phase sent, says
 * whether a cassette existed for it and, when not, where it first differs from the
 * closest request the record phase sent.
 *
 *   node scripts/harness/cassette-diff.mjs --record <requests.jsonl> --replay <requests.jsonl> --cassettes <dir>
 *
 * Exit 0 when every replay request had a cassette, 1 otherwise.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const read = (file) =>
  file && fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];
const recorded = read(flag('record'));
const replayed = read(flag('replay'));
const dir = flag('cassettes');

/** First path at which a and b differ, with both values there. */
function firstDiff(a, b, at = '') {
  if (typeof a === 'string' && typeof b === 'string') {
    if (a === b) return null;
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    const from = Math.max(0, i - 60);
    return { at: `${at} (char ${i})`, record: a.slice(from, i + 100), replay: b.slice(from, i + 100) };
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return JSON.stringify(a) === JSON.stringify(b) ? null : { at, record: a, replay: b };
  }
  const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])];
  for (const k of keys) {
    const d = firstDiff(a[k], b[k], `${at}${Array.isArray(a) ? `[${k}]` : `.${k}`}`);
    if (d) return d;
  }
  return null;
}

let misses = 0;
replayed.forEach((req, n) => {
  const hit = dir && fs.existsSync(path.join(dir, `${req.key}.json`));
  const role = (req.messages?.[0]?.content ?? '').toString().includes('Leader') ? 'leader' : 'follower';
  if (hit) {
    process.stdout.write(`  request ${n} (${role}, ${req.messages?.length} messages): cassette hit ${req.key.slice(0, 12)}\n`);
    return;
  }
  misses += 1;
  const candidates = recorded.filter((r) => r.model === req.model);
  const closest =
    candidates.find((r) => r.messages?.length === req.messages?.length) ?? candidates.at(-1);
  process.stdout.write(`  request ${n} (${role}, ${req.messages?.length} messages): cassette MISS ${req.key.slice(0, 12)}\n`);
  if (!closest) {
    process.stdout.write('    no recorded request for this model at all\n');
    return;
  }
  const d = firstDiff(closest.messages, req.messages, 'messages');
  if (!d) {
    process.stdout.write('    messages identical to a recorded request; the key differs by url or model\n');
    return;
  }
  process.stdout.write(`    first difference at ${d.at}\n`);
  process.stdout.write(`      record: ${JSON.stringify(d.record)}\n`);
  process.stdout.write(`      replay: ${JSON.stringify(d.replay)}\n`);
});
process.stdout.write(`  ${replayed.length} replay request(s), ${misses} miss(es)\n`);
process.exit(misses === 0 ? 0 : 1);
