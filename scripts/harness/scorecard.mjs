#!/usr/bin/env node
/**
 * Live-tier scorecard: one line per task plus a total, persisted as JSON for
 * regression bisection (plan future item: model ids, seed, git sha).
 *
 *   node scripts/harness/scorecard.mjs --results <results.json> --out <dir>
 *        [--leader <model>] [--follower <model>] [--seed <n>] [--sha <sha>]
 *        [--scripted <text>]
 *
 * <results.json> is [{task, title, passed, checks: [{name, ok, detail}]}].
 * Prints the scorecard, writes <out>/scorecard.json, and exits 0 only on a full pass.
 * Pixels tasks are omitted with a reason: the free Nemotron pair is text-only, so a
 * pixels pass on them would be a lie.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const resultsPath = flag('results');
const outDir = flag('out');
if (!resultsPath || !outDir) {
  process.stderr.write('usage: scorecard.mjs --results <json> --out <dir> [--leader <m>] [--follower <m>] [--seed <n>] [--sha <sha>] [--scripted <text>]\n');
  process.exit(2);
}

const results = JSON.parse(fs.readFileSync(resultsPath, 'utf8'));
let sha = flag('sha');
if (!sha) {
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    sha = 'unknown';
  }
}

const line = (cells) => cells.join('  ');
const taskCells = results.map((r) => `${r.task} ${r.passed ? 'pass' : 'FAIL'}`);
const passed = results.filter((r) => r.passed).length;

const scripted = flag('scripted');
if (scripted) process.stdout.write(`${line(['scripted', scripted])}\n`);
process.stdout.write(`${line(['live', ...taskCells])}\n`);
process.stdout.write(`pixels omitted: the live pair is text-only (no vision Follower), so no pixels task is scored\n`);
process.stdout.write(`${passed}/${results.length} live\n`);

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'scorecard.json'),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      sha,
      seed: flag('seed') ?? null,
      models: { leader: flag('leader') ?? null, follower: flag('follower') ?? null },
      results: results.map((r) => ({
        task: r.task,
        title: r.title,
        passed: r.passed,
        checks: r.checks,
      })),
      totals: { passed, total: results.length },
    },
    null,
    2,
  ) + '\n',
);

if (!Array.isArray(results) || results.length === 0) {
  process.stdout.write('no live results: refusing a 0-task pass\n');
  process.exit(1);
}
const failed = results.filter((r) => !r.passed);
if (failed.length > 0) {
  for (const r of failed) {
    const bad = r.checks.filter((c) => !c.ok);
    process.stdout.write(`  ${r.task}: ${bad.map((c) => c.name).join('; ').slice(0, 400)}\n`);
  }
  process.exit(1);
}
process.exit(0);
