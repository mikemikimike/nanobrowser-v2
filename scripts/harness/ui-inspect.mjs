#!/usr/bin/env node
/**
 * UI inspection: asserts the side panel itself in the harness's own browser.
 *
 * The verdicts judge run JSONL; this judges the product surface (hub status,
 * readiness, run log, handoff/tool cards, scripts console). A green verdict with
 * a blank or lying UI is a false pass.
 *
 *   # Once, before the first live task (the panel must be open DURING runs: it only
 *   # shows live broadcasts plus the last run it saw, so opening it after a run would
 *   # show an empty log):
 *   node scripts/harness/ui-inspect.mjs --mode open --ws <cdp url> --id <ext id>
 *     [--timeout <s>]
 *   # prints {"targetId": "..."} once hub-status reads connected
 *
 *   # After each task:
 *   node scripts/harness/ui-inspect.mjs --mode check --ws <cdp url> --target <id>
 *        --task <id> --runlog <runlog.jsonl> --expected <expected.json>
 *        --out <dir> [--expect-ready true|false] [--timeout <s>]
 *   # prints PASS/FAIL per assertion, writes <out>/<task>-panel.png and
 *   # <out>/<task>-inspection.json; exits 0 only if every assertion holds.
 *
 * <ws url> is the DevTools endpoint of the harness's own Chrome for Testing process
 * (from `agent-browser get cdp-url`), never the user's Chrome.
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};

const mode = flag('mode', 'check');
const ws = flag('ws');
const extId = flag('id');
const timeoutMs = Number(flag('timeout', '30')) * 1000;

if (!ws || (mode === 'open' && !extId)) {
  process.stderr.write('usage: ui-inspect.mjs --mode open --ws <url> --id <ext id> | --mode check --ws <url> --target <id> --task <id> --runlog <jsonl> --expected <json> --out <dir> | --mode toggle --ws <url> --target <id> --toggle <read-only|fidelity> --on <true|false> | --mode activate --ws <url> --match <url-prefix>\n');
  process.exit(2);
}

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exit(1);
}

const sock = new WebSocket(ws);
let seq = 0;
const pending = new Map();
sock.addEventListener('message', (ev) => {
  const msg = JSON.parse(String(ev.data));
  const waiter = msg.id !== undefined ? pending.get(msg.id) : undefined;
  if (!waiter) return;
  pending.delete(msg.id);
  if (msg.error) waiter.reject(new Error(`${msg.error.message} (${msg.error.code})`));
  else waiter.resolve(msg.result);
});
const call = (method, params = {}, sessionId) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    sock.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function evaluate(sessionId, expression) {
  const { result, exceptionDetails } = await call(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) {
    const why = exceptionDetails.exception?.description ?? exceptionDetails.text;
    throw new Error(`evaluate threw: ${String(why).split('\n')[0]} -- in: ${expression.slice(0, 160)}`);
  }
  return result.value;
}

async function waitFor(sessionId, expression, want, label, budgetMs = 10000) {
  const started = Date.now();
  for (;;) {
    const got = await evaluate(sessionId, expression);
    if (want(got)) return got;
    if (Date.now() - started > budgetMs) {
      throw new Error(`timed out waiting for ${label}; last value: ${JSON.stringify(got)?.slice(0, 300)}`);
    }
    await sleep(250);
  }
}

const PANEL_URL = (id) => `chrome-extension://${id}/sidepanel.html`;

/* -------------------------------------------------------------------- open */

async function openPanel() {
  const { targetId } = await call('Target.createTarget', { url: PANEL_URL(extId) });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  try {
    await waitFor(
      sessionId,
      `(() => { const el = document.querySelector('[data-testid="hub-status"]'); return el ? el.textContent : null; })()`,
      (v) => v === 'connected',
      'hub-status to read connected',
      timeoutMs,
    );
  } catch (err) {
    fail(`panel opened at ${PANEL_URL(extId)} but ${err.message}`);
  }
  process.stdout.write(JSON.stringify({ ok: true, targetId }) + '\n');
  process.exit(0);
}

/* ------------------------------------------------------------------- check */

const REQUIRED_TOOL = {
  ebay: 'run_userscript',
  userscript_debug: 'run_userscript',
  inventory: 'click',
  download: 'download',
  escalation: 'click',
  readonly: 'extract_text',
  login: 'type',
  redaction: 'extract_text',
  stall: 'click',
};

