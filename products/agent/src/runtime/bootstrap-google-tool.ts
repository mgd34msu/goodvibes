/**
 * Wiring the `google` tool to this process's stores.
 *
 * Split out of `bootstrap-core.ts` because it is the one tool whose options
 * carry a genuine argument rather than a value: WHY the write ports are here
 * at all, and why they are unscoped. That reasoning is several paragraphs and
 * it belongs next to the wiring, not buried in a file that registers thirty
 * other things.
 *
 * Mail runs in this process on the native connector. Calendar actions run on
 * the adopted daemon's `calendar.events.*` methods when `daemon.enabled` is on
 * and a connected-host credential is present, so both terminal apps reach the
 * same calendar backend; otherwise they run here too.
 */

import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { registerAgentGoogleTool } from '../tools/agent-google-tool.ts';
import { startLoopbackListener } from '@goodvibes-jev/engine/platform/platform/google/node';
import { getOutwardApprovalStore, OUTWARD_APPROVAL_GESTURE } from '../trust/outward-approvals.ts';
import type { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
import { retainGoogleConnectionOwners } from '../tools/agent-google-admission.ts';
import { createConnectedHost, resolveConnectedHost, type ConnectedHost } from '../agent/connected-host-client.ts';

/** The slice of the runtime this wiring needs. Nothing wider. */
export interface GoogleToolWiringDeps {
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
  readonly homeDirectory: string;
}

function readGoogleConfiguration(config: ConfigManager, key: string): unknown {
  let value: unknown = config.getRaw();
  for (const part of key.split('.')) {
    if (!value || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function captureGoogleConnectionCurrent(deps: GoogleToolWiringDeps): () => void {
  return retainGoogleConnectionOwners(deps);
}

/** The adopted daemon for calendar calls, or null when calendar work stays in this process. One config read and one credential lookup per call. */
function adoptedCalendarHost(deps: GoogleToolWiringDeps): () => ConnectedHost | null {
  const selection = { configManager: deps.configManager, homeDirectory: deps.homeDirectory };
  const host = createConnectedHost(selection);
  return () => {
    if (deps.configManager.get('daemon.enabled') !== true) return null;
    return resolveConnectedHost(selection).unavailable === undefined ? host : null;
  };
}

export function wireAgentGoogleTool(registry: ToolRegistry, deps: GoogleToolWiringDeps): void {
  registerAgentGoogleTool(registry, {
    calendarHost: adoptedCalendarHost(deps),
    homeDirectory: deps.homeDirectory,
    configManager: deps.configManager,
    secretsManager: deps.secretsManager,
    configGet: (key: string) => readGoogleConfiguration(deps.configManager, key),
    secretGet: (key: string) => deps.secretsManager.get(key),
    captureConnectionCurrent: () => captureGoogleConnectionCurrent(deps),

    // Exact config and credential plans publish into their native owning stores.

    // Binding the port Google redirects back to is real machine I/O, so the
    // connector takes it as a port and the concrete listener is named here.
    loopback: startLoopbackListener,

    // Existing native approval records remain exact and one-use. Model refusal
    // text does not turn this separate control into a runtime fallback.
    approvals: getOutwardApprovalStore(),
    approvalGesture: OUTWARD_APPROVAL_GESTURE,
  });
}
