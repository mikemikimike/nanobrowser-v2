import { useEffect, useRef, useState } from 'react';
import type { Userscript, UserscriptRunResult } from '@/src/messaging';
import { Button } from '../components/Button';
import { Card, Field, Section } from '../components/Card';
import { ConfirmButton } from '../components/ConfirmButton';
import { cn } from '../lib/cn';
import { formatDuration, prettyJson } from '../runlog/format';
import { isWaiting, type AreaStatus } from '../state/status';

const BLANK = (): Userscript => ({
  id: `script-${Date.now().toString(36)}`,
  name: 'new script',
  matches: ['*://*/*'],
  code: '// Runs in the page. The return value and console output come back below.\nreturn document.title;\n',
  updatedAt: Date.now(),
});

/** The side panel must not pretty-print a full comps dump. */
const PREVIEW_CHARS = 4_000;

const LEVEL_CLASS: Record<'log' | 'warn' | 'error', string> = {
  log: 'text-ink',
  warn: 'text-amber-700 dark:text-amber-300',
  error: 'text-rose-700 dark:text-rose-300',
};

/**
 * Execute and debug userscripts live (R-09/R-10). Run sends whatever is in the editor
 * right now — not the last saved copy — so edit-and-re-run needs no save step (O-03).
 */
function cappedJson(value: unknown): string {
  const full = prettyJson(value);
  if (full.length <= PREVIEW_CHARS) return full;
  return `${full.slice(0, PREVIEW_CHARS)}\n… preview truncated; Save JSON writes the full object`;
}

