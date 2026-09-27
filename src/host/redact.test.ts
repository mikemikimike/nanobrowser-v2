import { describe, expect, it } from 'vitest';
import type { RunEvent } from '@/src/messaging';
import { redactEvent } from './redact';

describe('redactEvent', () => {
  it('strips an OpenRouter key wherever it appears, nested in unknown args', () => {
    const event: RunEvent = {
      kind: 'tool.call',
      role: 'follower',
      call: { callId: 'c1', name: 'fetchKey', args: { header: 'Authorization: sk-or-abc123XYZ-9' } },
      at: 1,
    };
    const redacted = redactEvent(event);
    if (redacted.kind !== 'tool.call') throw new Error('expected tool.call');
    const serialized = JSON.stringify(redacted.call.args);
    expect(serialized).not.toContain('sk-or-abc123XYZ-9');
    expect(serialized).toContain('[redacted]');
  });

  it('strips a Bearer token', () => {
    const event: RunEvent = { kind: 'model.text', role: 'leader', text: 'sending Bearer abcDEF123.token', at: 2 };
    const redacted = redactEvent(event);
    if (redacted.kind !== 'model.text') throw new Error('expected model.text');
    expect(redacted.text).toBe('sending [redacted]');
  });

  it('replaces a screenshot data URL with a fixed placeholder', () => {
    const event: RunEvent = {
      kind: 'userscript.output',
      scriptId: 's1',
      level: 'log',
      text: 'captured: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA',
      at: 3,
    };
    const redacted = redactEvent(event);
    if (redacted.kind !== 'userscript.output') throw new Error('expected userscript.output');
    expect(redacted.text).toBe('captured: [screenshot omitted]');
  });

  it('redacts inside nested arrays and objects, and can redact more than once per string', () => {
    const event: RunEvent = {
      kind: 'tool.result',
      role: 'follower',
      result: {
        callId: 'c2',
        name: 'debug',
        ok: true,
        summary: 'keys: [sk-or-one111, sk-or-two222]',
        durationMs: 5,
      },
      at: 7,
    };
    const redacted = redactEvent(event);
    if (redacted.kind !== 'tool.result') throw new Error('expected tool.result');
    expect(redacted.result.summary).toBe('keys: [[redacted], [redacted]]');
  });

  it('strips other providers sk- tokens, mirroring the host redactor', () => {
    const event: RunEvent = {
      kind: 'model.text',
      role: 'follower',
      text: 'key sk-abcDEF12345678901234567890 leaked',
      at: 9,
    };
    const redacted = redactEvent(event);
    if (redacted.kind !== 'model.text') throw new Error('expected model.text');
    expect(redacted.text).toBe('key [redacted] leaked');
  });

  it('strips Doppler tokens', () => {
    const event: RunEvent = {
      kind: 'model.text',
      role: 'follower',
      text: 'token dp.ct.abcDEF1234567890 in output',
      at: 10,
    };
    const redacted = redactEvent(event);
    if (redacted.kind !== 'model.text') throw new Error('expected model.text');
    expect(redacted.text).toBe('token [redacted] in output');
  });

  it('leaves an event with nothing secret-shaped intact', () => {
    const event: RunEvent = { kind: 'step', n: 4, role: 'follower', at: 5 };
    expect(redactEvent(event)).toEqual(event);
  });

  it('does not mutate the input event', () => {
    const event: RunEvent = { kind: 'model.text', role: 'leader', text: 'Bearer topsecret', at: 6 };
    const before = JSON.parse(JSON.stringify(event));
    redactEvent(event);
    expect(event).toEqual(before);
  });

  it('leaves a non-screenshot data URL and unrelated text untouched', () => {
    const event: RunEvent = {
      kind: 'model.text',
      role: 'leader',
      text: 'see data:text/plain;base64,aGVsbG8= and note nothing else changes here',
      at: 8,
    };
    expect(redactEvent(event)).toEqual(event);
  });
});
