import { execFile } from 'node:child_process';
import { isAbsolute } from 'node:path';

export interface HerdrSessionUpdate {
  readonly sessionId: string;
  readonly sessionPath?: string | undefined;
  readonly busy: boolean;
  readonly waitingForOwner: boolean;
  readonly resumeArgv: readonly string[];
}

export interface HerdrReporterEnvironment {
  readonly HERDR_ENV?: string | undefined;
  readonly HERDR_PANE_ID?: string | undefined;
  readonly HERDR_BIN_PATH?: string | undefined;
  readonly HERDR_SOCKET_PATH?: string | undefined;
}

export interface HerdrTransportContext {
  readonly binaryPath: string;
  readonly socketPath: string;
  readonly paneId: string;
  readonly signal: AbortSignal;
  readonly timeoutMs: number;
}

export interface HerdrSessionReporterOptions {
  readonly environment?: HerdrReporterEnvironment | undefined;
  /** Execute an argv-only owning-binary command; return stdout for the version probe. */
  readonly transport?: ((argv: readonly string[], context: HerdrTransportContext) => Promise<string | void>) | undefined;
  readonly onError?: ((error: Error) => void) | undefined;
}

export interface HerdrSessionReporter {
  readonly enabled: boolean;
  /** Reflects the owning binary's detected protocol, available after the first report. */
  readonly resumeCommandSupported: boolean;
  update(input: HerdrSessionUpdate): Promise<void>;
  close(): Promise<void>;
}

interface Report {
  readonly sessionId: string;
  readonly sessionPath: string | undefined;
  readonly state: 'blocked' | 'working' | 'idle';
  readonly resumeArgv: readonly string[] | undefined;
}

const SOURCE = 'goodvibes';
const AGENT = 'goodvibes';
const validText = (value: unknown, limit: number): value is string => typeof value === 'string'
  && value.length > 0 && Buffer.byteLength(value) <= limit && !/\p{Cc}/u.test(value);

function captureResumeArgv(value: readonly string[]): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64) return undefined;
  const args: string[] = [];
  let bytes = 0;
  for (const arg of value) {
    if (typeof arg !== 'string' || /[\p{Cc}']/u.test(arg)) return undefined;
    bytes += Buffer.byteLength(arg);
    if (bytes > 8_192) return undefined;
    args.push(arg);
  }
  if (!args[0] || !/^[a-zA-Z0-9_.][a-zA-Z0-9_.-]*$/.test(args[0])) return undefined;
  return Object.freeze(args);
}

function runHerdr(argv: readonly string[], context: HerdrTransportContext): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(context.binaryPath, [...argv], { timeout: context.timeoutMs, maxBuffer: 16_384, windowsHide: true, signal: context.signal,
      env: { HERDR_ENV: '1', HERDR_PANE_ID: context.paneId, HERDR_BIN_PATH: context.binaryPath, HERDR_SOCKET_PATH: context.socketPath } }, (error, stdout) => {
      if (error) reject(new Error('Herdr session reporting failed'));
      else resolve(stdout);
    });
  });
}

