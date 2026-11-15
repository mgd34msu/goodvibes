/**
 * voice-setup.ts, the daemon's managed local-voice setup service, composed
 * once per runtime (extracted from runtime/services.ts).
 *
 * `install()` is SINGLE-FLIGHT: concurrent installs are never meaningful, a
 * second (and every further) concurrent caller joins the in-progress install's
 * promise instead of starting parallel multi-hundred-MB downloads.
 *
 * `status()` carries LIVE INSTALL PROGRESS and the LAST RESULT: while an
 * install runs, the provisioner's onProgress stream (bytes as they land) is
 * folded into a poll-able snapshot returned as `installInProgress`; once a run
 * ends, its receipt (or why it stopped) is returned as `lastInstall`.
 * `startInstall()` is what the daemon verb calls: it starts the run and returns
 * at once, so no request is held open for a download that can outlast the
 * server's idle limit; the surface polls status() for progress and the receipt.
 *
 * `setup()` is the one entry point for "set up voice" and "turn on the wake
 * word": it plans from what the host already has (voice/setup-chain.ts), does
 * what the plan says to do, and returns the plan with what happened.
 */
import {
  createVoiceInstallProgressTracker,
  describeSupersededVoiceKeys,
  localVoiceRuntimeStatus,
  preconfigureLocalVoiceKeys,
  provisionLocalVoiceRuntime,
  proveVoiceRoundTrip,
  readVoiceInstallStamp,
  writeVoiceInstallStamp,
  type VoiceComponentOutcome,
  type VoiceInstallStamp,
  type VoiceKeySupersede,
  type VoiceProvisionOptions,
  type VoiceProvisionResult,
  type VoiceRoundTripProof,
  type VoiceRuntimeStatus,
} from '../voice/provisioning/index.js';
import { DEFAULT_PIPER_VOICE, PIPER_ENGINES } from '../voice/provisioning/manifest.js';
import { recordVoiceDiagnostic } from '../voice/diagnostics.js';
import { assertVoiceProofCurrent, type VoiceProofLifetime, type VoiceRoundTripProofOptions } from '../voice/provisioning/round-trip-proof.js';
import { planVoiceSetupChain, renderVoiceSetupChain, type VoiceSetupChain, type VoiceSetupIntent, type VoiceSetupStep } from '../voice/setup-chain.js';
import { wakeSurfaceKey, type WakeSurface } from '../voice/wake/settings.js';
import { executePolicyCheck } from '../gate/execute-policy-check.js';
import {
  createWakeSetupService,
  type WakeModelChunkRequest,
  type WakeModelChunkResult,
  type WakeSetupService,
} from './wake-setup.js';
import { GatewayVerbError } from '../control-plane/routes/gateway-verb-error.js';
import type { WakeInstallProvisionOutcome } from '../voice/wake/install-provision.js';


/** What voice.local.install resolves with (the wire receipt). */
export interface VoiceInstallReceipt {
  /**
   * True only when the runtime was installed AND proved working by a live
   * round trip. Bytes on disk are not the claim anyone cares about, see
   * voice/provisioning/round-trip-proof.ts.
   */
  readonly provisioned: boolean;
  readonly platform: VoiceProvisionResult['platform'];
  readonly tts: VoiceProvisionResult['tts'];
  readonly stt: VoiceProvisionResult['stt'];
  readonly components: readonly VoiceComponentOutcome[];
  readonly configured: {
    readonly set: readonly { key: string; value: string }[];
    readonly skipped: readonly { key: string; reason: string }[];
    /** Keys taken over from an install this managed runtime replaces. */
    readonly superseded: readonly VoiceKeySupersede[];
  };
  /**
   * The live proof: a phrase spoken by the managed TTS and read back by the
   * managed STT. Absent only when STT was not provisioned at all, in which case
   * there is nothing to prove a round trip with.
   */
  readonly proof?: VoiceRoundTripProof | undefined;
  /** Plain-language lines a surface prints as-is: what was replaced, what was proven. */
  readonly notes: readonly string[];
}

/** What {@link VoiceSetupService.startInstall} returns at once: the run it started, or the one it joined. */
export interface VoiceInstallStart {
  readonly state: 'running';
  /** Epoch ms the run began. */
  readonly startedAt: number;
  /** True when an install was already running and this call joined it. */
  readonly joined: boolean;
}

/** The last install run that ended: its receipt, or why it stopped without one. */
export interface VoiceInstallOutcome {
  readonly startedAt: number;
  readonly finishedAt: number;
  readonly receipt?: VoiceInstallReceipt | undefined;
  readonly error?: string | undefined;
}

