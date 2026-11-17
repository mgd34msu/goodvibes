/**
 * routes/voice-setup.ts, handlers for the managed local-voice provisioning
 * verbs over the live provisioner + config (see voice/provisioning/*), and for
 * the wake-word artifacts served alongside them.
 *
 * The wake verbs attach HERE rather than through a group of their own for a
 * composition reason worth stating: this group is already wired into the gateway,
 * so the same service object gains three methods and the registration site does
 * not change. A new group would have meant editing the verb-group composition
 * file for a capability that is provisioning a pinned voice artifact, which is
 * exactly what this module already is.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import type { VoiceKeySupersede } from '../../voice/provisioning/config-preconfigure.js';
import type { VoiceRoundTripProof } from '../../voice/provisioning/round-trip-proof.js';
import { attachHandler } from './attach-handler.js';
import type { VoiceSetupOutcome, VoiceSetupRequest } from '../../runtime/voice-setup.js';

/** One-act install outcome served by voice.local.install. */
export interface VoiceLocalInstallResult {
  readonly operationProvenance?: 'classic';
  readonly semanticAssessment?: 'not-evaluated';
  readonly proof?: VoiceRoundTripProof | undefined;
  readonly notes?: readonly string[];
  readonly provisioned: boolean;
  readonly platform: string | null;
  readonly tts: {
    readonly engine: string;
    readonly state: string;
    readonly binaryPath?: string | undefined;
    readonly modelPath?: string | undefined;
    readonly reason?: string | undefined;
  };
  readonly stt: { readonly engine: string; readonly state: string; readonly binaryPath?: string | undefined; readonly modelPath?: string | undefined; readonly reason?: string | undefined };
  readonly components: ReadonlyArray<{ readonly id: string; readonly state: string; readonly bytes?: number | undefined; readonly error?: string | undefined }>;
  readonly configured: {
    readonly set: ReadonlyArray<{ readonly key: string; readonly value: string }>;
    readonly skipped: ReadonlyArray<{ readonly key: string; readonly reason: string }>;
    /** Keys taken over from an install this one replaces; absent from a service that predates the field. */
    readonly superseded?: readonly VoiceKeySupersede[];
  };
}

/** What voice.local.install answers at once: the run it started, or the one already running that it joined. */
export interface VoiceLocalInstallStart {
  readonly state: 'running';
  readonly startedAt: number;
  readonly joined: boolean;
}

/** The last install run that ended, served by voice.local.status as `lastInstall`. */
export interface VoiceLocalInstallOutcome {
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly receipt?: VoiceLocalInstallResult | undefined;
  /** Why the run stopped without a receipt. */
  readonly error?: string | undefined;
}

/** One bounded chunk of a provisioned wake artifact. */
export interface WakeModelChunkPayload {
  readonly component: string;
  readonly offset: number;
  readonly bytes: number;
  readonly totalBytes: number;
  readonly sha256: string;
  readonly dataBase64: string;
  readonly complete: boolean;
}

/** The narrow provisioning slice the verbs need. */
export interface VoiceSetupGatewayService {
  status(): unknown;
  /**
   * Start the install (or join the one running) and return at once. The run
   * outlives the request; its receipt is read from status() as `lastInstall`.
   */
  startInstall(): VoiceLocalInstallStart;
  /** Content-verified state of the pinned wake artifacts. */
  wakeStatus(): unknown;
  /** Download + verify the pinned wake artifacts. Explicit act, single-flight. */
  wakeProvision(): Promise<unknown>;
  /** Read one wake artifact in bounded chunks, for a surface that cannot fetch it. */
  wakeModelChunk(request: { component: string; offset?: number | undefined; maxBytes?: number | undefined }): WakeModelChunkPayload;
  /** Plan voice setup from the host's facts, do what needs no answer, and return the plan. */
  setup(request: VoiceSetupRequest): Promise<VoiceSetupOutcome>;
}

export function createVoiceStatusHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return () => service.status();
}

