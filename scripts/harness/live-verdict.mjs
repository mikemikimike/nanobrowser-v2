#!/usr/bin/env node
/**
 * Live-tier verdicts: one ground-truth scorer per task, implementing the scoring
 * pseudocode in the plan (`score_task`, `score_ebay`, `score_userscript_debug`).
 *
 *   node scripts/harness/live-verdict.mjs --task <id> --stream <runlog.jsonl>
 *        --expected <expected.json> [--page <page.json>] [--host-log <file>]
 *        [--ext-log <file>] [--download-dirs <dir:dir:...>] [--hits <hits.jsonl>]
 *
 * --page is the independently scraped ground truth (eBay listings as JSON).
 * --download-dirs are searched recursively for a file whose sha256 matches the
 * fixture's. Exits 0 only if every check for the task passes.
 *
 * The scoring functions are also imported by live-selftest.mjs, which proves they
 * accept a good synthetic log and reject tampered ones without spending a model call.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/* ------------------------------------------------------------------ helpers */

const readJsonl = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

const byKind = (events, kind) => events.filter((e) => e.kind === kind);
const handoffs = (events) => byKind(events, 'handoff');
const handoffCount = (events, from, to) =>
  handoffs(events).filter((h) => h.from === from && h.to === to).length;

const resultFor = (events, callEvent) =>
  events.find((e) => e.kind === 'tool.result' && e.result?.callId === callEvent.call.callId);

const callsOf = (events, role, name) =>
  byKind(events, 'tool.call').filter((c) => (role === undefined || c.role === role) && c.call?.name === name);

const okCalls = (events, role, name) =>
  callsOf(events, role, name).filter((c) => resultFor(events, c)?.result?.ok === true);

const doneCall = (events) => events.findLast((e) => e.kind === 'tool.call' && e.call?.name === 'done');
const doneSummary = (events) => doneCall(events)?.call?.args?.summary;

const terminalOf = (events) => byKind(events, 'run.ended').at(-1);
const hostEndOf = (events) => events.filter((e) => e.type === 'run.end').at(-1);

/** The summary itself, or failing that the outermost [...] or {...} in it. */
export function parseSummary(raw) {
  if (typeof raw !== 'string') return { ok: false, error: 'no done summary' };
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    const m = raw.match(/(\[.*\]|\{.*\})/s);
    if (!m) return { ok: false, error: 'summary is not JSON' };
    try {
      return { ok: true, value: JSON.parse(m[1]) };
    } catch {
      return { ok: false, error: 'summary is not JSON' };
    }
  }
}

function check(name, ok, detail = '') {
  return { name, ok: Boolean(ok), detail: String(detail ?? '') };
}

function walkFiles(dir, out = []) {
  if (!dir || !fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

export function findDownloadedBytes(dirs, wantSha) {
  const found = [];
  for (const dir of dirs) {
    for (const file of walkFiles(dir)) {
      let sha;
      try {
        sha = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
      } catch {
        continue;
      }
      if (sha === wantSha) found.push(file);
    }
  }
  return found;
}

/* ------------------------------------------------------------------ contexts */

/**
 * @param {object} ctx
 * @param {Array} ctx.events run-log events (nb-run stream / persisted runlog)
 * @param {string} ctx.taskId one of live-tasks.mjs TASK_IDS
 * @param {object} ctx.expected live-fixture expected.json
 * @param {Array} [ctx.pageListings] independently scraped eBay [{title, price}]
 * @param {string} [ctx.runlogText] whole runlog file text (leak checks)
 * @param {string} [ctx.hostLogText]
 * @param {string} [ctx.extLogText]
 * @param {string[]} [ctx.downloadMatches] files whose bytes match the fixture
 * @param {Array} [ctx.hits] fixture hits.jsonl rows
 */
export function scoreTask(ctx) {
  const checks = scoreTaskInner(ctx);
  checks.push(noExtErrorsCheck(ctx.extLogText));
  return checks;
}

/** Every task inherits this: a passing verdict with extension errors is a lie. */
function noExtErrorsCheck(extLogText = '') {
  const errors = extLogText
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry) => entry && entry.level === 'error');
  return check(
    'the extension logged no errors during the run',
    errors.length === 0,
    errors.length > 0
      ? errors
          .slice(0, 3)
          .map((e) => String(e.message ?? e))
          .join(' | ')
          .slice(0, 300)
      : 'ext.log clean',
  );
}

