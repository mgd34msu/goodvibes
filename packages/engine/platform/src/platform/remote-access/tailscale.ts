/**
 * remote-access/tailscale.ts
 *
 * Tailscale as the recommended path to https without the daemon ever minting a
 * certificate (self-provisioned CAs are ruled out; `tailscale serve` terminates
 * TLS with tailscale's own certificates, which is tailscale's business, never
 * the daemon's).
 *
 * Two operations, cleanly split by side effect:
 *  - `detectTailscale` is STRICTLY READ-ONLY: is the binary present, is the
 *    node logged in, what is the MagicDNS name. It never invokes a
 *    state-changing tailscale command. Where tailscale is absent, the result
 *    says so once and nothing nags.
 *  - `enableTailscaleServe` is the ONE state-changing action (`tailscale serve
 *    --bg <port>`), run only from the explicit user-initiated verb, recorded
 *    with an honest receipt either way.
 *
 * The command runner is injectable so tests never touch a real tailscale.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, existsSync, renameSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import { writeFileAtomic } from '../utils/atomic-json-store.js';

/** One command's result. `errorCode` is the spawn error's errno code (ENOENT, ETIMEDOUT, ...) when it did not run to an exit status. */
export interface TailscaleCommandResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly errorCode?: string | undefined;
}

/**
 * Injectable command execution seam. `run` blocks the calling thread until the
 * command ends; `runAsync` does not, and is what the daemon's request handlers
 * use so a wedged tailscale cannot stall every other request. A runner without
 * `runAsync` is run through `run`.
 */
export interface TailscaleCommandRunner {
  run(command: string, args: readonly string[]): TailscaleCommandResult;
  runAsync?(command: string, args: readonly string[]): Promise<TailscaleCommandResult>;
}

const COMMAND_TIMEOUT_MS = 10_000;

/** Real runner: a hard timeout, never a shell. `run` is spawnSync; `runAsync` is a non-blocking spawn. */
export function defaultTailscaleRunner(): TailscaleCommandRunner {
  return {
    runAsync(command, args) {
      return new Promise<TailscaleCommandResult>((resolve) => {
        let stdout = '';
        let stderr = '';
        let settled = false;
        const finish = (result: TailscaleCommandResult): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(result);
        };
        const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
        const timer = setTimeout(() => {
          child.kill('SIGKILL');
          finish({ status: null, stdout, stderr, errorCode: 'ETIMEDOUT' });
        }, COMMAND_TIMEOUT_MS);
        timer.unref?.();
        child.stdout.setEncoding('utf-8').on('data', (chunk: string) => { stdout += chunk; });
        child.stderr.setEncoding('utf-8').on('data', (chunk: string) => { stderr += chunk; });
        child.on('error', (error: NodeJS.ErrnoException) => {
          finish({ status: null, stdout, stderr: stderr || error.message, ...(error.code ? { errorCode: error.code } : {}) });
        });
        child.on('close', (code) => finish({ status: code, stdout, stderr }));
      });
    },
    run(command, args) {
      try {
        const result = spawnSync(command, [...args], { encoding: 'utf-8', timeout: COMMAND_TIMEOUT_MS });
        const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
        return {
          // Bun leaves `status` undefined, not null, when the binary is missing.
          status: result.status ?? null,
          stdout: result.stdout ?? '',
          stderr: result.stderr || result.error?.message || '',
          ...(errorCode ? { errorCode } : {}),
        };
      } catch (error) {
        return {
          status: null,
          stdout: '',
          stderr: error instanceof Error ? error.message : String(error),
          ...((error as NodeJS.ErrnoException)?.code ? { errorCode: (error as NodeJS.ErrnoException).code } : {}),
        };
      }
    },
  };
}

