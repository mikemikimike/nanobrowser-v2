import { useState } from 'react';
import type { ModelInfo, Readiness } from '@/src/messaging';
import type { InputFidelity, ModelSource, ObserveMode } from '@/src/storage';
import { Badge } from '../components/Badge';
import { Button } from '../components/Button';
import { Field, Section } from '../components/Card';
import { ModelSelect } from '../components/ModelSelect';
import { NumberField } from '../components/NumberField';
import { RadioGroup } from '../components/RadioGroup';
import { Toggle } from '../components/Toggle';
import { MAX_STEPS, PLANNING_INTERVAL } from '../state/gate';
import { findModel } from '../state/models';
import { useFreeModelsOnly, useModelSourceFilter, type SourceFilter } from '../state/modelFilter';
import { isWaiting, type AreaStatus } from '../state/status';
import { useConfig } from '../state/useConfig';
import { ReadinessRow } from './ReadinessRow';

const OBSERVE_OPTIONS = [
  { value: 'dom' as const, label: 'DOM', title: 'Navigate from the accessibility/DOM snapshot — fast, and works on pages a screenshot would misread.' },
  { value: 'pixels' as const, label: 'Pixels', title: 'Navigate from a screenshot — closer to what a person sees, at a higher token cost.' },
  { value: 'both' as const, label: 'Both', title: 'Send both the DOM snapshot and a screenshot, for the hardest pages.' },
] satisfies ReadonlyArray<{ value: ObserveMode; label: string; title: string }>;

const SOURCE_OPTIONS = [
  { value: 'all' as const, label: 'All' },
  { value: 'openrouter' as const, label: 'OpenRouter' },
  { value: 'kilo' as const, label: 'Kilo' },
] satisfies ReadonlyArray<{ value: SourceFilter; label: string }>;

