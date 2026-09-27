import { storage } from '#imports';

/** How the agent perceives the page (R-08). */
export type ObserveMode = 'dom' | 'pixels' | 'both';

/** How input is delivered (R-13). `escalated` means debugger/CDP-backed trusted input. */
export type InputFidelity = 'in-page' | 'escalated';

/** Which catalog a model came from -- also which base URL and credential it routes to. */
export type ModelSource = 'openrouter' | 'kilo';

/** User-owned run configuration. The side panel is the boss (R-05/R-11). */
export interface Config {
  leaderModel: string;
  followerModel: string;
  /**
   * Absent means OpenRouter: every config stored before Kilo existed has no opinion
   * here, and must keep routing exactly where it always did (R-11 continuity).
   * Only set when a role is deliberately picked from Kilo, and only needed at all
   * because the same model id can exist on both sources (disambiguates which one).
   */
  leaderModelSource?: ModelSource;
  followerModelSource?: ModelSource;
  observe: ObserveMode;
  planningInterval: number;
  maxSteps: number;
  inputFidelity: InputFidelity;
  /**
   * Read-only run mode (#13): navigation + reading + read-only userscripts, no
   * writes. Absent means a full run — every config stored before this mode
   * existed has no opinion here and must keep behaving exactly as before.
   */
  readOnly?: boolean;
}

export const DEFAULT_CONFIG: Config = {
  leaderModel: '',
  followerModel: '',
  observe: 'dom',
  planningInterval: 5,
  maxSteps: 50,
  inputFidelity: 'in-page',
  readOnly: false,
};

export const configItem = storage.defineItem<Config>('local:config', {
  fallback: DEFAULT_CONFIG,
  version: 1,
});

export async function getConfig(): Promise<Config> {
  return configItem.getValue();
}

/** Merges a partial update over the stored config and returns the result. */
export async function setConfig(patch: Partial<Config>): Promise<Config> {
  const next = { ...(await configItem.getValue()), ...patch };
  await configItem.setValue(next);
  return next;
}

export async function resetConfig(): Promise<void> {
  await configItem.removeValue();
}
