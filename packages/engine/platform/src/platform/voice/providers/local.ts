/**
 * providers/local.ts, the local voice provider: free, offline STT + TTS
 * behind the exact same seams as the cloud providers.
 *
 * Blessed engines (research pass 2026-07-14, citations in docs/voice-local.md):
 * - STT: whisper.cpp (CPU-first, real-time capable, no Python dependency) with
 *   faster-whisper as the NVIDIA-GPU alternative behind a wrapper script.
 * - TTS: Piper (sub-50 ms first-audio class, MIT) with Kokoro-82M as the
 *   quality alternative (Apache 2.0) behind a wrapper script.
 *
 * CONFIGURABLE-NOT-CONFIGURED BY DEFAULT: the keys ship empty and a machine
 * without engines reports an honest 'unconfigured' status, never an error.
 * Filling them in is the managed setup's job, it downloads and verifies the
 * engines, points the keys at them, and proves the round trip, and it costs
 * the user one act. This provider does not download anything ITSELF; that is a
 * statement about where the work happens, not a chore left to the user.
 *
 * Engine invocation contracts (all injectable for the scripted test fixture):
 * - whisper-cpp: `<binary> -m <model> -f <wav> --no-timestamps --no-prints`,
 *   transcript on stdout.
 * - faster-whisper: `<binary> <model> <wav>`, transcript on stdout (a
 *   two-line wrapper script, shown in the doc).
 * - piper: `<binary> --model <onnx> --output_file <wav>`, text on stdin.
 * - kokoro: `<binary> --model <path> --output_file <wav>`, text on stdin (a
 *   wrapper script, shown in the doc).
 *
 * BILLING: 'none', a local engine has no billing dimension, so it emits no
 * cost-attribution usage at all (honest absence, never a fake $0.00).
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { structuredLocalEngineFailure, type LocalEngineFailure } from './local-failure-reading.js';
import type {
  VoiceProvider,
  VoiceProviderStatus,
  VoiceSynthesisRequest,
  VoiceSynthesisResult,
  VoiceSynthesisStreamResult,
  VoiceTranscriptionRequest,
  VoiceTranscriptionResult,
} from '../types.js';

export type LocalSttEngine = 'whisper-cpp' | 'faster-whisper';
export type LocalTtsEngine = 'piper' | 'kokoro';

/** The voice.local.* config surface the provider reads live. */
export interface LocalVoiceConfigReader {
  (key: string): unknown;
}

/** Injectable process seam: run a binary, return stdout (text is fed via stdin when given). */
export type LocalEngineRunner = (input: {
  readonly binary: string;
  readonly args: readonly string[];
  readonly stdinText?: string | undefined;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}) => Promise<{ stdout: string }>;

/**
 * Run one engine binary to completion. The one runner for local speech: the
 * provider and the install proof both use it, so the proof runs the engines
 * the way the product does.
 *
 * Settles only when the child has closed, so a caller's scratch cleanup cannot
 * race a child that ignored SIGTERM and is still writing its output file. A
 * failure carries the exit `code`, `signal` and `stderr`; a deadline or abort
 * rejects with a `TimeoutError` or `AbortError`.
 */
export const runLocalEngine: LocalEngineRunner = (input) =>
  new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      reject(input.signal.reason ?? new DOMException('The local engine run was cancelled.', 'AbortError'));
      return;
    }
    let failure: unknown;
    let output = '';
    let escalation: ReturnType<typeof setTimeout> | undefined;
    let closing = false;
    const child = execFile(input.binary, [...input.args], { maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      output = stdout;
      if (error) { failure ??= Object.assign(error, { stderr }); terminate(); }
    });
    const terminate = () => {
      if (closing || child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      escalation ??= setTimeout(() => { if (!closing) child.kill('SIGKILL'); }, 250);
    };
    const abort = () => {
      failure ??= input.signal?.reason ?? new DOMException('The local engine run was cancelled.', 'AbortError');
      terminate();
    };
    const timeout = setTimeout(() => {
      failure ??= new DOMException(`${input.binary} did not finish within ${input.timeoutMs} ms.`, 'TimeoutError');
      terminate();
    }, input.timeoutMs);
    input.signal?.addEventListener('abort', abort, { once: true });
    child.once('close', () => {
      closing = true;
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      input.signal?.removeEventListener('abort', abort);
      if (failure !== undefined) reject(failure);
      else resolve({ stdout: output });
    });
    if (input.stdinText !== undefined && child.stdin) {
      // A binary that exits before reading all of stdin breaks the pipe; the
      // process-exit callback above already reports that failure.
      child.stdin.on('error', () => {});
      child.stdin.end(input.stdinText);
    }
  });

