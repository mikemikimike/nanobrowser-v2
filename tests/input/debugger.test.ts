import { describe, expect, it } from 'vitest';
import { DEBUGGER_PROTOCOL_VERSION, DebuggerInputTier, type DebuggerApi, type DebuggerTarget } from '@/src/input/debugger';
import { seededRng } from './support/rng';

interface RecordedCall {
  method: string;
  target: DebuggerTarget;
  params?: Record<string, unknown>;
}

function createFakeDebuggerApi() {
  const calls: RecordedCall[] = [];
  const attachCalls: { target: DebuggerTarget; version: string }[] = [];
  const detachCalls: DebuggerTarget[] = [];
  let listeners: Array<(source: DebuggerTarget, reason: string) => void> = [];

  const api: DebuggerApi = {
    async attach(target, requiredVersion) {
      attachCalls.push({ target, version: requiredVersion });
    },
    async detach(target) {
      detachCalls.push(target);
    },
    async sendCommand(target, method, params) {
      calls.push({ method, target, params });
      return undefined;
    },
    onDetach: {
      addListener(cb) {
        listeners.push(cb);
      },
      removeListener(cb) {
        listeners = listeners.filter(l => l !== cb);
      },
    },
  };

  return {
    api,
    calls,
    attachCalls,
    detachCalls,
    triggerDetach: (target: DebuggerTarget, reason: string) => {
      for (const l of listeners) l(target, reason);
    },
    listenerCount: () => listeners.length,
  };
}

function instantSleep() {
  const waits: number[] = [];
  return { sleep: async (ms: number) => { waits.push(ms); }, waits };
}

describe('DebuggerInputTier: click', () => {
  it('arrives along the humanized path, then mousePressed (force 0.5) -> mouseReleased, holding 40-120ms', async () => {
    const fake = createFakeDebuggerApi();
    const { sleep, waits } = instantSleep();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(1), sleep });

    await tier.attach(7);
    await tier.click(100, 200, { button: 'left', clickCount: 1 });

    const moves = fake.calls.filter(c => c.params?.type === 'mouseMoved');
    const pressed = fake.calls.filter(c => c.params?.type === 'mousePressed');
    const released = fake.calls.filter(c => c.params?.type === 'mouseReleased');
    // One arrival path (no teleport straight to the target), then exactly one press/release.
    expect(moves.length).toBeGreaterThan(1);
    expect(pressed).toHaveLength(1);
    expect(released).toHaveLength(1);
    expect(moves.at(-1)?.params).toMatchObject({ x: 100, y: 200, button: 'none', buttons: 0 });
    expect(pressed[0]?.params).toMatchObject({
      type: 'mousePressed',
      x: 100,
      y: 200,
      button: 'left',
      buttons: 1,
      clickCount: 1,
      force: 0.5,
    });
    expect(released[0]?.params).toMatchObject({
      type: 'mouseReleased',
      x: 100,
      y: 200,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    // The last sleep is the press hold (path pacing comes before it).
    expect(waits.at(-1)).toBeGreaterThanOrEqual(40);
    expect(waits.at(-1)).toBeLessThanOrEqual(120);
  });

  it('maps right/middle buttons and a triple clickCount', async () => {
    const fake = createFakeDebuggerApi();
    const { sleep } = instantSleep();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(2), sleep });
    await tier.attach(1);
    await tier.click(1, 1, { button: 'right', clickCount: 3 });
    const pressed = fake.calls.find(c => c.params?.type === 'mousePressed');
    expect(pressed?.params).toMatchObject({ button: 'right', buttons: 2, clickCount: 3, force: 0.5 });
  });

  it('dispatches no extra moves when already at the target, so a prior moveTo costs nothing', async () => {
    const fake = createFakeDebuggerApi();
    const { sleep } = instantSleep();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(21), sleep });
    await tier.attach(1);
    await tier.moveTo(100, 200);
    fake.calls.length = 0;
    await tier.click(100, 200);

    // The click's internal moveTo is a degenerate path (from === to): no mouseMoved.
    expect(fake.calls.filter(c => c.params?.type === 'mouseMoved')).toHaveLength(0);
    expect(fake.calls.filter(c => c.params?.type === 'mousePressed')).toHaveLength(1);
    expect(fake.calls.filter(c => c.params?.type === 'mouseReleased')).toHaveLength(1);
  });
});

