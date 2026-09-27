/**
 * The userscripts subsystem (R-09/R-10): a stored catalog, a live runner on
 * `chrome.userScripts.execute()`, and an edit-and-re-run debug loop.
 *
 * `handleUserscriptMessage` is the single entry point the service worker calls for
 * the `userscript.*` half of the panel/worker contract. It owns nothing else: it
 * takes a `PanelToWorkerMessage`, does the work, and hands back the matching
 * `WorkerToPanelMessage` for the worker to post.
 */
export * from './match-pattern';
export * from './catalog';
export * from './authoring';
export * from './examples';
export * from './runner';
export * from './debug';
export * from './i03';

import type { PanelToWorkerMessage, RunEvent, WorkerToPanelMessage } from '@/src/messaging';
import { deleteUserscript, getUserscript, listUserscripts, saveUserscript, seedDefaults } from './catalog';
import { applyUserscriptHeader } from './metadata';
import { DebugSession, toRunEvents } from './debug';
import { runUserscript, type AvailabilityEnv, type TabsApi, type UserScriptsApi } from './runner';

export interface UserscriptMessageContext {
  /** The tab the run targets. Falls back to {@link resolveTabId}. */
  tabId?: number;
  resolveTabId?: () => Promise<number | undefined>;
  /** The tab's URL, when the caller already knows it. */
  url?: string;
  api?: UserScriptsApi;
  tabs?: TabsApi;
  env?: AvailabilityEnv;
  now?: () => number;
  /** Run-log sink (R-07). Every captured console line is emitted through it. */
  emit?: (event: RunEvent) => void;
  /** Reused across runs so the panel keeps the last result per script (R-10). */
  session?: DebugSession;
}

function errorReply(message: string, inReplyTo: string): WorkerToPanelMessage {
  return { type: 'error', payload: { message, inReplyTo } };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function listReply(): Promise<WorkerToPanelMessage> {
  return { type: 'userscript.list', payload: { scripts: await listUserscripts() } };
}

/**
 * Handles `userscript.run | list | save | delete`. Returns `undefined` for every
 * other message type so the worker can fall through to its own handlers.
 */
export async function handleUserscriptMessage(
  message: PanelToWorkerMessage,
  context: UserscriptMessageContext = {},
): Promise<WorkerToPanelMessage | undefined> {
  switch (message.type) {
    case 'userscript.list': {
      // First look at the catalog is also when the bundled examples land.
      await seedDefaults(context.now);
      return listReply();
    }

    case 'userscript.save': {
      try {
        // A save from the panel is the user saving, so the script becomes theirs --
        // including one the agent wrote and the user then edited. Without this the
        // `author: 'agent'` stamp survived the user's own edit, and the agent could
        // overwrite work the user had put into it.
        await saveUserscript(applyUserscriptHeader({ ...message.payload, author: undefined }), context.now);
      } catch (error) {
        return errorReply(describe(error), 'userscript.save');
      }
      return listReply();
    }

    case 'userscript.delete': {
      await deleteUserscript(message.payload.id);
      return listReply();
    }

    case 'userscript.run': {
      const { scriptId, code } = message.payload;
      const script = await getUserscript(scriptId);
      if (!script) return errorReply(`unknown userscript: ${scriptId}`, 'userscript.run');

      const tabId = context.tabId ?? (await context.resolveTabId?.());
      if (tabId === undefined) return errorReply('no target tab for the userscript run', 'userscript.run');

      const session = context.session;
      let result;
      if (session) {
        if (session.script.id !== script.id) session.select(script);
        result = await session.rerun(code ?? script.code);
      } else {
        result = await runUserscript({
          tabId,
          script,
          code,
          url: context.url,
          api: context.api,
          tabs: context.tabs,
          env: context.env,
          now: context.now,
        });
      }

      if (context.emit) {
        for (const event of toRunEvents(result, context.now)) context.emit(event);
      }

      return { type: 'userscript.result', payload: result };
    }

    default:
      return undefined;
  }
}