/** The status read: the runtime on disk, the running install's progress, the last install's result. */
export type VoiceSetupStatus = VoiceRuntimeStatus & { readonly lastInstall?: VoiceInstallOutcome | undefined };

/** A request to set voice up, from a terminal product, the daemon or an agent. */
export interface VoiceSetupRequest extends VoiceProofLifetime {
  readonly intent: VoiceSetupIntent;
  /** The surface that asked; it is the one that must end up listening. */
  readonly surface: WakeSurface;
  /** Cloud voice providers whose credential this host holds; the local-or-cloud question is asked only when there are some. */
  readonly cloudVoiceProviders?: readonly string[] | undefined;
  /** Yes to the plan's proposals (install speech-to-text for a wake word). */
  readonly acceptProposals?: boolean | undefined;
  /** The answer to the text-to-speech question: `local` or one of {@link cloudVoiceProviders}. */
  readonly ttsChoice?: string | undefined;
}

/** What {@link VoiceSetupService.setup} did: the plan as carried out, and the install receipt when one ran. */
export interface VoiceSetupOutcome {
  /** Each step: `do` steps were done (or say why not), `propose` and `ask` steps still wait for an answer. */
  readonly plan: VoiceSetupChain;
  /** The plan as one reply a surface prints as-is. */
  readonly rendered: string;
  /** True when nothing is left to answer and every step that ran succeeded. */
  readonly complete: boolean;
  readonly install?: VoiceInstallReceipt | undefined;
}

export interface VoiceSetupServiceDeps {
  readonly managedVoiceRoot: string;
  readonly getConfig: (key: string) => string;
  readonly setConfig: (key: string, value: string | boolean) => void;
  /** Clear the local engine's tripped circuit breaker after a successful (re-)install. */
  readonly resetLocalEngineFailureState: () => void;
  /** Critical-tier admission gate (MemoryGovernor), for the wake provision that buffers its artifacts. */
  readonly admitExpensiveWork: (label: string) => { allowed: boolean; reason?: string | undefined };
  /** Provisioner seam (tests inject fetch/extractor via a wrapper). */
  readonly provision?: ((options: VoiceProvisionOptions) => Promise<VoiceProvisionResult>) | undefined;
  /**
   * The live round-trip proof seam. Injected by tests so no real engine has to
   * run; defaults to actually speaking a phrase and transcribing it back.
   */
  readonly prove?: ((options: VoiceRoundTripProofOptions) => Promise<VoiceRoundTripProof>) | undefined;
  /** Status-read seam (tests). */
  readonly readStatus?: ((options: { managedRoot: string }) => VoiceRuntimeStatus) | undefined;
}

export interface VoiceSetupService {
  status(): VoiceSetupStatus;
  install(options?: VoiceProofLifetime): Promise<VoiceInstallReceipt>;
  /**
   * Start the install, or join the one running, and return at once. The run's
   * result is read from status() as `lastInstall`. `assertCurrent` is checked
   * before the run's effects, as for install(); it throws at once when it
   * already fails.
   */
  startInstall(options?: Pick<VoiceProofLifetime, 'assertCurrent'>): VoiceInstallStart;
  /** Plan voice setup from the host's facts, do what the plan says, and return the plan with what happened. */
  setup(request: VoiceSetupRequest): Promise<VoiceSetupOutcome>;
  /** Wake-word artifact state, verified by content. See runtime/wake-setup.ts. */
  wakeStatus(): ReturnType<WakeSetupService['status']>;
  wakeProvision(): ReturnType<WakeSetupService['provision']>;
  /**
   * Install/boot provisioning: fetch whatever is missing, never throw, report one
   * line. Not admission-gated, unlike {@link wakeProvision}, a host that refused
   * this under memory pressure would ship an install with no model and no retry
   * until someone noticed, and the 6 MB it buffers is not what puts a daemon under
   * pressure. It joins the same single flight, so it cannot double the work either.
   */
  wakeEnsureProvisioned(options?: { readonly recoveryHint?: string | undefined }): Promise<WakeInstallProvisionOutcome>;
  wakeModelChunk(request: WakeModelChunkRequest): WakeModelChunkResult;
}

function currentVoiceInstallStamp(platform: VoiceProvisionResult['platform']): VoiceInstallStamp | null {
  const engine = platform ? PIPER_ENGINES[platform] : undefined;
  return engine ? { engineVersion: engine.version, voiceId: DEFAULT_PIPER_VOICE.id, configWrites: {} } : null;
}