describe('DebuggerInputTier: typeText', () => {
  it('dispatches keyDown(text,key,code,vk) + keyUp per character, with bounded hold and inter-key delays', async () => {
    const fake = createFakeDebuggerApi();
    const { sleep, waits } = instantSleep();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(3), sleep });
    await tier.attach(9);
    await tier.typeText('ab');

    expect(fake.calls).toEqual([
      { method: 'Input.dispatchKeyEvent', target: { tabId: 9 }, params: { type: 'keyDown', text: 'a', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 } },
      { method: 'Input.dispatchKeyEvent', target: { tabId: 9 }, params: { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65 } },
      { method: 'Input.dispatchKeyEvent', target: { tabId: 9 }, params: { type: 'keyDown', text: 'b', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 } },
      { method: 'Input.dispatchKeyEvent', target: { tabId: 9 }, params: { type: 'keyUp', key: 'b', code: 'KeyB', windowsVirtualKeyCode: 66 } },
    ]);

    // Two holds (one per char) then two inter-key delays -> 4 waits total.
    expect(waits).toHaveLength(4);
    const [hold1, interKey1, hold2, interKey2] = waits;
    for (const hold of [hold1, hold2]) {
      expect(hold).toBeGreaterThanOrEqual(40);
      expect(hold).toBeLessThanOrEqual(80);
    }
    for (const gap of [interKey1, interKey2]) {
      expect(gap).toBeGreaterThan(0);
    }
  });

  it('maps a newline to Enter instead of a literal keystroke', async () => {
    const fake = createFakeDebuggerApi();
    const { sleep } = instantSleep();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(4), sleep });
    await tier.attach(1);
    await tier.typeText('\n');
    expect(fake.calls).toEqual([
      { method: 'Input.dispatchKeyEvent', target: { tabId: 1 }, params: { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0, text: '\r' } },
      { method: 'Input.dispatchKeyEvent', target: { tabId: 1 }, params: { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 0 } },
    ]);
  });
});

describe('DebuggerInputTier: press', () => {
  it('dispatches keyDown/keyUp for a named key with a modifiers bitmask, holding 40-80ms', async () => {
    const fake = createFakeDebuggerApi();
    const { sleep, waits } = instantSleep();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(5), sleep });
    await tier.attach(3);
    await tier.press('ArrowDown', { modifiers: { shift: true, ctrl: true } });

    expect(fake.calls).toEqual([
      { method: 'Input.dispatchKeyEvent', target: { tabId: 3 }, params: { type: 'keyDown', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 10 } },
      { method: 'Input.dispatchKeyEvent', target: { tabId: 3 }, params: { type: 'keyUp', key: 'ArrowDown', code: 'ArrowDown', windowsVirtualKeyCode: 40, modifiers: 10 } },
    ]);
    expect(waits[0]).toBeGreaterThanOrEqual(40);
    expect(waits[0]).toBeLessThanOrEqual(80);
  });

  it('covers the full named-key table', async () => {
    const fake = createFakeDebuggerApi();
    const { sleep } = instantSleep();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(6), sleep });
    await tier.attach(1);
    const names = ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'];
    for (const name of names) {
      fake.calls.length = 0;
      await tier.press(name);
      const down = fake.calls.find(c => c.params?.type === 'keyDown');
      expect(down?.params?.key).toBe(name);
      expect(down?.params?.code).toBe(name);
    }
  });
});

describe('DebuggerInputTier: scroll', () => {
  it('dispatches mouseWheel in a few chunks that sum to the requested delta', async () => {
    const fake = createFakeDebuggerApi();
    const { sleep } = instantSleep();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(7), sleep });
    await tier.attach(1);
    await tier.scroll(50, 60, 300, -90);

    expect(fake.calls.length).toBeGreaterThanOrEqual(3);
    expect(fake.calls.length).toBeLessThanOrEqual(5);
    for (const c of fake.calls) {
      expect(c.method).toBe('Input.dispatchMouseEvent');
      expect(c.params).toMatchObject({ type: 'mouseWheel', x: 50, y: 60 });
    }
    const sumX = fake.calls.reduce((a, c) => a + (c.params?.deltaX as number), 0);
    const sumY = fake.calls.reduce((a, c) => a + (c.params?.deltaY as number), 0);
    expect(sumX).toBeCloseTo(300, 6);
    expect(sumY).toBeCloseTo(-90, 6);
  });
});