async function checkPanel() {
  const targetId = flag('target');
  const taskId = flag('task');
  const runlogPath = flag('runlog');
  const expectedPath = flag('expected');
  const outDir = flag('out');
  const expectReady = flag('expect-ready', 'true') !== 'false';
  if (!targetId || !taskId || !runlogPath || !expectedPath || !outDir) fail('check mode needs --target --task --runlog --expected --out');

  const events = fs.readFileSync(runlogPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const expected = JSON.parse(fs.readFileSync(expectedPath, 'utf8'));
  fs.mkdirSync(outDir, { recursive: true });

  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Page.enable', {}, sessionId).catch(() => undefined);
  // The task tab was frontmost for the run; the panel must be frontmost for
  // inspection (a background tab may never paint, hanging the screenshot).
  await call('Target.activateTarget', { targetId });
  await sleep(500);

  const results = [];
  const push = (name, ok, detail = '') => {
    results.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
    process.stdout.write(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` -- ${detail}` : ''}\n`);
  };

  const textOf = async (sel) =>
    evaluate(sessionId, `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? el.textContent : null; })()`);
  const countOf = async (sel) =>
    evaluate(sessionId, `(() => document.querySelectorAll(${JSON.stringify(sel)}).length)()`);
  const exists = async (sel) => (await countOf(sel)) > 0;
  const clickTab = async (tab) => {
    await evaluate(sessionId, `(() => { document.querySelector(${JSON.stringify(`#tab-${tab}`)})?.click(); return true; })()`);
    await sleep(400);
  };

  /* Header: hub status, no lingering worker banner. */
  const hub = await textOf('[data-testid="hub-status"]');
  push('hub-status reads connected', hub === 'connected', hub ?? 'missing');
  const bodyText = await evaluate(sessionId, 'document.body.textContent');
  push('the "Waiting for worker" banner is absent', !String(bodyText).includes('Waiting for worker'));

  /* Setup tab: readiness row, fidelity + read-only toggles reflect the run. */
  await clickTab('setup');
  const readinessExists = await exists('[data-testid="readiness-row"]');
  push('Setup shows a readiness row', readinessExists);
  if (readinessExists) {
    const ready = await evaluate(sessionId, `document.querySelector('[data-testid="readiness-row"]').getAttribute('data-ready')`);
    const rowText = await textOf('[data-testid="readiness-row"]');
    if (expectReady) {
      push('readiness row is ok in the live tier', ready === 'true', String(rowText).slice(0, 200));
    } else {
      push(
        'readiness row shows a reason, not a spinner',
        ready === 'false' && !String(rowText).includes('waiting for the worker'),
        String(rowText).slice(0, 200),
      );
    }
    push('fidelity explainer is present', await exists('[data-testid="fidelity-explainer"]'));
    // Toggles are role=switch buttons carrying aria-checked, not checkboxes.
    const fidelityOn = await evaluate(sessionId, `document.querySelector("#input-fidelity")?.getAttribute('aria-checked') ?? null`);
    const readonlyOn = await evaluate(sessionId, `document.querySelector("#read-only")?.getAttribute('aria-checked') ?? null`);
    push('fidelity and read-only toggles exist', fidelityOn !== null && readonlyOn !== null, `fidelity=${fidelityOn} readOnly=${readonlyOn}`);
    if (taskId === 'readonly') {
      push('read-only toggle is on for the readonly task', readonlyOn === 'true', `readOnly=${readonlyOn}`);
    }
  }

  /* Run tab: blocked reason absent, log shows this run's handoffs and tool cards. */
  await clickTab('run');
  const handoffs = events.filter((e) => e.kind === 'handoff').length;
  const doneSummary = events.findLast((e) => e.kind === 'tool.call' && e.call?.name === 'done')?.call?.args?.summary;
  const runLogExists = await exists('[data-testid="run-log"]');
  push('Run tab shows the run log', runLogExists);
  if (taskId !== 'stall') {
    // Harness runs go through nb-run options, so the stored config still has no models
    // picked and the gate bar shows a model-pick reason. That is expected; what must
    // never appear is a host/key/worker reason when the gate's infrastructure is green.
    const blockedReason = await textOf('[data-testid="run-blocked-reason"]');
    const infraBlocked = blockedReason !== null && /host|key|worker|offline|waiting/i.test(blockedReason);
    push(
      'no host/key/worker blocked reason is shown when readiness is green',
      !infraBlocked,
      blockedReason === null ? 'gate fully green' : String(blockedReason).slice(0, 160),
    );
  }
  if (runLogExists) {
    const cards = await countOf('[data-testid="handoff-card"]');
    push('handoff cards match the run log', cards === handoffs, `panel=${cards} runlog=${handoffs}`);
    const tool = REQUIRED_TOOL[taskId];
    const toolCards = await evaluate(
      sessionId,
      `[...document.querySelectorAll('[data-testid="tool-call-summary"]')].map((el) => el.textContent).join('\\n---\\n')`,
    );
    const sawTool = tool ? String(toolCards).includes(tool) : true;
    push(`a tool card names ${tool}`, sawTool, toolCards ? String(toolCards).slice(0, 200) : 'no tool cards');
    if (taskId === 'stall') {
      const ended = await textOf('[data-testid="run-ended"]');
      push('stall renders run-ended with the repeat-action error', ended !== null && /repeat/i.test(String(ended)), String(ended).slice(0, 200));
      const resultCard = await textOf('[data-testid="run-result-card"]');
      push('stall shows no success card', resultCard === null || !/Done/.test(String(resultCard)), String(resultCard).slice(0, 160));
    } else if (typeof doneSummary === 'string' && doneSummary.length > 0) {
      // The result card renders outcome/steps/message; the summary itself lives in the
      // done tool card inside the run log. Both must agree with the scored run.
      const ended = events.filter((e) => e.kind === 'run.ended').at(-1);
      const resultCard = await textOf('[data-testid="run-result-card"]');
      push(
        'the result card shows the scored outcome and step count',
        resultCard !== null && /Done/.test(String(resultCard)) && String(resultCard).includes(`${ended?.steps ?? '?'} steps`),
        resultCard ? String(resultCard).slice(0, 200) : 'no result card',
      );
      const probe = doneSummary.slice(0, 80);
      // Tool cards render collapsed (args only mount when expanded), so open every
      // disclosure in the log before looking for the summary text.
      await evaluate(
        sessionId,
        `(() => { for (const b of document.querySelectorAll('[data-testid="run-log"] button[aria-expanded="false"]')) b.click(); return true; })()`,
      );
      await sleep(300);
      const logText = await evaluate(sessionId, `document.querySelector('[data-testid="run-log"]')?.textContent ?? ''`);
      push(
        'the run log shows the same summary the verdict scored',
        String(logText).includes(probe),
        `summary prefix ${JSON.stringify(probe).slice(0, 100)} ${String(logText).includes(probe) ? 'shown' : 'MISSING'}`,
      );
    }
  }

  /* Per-task screenshot of the Run tab for human review (stored, not scored). */
  try {
    const { data } = await call('Page.captureScreenshot', { format: 'png' }, sessionId);
    const shot = path.join(outDir, `${taskId}-panel.png`);
    fs.writeFileSync(shot, Buffer.from(data, 'base64'));
    push('per-task screenshot stored', true, shot);
  } catch (err) {
    push('per-task screenshot stored', false, err.message);
  }

  /* Scripts tab after the userscript-debug task: the revised script runs here too. */
  if (taskId === 'userscript_debug') {
    await clickTab('scripts');
    const names = await evaluate(
      sessionId,
      `[...document.querySelectorAll('section ul li button')].map((b) => b.textContent).join('\\n')`,
    );
    const revisedListed = String(names).includes('harness-debug');
    push('the revised script is in the Scripts list', revisedListed, String(names).slice(0, 300));
    if (revisedListed) {
      // Load the revised script into the editor, then Run sends the editor text.
      await evaluate(
        sessionId,
        `(() => { const btn = [...document.querySelectorAll('section ul li button')].find((b) => b.textContent.includes('harness-debug')); btn?.click(); return Boolean(btn); })()`,
      );
      await sleep(400);
      await evaluate(
        sessionId,
        `(() => { const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Run'); btn?.click(); return Boolean(btn); })()`,
      );
      let value = null;
      try {
        value = await waitFor(
          sessionId,
          `(() => document.querySelector('[data-testid="script-value"]')?.textContent ?? null)()`,
          (v) => typeof v === 'string' && v.length > 0,
          'script-value to appear',
          20000,
        );
      } catch (err) {
        push('panel run of the revised script shows the fixed value', false, err.message);
      }
      if (value !== null) {
        push(
          'panel run of the revised script shows the fixed value',
          String(value).includes(expected.debug.fixedValue),
          String(value).slice(0, 200),
        );
        // The executed revision must be the agent's second run, not a stale save:
        // the result header names the scriptId it ran.
        const header = await evaluate(
          sessionId,
          `(() => document.querySelector('[data-testid="script-value"]')?.closest('div')?.parentElement?.querySelector('p span.font-mono')?.textContent ?? null)()`,
        );
        const secondRun = [...events]
          .reverse()
          .find((e) => e.kind === 'tool.call' && e.call?.name === 'run_userscript')?.call?.args?.scriptId;
        push(
          'the panel executed the same revision the agent reran',
          typeof header === 'string' && typeof secondRun === 'string' && header === secondRun,
          `panel ran ${header ?? '<none>'}, agent reran ${secondRun ?? '<none>'}`,
        );
      }
      // The first run's console error lives in the run log (userscript.output), which
      // the verdict already scored; the Scripts tab only shows panel-initiated runs.
      const loggedError = events.some((e) => e.kind === 'userscript.output' && e.level === 'error');
      push('the first run console error is in the run log (verdict-scored)', loggedError);
    }
  }

  /* Redaction: the password must not be rendered anywhere in the panel DOM. */
  if (taskId === 'redaction') {
    const html = await evaluate(sessionId, 'document.documentElement.innerHTML');
    push(
      'the password is rendered nowhere in the panel DOM',
      !String(html).includes(expected.redaction.password),
      'leaked into panel DOM: fail',
    );
  }

  fs.writeFileSync(path.join(outDir, `${taskId}-inspection.json`), JSON.stringify({ task: taskId, at: new Date().toISOString(), results }, null, 2) + '\n');
  const failed = results.filter((r) => !r.ok).length;
  process.stdout.write(`  ${failed === 0 ? 'INSPECT PASS' : `INSPECT FAIL (${failed} assertion(s))`}\n`);
  process.exit(failed === 0 ? 0 : 1);
}