function scoreTaskInner(ctx) {
  switch (ctx.taskId) {
    case 'ebay':
      return scoreEbay(ctx);
    case 'userscript_debug':
      return scoreUserscriptDebug(ctx);
    case 'inventory':
      return scoreInventory(ctx);
    case 'download':
      return scoreDownload(ctx);
    case 'escalation':
      return scoreEscalation(ctx);
    case 'readonly':
      return scoreReadonly(ctx);
    case 'login':
      return scoreLogin(ctx);
    case 'redaction':
      return scoreRedaction(ctx);
    case 'stall':
      return scoreStall(ctx);
    default:
      throw new Error(`unknown live task ${ctx.taskId}`);
  }
}

// Exported for live-selftest.mjs alongside scoreTask: a log missing the host's
// run.end is truncated, not done, so both terminal events are required.
export function terminalChecks(events, want) {
  const ended = terminalOf(events);
  const hostEnd = hostEndOf(events);
  return check(
    `terminal status is ${want} (run.ended and the host run.end agree)`,
    ended?.status === want && hostEnd?.status === want,
    `run.ended=${ended?.status ?? '<none>'} run.end=${hostEnd?.status ?? '<none>'}${ended?.message ? ` message=${JSON.stringify(ended.message).slice(0, 200)}` : ''}`,
  );
}

function handoffCheck(events) {
  const n = handoffCount(events, 'leader', 'follower');
  return check('the Leader handed off to the Follower', n >= 1, `${n} leader->follower`);
}

/* ---------------------------------------------------------------------- eBay */

// The bundled extractor's pinned id (src/userscripts/examples.ts). The prompt tells
// the Follower to pass the id, but resolveUserscript also accepts the bare name, so
// the log's scriptId may be either; anything else ran the wrong script.
const EBAY_SCRIPT_IDS = new Set(['bundled-ebay-search-extract', 'ebay-search-extract']);

function scoreEbay({ events, pageListings }) {
  const checks = [];
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const runs = callsOf(events, 'follower', 'run_userscript');
  const ebayOk = runs.filter(
    (c) => EBAY_SCRIPT_IDS.has(c.call?.args?.scriptId) && resultFor(events, c)?.result?.ok === true,
  );
  const listResults = callsOf(events, 'follower', 'list_userscripts')
    .map((c) => resultFor(events, c)?.result?.summary ?? '')
    .join('\n');
  const named = listResults.includes('ebay-search-extract');
  checks.push(
    check(
      'the Follower discovered ebay-search-extract via list_userscripts and ran it ok',
      ebayOk.length >= 1 && named,
      `${ebayOk.length} ok ebay run(s) of ${runs.length} run_userscript call(s)${named ? '; list_userscripts named ebay-search-extract' : '; list_userscripts never named it'}`,
    ),
  );

  // The extractor must have produced listing data itself: an ok run returning []
  // while the summary matches the page means the model hand-read the DOM and the
  // extractor went untested. Summaries are truncated for the log, so this checks
  // for listing shape (a title key) rather than full consistency.
  const outputOk = ebayOk.some((c) =>
    /"title"\s*:/.test(String(resultFor(events, c)?.result?.summary ?? '')),
  );
  checks.push(
    check(
      'the ok extractor run returned listing data, not an empty result',
      outputOk,
      outputOk ? '' : 'no ok ebay run summary contained a listing title',
    ),
  );

  const parsed = parseSummary(doneSummary(events));
  checks.push(check('the done summary parses as JSON', parsed.ok, parsed.ok ? '' : parsed.error));
  if (!parsed.ok) return checks;

  const summary = parsed.value;
  const isList = Array.isArray(summary) && summary.length >= 1 && summary.length <= 20;
  checks.push(
    check(
      'the done summary is a list of 1-20 listings',
      isList,
      Array.isArray(summary) ? `${summary.length} row(s)` : `type ${typeof summary}`,
    ),
  );
  if (!isList) return checks;

  const shapeBad = summary.findIndex(
    (row) => row === null || typeof row !== 'object' || typeof row.title !== 'string' || typeof row.price !== 'string',
  );
  checks.push(
    check(
      'every row has a title and a price',
      shapeBad === -1,
      shapeBad === -1 ? '' : `row ${shapeBad} is ${JSON.stringify(summary[shapeBad]).slice(0, 160)}`,
    ),
  );
  if (shapeBad !== -1) return checks;

  if (!Array.isArray(pageListings)) {
    checks.push(check('page ground truth was scraped for comparison', false, 'harness passed no --page file'));
    return checks;
  }
  // Multiset matching: every reported row consumes one distinct live listing, so
  // invented duplicates fail while genuine relist duplicates on the page still pass.
  const remaining = new Map();
  for (const p of pageListings) {
    const key = `${p.title}\n${p.price}`;
    remaining.set(key, (remaining.get(key) ?? 0) + 1);
  }
  const badRow = summary.find((row) => {
    const key = `${row.title}\n${row.price}`;
    const left = remaining.get(key) ?? 0;
    if (left === 0) return true;
    remaining.set(key, left - 1);
    return false;
  });
  checks.push(
    check(
      `every reported row matches a distinct live listing (${pageListings.length} live listings)`,
      badRow === undefined,
      badRow === undefined ? '' : `unmatched row ${JSON.stringify(badRow).slice(0, 160)}`,
    ),
  );
  return checks;
}