/** Read-only detection result, what a surface needs to offer (or not offer) the affordance. */
export interface TailscaleDetection {
  /** The tailscale binary exists and answered. */
  readonly available: boolean;
  /** The node is logged in and running. */
  readonly loggedIn: boolean;
  /** The node's MagicDNS name (trailing dot stripped), when logged in. */
  readonly magicDnsName?: string | undefined;
  /** The https URL `tailscale serve` would yield, when a MagicDNS name exists. */
  readonly httpsUrl?: string | undefined;
  /** Plain-language state, honest about what was (not) found. */
  readonly detail: string;
}

/** Why a tailscale command produced no exit status, from its errno code. */
function notRunDetail(result: TailscaleCommandResult): string {
  if (result.errorCode === 'ENOENT') return 'tailscale binary not found';
  if (result.errorCode === 'ETIMEDOUT') return `tailscale did not answer within ${COMMAND_TIMEOUT_MS / 1000} seconds`;
  const reason = result.stderr.trim();
  return `tailscale could not be run${reason ? `: ${reason}` : ''}`;
}

/**
 * Detect a usable tailscale environment. READ-ONLY: `tailscale status --json`
 * only, never up/login/serve/set. Absence is a quiet, honest result, not an
 * error and never a nag.
 */
export function detectTailscale(runner: TailscaleCommandRunner = defaultTailscaleRunner()): TailscaleDetection {
  return interpretTailscaleStatus(runner.run('tailscale', ['status', '--json']));
}

/** {@link detectTailscale} without blocking the thread while tailscale answers. */
export async function detectTailscaleAsync(runner: TailscaleCommandRunner = defaultTailscaleRunner()): Promise<TailscaleDetection> {
  return interpretTailscaleStatus(await runCommand(runner, 'tailscale', ['status', '--json']));
}

async function runCommand(runner: TailscaleCommandRunner, command: string, args: readonly string[]): Promise<TailscaleCommandResult> {
  return runner.runAsync ? runner.runAsync(command, args) : runner.run(command, args);
}

function interpretTailscaleStatus(status: TailscaleCommandResult): TailscaleDetection {
  if (status.status === null) {
    // Which of these it was is the spawn error's errno code: ENOENT is a
    // missing binary, ETIMEDOUT is a tailscale that did not answer in time.
    return { available: false, loggedIn: false, detail: notRunDetail(status) };
  }
  let parsed: { BackendState?: string; Self?: { DNSName?: string } };
  try {
    parsed = JSON.parse(status.stdout) as typeof parsed;
  } catch {
    return {
      available: true,
      loggedIn: false,
      detail: `tailscale answered but its status was unreadable${status.stderr ? `: ${status.stderr.trim()}` : ''}`,
    };
  }
  const loggedIn = parsed.BackendState === 'Running';
  const rawDnsName = parsed.Self?.DNSName?.replace(/\.$/, '') ?? '';
  if (!loggedIn) {
    return {
      available: true,
      loggedIn: false,
      detail: `tailscale is installed but not connected (state: ${parsed.BackendState ?? 'unknown'})`,
    };
  }
  if (!rawDnsName) {
    return { available: true, loggedIn: true, detail: 'tailscale is connected but reports no MagicDNS name' };
  }
  return {
    available: true,
    loggedIn: true,
    magicDnsName: rawDnsName,
    httpsUrl: `https://${rawDnsName}`,
    detail: `tailscale is connected as ${rawDnsName}`,
  };
}

/** The honest record of one serve attempt, persisted either way. */
export interface TailscaleServeReceipt {
  readonly at: number;
  readonly command: string;
  readonly ok: boolean;
  /** The https MagicDNS URL now fronting the daemon, on success. */
  readonly url?: string | undefined;
  readonly detail: string;
}

/**
 * Run `tailscale serve --bg <port>`, the ONE state-changing tailscale action,
 * invoked only from the explicit user-initiated verb. Returns an honest receipt
 * either way; the caller persists it and updates web.publicBaseUrl on success.
 */
