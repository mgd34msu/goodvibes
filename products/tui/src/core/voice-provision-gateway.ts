// ---------------------------------------------------------------------------
// voice-provision-gateway.ts
//
// The daemon-backed verbs the wake word's setup reads to install speech-to-text:
// voice.local.status (GET /api/voice/local/status), the no-network installed
// snapshot that also carries the running install's progress and the last
// install's receipt, and voice.local.install (POST /api/voice/local/install),
// which starts the one-act managed install and answers at once. Neither has a
// named facade on the in-process OperatorClient, so, exactly like the
// memory-consolidation gateway, they go over the generic operator invoke path
// (operator-rpc.ts's resolveOperatorRpc -> platform.operator.invoke), reaching
// the SAME daemon the command layer does.
//
// A daemon that predates managed voice provisioning answers an honest 501 (verb
// cataloged but no handler) or a 404 (older daemon without the route), both
// are "verb unavailable", NOT a fabricated empty/failed install (see
// classifyVoiceProvisionError). The interface is injectable so the command and
// its tests round-trip against a mocked daemon.
// ---------------------------------------------------------------------------

import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { GoodVibesError } from '@goodvibes/engine/errors';
import { resolveOperatorRpc, describeOperatorRpcError } from '../runtime/client/operator-endpoint.ts';
import type { VoiceRuntimeStatusResult, VoiceLocalInstallResult } from './voice-provision-status.ts';

/** The last install the daemon finished, as voice.local.status serves it once a run ends. */
export interface VoiceInstallOutcome {
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly receipt?: VoiceLocalInstallResult | undefined;
  /** Why the run stopped without a receipt. */
  readonly error?: string | undefined;
}

/** voice.local.status with the last install's outcome. */
export type VoiceStatusRead = VoiceRuntimeStatusResult & { readonly lastInstall?: VoiceInstallOutcome | undefined };

/**
 * What voice.local.install answers: the run it started (or joined), at once.
 * A daemon from before the start-then-read install still answers with the
 * finished receipt; that answer is printed as it is.
 */
export type VoiceInstallStartRead =
  | { readonly kind: 'started'; readonly startedAt: number; readonly joined: boolean }
  | { readonly kind: 'finished'; readonly receipt: VoiceLocalInstallResult };

/** The narrow async verb surface the wake word's setup drives. */
export interface VoiceProvisionGateway {
  /** Read the no-network managed-runtime snapshot (voice.local.status). */
  fetchStatus(): Promise<VoiceStatusRead>;
  /** Start the one-act managed install (voice.local.install); answers at once. */
  startInstall(): Promise<VoiceInstallStartRead>;
}

function readInstallStart(value: unknown): VoiceInstallStartRead {
  const record = value !== null && typeof value === 'object' ? value as Record<string, unknown> : {};
  if (record['state'] === 'running' && typeof record['startedAt'] === 'number') {
    return { kind: 'started', startedAt: record['startedAt'], joined: record['joined'] === true };
  }
  if (typeof record['provisioned'] === 'boolean') return { kind: 'finished', receipt: value as VoiceLocalInstallResult };
  throw new Error('the daemon answered voice.local.install with neither a started run nor a receipt');
}

/**
 * Why the gateway could not be built (daemon disabled / no control-plane URL),
 * surfaced verbatim so the surface prints an honest "unavailable" line rather
 * than guessing, mirrors MemoryConsolidationGatewayResolution.
 */
export type VoiceProvisionGatewayResolution =
  | { readonly available: true; readonly gateway: VoiceProvisionGateway }
  | { readonly available: false; readonly reason: string };

export interface VoiceProvisionGatewayDeps {
  readonly configManager: ConfigManager;
  readonly homeDirectory: string | (() => string);
}

/**
 * Build the live voice-provisioning gateway over the generic operator invoke
 * path, the same daemon resolution the command layer uses. Returns an honest
 * unavailable reason when no daemon is reachable, so the surface refuses
 * cleanly instead of throwing mid-render.
 */
export function createVoiceProvisionGateway(deps: VoiceProvisionGatewayDeps): VoiceProvisionGatewayResolution {
  const rpc = resolveOperatorRpc({ configManager: deps.configManager, homeDirectory: deps.homeDirectory });
  if (!rpc.available) return { available: false, reason: rpc.reason };
  const { platformClient } = rpc;
  return {
    available: true,
    gateway: {
      fetchStatus: async () => await platformClient.operator.invoke('voice.local.status', {}) as VoiceStatusRead,
      startInstall: async () => readInstallStart(await platformClient.operator.invoke('voice.local.install', {})),
    },
  };
}

/** How a voice verb rejection should render. */
export type VoiceProvisionFetchFailure =
  | { readonly kind: 'unavailable'; readonly reason: string }
  | { readonly kind: 'error'; readonly message: string };

/**
 * Classify a voice verb rejection: a 501 (a daemon that predates managed voice
 * provisioning, cataloged but unhandled) or a 404 (an older daemon without the
 * route) are both "verb unavailable", distinct from a generic request failure
 * (network error, 401/403, 500). Reuses describeOperatorRpcError's wording so
 * the call sites never diverge on how they describe the same daemon response.
 */
export function classifyVoiceProvisionError(error: unknown): VoiceProvisionFetchFailure {
  if (error instanceof GoodVibesError && (error.status === 501 || error.status === 404)) {
    return { kind: 'unavailable', reason: 'this daemon does not serve managed voice provisioning yet.' };
  }
  return { kind: 'error', message: describeOperatorRpcError(error) };
}

