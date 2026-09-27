/**
 * The probe's detection logic, proven against fake scopes: a clean scope comes
 * back with no anomalies, and each planted signal fires exactly its own check.
 * Live execution against real Chrome (clean profile vs driven run) is still to
 * run — host access is down — and when it does, `runStealthProbe` is the same
 * function it calls.
 */
import { describe, expect, it } from 'vitest';
import {
  PROBE_CHECKS,
  SUSPECT_GLOBALS,
  probeAnomalies,
  runStealthProbe,
  type ProbeNavigator,
  type ProbeScope,
} from './probe';

function cleanScope(): ProbeScope {
  return {
    // webdriver:false, as clean Chrome/Firefox inherit it — presence is not the tell.
    navigator: { webdriver: false, userAgent: 'clean', plugins: [], languages: ['en-US'], hardwareConcurrency: 8, deviceMemory: 8 },
    errorInstanceStackDescriptor: { value: 'Error\n    at clean', writable: true, enumerable: false, configurable: true },
    pointerEventHasCoalesced: true,
    isSecureContext: true,
    pageChromeRuntime: undefined,
    globalNames: ['window', 'document', 'foo'],
  };
}

describe('runStealthProbe', () => {
  it('covers every research signal, and none rots away unnoticed', () => {
    const checks = runStealthProbe(cleanScope()).map((f) => f.check);
    expect([...checks].sort()).toEqual([...PROBE_CHECKS].sort());
  });

  it('reports a clean scope with no anomalies', () => {
    const findings = runStealthProbe(cleanScope());
    expect(findings).toHaveLength(PROBE_CHECKS.length);
    expect(probeAnomalies(findings)).toEqual([]);
  });

  it('treats inherited webdriver=false as clean: the value is the tell, not presence', () => {
    const findings = runStealthProbe(cleanScope());
    expect(findings.find((f) => f.check === 'webdriver')?.anomalous).toBe(false);
  });

  it('flags webdriver=true as driven', () => {
    const scope = cleanScope();
    scope.navigator = { ...scope.navigator, webdriver: true };
    expect(probeAnomalies(runStealthProbe(scope))).toEqual(['webdriver']);
  });

  it('flags throwing webdriver traps without aborting the rest of the probe', () => {
    const scope = cleanScope();
    scope.navigator = new Proxy<ProbeNavigator>({} as ProbeNavigator, {
      has: () => {
        throw new Error('trap');
      },
    });
    const findings = runStealthProbe(scope);
    expect(probeAnomalies(findings)).toContain('webdriver');
    // The probe survived to run every other check too.
    expect(findings).toHaveLength(PROBE_CHECKS.length);
  });

  it('flags an injected stack getter on a fresh error', () => {
    const scope = cleanScope();
    scope.errorInstanceStackDescriptor = { get() { return 'hooked'; }, enumerable: false, configurable: true };
    expect(probeAnomalies(runStealthProbe(scope))).toEqual(['error-stack-accessor']);
  });

  it('treats this realm\'s own fresh-error descriptor as clean (stock V8 shape)', () => {
    const scope = cleanScope();
    scope.errorInstanceStackDescriptor = Object.getOwnPropertyDescriptor(new Error('x'), 'stack');
    expect(probeAnomalies(runStealthProbe(scope))).toEqual([]);
  });

  it('flags a navigator whose property reads throw (interposed proxy trap)', () => {
    const scope = cleanScope();
    scope.navigator = {
      userAgent: 'proxied',
      get plugins(): unknown {
        throw new Error('trap');
      },
    };
    expect(probeAnomalies(runStealthProbe(scope))).toEqual(['proxy-ownkeys']);
  });

  it('flags a navigator whose key enumeration throws (ownKeys trap)', () => {
    const scope = cleanScope();
    scope.navigator = new Proxy<ProbeNavigator>({ userAgent: 'x' } as ProbeNavigator, {
      ownKeys: () => {
        throw new Error('trap');
      },
    });
    expect(probeAnomalies(runStealthProbe(scope))).toEqual(['proxy-ownkeys']);
  });

  it('flags extension context leaking into page scope', () => {
    const scope = cleanScope();
    scope.pageChromeRuntime = { id: 'abcdef' };
    expect(probeAnomalies(runStealthProbe(scope))).toEqual(['main-world-execution']);
  });

  it('flags known automation globals and names them', () => {
    const scope = cleanScope();
    scope.globalNames = [...(scope.globalNames ?? []), '__playwright'];
    const findings = runStealthProbe(scope);
    expect(probeAnomalies(findings)).toEqual(['playwright-init-globals']);
    expect(findings.find((f) => f.check === 'playwright-init-globals')?.observed).toContain('__playwright');
  });

  it('flags the documented Playwright artifact names, not just the stem', () => {
    const scope = cleanScope();
    scope.globalNames = [...(scope.globalNames ?? []), '__playwright_builtins__', '__playwright__binding__'];
    const findings = runStealthProbe(scope);
    expect(probeAnomalies(findings)).toEqual(['playwright-init-globals']);
    expect(findings.find((f) => f.check === 'playwright-init-globals')?.observed).toContain(
      '__playwright_builtins__',
    );
  });

  it('flags a stripped PointerEvent with no coalesced events', () => {
    const scope = cleanScope();
    scope.pointerEventHasCoalesced = false;
    expect(probeAnomalies(runStealthProbe(scope))).toEqual(['coalesced-events']);
  });

  it('treats missing coalesced events on an insecure page as expected, not anomalous', () => {
    const scope = cleanScope();
    scope.pointerEventHasCoalesced = false;
    scope.isSecureContext = false;
    expect(probeAnomalies(runStealthProbe(scope))).toEqual([]);
  });

  it('fires every planted signal at once without cross-talk', () => {
    const findings = runStealthProbe({
      navigator: {
        webdriver: true,
        get plugins(): unknown {
          throw new Error('trap');
        },
      },
      errorInstanceStackDescriptor: { get() { return 'hooked'; }, enumerable: false, configurable: true },
      pointerEventHasCoalesced: false,
      pageChromeRuntime: { id: 'abcdef' },
      globalNames: [SUSPECT_GLOBALS[0]!],
    });
    expect(probeAnomalies(findings).sort()).toEqual(
      [
        'webdriver',
        'error-stack-accessor',
        'proxy-ownkeys',
        'main-world-execution',
        'playwright-init-globals',
        'coalesced-events',
      ].sort(),
    );
  });
});