describe('DebuggerInputTier: moveTo', () => {
  it('walks the humanized path via mouseMoved, never sending a non-Input command', async () => {
    const fake = createFakeDebuggerApi();
    const { sleep } = instantSleep();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(8), sleep });
    await tier.attach(1);
    await tier.moveTo(400, 300);

    expect(fake.calls.length).toBeGreaterThan(1);
    for (const c of fake.calls) {
      expect(c.method).toBe('Input.dispatchMouseEvent');
      expect(c.params?.type).toBe('mouseMoved');
    }
    const lastCall = fake.calls[fake.calls.length - 1]!;
    expect(lastCall.params?.x).toBe(400);
    expect(lastCall.params?.y).toBe(300);
  });
});

describe('DebuggerInputTier: no command outside the Input domain', () => {
  it('never sends Runtime/Page/DOM/Emulation commands across a mixed run', async () => {
    const fake = createFakeDebuggerApi();
    const { sleep } = instantSleep();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(9), sleep });
    await tier.attach(1);
    await tier.moveTo(50, 50);
    await tier.click(50, 50);
    await tier.typeText('hi\n');
    await tier.press('Tab');
    await tier.scroll(50, 50, 10, 10);

    expect(fake.calls.length).toBeGreaterThan(0);
    for (const c of fake.calls) {
      expect(c.method.startsWith('Input.')).toBe(true);
    }
  });

  it('refuses a non-Input command if one were ever attempted (defensive guard)', async () => {
    const fake = createFakeDebuggerApi();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(1) });
    await tier.attach(1);
    // Bracket-notation access reaches the private method without a compile error,
    // which is exactly what we want here: prove the guard itself, not just that
    // no *public* call path currently violates it.
    await expect(tier['sendInput']('Runtime.enable', {})).rejects.toThrow(/refusing non-Input/);
  });
});

describe('DebuggerInputTier: attach-once semantics', () => {
  it('attaches exactly once across multiple actions, and re-attach to the same tab is a no-op', async () => {
    const fake = createFakeDebuggerApi();
    const { sleep } = instantSleep();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(10), sleep });

    await tier.attach(42);
    await tier.click(1, 1);
    await tier.moveTo(2, 2);
    await tier.typeText('x');
    await tier.attach(42); // idempotent

    expect(fake.attachCalls).toEqual([{ target: { tabId: 42 }, version: DEBUGGER_PROTOCOL_VERSION }]);
  });

  it('detaching and re-attaching to a different tab attaches again', async () => {
    const fake = createFakeDebuggerApi();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(11) });
    await tier.attach(1);
    await tier.attach(2); // different tab -> implicit detach + re-attach
    expect(fake.attachCalls).toEqual([
      { target: { tabId: 1 }, version: DEBUGGER_PROTOCOL_VERSION },
      { target: { tabId: 2 }, version: DEBUGGER_PROTOCOL_VERSION },
    ]);
    expect(fake.detachCalls).toEqual([{ tabId: 1 }]);
  });
});

describe('DebuggerInputTier: onDetach', () => {
  it('marks itself detached and surfaces the reason when the browser detaches out from under it', async () => {
    const fake = createFakeDebuggerApi();
    const reasons: string[] = [];
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(12), onDetach: r => reasons.push(r) });

    await tier.attach(5);
    expect(tier.isAttached()).toBe(true);

    fake.triggerDetach({ tabId: 5 }, 'canceled_by_user');

    expect(tier.isAttached()).toBe(false);
    expect(reasons).toEqual(['canceled_by_user']);
    await expect(tier.click(1, 1)).rejects.toThrow(/not attached/);
  });

  it('ignores a detach event for a different tab', async () => {
    const fake = createFakeDebuggerApi();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(13) });
    await tier.attach(5);
    fake.triggerDetach({ tabId: 99 }, 'target_closed');
    expect(tier.isAttached()).toBe(true);
  });

  it('never silently re-attaches on its own after a detach', async () => {
    const fake = createFakeDebuggerApi();
    const tier = new DebuggerInputTier(fake.api, { rng: seededRng(14) });
    await tier.attach(5);
    fake.triggerDetach({ tabId: 5 }, 'canceled_by_user');
    // No further attach() call is made by the tier itself.
    expect(fake.attachCalls).toHaveLength(1);
    expect(tier.isAttached()).toBe(false);
  });
});
