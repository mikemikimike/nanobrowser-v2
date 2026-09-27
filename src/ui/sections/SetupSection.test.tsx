// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import type { ModelInfo } from '@/src/messaging';
import { DEFAULT_CONFIG, configItem, getConfig } from '@/src/storage';
import { SetupSection } from './SetupSection';

afterEach(cleanup);
beforeEach(() => {
  fakeBrowser.reset();
});

const MODELS: ModelInfo[] = [
  { id: 'nvidia/nemotron-ultra', name: 'NVIDIA Nemotron Ultra', free: false, vision: true, tools: true, contextLength: 1_000_000 },
  { id: 'meta/llama-4', name: 'Llama 4', free: true, vision: false, tools: true, contextLength: 256_000 },
];

const READY = { hostConnected: true, keyReady: true };

function setup(over: Partial<Parameters<typeof SetupSection>[0]> = {}) {
  return render(
    <SetupSection
      models={MODELS}
      modelsStatus="ready"
      onRefreshModels={vi.fn()}
      readiness={READY}
      readinessStatus="ready"
      onRefreshReadiness={vi.fn()}
      {...over}
    />,
  );
}

describe('SetupSection config persistence', () => {
  it('writes every change to the Config storage item', async () => {
    const user = userEvent.setup();
    setup();

    // Nemotron Ultra is paid in this fixture; free-only is on by default, so it would
    // not appear in the dropdown otherwise (see the free-models-only tests below).
    await user.click(screen.getByRole('switch', { name: 'Free models only' }));
    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    await user.click(screen.getByRole('option', { name: /Nemotron/ }));
    await waitFor(async () =>
      expect((await getConfig()).leaderModel).toBe('nvidia/nemotron-ultra'),
    );

    await user.click(screen.getByRole('combobox', { name: 'Follower model' }));
    await user.click(screen.getByRole('option', { name: /Llama 4/ }));

    await user.click(screen.getByRole('radio', { name: 'Pixels' }));
    await user.click(screen.getByRole('switch', { name: 'Escalate to trusted input' }));

    await waitFor(async () =>
      expect(await getConfig()).toEqual({
        ...DEFAULT_CONFIG,
        leaderModel: 'nvidia/nemotron-ultra',
        followerModel: 'meta/llama-4',
        observe: 'pixels',
        inputFidelity: 'escalated',
      }),
    );
  });

  it('persists the read-only toggle (#13)', async () => {
    const user = userEvent.setup();
    setup();
    expect((await getConfig()).readOnly).toBe(false);
    await user.click(screen.getByRole('switch', { name: 'Read-only run' }));
    await waitFor(async () => expect((await getConfig()).readOnly).toBe(true));
  });

  it('restores a stored config on mount, so reopening the panel keeps the setup', async () => {
    await configItem.setValue({
      leaderModel: 'nvidia/nemotron-ultra',
      followerModel: 'meta/llama-4',
      observe: 'both',
      planningInterval: 3,
      maxSteps: 120,
      inputFidelity: 'escalated',
    });

    setup();

    const leader = await screen.findByDisplayValue('NVIDIA Nemotron Ultra');
    expect(leader).toBeTruthy();
    expect(screen.getByDisplayValue('Llama 4')).toBeTruthy();
    await waitFor(() =>
      expect((screen.getByRole('radio', { name: 'Both' }) as HTMLInputElement).checked).toBe(true),
    );
    expect((screen.getByLabelText('Planning interval') as HTMLInputElement).value).toBe('3');
    expect((screen.getByLabelText('Max steps') as HTMLInputElement).value).toBe('120');
    expect(
      screen.getByRole('switch', { name: 'Escalate to trusted input' }).getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('persists validated cadence values and flags invalid ones', async () => {
    const user = userEvent.setup();
    setup();

    const interval = screen.getByLabelText('Planning interval');
    await user.clear(interval);
    await user.type(interval, '7');
    await waitFor(async () => expect((await getConfig()).planningInterval).toBe(7));

    await user.clear(interval);
    expect(interval.getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByRole('alert').textContent).toMatch(/whole number from 1 to 100/);
  });

  it('resets to defaults', async () => {
    const user = userEvent.setup();
    await configItem.setValue({ ...DEFAULT_CONFIG, leaderModel: 'meta/llama-4', maxSteps: 3 });
    setup();

    await screen.findByDisplayValue('Llama 4');
    await user.click(screen.getByRole('button', { name: 'Reset to defaults' }));

    await waitFor(async () => expect(await getConfig()).toEqual(DEFAULT_CONFIG));
    expect((screen.getByLabelText('Max steps') as HTMLInputElement).value).toBe('50');
  });

  it('explains that escalated input raises Chrome\'s debugger banner', () => {
    setup();
    expect(screen.getByTestId('fidelity-explainer').textContent).toMatch(/debugging this browser/i);
  });

  it('shows the currently running Leader/Follower prominently', async () => {
    await configItem.setValue({
      leaderModel: 'nvidia/nemotron-ultra',
      followerModel: 'meta/llama-4',
      observe: 'dom',
      planningInterval: 5,
      maxSteps: 50,
      inputFidelity: 'in-page',
    });
    setup();
    expect(await screen.findAllByText('NVIDIA Nemotron Ultra')).not.toHaveLength(0);
  });
});

describe('SetupSection free models only', () => {
  it('defaults on and hides paid models from the picker', async () => {
    const user = userEvent.setup();
    setup();

    expect(screen.getByRole('switch', { name: 'Free models only' }).getAttribute('aria-checked')).toBe('true');

    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    expect(screen.queryByRole('option', { name: /Nemotron/ })).toBeNull();
    expect(screen.getByRole('option', { name: /Llama 4/ })).toBeTruthy();
  });

  it('reveals paid models once turned off', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('switch', { name: 'Free models only' }));
    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    expect(screen.getByRole('option', { name: /Nemotron/ })).toBeTruthy();
  });

  it('warns when a paid model is picked', async () => {
    const user = userEvent.setup();
    setup();

    await user.click(screen.getByRole('switch', { name: 'Free models only' }));
    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    await user.click(screen.getByRole('option', { name: /Nemotron/ }));

    expect(screen.getByRole('alert').textContent).toMatch(/paid model/i);
  });

  it('never keeps an existing paid selection out of view: it still resolves, just is not offered as a new pick', async () => {
    await configItem.setValue({
      leaderModel: 'nvidia/nemotron-ultra',
      followerModel: 'meta/llama-4',
      observe: 'dom',
      planningInterval: 5,
      maxSteps: 50,
      inputFidelity: 'in-page',
    });
    setup();

    // Free-only defaults on, but the stored paid Leader still displays as itself.
    expect(await screen.findByDisplayValue('NVIDIA Nemotron Ultra')).toBeTruthy();
  });
});

describe('SetupSection model source (Kilo addition)', () => {
  const MIXED: ModelInfo[] = [
    ...MODELS,
    {
      id: 'meta/muse-spark-1.3-contributor',
      name: 'Muse Spark',
      free: false,
      vision: false,
      tools: true,
      contextLength: 200_000,
      source: 'kilo',
      mayTrainOnYourPrompts: false,
    },
  ];

  it('filters the picker by source, defaulting to showing every source', async () => {
    const user = userEvent.setup();
    setup({ models: MIXED });

    await user.click(screen.getByRole('switch', { name: 'Free models only' }));
    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    expect(screen.getByRole('option', { name: /Muse Spark/ })).toBeTruthy();

    // Clicking the radio closes the combobox (it is outside its root); reopen it
    // to see the filter take effect.
    await user.click(screen.getByRole('radio', { name: 'Kilo' }));
    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    expect(screen.queryByRole('option', { name: /Nemotron/ })).toBeNull();
    expect(screen.getByRole('option', { name: /Muse Spark/ })).toBeTruthy();
  });

  it('persists both the model id and its source when a Kilo model is picked', async () => {
    const user = userEvent.setup();
    setup({ models: MIXED });

    await user.click(screen.getByRole('switch', { name: 'Free models only' }));
    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    await user.click(screen.getByRole('option', { name: /Muse Spark/ }));

    await waitFor(async () => {
      const stored = await getConfig();
      expect(stored.leaderModel).toBe('meta/muse-spark-1.3-contributor');
      expect(stored.leaderModelSource).toBe('kilo');
    });
  });

  it('never writes a source for an OpenRouter pick, keeping old stored configs byte-identical', async () => {
    const user = userEvent.setup();
    setup({ models: MIXED });

    await user.click(screen.getByRole('switch', { name: 'Free models only' }));
    await user.click(screen.getByRole('combobox', { name: 'Leader model' }));
    await user.click(screen.getByRole('option', { name: /Nemotron/ }));

    await waitFor(async () => expect((await getConfig()).leaderModel).toBe('nvidia/nemotron-ultra'));
    expect((await getConfig()).leaderModelSource).toBeUndefined();
  });
});

describe('SetupSection readiness row', () => {
  it('is green when the worker validates the host and the key', () => {
    setup();
    expect(screen.getByTestId('readiness-row').getAttribute('data-ready')).toBe('true');
    expect(screen.queryByTestId('readiness-reason')).toBeNull();
  });

  it('shows the specific reason when it is not', () => {
    setup({
      readiness: { hostConnected: true, keyReady: false, reason: 'Doppler returned no key' },
    });
    expect(screen.getByTestId('readiness-row').getAttribute('data-ready')).toBe('false');
    expect(screen.getByTestId('readiness-reason').textContent).toBe('Doppler returned no key');
  });

  it('degrades to "waiting for worker" when nothing has answered', () => {
    setup({ readiness: undefined, readinessStatus: 'waiting', modelsStatus: 'waiting', models: [] });
    expect(screen.getByText('Waiting for worker')).toBeTruthy();
    expect(screen.getByTestId('readiness-reason').textContent).toMatch(/waiting for the worker/i);
    expect(screen.getByText(/Waiting for the worker to send the model list/)).toBeTruthy();
  });

  it('rechecks on demand', async () => {
    const user = userEvent.setup();
    const onRefreshReadiness = vi.fn();
    setup({ onRefreshReadiness });
    await user.click(screen.getByRole('button', { name: 'recheck' }));
    expect(onRefreshReadiness).toHaveBeenCalledOnce();
  });
});
