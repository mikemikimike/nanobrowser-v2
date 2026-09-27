/**
 * Preloaded into the HARNESS's own host process only (`node --import` in the wrapper the
 * harness writes into its temp dir; host/bin/nanobrowser-host is never touched). Replaces
 * `globalThis.fetch`, which is the host's only way out to a model:
 *
 * - NANOBROWSER_CASSETTE=record: OpenRouter-shaped requests are answered by a scripted
 *   Leader and Follower defined below, and the host's own cassette code records every
 *   reply. Nothing leaves the machine; the fake key the harness's `doppler` shim hands
 *   the host is only ever seen by this function.
 * - NANOBROWSER_CASSETTE=replay: every fetch throws. The run can only succeed if the
 *   host's cassette replay serves every model call from disk.
 *
 * The script is a policy, not a transcript. Each reply is derived from what the
 * extension actually sent -- the Follower's page snapshot, the text its extract_text
 * returned, the Leader's evidence read -- so a broken snapshot, a click that did not
 * land, or a page read that came back empty produces a wrong answer or `blocked`, and
 * the harness verdict fails.
 *
 * Every request/response pair is appended to NB_HARNESS_UPSTREAM_LOG when set.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const mode = process.env.NANOBROWSER_CASSETTE ?? 'off';
const logPath = process.env.NB_HARNESS_UPSTREAM_LOG;

const ROW_RE = /\b([A-Z]{2}-\d{4})\s*·\s*([^·\n]+?)\s*·\s*(\d+) in stock/g;
const REVEAL_RE = /button "Reveal inventory" \[ref=(e\d+)\]/;

function record(entry) {
  if (!logPath) return;
  try {
    fs.appendFileSync(logPath, JSON.stringify({ at: Date.now(), ...entry }) + '\n');
  } catch {
    /* diagnostics only */
  }
}

function textOf(message) {
  const { content } = message ?? {};
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : '')).join('\n');
}

function rowsIn(text) {
  return [...text.matchAll(ROW_RE)].map((m) => ({ sku: m[1], name: m[2].trim(), stock: Number(m[3]) }));
}

/** Tool name of a `tool` message, recovered from the assistant call it answers. */
function toolResults(messages, name) {
  const ids = new Set();
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const c of m.tool_calls ?? []) if (c.function?.name === name) ids.add(c.id);
  }
  return messages.filter((m) => m.role === 'tool' && ids.has(m.tool_call_id)).map(textOf);
}

function lastIndexWhere(list, pred) {
  for (let i = list.length - 1; i >= 0; i--) if (pred(list[i])) return i;
  return -1;
}

const SUBGOALS = [
  'Reveal the inventory list on this page',
  'Read every inventory row and report them as JSON',
];

function leaderTurn(messages) {
  const lastUser = lastIndexWhere(messages, (m) => m.role === 'user');
  const situation = textOf(messages[lastUser]);
  const replan = /signalled [A-Z_]+/.test(situation);
  const thisTurn = messages.slice(lastUser + 1);
  const evidence = toolResults(thisTurn, 'leader_snapshot');

  if (replan && evidence.length === 0) {
    return { name: 'leader_snapshot', args: {} };
  }
  const revealed = evidence.some((t) => rowsIn(t).length > 0);
  return {
    name: 'set_plan',
    args: {
      plan: 'Reveal the hidden inventory, then read every row and report it as JSON.',
      subgoals: SUBGOALS,
      currentSubgoal: replan && revealed ? 1 : 0,
    },
  };
}

function followerTurn(messages) {
  const observation = textOf(messages[lastIndexWhere(messages, (m) => m.role === 'user')]);
  const extracted = toolResults(messages, 'extract_text');
  const readRows = extracted.length ? rowsIn(extracted.at(-1)) : [];

  if (readRows.length > 0) {
    return {
      name: 'done',
      args: {
        summary: JSON.stringify({ inventory: readRows, count: readRows.length }),
        signal: 'SUBGOAL_COMPLETE',
        note: 'every inventory row was read with extract_text',
      },
    };
  }
  if (rowsIn(observation).length > 0) {
    return {
      name: 'extract_text',
      args: { maxChars: 4000, signal: 'CONTINUE', note: 'the inventory is visible; reading it as text' },
    };
  }
  const reveal = REVEAL_RE.exec(observation);
  if (reveal && extracted.length === 0) {
    return {
      name: 'click',
      args: { ref: reveal[1], signal: 'SUBGOAL_COMPLETE', note: 'clicked Reveal inventory' },
    };
  }
  return {
    name: 'blocked',
    args: {
      reason: 'the snapshot shows neither inventory rows nor a Reveal inventory button',
      signal: 'BLOCKED',
      note: 'scripted follower found nothing it recognises',
    },
  };
}