export function enableTailscaleServe(
  port: number,
  runner: TailscaleCommandRunner = defaultTailscaleRunner(),
): TailscaleServeReceipt {
  const command = `tailscale serve --bg ${port}`;
  const detection = detectTailscale(runner);
  if (!detection.available || !detection.loggedIn || !detection.httpsUrl) {
    return { at: Date.now(), command, ok: false, detail: detection.detail };
  }
  return serveReceipt(port, command, detection.httpsUrl, runner.run('tailscale', ['serve', '--bg', String(port)]));
}

function serveReceipt(port: number, command: string, httpsUrl: string, result: TailscaleCommandResult): TailscaleServeReceipt {
  if (result.status === null) return { at: Date.now(), command, ok: false, detail: notRunDetail(result) };
  if (result.status !== 0) {
    const stderr = result.stderr.trim() || result.stdout.trim() || 'tailscale serve failed';
    return { at: Date.now(), command, ok: false, detail: stderr };
  }
  return {
    at: Date.now(),
    command,
    ok: true,
    url: httpsUrl,
    detail: `tailscale serve is fronting port ${port} at ${httpsUrl}`,
  };
}

/** Serve attempts running now, by port: a second request for the same port waits for the first and shares its receipt. */
const serveInFlight = new Map<number, Promise<TailscaleServeReceipt>>();

/**
 * {@link enableTailscaleServe} without blocking the thread while tailscale
 * answers. Calls for the same port made while one is running (a double click,
 * two surfaces) share that one run, so `tailscale serve` is started once.
 */
export function enableTailscaleServeAsync(
  port: number,
  runner: TailscaleCommandRunner = defaultTailscaleRunner(),
): Promise<TailscaleServeReceipt> {
  const running = serveInFlight.get(port);
  if (running) return running;
  const attempt = (async (): Promise<TailscaleServeReceipt> => {
    const command = `tailscale serve --bg ${port}`;
    const detection = await detectTailscaleAsync(runner);
    if (!detection.available || !detection.loggedIn || !detection.httpsUrl) {
      return { at: Date.now(), command, ok: false, detail: detection.detail };
    }
    return serveReceipt(port, command, detection.httpsUrl, await runCommand(runner, 'tailscale', ['serve', '--bg', String(port)]));
  })().finally(() => { serveInFlight.delete(port); });
  serveInFlight.set(port, attempt);
  return attempt;
}

const MAX_RECEIPTS = 20;

/** Bounded on-disk receipt log for serve attempts (newest last). */
export class TailscaleServeReceiptStore {
  constructor(private readonly filePath: string) {}

  list(): TailscaleServeReceipt[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as { receipts?: TailscaleServeReceipt[] };
      return Array.isArray(parsed.receipts) ? parsed.receipts : [];
    } catch {
      return [];
    }
  }

  append(receipt: TailscaleServeReceipt): void {
    this.setAsideUnreadableLog();
    const receipts = [...this.list(), receipt].slice(-MAX_RECEIPTS);
    try {
      // Staged beside the log and renamed over it, so a crash mid-write leaves
      // the previous log intact instead of a torn file the next append would
      // overwrite.
      writeFileAtomic(this.filePath, JSON.stringify({ receipts }, null, 2), { durable: false });
    } catch (error) {
      logger.warn('TailscaleServeReceiptStore: flush failed', { path: this.filePath, error: String(error) });
    }
  }

  /** A log that exists but cannot be read is kept as `.corrupt` rather than silently replaced by the next append. */
  private setAsideUnreadableLog(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, 'utf-8')) as { receipts?: unknown };
      if (Array.isArray(parsed.receipts)) return;
    } catch {
      // fall through to set the file aside
    }
    try {
      renameSync(this.filePath, `${this.filePath}.corrupt`);
    } catch (error) {
      logger.warn('TailscaleServeReceiptStore: could not set aside an unreadable log', { path: this.filePath, error: String(error) });
    }
  }

  latest(): TailscaleServeReceipt | null {
    const receipts = this.list();
    return receipts[receipts.length - 1] ?? null;
  }
}