/* -------------------------------------------------------- userscript debugging */

function scoreUserscriptDebug({ events, expected }) {
  const checks = [];
  const fixed = expected.debug.fixedValue;
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const runCalls = callsOf(events, 'follower', 'run_userscript');
  const first = runCalls[0];
  if (!first) {
    checks.push(check('the agent ran a userscript at least once', false, 'no run_userscript call'));
    return checks;
  }
  const firstResult = resultFor(events, first)?.result;
  const firstIdx = events.indexOf(first);
  // The prompt demands the revision reuse the SAME scriptId: a fix under a new id
  // is a different script, not the write-run-revise loop being graded.
  const firstScriptId = first.call?.args?.scriptId;
  // The console comes back two ways: userscript.output events in the run log, and the
  // result summary's own "console:" section (truncated to 240 chars for the log).
  const errorOutputs = events.filter(
    (e, i) => i > firstIdx && e.kind === 'userscript.output' && e.level === 'error',
  );
  const summaryText = String(firstResult?.summary ?? '');
  const sawConsoleError = errorOutputs.length >= 1 || /error/i.test(summaryText);
  checks.push(
    check(
      'the first run failed and its console error is in the log',
      firstResult?.ok === false && sawConsoleError,
      `first run ok=${firstResult?.ok ?? '<none>'}; userscript.output error lines after it: ${errorOutputs.length}`,
    ),
  );

  const writesAfter = callsOf(events, 'follower', 'write_userscript').filter(
    (c) => events.indexOf(c) > firstIdx && c.call?.args?.scriptId === firstScriptId,
  );
  checks.push(
    check(
      'the agent revised the script with write_userscript after the error, reusing its scriptId',
      writesAfter.length >= 1,
      `${writesAfter.length} write_userscript call(s) after the first run targeting ${JSON.stringify(firstScriptId)}`,
    ),
  );
  if (writesAfter.length === 0) return checks;

  const writeIdx = events.indexOf(writesAfter[0]);
  const second = runCalls.find((c) => events.indexOf(c) > writeIdx && c.call?.args?.scriptId === firstScriptId);
  const secondResult = second ? resultFor(events, second)?.result : undefined;
  const secondText = String(secondResult?.summary ?? '');
  checks.push(
    check(
      'the rerun after the revision returned ok with the fixed value',
      second !== undefined && secondResult?.ok === true && secondText.includes(fixed),
      second === undefined
        ? 'no run_userscript call after the revision'
        : `rerun ok=${secondResult?.ok ?? '<none>'}; fixed value ${secondText.includes(fixed) ? 'present' : 'absent'} in result`,
    ),
  );

  const summary = doneSummary(events);
  // The task requires the fixed result in the JSON value field: a summary that
  // merely mentions the value elsewhere (a note, a wrong value) is not the fix.
  let summaryValue;
  try {
    summaryValue = JSON.parse(String(summary)).value;
  } catch {
    summaryValue = undefined;
  }
  checks.push(
    check(
      'the done summary is JSON with the fixed value in its value field',
      summaryValue === fixed,
      typeof summary === 'string' ? summary.slice(0, 200) : '<none>',
    ),
  );
  return checks;
}

/* ----------------------------------------------------------------- inventory */

