/**
 * The daemon's Google connection repair: one per daemon, keyed by its secret
 * store, so the calendar verbs, the mail routes, the inbound reader and the
 * `google` tool of every hosted turn repair through the same consent.
 *
 * The person sees a consent link in the owner inbox (every program and the
 * phone read it) the moment a request opens one; the item is withdrawn when
 * the consent ends. Enabling an API is put to the person's mode through the
 * daemon's permission manager: the ordinary approval prompt under Ask me, the
 * decision model under Jev decides.
 */
import { revealOrNull, type Secret } from '@goodvibes/engine/platform/platform/security';
import { GoogleConnectionRepair, installGoogleConnectionRepair, type GoogleRepairNotice } from '@goodvibes/engine/platform/platform/google';
import { createProcessCommandPort, startLoopbackListener } from '@goodvibes/engine/platform/platform/google/node';

export interface DaemonGoogleRepairDeps {
  readonly configManager: { get(key: never): unknown };
  readonly secretsManager: {
    get(key: string): Promise<Secret | null>;
    set(key: string, value: string): Promise<void>;
  };
  readonly homeDirectory: string;
  readonly permissionManager: {
    getMode(): string;
    askEnableGoogleApis(question: { readonly services: readonly string[]; readonly project: string; readonly account: string }, options?: { readonly signal?: AbortSignal | undefined }): Promise<boolean>;
  };
  readonly ownerInbox: {
    postNow(input: { readonly kind: 'report'; readonly title: string; readonly detail: string; readonly key: string; readonly askedBy: string }, postedBy?: string): { readonly item: { readonly id: string } };
    withdraw(id: string, reason: string): unknown;
  };
}

/** Builds and installs the repair; returns the stop. */
export function installDaemonGoogleRepair(deps: DaemonGoogleRepairDeps): () => void {
  const repair = new GoogleConnectionRepair({
    config: {
      get: (key) => {
        try { return deps.configManager.get(key as never); } catch { return undefined; }
      },
    },
    secrets: {
      get: async (key) => revealOrNull(await deps.secretsManager.get(key), 'dispatch'),
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
  let openItem: string | null = null;
  const stop = repair.onNotice((notice: GoogleRepairNotice) => {
    if (notice.phase === 'consent-open') {
      openItem = deps.ownerInbox.postNow({ kind: 'report', key: 'google-consent', askedBy: 'google', title: 'Approve Google access', detail: notice.words }, 'google').item.id;
      return;
    }
    if (openItem !== null) deps.ownerInbox.withdraw(openItem, notice.words);
    openItem = null;
  });
  installGoogleConnectionRepair(deps.secretsManager, repair);
  return () => { stop(); repair.close(); };
}