export function SetupSection({
  models,
  modelsStatus,
  modelsError,
  onRefreshModels,
  readiness,
  readinessStatus,
  onRefreshReadiness,
}: {
  models: ModelInfo[];
  modelsStatus: AreaStatus;
  modelsError?: string;
  onRefreshModels: () => void;
  readiness?: Readiness;
  readinessStatus: AreaStatus;
  onRefreshReadiness: () => void;
}) {
  const { config, update, reset } = useConfig();
  const [freeOnly, setFreeOnly] = useFreeModelsOnly();
  const [sourceFilter, setSourceFilter] = useModelSourceFilter();
  const escalated: boolean = config.inputFidelity === 'escalated';
  const observeExplainer = OBSERVE_OPTIONS.find((option) => option.value === config.observe)?.title;

  // "Selecting one must warn": these track the last picker to knowingly commit a paid
  // model, so the warning stays specific to the role that just changed and clears once
  // that role is free again.
  const [paidWarning, setPaidWarning] = useState<{ role: 'Leader' | 'Follower'; model: ModelInfo } | null>(null);

  const pick =
    (role: 'Leader' | 'Follower', modelField: 'leaderModel' | 'followerModel', sourceField: 'leaderModelSource' | 'followerModelSource') =>
    (id: string, source: ModelSource) => {
      // Absent (rather than an explicit 'openrouter') keeps a config written before Kilo
      // existed byte-for-byte reproducible, and keeps the common case's patch small.
      update({ [modelField]: id, [sourceField]: source === 'openrouter' ? undefined : source } as Partial<typeof config>);
      const model = findModel(models, id, source);
      setPaidWarning(model && !model.free ? { role, model } : null);
    };

  const leaderModel = findModel(models, config.leaderModel, config.leaderModelSource);
  const followerModel = findModel(models, config.followerModel, config.followerModelSource);

  return (
    <div className="space-y-4">
      <ReadinessRow readiness={readiness} status={readinessStatus} onRefresh={onRefreshReadiness} />

      <Section
        title="Models"
        actions={
          <span className="flex items-center gap-2">
            <span className="flex items-center gap-1.5 text-xs text-muted">
              <Toggle
                id="free-only"
                label="Free models only"
                checked={freeOnly}
                onChange={setFreeOnly}
              />
              free only
            </span>
            <RadioGroup
              name="model-source"
              aria-label="Model source"
              value={sourceFilter}
              options={SOURCE_OPTIONS}
              onChange={setSourceFilter}
            />
            <Button variant="ghost" onClick={onRefreshModels}>
              reload
            </Button>
          </span>
        }
        hint={
          modelsError ? (
            <span className="text-rose-600 dark:text-rose-400">{modelsError}</span>
          ) : isWaiting(modelsStatus) ? (
            'Waiting for the worker to send the model list.'
          ) : (
            `${models.length} models. NVIDIA Nemotron is listed first, then free models.`
          )
        }
      >
        {/* Prominent, so a stale picker display is never mistaken for a lost selection
           (the value itself lives in Config storage untouched either way). */}
        <p className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
          <span>Running with</span>
          <Badge tone="leader">{leaderModel?.name || config.leaderModel || 'no leader model'}</Badge>
          <span>/</span>
          <Badge tone="follower">{followerModel?.name || config.followerModel || 'no follower model'}</Badge>
        </p>

        <div className="mt-2 space-y-2">
          <Field label="Leader" htmlFor="leader-model" hint="Plans and re-plans the objective.">
            <ModelSelect
              id="leader-model"
              label="Leader model"
              models={models}
              freeOnly={freeOnly}
              sourceFilter={sourceFilter}
              value={config.leaderModel}
              source={config.leaderModelSource}
              onChange={pick('Leader', 'leaderModel', 'leaderModelSource')}
            />
          </Field>
          <Field label="Follower" htmlFor="follower-model" hint="Acts, and signals when to hand control back.">
            <ModelSelect
              id="follower-model"
              label="Follower model"
              models={models}
              freeOnly={freeOnly}
              sourceFilter={sourceFilter}
              value={config.followerModel}
              source={config.followerModelSource}
              onChange={pick('Follower', 'followerModel', 'followerModelSource')}
            />
          </Field>
        </div>

        {paidWarning ? (
          <p role="alert" className="rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
            {paidWarning.role} is now a paid model ({paidWarning.model.name}) — it costs money to run. Turn on
            &ldquo;free only&rdquo; above and re-pick to go back to a free model.
          </p>
        ) : null}
      </Section>

      <Section title="Observation">
        <Field label="Observe mode" hint="How the agent perceives the page.">
          <RadioGroup
            name="observe"
            aria-label="Observe mode"
            value={config.observe}
            options={OBSERVE_OPTIONS}
            onChange={(observe) => update({ observe })}
          />
          {observeExplainer ? <p className="mt-1 text-xs leading-snug text-muted">{observeExplainer}</p> : null}
        </Field>
      </Section>

      <Section title="Cadence">
        <div className="grid grid-cols-2 gap-2">
          <Field
            label="Planning interval"
            htmlFor="planning-interval"
            hint="How many Follower steps run before the Leader re-plans."
          >
            <NumberField
              id="planning-interval"
              value={config.planningInterval}
              min={PLANNING_INTERVAL.min}
              max={PLANNING_INTERVAL.max}
              onChange={(planningInterval) => update({ planningInterval })}
            />
          </Field>
          <Field
            label="Max steps"
            htmlFor="max-steps"
            hint="A safety valve that ends the run if it goes on too long, not the normal way it finishes."
          >
            <NumberField
              id="max-steps"
              value={config.maxSteps}
              min={MAX_STEPS.min}
              max={MAX_STEPS.max}
              onChange={(maxSteps) => update({ maxSteps })}
            />
          </Field>
        </div>
      </Section>

      <Section title="Input fidelity">
        <div className="flex items-start gap-2">
          <Toggle
            id="input-fidelity"
            label="Escalate to trusted input"
            checked={escalated}
            onChange={(on) =>
              update({ inputFidelity: (on ? 'escalated' : 'in-page') satisfies InputFidelity })
            }
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">
              {escalated ? 'Escalated (debugger/CDP)' : 'In-page events'}
            </p>
            <p data-testid="fidelity-explainer" className="text-xs leading-snug text-muted">
              Escalated input is delivered through chrome.debugger, so Chrome shows its
              &ldquo;is debugging this browser&rdquo; banner while it is attached.
            </p>
          </div>
        </div>
      </Section>

      <Section title="Run policy">
        <div className="flex items-start gap-2">
          <Toggle
            id="read-only"
            label="Read-only run"
            checked={config.readOnly ?? false}
            onChange={(on) => update({ readOnly: on })}
          />
          <div className="min-w-0">
            <p className="text-sm font-medium text-ink">
              {config.readOnly ? 'Read-only: no clicks, typing, or downloads' : 'Full run'}
            </p>
            <p className="text-xs leading-snug text-muted">
              Read-only runs navigate, read, run read-only userscripts, and save — acting
              tools are hidden from the agent and refused by the runtime.
            </p>
          </div>
        </div>
      </Section>

      <div className="border-t border-line pt-3">
        <Button variant="ghost" onClick={reset}>
          Reset to defaults
        </Button>
      </div>
    </div>
  );
}