function scoreInventory({ events, expected, hits }) {
  const checks = [];
  const want = expected.inventory;
  checks.push(check('the first event is run.started', events[0]?.kind === 'run.started', `first: ${events[0]?.kind ?? events[0]?.type}`));
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const clicks = okCalls(events, 'follower', 'click');
  checks.push(check('the Follower clicked and the click succeeded', clicks.length >= 1, `${clicks.length} ok click(s)`));

  const reads = okCalls(events, 'follower', 'extract_text');
  const readSaw = reads.some((c) => want.some((row) => String(resultFor(events, c)?.result?.summary ?? '').includes(row.sku)));
  checks.push(
    check(
      'the Follower read the revealed rows (extract_text names a fixture SKU)',
      reads.length >= 1 && readSaw,
      `${reads.length} ok extract_text, saw a fixture SKU: ${readSaw}`,
    ),
  );

  const parsed = parseSummary(doneSummary(events));
  checks.push(check('the done summary parses as JSON', parsed.ok, parsed.ok ? '' : parsed.error));
  if (parsed.ok) {
    const v = parsed.value;
    const rowsOk =
      v !== null && typeof v === 'object' && !Array.isArray(v) && Array.isArray(v.inventory) && v.inventory.length === want.length;
    checks.push(
      check(
        'the done summary is exactly the fixture rows in page order',
        rowsOk &&
          v.inventory.every((row, i) => row.sku === want[i].sku && row.name === want[i].name && row.stock === want[i].stock) &&
          v.count === want.length,
        JSON.stringify(v).slice(0, 300),
      ),
    );
  }
  if (Array.isArray(hits)) {
    const pages = hits.filter((h) => h.path === '/').length;
    const api = hits.filter((h) => h.path === '/api/inventory').length;
    checks.push(
      check("the fixture saw GET / and the click handler's GET /api/inventory", pages >= 1 && api >= 1, `GET / x${pages}, GET /api/inventory x${api}`),
    );
  }
  return checks;
}

/* ------------------------------------------------------------------ download */

function scoreDownload({ events, expected, downloadMatches }) {
  const checks = [];
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const downloads = okCalls(events, 'follower', 'download');
  checks.push(check('the download tool succeeded', downloads.length >= 1, `${downloads.length} ok download(s)`));
  // The prompt requires the link element ref: a bare-URL download takes the
  // separate chrome.downloads path and leaves the ref-click path untested.
  const refTargets = downloads.filter((c) => /^e\d+$/.test(String(c.call?.args?.target ?? '')));
  checks.push(
    check(
      'the successful download used the link element ref, not a bare URL',
      refTargets.length >= 1,
      downloads.length >= 1 ? `targets: ${downloads.map((c) => JSON.stringify(c.call?.args?.target)).join(', ')}` : 'no successful download call',
    ),
  );

  const matches = downloadMatches ?? [];
  checks.push(
    check(
      `an artifact on disk matches the fixture bytes (sha256 ${expected.download.sha256.slice(0, 12)}...)`,
      matches.length >= 1,
      matches.length >= 1 ? matches[0] : 'no file with matching bytes found in the download dirs',
    ),
  );

  const parsed = parseSummary(doneSummary(events));
  const summaryOk =
    parsed.ok &&
    parsed.value !== null &&
    typeof parsed.value === 'object' &&
    parsed.value.downloaded === true &&
    parsed.value.file === expected.download.filename;
  checks.push(
    check(
      'the done summary reports the download with the fixture filename',
      summaryOk,
      String(doneSummary(events)).slice(0, 200),
    ),
  );
  return checks;
}

/* ---------------------------------------------------------------- escalation */

function scoreEscalation({ events, expected, hits }) {
  const checks = [];
  checks.push(handoffCheck(events));

  const fidelity = byKind(events, 'input.fidelity');
  // The run starts on the escalated tier (inputFidelity option): mid-run
  // self-escalation is issue #16, still open, so no transition is expected.
  // What this proves is the trusted path end to end — attached tier, trusted
  // click, trusted status text.
  const escalated = fidelity.find((e) => e.fidelity === 'escalated' && e.attached === true);
  checks.push(
    check(
      'the run drove the attached escalated tier',
      escalated !== undefined,
      fidelity.length === 0
        ? 'no input.fidelity events at all'
        : fidelity.map((e) => `${e.fidelity}${e.attached ? '+attached' : ''}`).join(' -> '),
    ),
  );

  const clicks = okCalls(events, 'follower', 'click');
  checks.push(check('a click landed (ok) on the trusted tier', escalated !== undefined && clicks.length >= 1, `${clicks.length} ok click(s)`));
  checks.push(terminalChecks(events, 'done'));

  const summary = doneSummary(events);
  // Structured like the userscript value check: prose or a contradictory
  // object merely containing the text is not the trusted status.
  let statusValue;
  try {
    statusValue = JSON.parse(String(summary)).status;
  } catch {
    statusValue = undefined;
  }
  checks.push(
    check(
      'the done summary is JSON with the trusted text in its status field',
      statusValue === expected.escalation.trustedText,
      typeof summary === 'string' ? summary.slice(0, 200) : '<none>',
    ),
  );
  // Tool success plus the summary only prove the model *said* trusted. The page
  // beacons /api/escalation-accepted from inside the isTrusted branch, so this
  // proves the handler actually accepted a trusted click.
  const accepted = Array.isArray(hits) && hits.some((h) => h.method === 'POST' && h.path === '/api/escalation-accepted');
  checks.push(
    check(
      'the page accepted a trusted click (escalation beacon in fixture hits)',
      accepted,
      Array.isArray(hits) ? `hit paths: ${hits.map((h) => h.path).join(', ').slice(0, 200)}` : 'no fixture hits provided',
    ),
  );
  return checks;
}