/* ------------------------------------------------------------------ toggle */

/**
 * Flips a Setup toggle in the open panel (the read-only task needs stored
 * readOnly on: nb-run's --option values are strings, and the worker only honours
 * a boolean readOnly, so the option cannot carry it -- the toggle is the real path).
 */
async function toggleSetup() {
  const targetId = flag('target');
  const which = flag('toggle');
  const want = flag('on') === 'true';
  const sel = which === 'read-only' ? '#read-only' : which === 'fidelity' ? '#input-fidelity' : null;
  if (!targetId || !sel) fail('toggle mode needs --target and --toggle <read-only|fidelity> --on <true|false>');
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Target.activateTarget', { targetId });
  await evaluate(sessionId, `document.querySelector('#tab-setup')?.click()`);
  await sleep(400);
  // role=switch buttons: state lives in aria-checked, not .checked.
  const readState = `document.querySelector(${JSON.stringify(sel)})?.getAttribute('aria-checked') ?? null`;
  const before = await evaluate(sessionId, readState);
  if (before === null) fail(`toggle ${sel} not found in the panel`);
  if ((before === 'true') !== want) {
    await evaluate(sessionId, `document.querySelector(${JSON.stringify(sel)})?.click()`);
    await sleep(400);
  }
  const after = await evaluate(sessionId, readState);
  await evaluate(sessionId, `document.querySelector('#tab-run')?.click()`);
  const ok = (after === 'true') === want;
  process.stdout.write(JSON.stringify({ ok, toggle: which, before, after }) + '\n');
  process.exit(ok ? 0 : 1);
}