/** Use the pane-owning binary/socket, and retain only the latest unsent lifecycle state. */
export function createHerdrSessionReporter(options: HerdrSessionReporterOptions = {}): HerdrSessionReporter {
  const environment = options.environment ?? { HERDR_ENV: process.env.HERDR_ENV, HERDR_PANE_ID: process.env.HERDR_PANE_ID,
    HERDR_BIN_PATH: process.env.HERDR_BIN_PATH, HERDR_SOCKET_PATH: process.env.HERDR_SOCKET_PATH };
  const pane = environment.HERDR_ENV === '1' && typeof environment.HERDR_PANE_ID === 'string'
    && /^w[1-9]\d*:p[1-9]\d*$/.test(environment.HERDR_PANE_ID) ? environment.HERDR_PANE_ID : undefined;
  const binary = validText(environment.HERDR_BIN_PATH, 4_096) && isAbsolute(environment.HERDR_BIN_PATH) ? environment.HERDR_BIN_PATH : undefined;
  const socket = validText(environment.HERDR_SOCKET_PATH, 4_096) ? environment.HERDR_SOCKET_PATH : undefined;
  const enabled = pane !== undefined && binary !== undefined && socket !== undefined;
  const transport = options.transport ?? runHerdr;
  let desired: Report | undefined;
  let draining: Promise<void> | undefined;
  let active: AbortController | undefined;
  let closing: Promise<void> | undefined;
  let closed = false, legacyReleased = false, detected = false, resumeSupported = false;
  let lastReported = '', sequence = 0;
  const nextSequence = () => String(sequence = Math.max(sequence + 1, Date.now()));
  const notifyFailure = () => { try { options.onError?.(new Error('Herdr session reporting failed')); } catch { /* Terminal execution does not depend on reporting. */ } };

  const command = (argv: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<string | void> => {
    if (!enabled || !pane || !binary || !socket) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      let settled = false;
      const finish = (error: boolean, value?: string | void) => {
        if (settled) return;
        settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
        if (error) { controller.abort(); reject(new Error('Herdr session reporting failed')); } else resolve(value);
      };
      const abort = () => finish(true);
      const timer = setTimeout(abort, Math.max(1, timeoutMs));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) { abort(); return; }
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw new Error('Herdr command cancelled');
        return transport(argv, { binaryPath: binary, socketPath: socket, paneId: pane, signal: controller.signal, timeoutMs });
      }).then(value => finish(false, value), () => finish(true));
    });
  };
  const releaseLegacy = async (timeoutMs: number, signal?: AbortSignal) => {
    if (legacyReleased || !pane) return;
    // Herdr's release handler returns success even if this source does not hold the pane.
    await command(['pane', 'release-agent', pane, '--source', 'herdr:goodvibes', '--agent', AGENT], timeoutMs, signal);
    legacyReleased = true;
  };
  const flush = (): Promise<void> => {
    if (draining) return draining;
    const controller = new AbortController(); active = controller;
    const operation = Promise.resolve().then(async () => {
      if (!detected && !closed) {
        try {
          const version = await command(['--version'], 1_000, controller.signal);
          const match = typeof version === 'string' ? /\bherdr\s+(\d+)\.(\d+)\.(\d+)\b/.exec(version) : null;
          resumeSupported = !!match && (Number(match[1]) > 0 || Number(match[2]) > 9 || (Number(match[2]) === 9 && Number(match[3]) >= 2));
          detected = true;
        } catch { if (closed) return; detected = true; }
      }
      if (closed) return;
      await releaseLegacy(3_000, controller.signal);
      while (!closed && desired) {
        const report = desired; desired = undefined;
        const resumeArgv = resumeSupported ? report.resumeArgv : undefined;
        const signature = JSON.stringify([report.sessionId, report.sessionPath ?? null, report.state, resumeArgv ?? null]);
        if (signature === lastReported) continue;
        await command(['pane', 'report-agent', pane!, '--source', SOURCE, '--agent', AGENT, '--state', report.state,
          '--seq', nextSequence(), `--agent-session-id=${report.sessionId}`,
          ...(report.sessionPath === undefined ? [] : [`--agent-session-path=${report.sessionPath}`]),
          ...(resumeArgv === undefined ? [] : ['--', ...resumeArgv])], 3_000, controller.signal);
        lastReported = signature;
      }
    }).catch(() => { desired = undefined; if (!closed) notifyFailure(); });
    draining = operation.finally(() => {
      draining = undefined;
      if (active === controller) active = undefined;
      if (!closed && desired) return flush();
    });
    return draining;
  };

  return {
    enabled,
    get resumeCommandSupported() { return resumeSupported; },
    update(input) {
      if (!enabled || closed || !validText(input.sessionId, 512)
        || (input.sessionPath !== undefined && !validText(input.sessionPath, 4_096))) return Promise.resolve();
      desired = { sessionId: input.sessionId, sessionPath: input.sessionPath,
        state: input.waitingForOwner ? 'blocked' : input.busy ? 'working' : 'idle', resumeArgv: captureResumeArgv(input.resumeArgv) };
      return flush();
    },
    close() {
      if (closing) return closing;
      closed = true; desired = undefined; active?.abort();
      closing = enabled ? (async () => {
        // Abort settles the one active command; unsent historical updates never delay release.
        await draining;
        const deadline = Date.now() + 900;
        try { await releaseLegacy(300); } catch { notifyFailure(); }
        try {
          await command(['pane', 'release-agent', pane!, '--source', SOURCE, '--agent', AGENT, '--seq', nextSequence()], Math.max(1, deadline - Date.now()));
        } catch { notifyFailure(); }
      })() : Promise.resolve();
      return closing;
    },
  };
}
