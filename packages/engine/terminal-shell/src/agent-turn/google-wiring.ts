/**
 * Wiring the `google` tool to a process's stores: the Agent process's own, or,
 * in a session the daemon hosts for the Agent, the daemon's.
 *
 * Split out because it is the one tool whose options carry a genuine argument
 * rather than a value: WHY the write ports are here at all, and why they are
 * unscoped. That reasoning belongs next to the wiring.
 *
 * Mail runs on the native connector of the process the turn runs in. Calendar
 * actions run on the daemon's `calendar.events.*` methods when one is
 * reachable (`calendarHost`: the Agent's adopted daemon, or, in a hosted turn,
 * the daemon through its own request path), so every surface reaches the same calendar
 * backend; otherwise they run on the connector too.
 */

import { revealOrNull } from '@goodvibes/engine/platform/platform/security';
import type { ToolRegistry } from '@goodvibes/engine/platform/platform/tools';
import { registerAgentGoogleTool, type GoogleCalendarHost } from './google-tool.js';
import type { DaemonExpectationClient } from './session-expectations.js';
import { startLoopbackListener } from '@goodvibes/engine/platform/platform/google/node';
import type { ConfigManager, SecretsManager } from '@goodvibes/engine/platform/platform/config';
import type { ArtifactStore } from '@goodvibes/engine/platform/platform/artifacts';
import type { OwnerApprovalStore } from '@goodvibes/engine/platform/platform/security';
import { retainGoogleConnectionOwners } from './google-admission.js';

/** The slice of the runtime this wiring needs. Nothing wider. */
export interface GoogleToolWiringDeps {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly homeDirectory: string;
  /** Where a sent mail or created event leaves its Personal Ops receipt. */
  readonly artifactStore?: ArtifactStore | undefined;
  /** The daemon's calendar when one is reachable; null or absent keeps calendar work on the connector. */
  readonly calendarHost?: (() => GoogleCalendarHost | null) | undefined;
  /**
   * Where approvals the owner answers are held, and the gesture that answers
   * one on this surface (the Agent's `/google approve`). Absent where no
   * approval prompt is wired, and the refusal then says so.
   */
  readonly approvals?: { readonly store: OwnerApprovalStore; readonly gesture: string } | undefined;
  /**
   * The daemon's verification-mail book, the one a signup alias (`accounts`)
   * opened its watch in; `mail.verification` with an expectation id waits on it.
   */
  readonly expectations?: DaemonExpectationClient | undefined;
}

function readGoogleConfiguration(config: ConfigManager, key: string): unknown {
  let value: unknown = config.getRaw();
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function captureGoogleConnectionCurrent(deps: Pick<GoogleToolWiringDeps, 'configManager' | 'secretsManager'>): () => void {
  return retainGoogleConnectionOwners(deps);
}

export function wireAgentGoogleTool(registry: ToolRegistry, deps: GoogleToolWiringDeps): void {
  registerAgentGoogleTool(registry, {
    calendarHost: deps.calendarHost,
    expectations: deps.expectations,
    homeDirectory: deps.homeDirectory,
    configManager: deps.configManager,
    secretsManager: deps.secretsManager,
    configGet: (key: string) => readGoogleConfiguration(deps.configManager, key),
    secretGet: async (key: string) => revealOrNull(await deps.secretsManager.get(key), 'dispatch'),
    captureConnectionCurrent: () => captureGoogleConnectionCurrent(deps),
    artifactStore: deps.artifactStore,

    // Exact config and credential plans publish into their native owning stores.

    // Binding the port Google redirects back to is real machine I/O, so the
    // connector takes it as a port and the concrete listener is named here.
    loopback: startLoopbackListener,

    // Existing native approval records remain exact and one-use. Model refusal
    // text does not turn this separate control into a runtime fallback.
    approvals: deps.approvals?.store,
    approvalGesture: deps.approvals?.gesture,
  });
}
