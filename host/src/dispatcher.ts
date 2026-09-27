import { ArtifactError, saveArtifact } from './artifacts.ts';
import { appendExtLog, ExtLogError, mirrorToHostLog, toEntry } from './extlog.ts';
import { getInjector, type InputInjector } from './input/index.ts';
import type { LlmProxy } from './llm.ts';
import { log } from './log.ts';
import type {
  ArtifactSaveMsg,
  ErrorCode,
  InboundMsg,
  InputMsg,
  LlmRequestMsg,
  LogAppendMsg,
  OutboundMsg,
  RunLogAppendMsg,
} from './protocol.ts';
import { appendRunLog, assertRunId, RunLogError } from './runlog.ts';

export interface DispatcherDeps {
  send: (msg: OutboundMsg) => void;
  llm: LlmProxy;
  runsDir: string;
  /** Where extension-forwarded diagnostics land. Defaults to ~/.local/share/nanobrowser/ext.log. */
  extLogPath?: string;
  /** Base directory for `artifact.save`. Defaults to ~/.local/share/nanobrowser/artifacts. */
  artifactsDir?: string;
  /** Mirrors run-log events to dev unix-socket subscribers. */
  onRunEvent?: (runId: string, event: unknown) => void;
  injector?: () => InputInjector;
}

const INPUT_TYPES = new Set(['input.moveTo', 'input.click', 'input.typeText', 'input.key']);

/** Fire-and-forget messages: `id` is optional on these two, required everywhere else. */
const OPTIONAL_ID_TYPES = new Set(['runlog.append', 'log.append']);

export class Dispatcher {
  readonly #deps: DispatcherDeps;
  /**
   * The tail of each run's append chain. main.ts handles frames concurrently, and two
   * awaited appendFile calls can land in either order -- run.end overtaking run.ended
   * made the trigger close nb-run's stream before the run's own terminal event.
   */
  readonly #runLogTails = new Map<string, Promise<void>>();

  constructor(deps: DispatcherDeps) {
    this.#deps = deps;
  }

  #fail(id: string | undefined, code: ErrorCode, message: string): void {
    this.#deps.send({ type: 'error', id, code, message });
  }

  async handle(raw: unknown): Promise<void> {
    if (typeof raw !== 'object' || raw === null || typeof (raw as { type?: unknown }).type !== 'string') {
      return this.#fail(undefined, 'bad_request', 'message must be an object with a string "type"');
    }
    const msg = raw as InboundMsg;
    const id = (raw as { id?: unknown }).id;
    if (!OPTIONAL_ID_TYPES.has(msg.type) && typeof id !== 'string') {
      return this.#fail(undefined, 'bad_request', `${msg.type} requires a string "id"`);
    }

    switch (msg.type) {
      case 'key.status': {
        const { ready, reason } = await this.#deps.llm.keyStatus();
        return this.#deps.send({ type: 'key.status.result', id: msg.id, ready, ...(reason ? { reason } : {}) });
      }

      case 'models.list': {
        try {
          // Both catalogs (OpenRouter + Kilo), fetched in parallel and merged; one
          // source failing does not fail this call (host/src/llm.ts modelsAll()).
          const { status, body } = await this.#deps.llm.modelsAll();
          return this.#deps.send({ type: 'models.list.result', id: msg.id, status, body });
        } catch (err) {
          return this.#fail(msg.id, 'upstream', (err as Error).message);
        }
      }

      case 'llm.request': {
        const m = msg as LlmRequestMsg;
        if (typeof m.url !== 'string' || m.url.length === 0) {
          return this.#fail(m.id, 'bad_request', 'llm.request requires a string "url"');
        }
        return this.#deps.llm.request(m);
      }

      case 'llm.abort':
        this.#deps.llm.abort(msg.id);
        return;

      case 'runlog.append': {
        const m = msg as RunLogAppendMsg;
        try {
          assertRunId(m.runId);
        } catch (err) {
          return this.#fail(m.id, 'bad_request', (err as RunLogError).message);
        }
        const append = async (): Promise<void> => {
          try {
            await appendRunLog(m.runId, m.event, this.#deps.runsDir);
          } catch (err) {
            return this.#fail(m.id, 'io', (err as Error).message);
          }
          this.#deps.onRunEvent?.(m.runId, m.event);
          this.#deps.send({ type: 'runlog.ack', ...(m.id ? { id: m.id } : {}), runId: m.runId, ok: true });
        };
        // The stored tail is guarded: if this append throws (a subscriber or a dead
        // socket), the caller still sees the rejection, but the chain itself stays
        // healthy so later appends are not silently skipped behind a rejected link.
        const prev = this.#runLogTails.get(m.runId) ?? Promise.resolve();
        const run = prev.then(append, append);
        const guarded = run.catch(() => {});
        this.#runLogTails.set(m.runId, guarded);
        try {
          await run;
        } finally {
          if (this.#runLogTails.get(m.runId) === guarded) this.#runLogTails.delete(m.runId);
        }
        return;
      }

      case 'artifact.save': {
        const m = msg as ArtifactSaveMsg;
        if (typeof m.runId !== 'string' || typeof m.filename !== 'string' || typeof m.content !== 'string') {
          return this.#fail(m.id, 'bad_request', 'artifact.save requires string runId, filename and content');
        }
        let result: { path: string; bytes: number };
        try {
          result = await saveArtifact(m.runId, m.filename, m.content, this.#deps.artifactsDir);
        } catch (err) {
          if (err instanceof ArtifactError || err instanceof RunLogError) {
            return this.#fail(m.id, 'bad_request', (err as Error).message);
          }
          return this.#fail(m.id, 'io', (err as Error).message);
        }
        return this.#deps.send({
          type: 'artifact.save.result',
          id: m.id,
          runId: m.runId,
          filename: m.filename,
          bytes: result.bytes,
          path: result.path,
        });
      }

      case 'log.append': {
        const m = msg as LogAppendMsg;
        let entry;
        try {
          entry = toEntry(m);
        } catch (err) {
          return this.#fail(m.id, 'bad_request', (err as ExtLogError).message);
        }
        try {
          await appendExtLog(entry, this.#deps.extLogPath);
        } catch (err) {
          return this.#fail(m.id, 'io', (err as Error).message);
        }
        mirrorToHostLog(entry);
        return this.#deps.send({ type: 'log.ack', ...(m.id ? { id: m.id } : {}), ok: true });
      }

      default: {
        if (INPUT_TYPES.has(msg.type)) return this.#handleInput(msg as InputMsg);
        log('warn', 'unknown message type', { type: (msg as { type: string }).type });
        return this.#fail(typeof id === 'string' ? id : undefined, 'unknown_type', `unknown type ${msg.type}`);
      }
    }
  }

  async #handleInput(m: InputMsg): Promise<void> {
    const injector = (this.#deps.injector ?? getInjector)();
    try {
      switch (m.type) {
        case 'input.moveTo':
          await injector.moveTo(Number(m.x), Number(m.y));
          break;
        case 'input.click':
          await injector.click((m.button ?? 'left') as 'left');
          break;
        case 'input.typeText':
          await injector.typeText(String(m.text ?? ''));
          break;
        case 'input.key':
          await injector.key(String(m.name ?? ''), (m.action ?? 'press') as 'press');
          break;
      }
      this.#deps.send({ type: 'input.result', id: m.id, ok: true, injector: injector.name });
    } catch (err) {
      this.#deps.send({
        type: 'input.result',
        id: m.id,
        ok: false,
        injector: injector.name,
        reason: (err as Error).message,
      });
    }
  }
}