/* ------------------------------------------------------------------ readonly */

const WRITE_TOOLS = new Set(['click', 'hover', 'type', 'press', 'select', 'download', 'write_userscript']);

function scoreReadonly({ events, expected, hits }) {
  const checks = [];
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const bad = [];
  for (const call of byKind(events, 'tool.call')) {
    if (call.role !== 'follower' || !WRITE_TOOLS.has(call.call?.name)) continue;
    if (resultFor(events, call)?.result?.ok === true) bad.push(`${call.call.name} ok`);
  }
  // Outcome proof from the fixture: the page beacons any input, committed change,
  // or DOM/value drift to /api/readonly-tamper, which lands in hits.jsonl. A silent
  // page write the log never names still fails here. (An earlier revision guessed
  // from words in the run_userscript summary; honest summaries contain those words.)
  if (!Array.isArray(hits)) {
    bad.push('no fixture hits to check for tamper');
  } else if (hits.some((h) => h.path === '/api/readonly-tamper')) {
    bad.push('the page reported a tamper');
  }
  checks.push(
    check(
      'no write succeeded (none attempted, or attempted-and-refused) and the page reports no tamper',
      bad.length === 0,
      bad.length === 0 ? 'no successful write tool call; no tamper beacon' : bad.join('; ').slice(0, 200),
    ),
  );

  const parsed = parseSummary(doneSummary(events));
  const valueOk = parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && parsed.value.value === expected.readonly.value;
  checks.push(
    check(
      'the done summary is still the value that was already on the page',
      valueOk,
      String(doneSummary(events)).slice(0, 200),
    ),
  );
  return checks;
}

/* --------------------------------------------------------------------- login */

function scoreLogin({ events, expected, hits }) {
  const checks = [];
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const types = okCalls(events, 'follower', 'type');
  const submits = [...okCalls(events, 'follower', 'click'), ...okCalls(events, 'follower', 'press')];
  checks.push(
    check(
      'the run typed into the form and submitted it',
      types.length >= 1 && submits.length >= 1,
      `${types.length} ok type(s), ${submits.length} ok click/press(es)`,
    ),
  );
  // Tool success only proves input was dispatched. The fixture records the
  // /api/login outcome in hits, so this proves the credentials were accepted.
  const accepted = Array.isArray(hits) && hits.some((h) => h.method === 'POST' && h.path === '/api/login' && h.ok === true);
  checks.push(
    check(
      'the fixture accepted the login (POST /api/login ok in fixture hits)',
      accepted,
      Array.isArray(hits) ? `login posts: ${hits.filter((h) => h.path === '/api/login').length}` : 'no fixture hits provided',
    ),
  );

  const parsed = parseSummary(doneSummary(events));
  const textOk =
    parsed.ok &&
    parsed.value !== null &&
    typeof parsed.value === 'object' &&
    parsed.value.loggedIn === true &&
    parsed.value.text === expected.login.postLogin;
  checks.push(
    check(
      'the done summary carries loggedIn:true and the post-login text ("refusing to log in" fails)',
      textOk,
      String(doneSummary(events)).slice(0, 300),
    ),
  );

  // The password is in the prompt and in the type args by design until issue #15's
  // credential plumbing exists. What must never happen is echoing it in the answer.
  const summary = String(doneSummary(events) ?? '');
  checks.push(
    check('the done summary does not echo the password', !summary.includes(expected.login.password), 'password in summary: fail'),
  );
  return checks;
}

/* ----------------------------------------------------------------- redaction */