/**
 * The install answers as soon as the run has started: a multi-hundred-MB
 * download held open as one request would outlive the server's idle limit and
 * be reported failed while the daemon finished it. The caller's write:config
 * authority is the verb's own admission (its descriptor's scope); once
 * admitted, the run finishes on its own and leaves its receipt in status().
 */
export function createVoiceInstallHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return () => service.startInstall();
}

export function createWakeStatusHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return () => service.wakeStatus();
}

export function createWakeProvisionHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return () => service.wakeProvision();
}

/**
 * A GET verb's numbers arrive as STRINGS, and that is not a detail here.
 *
 * The control plane says so in as many words: "GET/DELETE params arrive as query
 * strings that cannot be soundly type-checked", so nothing coerces or validates
 * them before a handler runs. A `typeof value === 'number'` test therefore
 * silently rejects `offset=524288` and falls back to 0, which for a chunked read
 * means the client re-fetches the first chunk forever, or reassembles a file out
 * of repeated openings and verifies it against a checksum it can never match.
 * Loud on a bad value, correct on a good one, is the only safe shape.
 */
function readOptionalCount(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new GatewayVerbError(`voice.wake.model.get: ${field} must be a non-negative number (got ${JSON.stringify(value)})`, 'INVALID_ARGUMENT', 400, field);
  }
  return Math.trunc(parsed);
}

/**
 * Read one chunk. The component is validated here rather than trusted: an
 * unrecognised name is a caller error with a written message, not a path built
 * out of whatever arrived.
 */
export function createWakeModelHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const component = typeof params['component'] === 'string' ? params['component'] : '';
    const known = ['classifier', 'tflite', 'embedding', 'notice', 'embedding-notice', 'vad', 'vad-notice'];
    if (!known.includes(component)) {
      throw new GatewayVerbError(`voice.wake.model.get: component must be one of ${known.join(', ')} (got "${component}")`, 'INVALID_ARGUMENT', 400, 'component');
    }
    return service.wakeModelChunk({
      component,
      offset: readOptionalCount(params['offset'], 'offset'),
      maxBytes: readOptionalCount(params['maxBytes'], 'maxBytes'),
    });
  };
}

const SETUP_INTENTS = ['wake', 'stt', 'tts', 'voice'] as const;
const SETUP_SURFACES = ['tui', 'agent', 'webui', 'app'] as const;

function readChoice<T extends string>(value: unknown, choices: readonly T[], field: string): T {
  const found = choices.find((choice) => choice === value);
  if (found === undefined) {
    throw new GatewayVerbError(`voice.setup: ${field} must be one of ${choices.join(', ')} (got ${JSON.stringify(value)})`, 'INVALID_ARGUMENT', 400, field);
  }
  return found;
}

/**
 * The one setup operation for every surface. The install the plan needs is
 * started in the background: a download held open as one request would
 * outlive the server's idle limit (see createVoiceInstallHandler). Which cloud
 * voice credentials exist is this host's fact, so it is never read from the
 * caller.
 */
export function createVoiceSetupHandler(service: VoiceSetupGatewayService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const ttsChoice = typeof params['ttsChoice'] === 'string' && params['ttsChoice'] ? params['ttsChoice'] : undefined;
    return service.setup({
      intent: readChoice(params['intent'], SETUP_INTENTS, 'intent'),
      surface: readChoice(params['surface'], SETUP_SURFACES, 'surface'),
      acceptProposals: params['acceptProposals'] === true,
      ...(ttsChoice !== undefined ? { ttsChoice } : {}),
      installInBackground: true,
    });
  };
}

/** Attach the voice-setup handlers to their registered descriptors (missing = no-op). */
export function registerVoiceSetupGatewayMethods(catalog: GatewayMethodCatalog, service: VoiceSetupGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => { attachHandler(catalog, id, handler); };
  attach('voice.local.status', createVoiceStatusHandler(service));
  attach('voice.local.install', createVoiceInstallHandler(service));
  attach('voice.setup', createVoiceSetupHandler(service));
  attach('voice.wake.status', createWakeStatusHandler(service));
  attach('voice.wake.provision', createWakeProvisionHandler(service));
  attach('voice.wake.model.get', createWakeModelHandler(service));
}