/** The piper/kokoro invocation: text on stdin, wav to `--output_file`. */
export function localTtsArgs(modelPath: string, outPath: string): readonly string[] {
  return ['--model', modelPath, '--output_file', outPath];
}

/** The whisper-cpp or faster-whisper invocation over one wav file; transcript on stdout. */
export function localSttArgs(engine: string, modelPath: string, wavPath: string): readonly string[] {
  return engine === 'whisper-cpp'
    ? ['-m', modelPath, '-f', wavPath, '--no-timestamps', '--no-prints']
    : [modelPath, wavPath];
}

interface LocalEngineConfig {
  readonly engine: string;
  readonly binary: string;
  readonly modelPath: string;
}

/** Resolve the managed install for a prefix (null when not provisioned / not managed). */
export type ManagedEngineResolver = (prefix: 'stt' | 'tts') => LocalEngineConfig | null;

/** Neither existsSync nor execFile expands `~`, so a documented `~/...` path would otherwise read as missing. */
function expandHomePath(value: string): string {
  if (value === '~') return homedir();
  return value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

function readEngine(
  read: LocalVoiceConfigReader,
  prefix: 'stt' | 'tts',
  resolveManaged?: ManagedEngineResolver | undefined,
): LocalEngineConfig | null {
  const engine = String(read(`voice.local.${prefix}Engine`) ?? '').trim();
  const binary = expandHomePath(String(read(`voice.local.${prefix}Binary`) ?? '').trim());
  const modelPath = expandHomePath(String(read(`voice.local.${prefix}ModelPath`) ?? '').trim());
  if (engine && binary && modelPath) return { engine, binary, modelPath };
  // Fall back to the managed install for any unset field (config values that
  // ARE set always win, a user's custom path is never overridden).
  const managed = resolveManaged?.(prefix);
  if (!managed) return null;
  const merged = {
    engine: engine || managed.engine,
    binary: binary || managed.binary,
    modelPath: modelPath || managed.modelPath,
  };
  return merged.engine && merged.binary && merged.modelPath ? merged : null;
}

const RUN_TIMEOUT_MS = 120_000;

/** Failed runs in a row, whatever the wording, after which an engine is not spawned again. */
const CONSECUTIVE_FAILURE_LIMIT = 3;

/** Breakers belong to an engine incarnation, not a reusable config string. */
interface EngineIncarnation {
  readonly config: LocalEngineConfig | null;
  readonly configIncarnation: number | undefined;
  readonly controller: AbortController;
  unavailable: string | null;
  consecutiveFailures: number;
}

function sameEngine(left: LocalEngineConfig | null, right: LocalEngineConfig | null): boolean {
  return left === right || (left !== null && right !== null && left.engine === right.engine
    && left.binary === right.binary && left.modelPath === right.modelPath);
}
function newIncarnation(config: LocalEngineConfig | null, configIncarnation?: number): EngineIncarnation {
  return { config: config ? Object.freeze({ ...config }) : null, configIncarnation, controller: new AbortController(), unavailable: null, consecutiveFailures: 0 };
}
function unavailableMessage(cfg: LocalEngineConfig, operation: 'TTS' | 'STT', failure: LocalEngineFailure, failures: number): string {
  const cause = failure.kind === 'model-load-incompatible'
    ? `${cfg.engine} could not load an incompatible model. Update the engine/runtime (including onnxruntime where applicable), or use a compatible model.`
    : failure.kind === 'fatal-crash'
      ? `${cfg.engine} crashed (${failure.signal || 'fatal abort'}) while running ${cfg.binary}. Confirm the binary and model are compatible with this host, including the onnxruntime/model IR versions where applicable (see docs/voice-local.md).`
      : `${cfg.engine} failed ${failures} times in a row (last ${failure.code !== undefined ? `exit ${failure.code}` : failure.signal ? `signal ${failure.signal}` : 'run'}) while running ${cfg.binary}. Confirm the binary and model are present and compatible with this host (see docs/voice-local.md).`;
  const prefix = operation === 'TTS' ? 'tts' : 'stt';
  return `Local ${operation} engine '${cfg.engine}' is unavailable on this host, ${cause} Reinstalling the managed voice `
    + 'runtime updates the engine and clears this state, as does a daemon restart or a change to the '
    + `voice.local.${prefix}Binary / voice.local.${prefix}ModelPath rows.`;
}

export interface LocalVoiceProviderOptions {
  readonly readConfig: LocalVoiceConfigReader;
  /** Monotonic source revision, including mutations that restore the same values. */
  readonly readConfigIncarnation?: (() => number) | undefined;
  /** Injectable engine runner (scripted fixtures in tests). */
  readonly runner?: LocalEngineRunner | undefined;
  /** Injectable existence check (tests). */
  readonly fileExists?: ((path: string) => boolean) | undefined;
  /**
   * Resolve the managed (provisioned) engine for a prefix so a provisioned host
   * needs zero config. Config values always win; this only fills unset fields.
   */
  readonly resolveManaged?: ManagedEngineResolver | undefined;
}

/** Create the local (free, offline) voice provider. */
export function createLocalVoiceProvider(options: LocalVoiceProviderOptions): VoiceProvider {
  const read = options.readConfig;
  const readConfigIncarnation = options.readConfigIncarnation;
  const runner = options.runner ?? runLocalEngine;
  const exists = options.fileExists ?? existsSync;
  const resolveManaged = options.resolveManaged;
  const engines: Record<'tts' | 'stt', EngineIncarnation> = {
    tts: newIncarnation(null), stt: newIncarnation(null),
  };
  // A transition (including configured -> absent -> configured), an explicit
  // reset, or a newer configuration revision starts a new incarnation; a late
  // failure from an older one cannot trip the newer one's breaker. The engine
  // settings are read once per call.
  const observeEngine = (prefix: 'tts' | 'stt'): EngineIncarnation => {
    const configIncarnation = readConfigIncarnation?.();
    const config = readEngine(read, prefix, resolveManaged);
    const previous = engines[prefix];
    if (!sameEngine(previous.config, config) || previous.configIncarnation !== configIncarnation) {
      engines[prefix] = newIncarnation(config, configIncarnation);
      previous.controller.abort();
    }
    return engines[prefix];
  };
  const runEngine = async <T>(incarnation: EngineIncarnation, operation: 'TTS' | 'STT', signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const active = signal ? AbortSignal.any([incarnation.controller.signal, signal]) : incarnation.controller.signal;
    try {
      const result = await run(active);
      incarnation.consecutiveFailures = 0;
      return result;
    } catch (error) {
      const failure = structuredLocalEngineFailure(error);
      if (failure.kind === 'cancelled' || active.aborted) throw error;
      const failures = ++incarnation.consecutiveFailures;
      if (failure.kind === 'failed' && failures < CONSECUTIVE_FAILURE_LIMIT) throw error;
      // First trip wins; a concurrent failure cannot overwrite its message.
      throw new Error(incarnation.unavailable ??= unavailableMessage(incarnation.config!, operation, failure, failures));
    }
  };

  const synthesizeWav = async (request: VoiceSynthesisRequest): Promise<{ wav: Buffer; engine: LocalEngineConfig }> => {
    const incarnation = observeEngine('tts');
    const tts = incarnation.config;
    if (!tts) {
      throw new Error(
        'Local text-to-speech is not configured on this host: voice.local.ttsEngine, ttsBinary and ttsModelPath are '
        + 'not all set, and no managed install was found to fall back on. The managed voice runtime installs the '
        + 'engine and fills these in.',
      );
    }
    if (incarnation.unavailable) throw new Error(incarnation.unavailable);
    const scratch = mkdtempSync(join(tmpdir(), 'gv-local-tts-'));
    const outPath = join(scratch, 'out.wav');
    try {
      return await runEngine(incarnation, 'TTS', request.signal, async (signal) => {
        await runner({ binary: tts.binary, args: localTtsArgs(tts.modelPath, outPath), stdinText: request.text, timeoutMs: RUN_TIMEOUT_MS, signal });
        // An engine can exit 0 and write nothing; reading the file is that check.
        const wav = readFileSync(outPath);
        if (wav.byteLength === 0) throw new Error(`${tts.engine} exited without writing any audio`);
        return { wav, engine: tts };
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

  const transcribeOnce = async (request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> => {
    const incarnation = observeEngine('stt');
    const stt = incarnation.config;
    if (!stt) {
      throw new Error(
        'Local speech-to-text is not configured on this host: voice.local.sttEngine, sttBinary and sttModelPath are '
        + 'not all set, and no managed install was found to fall back on. The managed voice runtime installs whisper '
        + 'and fills these in.',
      );
    }
    if (!request.audio.dataBase64) {
      throw new Error('local STT needs inline audio (dataBase64)');
    }
    if (incarnation.unavailable) throw new Error(incarnation.unavailable);
    const scratch = mkdtempSync(join(tmpdir(), 'gv-local-stt-'));
    const wavPath = join(scratch, 'in.wav');
    try {
      writeFileSync(wavPath, Buffer.from(request.audio.dataBase64, 'base64'));
      const { stdout } = await runEngine(incarnation, 'STT', request.signal, (signal) =>
        runner({ binary: stt.binary, args: localSttArgs(stt.engine, stt.modelPath, wavPath), timeoutMs: RUN_TIMEOUT_MS, signal }));
      return {
        providerId: 'local',
        text: stdout.trim(),
        metadata: { engine: stt.engine, modelPath: stt.modelPath, billing: 'none' },
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  };

return {
  id: 'local',
  label: 'Local engines (free, offline)',
  capabilities: ['tts', 'tts-stream', 'stt'],
  billing: 'none',
  resetEngineFailureState(): void {
    const previous = [engines.tts, engines.stt];
    engines.tts = newIncarnation(engines.tts.config, engines.tts.configIncarnation);
    engines.stt = newIncarnation(engines.stt.config, engines.stt.configIncarnation);
    for (const incarnation of previous) incarnation.controller.abort();
  },
  status(): VoiceProviderStatus {
    const ttsState = observeEngine('tts');
    const sttState = observeEngine('stt');
    const tts = ttsState.config;
    const stt = sttState.config;
    const caps: Array<'tts' | 'tts-stream' | 'stt'> = [];
    if (tts) caps.push('tts', 'tts-stream');
    if (stt) caps.push('stt');
    const missing: string[] = [];
    for (const [label, engine] of [['TTS', tts], ['STT', stt]] as const) {
      if (engine && (!exists(engine.binary) || !exists(engine.modelPath))) {
        missing.push(`${label} (${engine.engine}): binary or model missing on disk`);
      }
    }
    // Surface a tripped circuit breaker as the honest engine-unavailable state
    // (one line, not a per-chunk crash storm), while its config is unchanged.
    if (tts && ttsState.unavailable) missing.push(ttsState.unavailable);
    if (stt && sttState.unavailable) missing.push(sttState.unavailable);
    const configured = caps.length > 0;
    return {
      id: 'local',
      label: 'Local engines (free, offline)',
      state: !configured ? 'unconfigured' : missing.length > 0 ? 'degraded' : 'healthy',
      capabilities: caps,
      configured,
      detail: !configured
        ? 'Not configured, local voice needs an installed engine and model, which the managed voice runtime provisions in one act.'
        : missing.length > 0
          ? missing.join('; ')
          : `STT: ${stt?.engine ?? 'off'}; TTS: ${tts?.engine ?? 'off'}, offline, no billing dimension.`,
      metadata: { billing: 'none', sttEngine: stt?.engine ?? null, ttsEngine: tts?.engine ?? null },
    };
  },
  async synthesize(request: VoiceSynthesisRequest): Promise<VoiceSynthesisResult> {
    const { wav, engine } = await synthesizeWav(request);
    return {
      providerId: 'local',
      audio: {
        mimeType: 'audio/wav',
        format: 'wav',
        dataBase64: wav.toString('base64'),
        metadata: { engine: engine.engine, billing: 'none' },
      },
      metadata: { engine: engine.engine, modelPath: engine.modelPath, billing: 'none' },
    };
  },
  async synthesizeStream(request: VoiceSynthesisRequest): Promise<VoiceSynthesisStreamResult> {
    // Local engines emit whole wav files; the stream contract is satisfied
    // with a single final chunk (the spoken-turn controller already handles
    // single-chunk streams, same shape a short cloud response produces).
    const { wav, engine } = await synthesizeWav(request);
    const chunk = { data: new Uint8Array(wav), sequence: 0, mimeType: 'audio/wav', format: 'wav' as const, final: true };
    return {
      providerId: 'local',
      mimeType: 'audio/wav',
      format: 'wav',
      chunks: (async function* () {
        yield chunk;
      })(),
      metadata: { engine: engine.engine, billing: 'none' },
    };
  },
  async transcribe(request: VoiceTranscriptionRequest): Promise<VoiceTranscriptionResult> {
    const result = await transcribeOnce(request);
    // Same contract as every cloud provider: an empty result is a failure, not an empty success.
    if (!result.text) throw new Error('Local transcription response missing transcript (no speech was recognised)');
    return result;
  },
  };
}
