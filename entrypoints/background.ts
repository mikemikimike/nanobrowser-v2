/**
 * The service worker. Thin on purpose: it constructs the real adapters and hands
 * them to `createWorker` (src/runtime/worker.ts), which owns every message.
 *
 * Nothing here has logic worth testing — the seams below (`HostClient`,
 * `PageDriver`, `chromeTabsPort`, `createChromeDebuggerApi`) are each covered by
 * their own subsystem's tests, and the wiring they feed is covered by
 * `src/runtime/*.test.ts` with fakes.
 */
import { defineBackground } from '#imports';
import { ChromePort, SIDEPANEL_PORT } from '@/src/messaging';
import { createChatModel } from '@/src/agent/models';
import { createChromeDebuggerApi, DebuggerInputTier } from '@/src/input';
import { HostClient, createHostFetch } from '@/src/host';
import { PageDriver } from '@/src/page';
import { getConfig } from '@/src/storage';
import { notifyUserscriptProgress, resolveUserscript, runUserscript, seedDefaults } from '@/src/userscripts';
import { RunManager, chromeTabsPort, createWorker, installErrorForwarding } from '@/src/runtime';
import { sessionReplayStore, sessionUserscriptValueStore } from '@/src/runtime/durability';
import { getLastRunId, setLastRunId } from '@/src/ui/state/lastRun';

export default defineBackground(() => {
  // Chrome does not start an MV3 service worker on browser launch unless the worker
  // registered a startup listener the last time it ran. Without this, a Chrome restart
  // leaves the worker inactive, so connectNative never runs and the host never exists
  // for nb-run / e2e. The listener body can be empty; registration is the wake.
  // https://groups.google.com/a/chromium.org/g/chromium-extensions/c/XY6u0raKRJQ
  chrome.runtime.onStartup.addListener(() => {});

  // The toolbar action opens the side panel (R-05). Chrome 114+, needs the sidePanel permission.
  void chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error: unknown) => console.error('[nanobrowser] setPanelBehavior failed', error));

  chrome.runtime.onInstalled.addListener(() => {
    // The bundled example userscripts land on first install (R-09).
    void seedDefaults().catch((error: unknown) =>
      console.error('[nanobrowser] seedDefaults failed', error),
    );
  });

  const host = new HostClient();
  // Before anything else can throw: worker errors are otherwise only visible on the
  // chrome://extensions page, which no unattended run is watching (docs/host-protocol.md).
  installErrorForwarding({
    source: 'worker',
    target: self,
    console,
    send: (entry) => host.appendLog(entry),
  });
  // Connect eagerly: the dev trigger (docs/host-protocol.md) pushes `run.start` with the
  // panel closed, and an open native port keeps this worker alive (Chrome 105+).
  host.connect();
  const hostFetch = createHostFetch(host);
  const driver = new PageDriver();
  // M6 durability, resolved once: undefined outside the extension (tests, dev).
  const replayStore = sessionReplayStore();

  const runManager = new RunManager({
    driver,
    tabs: chromeTabsPort(),
    host,
    // C-07: the host holds the key; the panel picks the models, one per role (R-11).
    // `source` (from the picked ModelInfo, threaded via Config) chooses the base
    // URL/credential; createChatModel defaults it to OpenRouter when absent.
    createModel: (model, source) => createChatModel({ model, source, fetch: hostFetch }),
    makeDebuggerTier: (onDetach) => new DebuggerInputTier(createChromeDebuggerApi(), { onDetach }),
    runUserscript: async (scriptId, tabId, args) => {
      // `resolveUserscript` tolerates the script's name: weak Followers echo the
      // parenthesized name from the per-turn prompt instead of the id (seen live
      // with ebay-search-extract). Unambiguous names run; anything else errors.
      const script = await resolveUserscript(scriptId);
      if (!script) {
        return { scriptId, ok: false, error: `unknown userscript: ${scriptId}`, console: [], durationMs: 0 };
      }
      // Agent runs stream console lines into the run log; panel runs do not.
      return runUserscript({ tabId, script, reportProgress: true, ...(args ? { args } : {}) });
    },
    saveLastRunId: setLastRunId,
    // M6: the replay ring and the last-userscript value survive a worker
    // restart in chrome.storage.session. Undefined outside the extension.
    ...(replayStore ? { replayStore } : {}),
    userscriptValueStoreFor: (runId) => sessionUserscriptValueStore(runId),
  });

  const worker = createWorker({
    host,
    runManager,
    getConfig,
    getLastRunId,
    extensionVersion: chrome.runtime.getManifest().version,
  });

  const runtime = chrome.runtime as typeof chrome.runtime & {
    onUserScriptMessage?: { addListener(cb: (message: { type?: string; level?: unknown; text?: unknown; at?: unknown }) => void): void };
  };
  runtime.onUserScriptMessage?.addListener((message) => {
    if (message?.type === 'nanobrowser.userscript.progress') notifyUserscriptProgress(message);
  });

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== SIDEPANEL_PORT) return;
    worker.connect(new ChromePort(port));
  });
});