export function createVoiceSetupService(deps: VoiceSetupServiceDeps): VoiceSetupService {
  const provision = deps.provision ?? provisionLocalVoiceRuntime;
  const readStatus = deps.readStatus ?? localVoiceRuntimeStatus;
  const progress = createVoiceInstallProgressTracker();
  // Wake artifacts live under the same managed voice root, in its `wake`
  // subdirectory, so they share this service's ownership of that tree.
  const wake = createWakeSetupService({ managedVoiceRoot: deps.managedVoiceRoot });

  let inFlight: { readonly run: Promise<VoiceInstallReceipt>; readonly startedAt: number } | undefined;
  let lastInstall: VoiceInstallOutcome | undefined;
  // The first request owns the shared work; its outcome is kept for status().
  const beginRun = (request: VoiceProofLifetime): { readonly run: Promise<VoiceInstallReceipt>; readonly startedAt: number } => {
    const startedAt = Date.now();
    const run = runInstall(request).then(
      (receipt) => { lastInstall = { startedAt, finishedAt: Date.now(), receipt }; return receipt; },
      (error: unknown) => { lastInstall = { startedAt, finishedAt: Date.now(), error: error instanceof Error ? error.message : String(error) }; throw error; },
    ).finally(() => { inFlight = undefined; });
    return { run, startedAt };
  };
  const runInstall = async (request: VoiceProofLifetime): Promise<VoiceInstallReceipt> => {
    assertVoiceProofCurrent(request);
    progress.begin();
    try {
      const result = await provision({
        managedRoot: deps.managedVoiceRoot,
        onProgress: (event) => progress.onProgress(event),
      });
      assertVoiceProofCurrent(request);
      let configured: VoiceInstallReceipt['configured'] = { set: [], skipped: [], superseded: [] };
      const notes: string[] = [];
      let proof: VoiceRoundTripProof | undefined;
      let proofLifetime: VoiceProofLifetime = request;
      const ttsProvisioned = result.tts.state === 'provisioned' && !!result.tts.binaryPath && !!result.tts.modelPath;
      const sttProvisioned = result.stt.state === 'provisioned' && !!result.stt.binaryPath && !!result.stt.modelPath;

      if (ttsProvisioned) {
        // Ownership-aware preconfigure: values THIS installer previously wrote
        // (recorded in the install stamp) update to the new managed paths; a
        // path naming a DIFFERENT install is superseded by this managed one and
        // the replaced path is named; a user-cleared installer value is a
        // deliberate disable and stays cleared.
        const stamp = readVoiceInstallStamp(deps.managedVoiceRoot);
        const receipt = preconfigureLocalVoiceKeys({
          getConfig: deps.getConfig,
          setConfig: deps.setConfig,
          managedRoot: deps.managedVoiceRoot,
          ttsEngine: result.tts.engine,
          ttsBinary: result.tts.binaryPath!,
          ttsModelPath: result.tts.modelPath!,
          ...(sttProvisioned
            ? { sttEngine: result.stt.engine, sttBinary: result.stt.binaryPath, sttModelPath: result.stt.modelPath }
            : {}),
          priorInstallWrites: stamp?.configWrites,
        });
        configured = { set: [...receipt.set], skipped: [...receipt.skipped], superseded: [...receipt.superseded] };
        notes.push(...describeSupersededVoiceKeys(receipt));
        // The stamp is what lets a later install update these keys; without it
        // they read as user-set and keep pointing at today's paths.
        const written = Object.entries(receipt.installWrites);
        if (written.length > 0) {
          // No stamp on disk (the provisioner's own write failed, or it was never
          // written): start one from the pinned versions so the keys just set stay owned.
          const base = stamp ?? currentVoiceInstallStamp(result.platform);
          const recorded = !!base && writeVoiceInstallStamp(deps.managedVoiceRoot, { ...base, configWrites: { ...base.configWrites, ...receipt.installWrites } });
          if (!recorded) {
            notes.push(
              'The installer could not record which voice settings it set, so a later reinstall will treat '
              + `${written.map(([key]) => key).join(', ')} as your own choices and will not move them to new managed paths. `
              + 'Check that the managed voice folder is writable, then reinstall.',
            );
          }
        }
        // A successful (re-)install is the recovery act: clear any tripped
        // local-engine circuit breaker so the next call retries the fresh engine.
        deps.resetLocalEngineFailureState();
      } else if (sttProvisioned) {
        // Speech-to-text needs no config keys: the local provider falls back to
        // the managed install for any key left unset.
        deps.resetLocalEngineFailureState();
      }

      // THE LAST ACT IS PROOF. Speak a phrase with the engine just installed,
      // read it back with the recogniser just installed, and report what came
      // back. Without this, "provisioned" only ever meant "the bytes are
      // there", which is exactly what was true on a machine where voice did
      // not work.
      if (ttsProvisioned && sttProvisioned) {
        const configKeys = ['voice.local.ttsEngine', 'voice.local.ttsBinary', 'voice.local.ttsModelPath',
          'voice.local.sttEngine', 'voice.local.sttBinary', 'voice.local.sttModelPath'];
        const config = configKeys.map(key => deps.getConfig(key));
        proofLifetime = {
          signal: AbortSignal.any([AbortSignal.timeout(120_000), ...(request.signal ? [request.signal] : [])]),
          assertCurrent: () => {
            assertVoiceProofCurrent(request);
            if (configKeys.some((key, index) => deps.getConfig(key) !== config[index])) {
              throw new Error('Voice setup configuration changed during the proof. Retry the original request.');
            }
          },
        };
        proof = await (deps.prove ?? proveVoiceRoundTrip)({
          ...proofLifetime,
          ttsEngine: result.tts.engine,
          ttsBinary: result.tts.binaryPath!,
          ttsModelPath: result.tts.modelPath!,
          sttEngine: result.stt.engine,
          sttBinary: result.stt.binaryPath!,
          sttModelPath: result.stt.modelPath!,
        });
        assertVoiceProofCurrent(proofLifetime);
        notes.push(proof.summary);
        recordVoiceDiagnostic(deps.managedVoiceRoot, {
          ...(proof.proofBasis !== undefined ? { proofBasis: proof.proofBasis } : {}),
          at: new Date().toISOString(),
          operation: 'provision-proof',
          route: 'in-process',
          ok: proof.proved,
          provider: `${result.tts.engine} + ${result.stt.engine}`,
          configSource: 'the managed voice runtime just installed',
          ...(proof.error !== undefined ? { error: proof.error } : {}),
          detail: proof.summary,
        });
      } else if (ttsProvisioned) {
        notes.push(
          `Text-to-speech is installed, but speech-to-text is not (${result.stt.reason ?? result.stt.state}), so there was nothing to read the test phrase `
          + 'back with and no round trip could be proven.',
        );
      } else if (sttProvisioned) {
        notes.push(
          `Speech-to-text is installed, but text-to-speech is not (${result.tts.reason ?? result.tts.state}), so there was no voice to speak the test phrase `
          + 'and no round trip could be proven. Dictation and the wake word can use speech-to-text now.',
        );
      }
      assertVoiceProofCurrent(proofLifetime);
      return {
        // Installed AND proven. A failed proof, or a speech-to-text half that
        // failed where it is supported, reports NOT provisioned, because a false
        // "ready" costs a session and an honest failure costs a retry; each
        // half's own state is in `tts` and `stt`.
        provisioned: ttsProvisioned && (sttProvisioned ? proof?.proved === true : result.stt.state === 'unsupported-platform'),
        platform: result.platform,
        tts: result.tts,
        stt: result.stt,
        components: result.components,
        configured,
        ...(proof !== undefined ? { proof } : {}),
        notes,
      };
    } finally {
      progress.end();
    }
  };

  const runSetup = async (request: VoiceSetupRequest): Promise<VoiceSetupOutcome> => {
    assertVoiceProofCurrent(request);
    const runtime = readStatus({ managedRoot: deps.managedVoiceRoot });
    const surfaceRow = wakeSurfaceKey(request.surface);
    const cloud = request.cloudVoiceProviders ?? [];
    // Everything the plan needs is a fact this host already holds.
    const chain = planVoiceSetupChain(request.intent, {
      surface: request.surface,
      wakeEnabled: deps.getConfig('voice.wake.enabled') === 'true',
      surfaceEnabled: deps.getConfig(surfaceRow) === 'true',
      wakeProvisioned: wake.status().ready,
      sttReady: runtime.stt.state === 'provisioned',
      ttsReady: runtime.state === 'provisioned' || (deps.getConfig('tts.provider') !== '' && deps.getConfig('tts.provider') !== 'local'),
      inputDevice: deps.getConfig('voice.wake.inputDevice'),
      cloudVoiceProviders: cloud,
    });
    let install: VoiceInstallReceipt | undefined;
    let installFailure: string | undefined;
    const ensureInstalled = async (): Promise<void> => {
      if (install || installFailure) return;
      try { install = await service.install(request); }
      catch (error) { assertVoiceProofCurrent(request); installFailure = error instanceof Error ? error.message : String(error); }
    };
    const halfFailure = (half: 'stt' | 'tts'): string | undefined => {
      if (installFailure) return installFailure;
      const state = install?.[half];
      return state && state.state !== 'provisioned' ? state.reason ?? state.state : undefined;
    };
    const steps: VoiceSetupStep[] = [];
    let complete = true;
    for (const step of chain.steps) {
      const answered = step.kind === 'propose' ? request.acceptProposals === true
        : step.kind === 'ask' ? request.ttsChoice !== undefined && (request.ttsChoice === 'local' || cloud.includes(request.ttsChoice))
        : true;
      if (!answered) { steps.push(step); complete = false; continue; }
      let failure: string | undefined;
      let message = step.message;
      if (step.subject === 'wake') {
        if (deps.getConfig('voice.wake.enabled') !== 'true') deps.setConfig('voice.wake.enabled', true);
        if (deps.getConfig(surfaceRow) !== 'true') deps.setConfig(surfaceRow, true);
      } else if (step.subject === 'wake-models') {
        const outcome = await wake.ensureProvisioned();
        if (!outcome.ready) failure = outcome.message;
      } else if (step.subject === 'stt' && runtime.stt.state !== 'provisioned') {
        await ensureInstalled();
        failure = halfFailure('stt');
        if (step.kind === 'propose' && !failure) message = 'The local speech-to-text runtime is installed and pointed at, so what you say after the wake word becomes text.';
      } else if (step.subject === 'tts' && runtime.state !== 'provisioned') {
        await ensureInstalled();
        failure = halfFailure('tts');
      } else if (step.subject === 'tts-provider') {
        if (request.ttsChoice === 'local') {
          await ensureInstalled();
          failure = halfFailure('tts');
          if (!failure) message = 'The local text-to-speech engine is installed and pointed at.';
        } else {
          deps.setConfig('tts.provider', request.ttsChoice!);
          message = `Text-to-speech uses your ${request.ttsChoice} account.`;
        }
      }
      assertVoiceProofCurrent(request);
      if (failure !== undefined) {
        complete = false;
        message = `${step.subject === 'wake-models' ? 'The wake models' : step.subject.startsWith('tts') ? 'Text-to-speech' : 'Speech-to-text'} could not be set up: ${failure}`;
      }
      steps.push({ ...step, kind: 'do', message });
    }
    const plan: VoiceSetupChain = { ...chain, steps };
    return { plan, rendered: renderVoiceSetupChain(plan), complete, ...(install ? { install } : {}) };
  };

  const service: VoiceSetupService = {
    status(): VoiceSetupStatus {
      const status = readStatus({ managedRoot: deps.managedVoiceRoot });
      const installInProgress = progress.snapshot();
      return {
        ...status,
        ...(installInProgress ? { installInProgress } : {}),
        ...(lastInstall ? { lastInstall } : {}),
      };
    },
    async install(options: VoiceProofLifetime = {}): Promise<VoiceInstallReceipt> {
      const request = Object.freeze({ ...options });
      assertVoiceProofCurrent(request);
      // Downloads stream to disk a network chunk at a time, so an install
      // holds no file in memory and needs no memory-pressure admission.
      // Joining callers may cancel their wait, but cannot lend new authority
      // to the original installation.
      inFlight ??= beginRun(request);
      const ownedRun = inFlight.run;
      const receipt = await executePolicyCheck(() => ownedRun, request.signal);
      assertVoiceProofCurrent(request);
      return receipt;
    },
    startInstall(options = {}): VoiceInstallStart {
      const request = Object.freeze({ ...options });
      assertVoiceProofCurrent(request);
      const joined = inFlight !== undefined;
      inFlight ??= beginRun(request);
      // The outcome is read through status(); nobody awaits this run here.
      inFlight.run.catch(() => undefined);
      return { state: 'running', startedAt: inFlight.startedAt, joined };
    },
    setup: (request) => runSetup(request),
    wakeStatus: () => wake.status(),
    async wakeProvision() {
      // Same admission gate as the local runtime install: this one is 6.1 MB
      // rather than 209 MB, but it still buffers artifacts to verify them, and
      // refusing honestly under memory pressure beats adding to it.
      const admission = deps.admitExpensiveWork('wake-word model provision');
      if (!admission.allowed) {
        throw new GatewayVerbError(admission.reason ?? 'wake-word provision refused: daemon is under critical memory pressure. Retry when memory pressure eases.', 'SERVICE_UNAVAILABLE', 503);
      }
      return wake.provision();
    },
    wakeEnsureProvisioned: (options) => wake.ensureProvisioned(options),
    wakeModelChunk: (request) => wake.modelChunk(request),
  };
  return service;
}
