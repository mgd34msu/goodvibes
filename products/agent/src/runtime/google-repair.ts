/**
 * The Agent process's Google connection repair, keyed by its secret store, so
 * the `google` tool of its own turns and the `/google` commands repair through
 * one consent: a request that meets no connection, a missing scope, a dead
 * grant or a disabled API starts the repair itself, and the consent link is
 * shown on this screen at once.
 *
 * Enabling an API goes through this process's permission manager: the
 * ordinary approval prompt under Ask me, the decision model under Jev decides.
 */
import { revealOrNull, type Secret } from '@goodvibes/engine/platform/platform/security';
import { GoogleConnectionRepair, installGoogleConnectionRepair } from '@goodvibes/engine/platform/platform/google';
import { createProcessCommandPort, startLoopbackListener } from '@goodvibes/engine/platform/platform/google/node';

export interface AgentGoogleRepairDeps {
  readonly configManager: { get(key: never): unknown };
  readonly secretsManager: {
    get(key: string): Promise<Secret | string | null>;
    set(key: string, value: string): Promise<void>;
  };
  readonly homeDirectory: string;
  readonly permissionManager: {
    getMode(): string;
    askEnableGoogleApis(question: { readonly services: readonly string[]; readonly project: string; readonly account: string }, options?: { readonly signal?: AbortSignal | undefined }): Promise<boolean>;
  };
  /** Shows a line on this screen at once. */
  readonly notify: (text: string) => void;
}

/** Builds and installs the repair; returns the stop. */
export function installAgentGoogleRepair(deps: AgentGoogleRepairDeps): () => void {
  const repair = new GoogleConnectionRepair({
    config: {
      get: (key) => {
        try { return deps.configManager.get(key as never); } catch { return undefined; }
      },
    },
    secrets: {
      get: async (key) => {
        const value = await deps.secretsManager.get(key);
        return typeof value === 'string' || value === null ? value : revealOrNull(value, 'dispatch');
      },
      set: (key, value) => deps.secretsManager.set(key, value),
    },
    loopback: startLoopbackListener,
    fetchPort: { fetch: (url: string, init: RequestInit) => fetch(url, init) },
    commands: createProcessCommandPort(),
    homeDirectory: deps.homeDirectory,
    decider: {
      mode: () => deps.permissionManager.getMode(),
      ask: (request, signal) => deps.permissionManager.askEnableGoogleApis(request, signal ? { signal } : undefined),
    },
  });
  const stop = repair.onNotice((notice) => deps.notify(`[Google] ${notice.words}`));
  installGoogleConnectionRepair(deps.secretsManager, repair);
  return () => { stop(); repair.close(); };
}
