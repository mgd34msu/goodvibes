// ---------------------------------------------------------------------------
// voice-provision-gateway.ts
//
// The daemon-backed verbs the /voice setup + /voice status surfaces read:
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

import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GoodVibesError } from '@goodvibes-jev/engine/platform';
import { resolveOperatorRpc, describeOperatorRpcError } from '../input/commands/operator-rpc.ts';
import type { VoiceRuntimeStatusResult, VoiceLocalInstallResult } from './voice-provision-status.ts';
import { voiceStatusLines, voiceInstallReceiptLines, voiceInstallComponentLine } from './voice-provision-status.ts';

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

/** The narrow async verb surface the /voice setup + /voice status surfaces drive. */
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

/** The single one-act setup announcement shown before the (possibly long) install runs. */
export const VOICE_SETUP_ANNOUNCEMENT = [
  'Local Voice Setup',
  '  provisioning the managed local voice runtime (piper TTS + a default voice; whisper STT where a bundle is published)…',
  '  downloads are checksum-verified and resumable; re-run /voice setup to retry any failed component.',
].join('\n');

/**
 * Render the /voice status or /voice setup RESULT block from an already-resolved
 * gateway resolution, the testable core the command wraps. Kept separate from
 * the live gateway construction so a wire test injects a fake resolution
 * (available / unavailable / failing) with no HTTP. `/voice setup` with live
 * progress goes through runVoiceSetupWithProgress; the setup branch here runs
 * the same flow and returns what it printed as one block.
 */
export async function renderVoiceProvision(
  sub: 'status' | 'setup',
  resolution: VoiceProvisionGatewayResolution,
  options: Pick<VoiceSetupProgressOptions, 'pollMs' | 'sleep'> = {},
): Promise<string> {
  if (!resolution.available) {
    const label = sub === 'status' ? 'Local Voice Runtime' : 'Local Voice Setup';
    return `${label} unavailable: ${resolution.reason}`;
  }
  if (sub === 'status') {
    try {
      const status = await resolution.gateway.fetchStatus();
      return ['Local Voice Runtime', ...voiceStatusLines(status)].join('\n');
    } catch (error) {
      const failure = classifyVoiceProvisionError(error);
      return failure.kind === 'unavailable'
        ? `Local Voice Runtime\n  ${failure.reason}`
        : `Local Voice Runtime\n  could not read status: ${failure.message}`;
    }
  }
  const blocks: string[] = [];
  await runVoiceSetupWithProgress(resolution, { ...options, print: (block) => blocks.push(block) });
  return blocks.join('\n');
}

export interface VoiceSetupProgressOptions {
  /** Sink for each printed block (the command passes ctx.print). */
  readonly print: (block: string) => void;
  /** Poll interval while the install is in flight (default 800ms). */
  readonly pollMs?: number;
  /** Injectable delay (tests pass a fake; the command uses setTimeout). */
  readonly sleep?: (ms: number) => Promise<void>;
}

const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Status reads in a row that may fail before the surface stops waiting and says so (about 5 s at the default poll). */
const MAX_STATUS_READ_FAILURES = 6;

function installFailureBlock(error: unknown): string {
  const failure = classifyVoiceProvisionError(error);
  return failure.kind === 'unavailable'
    ? `Local Voice Setup\n  ${failure.reason}`
    : `Local Voice Setup\n  install failed: ${failure.message}`;
}

/**
 * Run /voice setup with LIVE progress. voice.local.install starts the run and
 * answers at once; the run goes on in the daemon. This polls voice.local.status,
 * printing a per-component line each time a component's phase advances
 * (download → verify → extract → done), until the run has ended and its
 * outcome is on the status read as `lastInstall`; then it prints that receipt
 * or the reason the run stopped. No request is held open for the download, so
 * a long install is never reported failed because the connection idled out.
 *
 * The caller prints VOICE_SETUP_ANNOUNCEMENT before calling this. gateway
 * fetchStatus/startInstall and sleep are injectable so a wire test drives the
 * whole flow with no real timers or HTTP.
 */
export async function runVoiceSetupWithProgress(
  resolution: VoiceProvisionGatewayResolution,
  opts: VoiceSetupProgressOptions,
): Promise<void> {
  if (!resolution.available) {
    opts.print(`Local Voice Setup unavailable: ${resolution.reason}`);
    return;
  }
  const { gateway } = resolution;
  const pollMs = opts.pollMs ?? 800;
  const sleep = opts.sleep ?? realSleep;

  let started: VoiceInstallStartRead;
  try {
    started = await gateway.startInstall();
  } catch (error) {
    opts.print(installFailureBlock(error));
    return;
  }
  if (started.kind === 'finished') {
    opts.print(['Local Voice Setup: receipt', ...voiceInstallReceiptLines(started.receipt)].join('\n'));
    return;
  }
  if (started.joined) opts.print('  an install was already running; following it to its receipt.');

  // Print a component line only when its phase changes, so a slow install does
  // not spam identical lines each poll.
  const lastPhase = new Map<string, string>();
  let failures = 0;
  let unreported = 0;
  let lastError: unknown;
  for (;;) {
    await sleep(pollMs);
    let status: VoiceStatusRead;
    try {
      status = await gateway.fetchStatus();
      failures = 0;
    } catch (error) {
      lastError = error;
      if (++failures < MAX_STATUS_READ_FAILURES) continue;
      opts.print([
        'Local Voice Setup',
        `  could not read the install's progress: ${classifyVoiceProvisionError(lastError).kind === 'unavailable' ? 'the daemon no longer serves voice status' : describeOperatorRpcError(lastError)}`,
        '  the install may still be running in the daemon; /voice status shows its state and, once it ends, its receipt.',
      ].join('\n'));
      return;
    }
    const progress = status.installInProgress;
    if (progress) {
      unreported = 0;
      const changed = progress.components.filter((c) => lastPhase.get(c.component) !== c.phase);
      for (const c of changed) lastPhase.set(c.component, c.phase);
      if (changed.length > 0) opts.print(changed.map(voiceInstallComponentLine).join('\n'));
      continue;
    }
    const outcome = status.lastInstall;
    if (outcome === undefined || outcome.startedAt < started.startedAt) {
      // Neither running nor finished: the daemon lost the run (a restart drops both).
      if (++unreported < MAX_STATUS_READ_FAILURES) continue;
      opts.print([
        'Local Voice Setup',
        '  the daemon no longer reports this install as running or finished (it may have restarted while installing).',
        '  /voice status shows what is installed; re-run /voice setup to finish any missing component.',
      ].join('\n'));
      return;
    }
    if (outcome.receipt) {
      opts.print(['Local Voice Setup: receipt', ...voiceInstallReceiptLines(outcome.receipt)].join('\n'));
    } else {
      opts.print(`Local Voice Setup\n  install failed: ${outcome.error ?? 'the daemon recorded no reason'}. Re-run /voice setup to retry any failed component.`);
    }
    return;
  }
}
