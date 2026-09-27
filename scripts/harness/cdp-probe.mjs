#!/usr/bin/env node
/**
 * Proves the extension's service worker is running in the browser the harness spawned.
 *
 *   node scripts/harness/cdp-probe.mjs --ws <browser ws url> --id <extension id> [--timeout <s>]
 *
 * <ws url> is the DevTools endpoint of the harness's own Chrome for Testing process
 * (from `agent-browser get cdp-url`), never the user's Chrome. Polls Target.getTargets
 * for the extension's service_worker target, attaches, and evaluates chrome.runtime in
 * the worker. Prints one JSON line and exits 0 on success, 1 on timeout or mismatch.
 */
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const ws = flag('ws');
const extId = flag('id');
const timeoutMs = Number(flag('timeout', '30')) * 1000;
if (!ws || !extId) {
  process.stderr.write('usage: cdp-probe.mjs --ws <url> --id <extension id> [--timeout <s>]\n');
  process.exit(2);
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

function fail(message) {
  process.stdout.write(JSON.stringify({ ok: false, error: message }) + '\n');
  process.exit(1);
}

const timer = setTimeout(() => fail(`no service worker for chrome-extension://${extId}/ within ${timeoutMs / 1000}s`), timeoutMs);

sock.addEventListener('error', () => fail(`cannot connect to ${ws}`));
sock.addEventListener('open', async () => {
  try {
    const version = await call('Browser.getVersion');
    const prefix = `chrome-extension://${extId}/`;
    let worker;
    for (;;) {
      const { targetInfos } = await call('Target.getTargets');
      worker = targetInfos.find((t) => t.type === 'service_worker' && t.url.startsWith(prefix));
      if (worker) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    const { sessionId } = await call('Target.attachToTarget', { targetId: worker.targetId, flatten: true });
    const { result, exceptionDetails } = await call(
      'Runtime.evaluate',
      {
        expression:
          'JSON.stringify({ id: chrome.runtime.id, name: chrome.runtime.getManifest().name, version: chrome.runtime.getManifest().version, nativeMessaging: chrome.runtime.getManifest().permissions.includes("nativeMessaging") })',
        returnByValue: true,
      },
      sessionId,
    );
    if (exceptionDetails) fail(`evaluate in worker threw: ${exceptionDetails.text}`);
    const runtime = JSON.parse(result.value);
    if (runtime.id !== extId) fail(`worker reports extension id ${runtime.id}, expected ${extId}`);
    clearTimeout(timer);
    process.stdout.write(
      JSON.stringify({ ok: true, browser: version.product, userAgent: version.userAgent, worker: worker.url, runtime }) + '\n',
    );
    process.exit(0);
  } catch (err) {
    fail(err.message);
  }
});