/** Match patterns are edited as free text; whitespace is only split when it is read. */
function parseMatches(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

export function UserscriptsSection({
  scripts,
  scriptsStatus,
  result,
  runStatus,
  onSave,
  onRun,
  onDelete,
  onRefresh,
  onStop,
  onSaveResult,
  saved,
}: {
  scripts: Userscript[];
  scriptsStatus: AreaStatus;
  result?: UserscriptRunResult;
  runStatus: AreaStatus;
  onSave: (script: Userscript) => void;
  onRun: (scriptId: string, code: string) => void;
  onDelete: (id: string) => void;
  onRefresh: () => void;
  onStop?: () => void;
  onSaveResult?: (value: unknown) => void;
  saved?: { filename: string; path: string; bytes: number; note?: string };
}) {
  const [draft, setDraft] = useState<Userscript>(BLANK);
  const [matchesText, setMatchesText] = useState(() => draft.matches.join(' '));
  const [dirty, setDirty] = useState(false);
  const codeRef = useRef<HTMLTextAreaElement>(null);

  const load = (script: Userscript, asDirty: boolean) => {
    setDirty(asDirty);
    setDraft(script);
    setMatchesText(script.matches.join(' '));
  };

  // Adopt a stored script the first time the list arrives, unless the user is mid-edit.
  useEffect(() => {
    if (dirty) return;
    const match = scripts.find((script) => script.id === draft.id) ?? scripts[0];
    if (!match || match === draft) return;
    setDraft(match);
    setMatchesText(match.matches.join(' '));
  }, [scripts, dirty, draft]);

  const edit = (patch: Partial<Userscript>) => {
    setDirty(true);
    setDraft((prev) => ({ ...prev, ...patch }));
  };

  // The error line is already the user's line, with the wrapper offset removed.
  useEffect(() => {
    const match = result?.error?.match(/line (\d+)/);
    const area = codeRef.current;
    if (!match || !area) return;
    const line = Number(match[1]);
    // The newline that ends the previous line belongs before this line's first character.
    const before = line > 1 ? draft.code.split('\n').slice(0, line - 1).join('\n').length + 1 : 0;
    area.focus();
    area.setSelectionRange(before, before);
    area.scrollTop = (line - 1) * 16;
  }, [result?.error, draft.code]);

  return (
    <div className="space-y-4">
      <Section
        title="Scripts"
        actions={
          <span className="flex gap-1">
            <Button variant="ghost" onClick={onRefresh}>
              reload
            </Button>
            <Button
              variant="ghost"
              onClick={() => load(BLANK(), true)}
            >
              new
            </Button>
          </span>
        }
        hint={
          isWaiting(scriptsStatus)
            ? 'Waiting for the worker to send the script list.'
            : scripts.length === 0
              ? 'No saved scripts yet.'
              : undefined
        }
      >
        {scripts.length > 0 ? (
          <ul className="divide-y divide-line overflow-hidden rounded-md border border-line">
            {scripts.map((script) => (
              <li key={script.id} className="flex items-center gap-1 bg-surface px-2 py-1">
                <button
                  type="button"
                  onClick={() => load(script, false)}
                  aria-current={script.id === draft.id}
                  className={cn(
                    'min-w-0 flex-1 truncate text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-accent',
                    script.id === draft.id ? 'font-semibold text-ink' : 'text-muted',
                  )}
                >
                  {script.name}
                  {/* The agent can now author scripts (O-03). Which ones it wrote is
                      the user's business, so it is on the row rather than buried. */}
                  {script.author === 'agent' ? (
                    <span
                      title="Written by the agent during a run"
                      className="ml-1 rounded-sm border border-line px-1 text-[10px] uppercase tracking-wide text-muted"
                    >
                      agent
                    </span>
                  ) : null}
                  <span className="ml-1 text-[11px] text-muted">{script.matches.join(' ')}</span>
                </button>
                <ConfirmButton label="delete" onConfirm={() => onDelete(script.id)} />
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section
        title="Editor"
        actions={
          <span className="flex gap-1">
            <Button
              onClick={() => {
                onSave({ ...draft, updatedAt: Date.now() });
                setDirty(false);
              }}
            >
              Save
            </Button>
            <Button variant="primary" onClick={() => onRun(draft.id, draft.code)}>
              Run
            </Button>
            {onStop ? (
              <Button variant="ghost" onClick={onStop}>
                Stop
              </Button>
            ) : null}
          </span>
        }
        hint={dirty ? 'Unsaved — Run still uses exactly what is in the editor.' : undefined}
      >
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <Field label="Name" htmlFor="script-name">
              <input
                id="script-name"
                value={draft.name}
                onChange={(event) => edit({ name: event.target.value })}
                className="w-full rounded-md border border-line bg-paper px-2 py-1.5 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </Field>
            <Field label="Matches" htmlFor="script-matches" hint="Space-separated match patterns.">
              <input
                id="script-matches"
                value={matchesText}
                onChange={(event) => {
                  setMatchesText(event.target.value);
                  edit({ matches: parseMatches(event.target.value) });
                }}
                className="w-full rounded-md border border-line bg-paper px-2 py-1.5 font-mono text-xs text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </Field>
          </div>
          <Field label="Code" htmlFor="script-code">
            <div className="flex overflow-hidden rounded-md border border-line">
              <pre
                aria-hidden="true"
                data-testid="script-lines"
                className="select-none bg-raised px-1.5 py-1.5 text-right font-mono text-xs leading-4 text-muted"
              >
                {draft.code.split('\n').map((_, index) => String(index + 1)).join('\n')}
              </pre>
              <textarea
                id="script-code"
                ref={codeRef}
                rows={10}
                spellCheck={false}
                value={draft.code}
                onChange={(event) => edit({ code: event.target.value })}
                className="w-full resize-y bg-paper px-2 py-1.5 font-mono text-xs leading-4 text-ink outline-none focus-visible:ring-2 focus-visible:ring-accent"
              />
            </div>
          </Field>
        </div>
      </Section>

      <Section title="Result">
        {runStatus === 'waiting' ? (
          <p className="text-xs text-muted">Waiting for the worker to run the script…</p>
        ) : !result ? (
          <p className="text-xs text-muted">Run a script to see its value, errors and console.</p>
        ) : (
          <Card className="space-y-2 p-2">
            <p className="flex items-center gap-1.5 text-xs text-muted">
              <span
                className={cn(
                  'rounded border px-1.5 py-px text-[11px] font-medium',
                  result.ok
                    ? 'border-emerald-500/40 bg-emerald-500/12 text-emerald-700 dark:text-emerald-300'
                    : 'border-rose-500/40 bg-rose-500/12 text-rose-700 dark:text-rose-300',
                )}
              >
                {result.ok ? 'ok' : 'error'}
              </span>
              <span className="tabular-nums">{formatDuration(result.durationMs)}</span>
              <span className="font-mono">{result.scriptId}</span>
            </p>
            {result.error ? (
              <pre data-testid="script-error" className="rounded bg-rose-500/10 p-2 font-mono text-xs text-rose-700 dark:text-rose-300">
                {result.error}
              </pre>
            ) : null}
            <div>
              <p className="flex items-center gap-2 text-[11px] font-semibold tracking-wide text-muted uppercase">
                Value
                {onSaveResult && result.value !== undefined ? (
                  <Button variant="ghost" onClick={() => onSaveResult(result.value)}>
                    Save JSON
                  </Button>
                ) : null}
              </p>
              <pre data-testid="script-value" className="mt-1 max-h-40 overflow-auto rounded bg-raised p-2 font-mono text-xs text-ink">
                {cappedJson(result.value)}
              </pre>
              {saved ? (
                <p data-testid="script-saved" className="mt-1 text-xs text-muted">
                  Saved {saved.filename} to <span className="font-mono">{saved.path}</span> ({saved.bytes} bytes)
                  {saved.note ? `. ${saved.note}` : ''}
                </p>
              ) : null}
            </div>
            <div>
              <p className="text-[11px] font-semibold tracking-wide text-muted uppercase">Console</p>
              {result.console.length === 0 ? (
                <p className="text-xs text-muted">nothing logged</p>
              ) : (
                <ul data-testid="script-console" className="mt-1 space-y-0.5">
                  {result.console.map((line, index) => (
                    <li
                      key={`${index}-${line.at}`}
                      className={cn('font-mono text-xs break-words', LEVEL_CLASS[line.level])}
                    >
                      <span className="text-muted">[{line.level}]</span> {line.text}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </Card>
        )}
      </Section>
    </div>
  );
}