/* ---------------------------------------------------------------- activate */

/**
 * Brings the task tab to the front. The panel target created by `open` becomes the
 * active tab, and the worker refuses to run on an extension page -- so every task
 * activates its own page (by URL prefix) after navigating and before nb-run.
 */
async function activateTab() {
  const match = flag('match');
  if (!match) fail('activate mode needs --match <url-prefix>');
  const { targetInfos } = await call('Target.getTargets');
  const target = targetInfos.find((t) => t.type === 'page' && typeof t.url === 'string' && t.url.startsWith(match));
  if (!target) fail(`no page target starts with ${match}`);
  await call('Target.activateTarget', { targetId: target.targetId });
  process.stdout.write(JSON.stringify({ ok: true, targetId: target.targetId, url: target.url }) + '\n');
  process.exit(0);
}

/* ----------------------------------------------------------------------- main */

const timer = setTimeout(() => fail(`timed out after ${timeoutMs / 1000}s`), timeoutMs + 30000);
sock.addEventListener('error', () => fail(`cannot connect to ${ws}`));
sock.addEventListener('open', async () => {
  try {
    if (mode === 'open') await openPanel();
    else if (mode === 'toggle') await toggleSetup();
    else if (mode === 'activate') await activateTab();
    else await checkPanel();
  } catch (err) {
    fail(err.message);
  } finally {
    clearTimeout(timer);
  }
});