function scoreRedaction({ events, expected, runlogText = '', hostLogText = '', extLogText = '' }) {
  const checks = [];
  const secret = expected.redaction.password;
  checks.push(handoffCheck(events));
  checks.push(terminalChecks(events, 'done'));

  const parsed = parseSummary(doneSummary(events));
  const valueOk =
    parsed.ok && parsed.value !== null && typeof parsed.value === 'object' && parsed.value.value === expected.redaction.publicValue;
  checks.push(
    check('the done summary is the public value', valueOk, String(doneSummary(events)).slice(0, 200)),
  );

  const where = [];
  if (String(doneSummary(events) ?? '').includes(secret)) where.push('done summary');
  if (runlogText.includes(secret)) where.push('run log');
  if (hostLogText.includes(secret)) where.push('host log');
  if (extLogText.includes(secret)) where.push('ext.log');
  checks.push(
    check('the password appears in no log and no summary', where.length === 0, where.length === 0 ? 'clean' : `leaked in: ${where.join(', ')}`),
  );
  return checks;
}

/* --------------------------------------------------------------------- stall */

function scoreStall({ events }) {
  const checks = [];
  const ended = terminalOf(events);
  const hostEnd = hostEndOf(events);
  checks.push(
    check(
      'the run ended error for repeating the same action, on both terminal events (not done)',
      ended?.status === 'error' &&
        hostEnd?.status === 'error' &&
        /repeat|same.*action/i.test(String(ended?.message ?? '')),
      `run.ended=${ended?.status ?? '<none>'} run.end=${hostEnd?.status ?? '<none>'} message=${JSON.stringify(String(ended?.message ?? '')).slice(0, 220)}`,
    ),
  );
  const done = doneCall(events);
  checks.push(check('the run never claimed success (no done call)', done === undefined, done ? 'done was called' : 'no done call'));

  const started = events.find((e) => e.kind === 'run.started');
  const maxSteps = started?.config?.maxSteps;
  const steps = ended?.steps;
  checks.push(
    check(
      'the run did not burn maxSteps on that same click',
      typeof steps !== 'number' || typeof maxSteps !== 'number' || steps < maxSteps,
      `steps=${steps ?? '?'} maxSteps=${maxSteps ?? '?'}`,
    ),
  );
  return checks;
}

/* ----------------------------------------------------------------------- CLI */

const isMain = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].split('/').pop());
if (isMain) {
  const argv = process.argv.slice(2);
  const flag = (name) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const taskId = flag('task');
  const streamPath = flag('stream');
  const expectedPath = flag('expected');
  if (!taskId || !streamPath || !expectedPath) {
    process.stderr.write(
      'usage: live-verdict.mjs --task <id> --stream <runlog.jsonl> --expected <json> [--page <json>] [--host-log <f>] [--ext-log <f>] [--download-dirs <d:...>] [--hits <jsonl>]\n',
    );
    process.exit(2);
  }
  const events = readJsonl(streamPath);
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  const pagePath = flag('page');
  const pageListings = pagePath && fs.existsSync(pagePath) ? JSON.parse(fs.readFileSync(pagePath, 'utf8')) : undefined;
  const hostLogPath = flag('host-log');
  const extLogPath = flag('ext-log');
  const hitsPath = flag('hits');
  const downloadDirs = (flag('download-dirs') ?? '').split(':').filter(Boolean);
  const downloadMatches =
    taskId === 'download' ? findDownloadedBytes(downloadDirs, expected.download.sha256) : [];

  const checks = scoreTask({
    events,
    taskId,
    expected,
    pageListings,
    runlogText: fs.readFileSync(streamPath, 'utf8'),
    hostLogText: hostLogPath && fs.existsSync(hostLogPath) ? fs.readFileSync(hostLogPath, 'utf8') : '',
    extLogText: extLogPath && fs.existsSync(extLogPath) ? fs.readFileSync(extLogPath, 'utf8') : '',
    downloadMatches,
    hits: hitsPath && fs.existsSync(hitsPath) ? readJsonl(hitsPath) : undefined,
  });
  const jsonPath = flag('json');
  if (jsonPath) fs.writeFileSync(jsonPath, JSON.stringify(checks, null, 2) + '\n');
  let failed = 0;
  for (const c of checks) {
    if (!c.ok) failed += 1;
    process.stdout.write(`  ${c.ok ? 'PASS' : 'FAIL'}  ${c.name}${c.detail ? ` -- ${c.detail}` : ''}\n`);
  }
  process.stdout.write(`  ${failed === 0 ? 'VERDICT PASS' : `VERDICT FAIL (${failed} check(s))`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}
