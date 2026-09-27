import { useState } from 'react';
import { Tabs, TabPanel } from '@/src/ui/components/Tabs';
import { RunSection } from '@/src/ui/sections/RunSection';
import { SetupSection } from '@/src/ui/sections/SetupSection';
import { UserscriptsSection } from '@/src/ui/sections/UserscriptsSection';
import { useConfig } from '@/src/ui/state/useConfig';
import { usePanel } from './usePanel';

const DOT: Record<string, string> = {
  connecting: 'bg-amber-400',
  connected: 'bg-emerald-500',
  disconnected: 'bg-rose-500',
};

type TabValue = 'run' | 'setup' | 'scripts';

const TABS = [
  { value: 'run' as const, label: 'Run' },
  { value: 'setup' as const, label: 'Setup' },
  { value: 'scripts' as const, label: 'Scripts' },
];

/** The side panel is the primary and only user surface (R-05). */
export default function App() {
  const panel = usePanel();
  const { config } = useConfig();
  const [tab, setTab] = useState<TabValue>('run');

  return (
    <div className="flex h-screen flex-col bg-paper text-ink">
      <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
        <h1 className="text-base font-semibold tracking-tight">nanobrowser</h1>
        <div className="flex items-center gap-2 text-xs text-muted" title={panel.hub.status}>
          <span className={`size-2 rounded-full ${DOT[panel.hub.status]}`} aria-hidden />
          <span data-testid="hub-status">{panel.hub.status}</span>
          {panel.hub.extensionVersion ? (
            <span className="tabular-nums">v{panel.hub.extensionVersion}</span>
          ) : null}
        </div>
      </header>

      {panel.workerSilent && panel.hub.status === 'connected' ? (
        <p role="status" className="border-b border-line bg-amber-500/10 px-3 py-1 text-xs text-amber-700 dark:text-amber-300">
          Waiting for worker — it has not answered models, readiness or scripts yet.
        </p>
      ) : null}
      {panel.workerError ? (
        <p role="alert" className="border-b border-line bg-rose-500/10 px-3 py-1 text-xs text-rose-700 dark:text-rose-300">
          {panel.workerError}
        </p>
      ) : null}

      <Tabs items={TABS} value={tab} onChange={setTab} label="Panel sections" />

      <main className="flex min-h-0 flex-1 flex-col overflow-hidden p-3">
        <TabPanel value="run" active={tab}>
          <RunSection
            config={config}
            models={panel.models}
            readiness={panel.readiness}
            readinessStatus={panel.readinessStatus}
            log={panel.log}
            starting={panel.starting}
            onStart={(prompt) => panel.startRun(prompt, config)}
            onPause={panel.pauseRun}
            onResume={panel.resumeRun}
            onAbort={panel.abortRun}
            onGoToSetup={() => setTab('setup')}
          />
        </TabPanel>

        <TabPanel value="setup" active={tab}>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <SetupSection
              models={panel.models}
              modelsStatus={panel.modelsStatus}
              modelsError={panel.modelsError}
              onRefreshModels={panel.refreshModels}
              readiness={panel.readiness}
              readinessStatus={panel.readinessStatus}
              onRefreshReadiness={panel.refreshReadiness}
            />
          </div>
        </TabPanel>

        <TabPanel value="scripts" active={tab}>
          <div className="min-h-0 flex-1 overflow-y-auto">
            <UserscriptsSection
              scripts={panel.scripts}
              scriptsStatus={panel.scriptsStatus}
              result={panel.scriptResult}
              runStatus={panel.scriptRunStatus}
              saved={panel.scriptSaved}
              onSave={panel.saveScript}
              onRun={panel.runScript}
              onStop={panel.stopScript}
              onSaveResult={panel.saveScriptResult}
              onDelete={panel.deleteScript}
              onRefresh={panel.refreshScripts}
            />
          </div>
        </TabPanel>
      </main>
    </div>
  );
}