function completion(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const tools = (body?.tools ?? []).map((t) => t?.function?.name).filter(Boolean);
  const role = tools.includes('set_plan') ? 'leader' : 'follower';
  const turn = role === 'leader' ? leaderTurn(messages) : followerTurn(messages);
  if (!tools.includes(turn.name)) {
    throw new Error(`scripted ${role} wanted ${turn.name}, which is not bound (bound: ${tools.join(', ')})`);
  }
  const digest = createHash('sha256').update(JSON.stringify(messages)).digest('hex');
  const callId = `call_${digest.slice(0, 16)}`;
  const response = {
    id: `chatcmpl-harness-${digest.slice(0, 12)}`,
    object: 'chat.completion',
    created: 0,
    model: body?.model ?? 'harness',
    choices: [
      {
        index: 0,
        finish_reason: 'tool_calls',
        message: {
          role: 'assistant',
          content: '',
          tool_calls: [{ id: callId, type: 'function', function: { name: turn.name, arguments: JSON.stringify(turn.args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  };
  return { role, turn, callId, response };
}

function sse(response) {
  const choice = response.choices[0];
  const call = choice.message.tool_calls[0];
  const chunk = (delta, finish = null) =>
    `data: ${JSON.stringify({ ...response, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
  return (
    chunk({ role: 'assistant', content: '', tool_calls: [{ index: 0, ...call }] }) +
    chunk({}, choice.finish_reason) +
    'data: [DONE]\n\n'
  );
}

function json(status, value) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const method = (init.method ?? 'GET').toUpperCase();

  if (mode === 'replay') {
    record({ sealed: true, method, url });
    throw new Error(`harness: network is sealed in cassette replay mode (${method} ${url})`);
  }

  const u = new URL(url);
  if (u.origin !== 'https://openrouter.ai' && u.origin !== 'https://api.kilo.ai') {
    record({ refused: true, method, url });
    throw new Error(`harness: scripted upstream refuses ${u.origin}`);
  }
  if (u.pathname.endsWith('/key')) {
    return json(200, { data: { label: 'nanobrowser harness scripted upstream' } });
  }
  if (u.pathname.endsWith('/models')) {
    const model = (id) => ({ id, name: id, context_length: 32768, pricing: { prompt: '0', completion: '0' }, supported_parameters: ['tools'] });
    return json(200, { data: [model('harness/scripted-leader'), model('harness/scripted-follower')] });
  }
  if (u.pathname.endsWith('/chat/completions') && method === 'POST') {
    const body = JSON.parse(typeof init.body === 'string' ? init.body : '{}');
    let out;
    try {
      out = completion(body);
    } catch (err) {
      record({ method, url, error: err.message });
      return json(400, { error: { code: 400, message: err.message } });
    }
    record({ method, url, role: out.role, model: body.model, tool: out.turn.name, args: out.turn.args, callId: out.callId, messages: body.messages?.length ?? 0 });
    if (body.stream) {
      return new Response(sse(out.response), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return json(200, out.response);
  }
  record({ refused: true, method, url });
  return json(404, { error: { code: 404, message: `harness: no scripted route for ${method} ${u.pathname}` } });
};

/**
 * NB_HARNESS_REQUEST_LOG: every inbound `llm.request` frame, with the cassette key the
 * host will compute for it, so a replay miss can be diffed against what was recorded.
 * The tap is attached in the same call that registers main.ts's own stdin listener --
 * attaching earlier would switch stdin to flowing mode before the host is listening.
 */
const requestLog = process.env.NB_HARNESS_REQUEST_LOG;
if (requestLog) {
  const { cassetteKey } = await import(new URL('../../host/src/cassette.ts', import.meta.url).href);
  let pending = Buffer.alloc(0);
  const tap = (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    while (pending.length >= 4) {
      const len = pending.readUInt32LE(0);
      if (pending.length < 4 + len) break;
      const frame = pending.subarray(4, 4 + len).toString('utf8');
      pending = pending.subarray(4 + len);
      try {
        const msg = JSON.parse(frame);
        if (msg?.type !== 'llm.request') continue;
        fs.appendFileSync(
          requestLog,
          JSON.stringify({ at: Date.now(), key: cassetteKey(msg), url: msg.url, model: msg.body?.model ?? null, messages: msg.body?.messages ?? null }) + '\n',
        );
      } catch {
        /* diagnostics only */
      }
    }
  };
  const on = process.stdin.on.bind(process.stdin);
  let tapped = false;
  process.stdin.on = (event, listener) => {
    if (event === 'data' && !tapped) {
      tapped = true;
      on('data', tap);
    }
    return on(event, listener);
  };
}

record({ preload: true, mode, pid: process.pid });
