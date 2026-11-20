/**
 * remote-access/tailscale.ts
 *
 * Tailscale as the recommended path to https without the daemon ever minting a
 * certificate (self-provisioned CAs are ruled out; `tailscale serve` terminates
 * TLS with tailscale's own certificates, which is tailscale's business, never
 * the daemon's).
 *
 * Operations, split by side effect:
 *  - `detectTailscale` is STRICTLY READ-ONLY: is the binary present, is the
 *    node logged in, what is the MagicDNS name. It never invokes a
 *    state-changing tailscale command. Where tailscale is absent, the result
 *    says so once and nothing nags.
 *  - `enableTailscaleServe` starts publishing (`tailscale serve --bg <port>`)
 *    and `disableTailscaleServeAsync` stops it (`tailscale serve --https=443
 *    off`). Both run only from explicit user-initiated verbs and are recorded
 *    with an honest receipt either way. tailscaled keeps a started serve after
 *    the daemon stops, so stopping is a verb of its own, not a shutdown step.
 *
 * The command runner is injectable so tests never touch a real tailscale.
 */
import { spawn, spawnSync } from 'node:child_process';
import { readDocument, writeDocument } from '../utils/atomic-json-store.js';

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

/** Longest stretch of a command's own output carried into a receipt. */
const MAX_OUTPUT_IN_DETAIL = 600;

/** What the command printed, stderr first, bounded for a receipt. */
function capturedOutput(result: TailscaleCommandResult): string {
  const text = [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join('\n');
  return text.length > MAX_OUTPUT_IN_DETAIL ? `${text.slice(0, MAX_OUTPUT_IN_DETAIL)}...` : text;
}

/**
 * The first https link a command printed. On a tailnet where Serve or HTTPS is
 * off, `tailscale serve` prints the admin link that turns it on and then waits,
 * so the link is the user's next step even when the command timed out.
 */
function printedLink(result: TailscaleCommandResult): string | undefined {
  return /https:\/\/[^\s"'<>]+/.exec(`${result.stdout}\n${result.stderr}`)?.[0];
}

/** Why a tailscale command produced no exit status, from its errno code, with what it printed before it stopped. */
function notRunDetail(result: TailscaleCommandResult): string {
  if (result.errorCode === 'ENOENT') return 'tailscale binary not found';
  if (result.errorCode === 'ETIMEDOUT') {
    const printed = capturedOutput(result);
    return `tailscale did not answer within ${COMMAND_TIMEOUT_MS / 1000} seconds${printed ? `; it printed: ${printed}` : ''}`;
  }
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

/** The honest record of one serve or stop attempt, persisted either way. */
export interface TailscaleServeReceipt {
  readonly at: number;
  /** What was attempted. Receipts written before stopping existed carry no action and were serves. */
  readonly action?: 'serve' | 'stop' | undefined;
  readonly command: string;
  readonly ok: boolean;
  /** The https MagicDNS URL: now fronting the daemon after a serve, no longer fronting it after a stop. */
  readonly url?: string | undefined;
  /** The local port a serve fronts. */
  readonly port?: number | undefined;
  /** The web.publicBaseUrl a successful serve replaced; a stop puts it back. */
  readonly previousPublicBaseUrl?: string | undefined;
  /** A link tailscale printed for the user to act on, such as the page that turns Serve on for the tailnet. */
  readonly enableUrl?: string | undefined;
  readonly detail: string;
}

/** The command that stops what `tailscale serve --bg <port>` started: the https:443 handler it installs. */
export const TAILSCALE_SERVE_STOP_ARGS: readonly string[] = ['serve', '--https=443', 'off'];

function serveCommand(port: number): string {
  return `tailscale serve --bg ${port}`;
}

/**
 * Run `tailscale serve --bg <port>`, invoked only from the explicit
 * user-initiated verb. Returns an honest receipt either way; the caller
 * persists it and updates web.publicBaseUrl on success.
 */
export function enableTailscaleServe(
  port: number,
  runner: TailscaleCommandRunner = defaultTailscaleRunner(),
): TailscaleServeReceipt {
  const detection = detectTailscale(runner);
  if (!detection.available || !detection.loggedIn || !detection.httpsUrl) {
    return { at: Date.now(), action: 'serve', command: serveCommand(port), ok: false, port, detail: detection.detail };
  }
  return serveReceipt(port, detection.httpsUrl, runner.run('tailscale', ['serve', '--bg', String(port)]));
}

function failedReceipt(base: Omit<TailscaleServeReceipt, 'at' | 'ok' | 'detail'>, result: TailscaleCommandResult, fallback: string): TailscaleServeReceipt {
  const detail = result.status === null ? notRunDetail(result) : (capturedOutput(result) || fallback);
  const enableUrl = printedLink(result);
  return { at: Date.now(), ...base, ok: false, detail, ...(enableUrl ? { enableUrl } : {}) };
}

function serveReceipt(port: number, httpsUrl: string, result: TailscaleCommandResult): TailscaleServeReceipt {
  const base = { action: 'serve' as const, command: serveCommand(port), port };
  if (result.status !== 0) return failedReceipt(base, result, 'tailscale serve failed');
  return {
    at: Date.now(),
    ...base,
    ok: true,
    url: httpsUrl,
    detail: `tailscale serve is fronting port ${port} at ${httpsUrl}. tailscale keeps it on, also after the daemon stops or restarts, until it is stopped with tailscale.serve.stop`,
  };
}

/** Serve and stop attempts running now: a second request for the same thing waits for the first and shares its receipt. */
const inFlight = new Map<string, Promise<TailscaleServeReceipt>>();

function shared(key: string, attempt: () => Promise<TailscaleServeReceipt>): Promise<TailscaleServeReceipt> {
  const running = inFlight.get(key);
  if (running) return running;
  const started = attempt().finally(() => { inFlight.delete(key); });
  inFlight.set(key, started);
  return started;
}

/**
 * {@link enableTailscaleServe} without blocking the thread while tailscale
 * answers. Calls for the same port made while one is running (a double click,
 * two surfaces) share that one run, so `tailscale serve` is started once.
 */
export function enableTailscaleServeAsync(
  port: number,
  runner: TailscaleCommandRunner = defaultTailscaleRunner(),
): Promise<TailscaleServeReceipt> {
  return shared(`serve:${port}`, async () => {
    const detection = await detectTailscaleAsync(runner);
    if (!detection.available || !detection.loggedIn || !detection.httpsUrl) {
      return { at: Date.now(), action: 'serve', command: serveCommand(port), ok: false, port, detail: detection.detail };
    }
    return serveReceipt(port, detection.httpsUrl, await runCommand(runner, 'tailscale', ['serve', '--bg', String(port)]));
  });
}

/**
 * Stop publishing the daemon to the tailnet: `tailscale serve --https=443 off`
 * removes the handler `tailscale serve --bg <port>` installed, whatever port it
 * fronted. `url` is the address being withdrawn, for the receipt. Concurrent
 * calls share one run.
 */
export function disableTailscaleServeAsync(
  url: string | undefined,
  runner: TailscaleCommandRunner = defaultTailscaleRunner(),
): Promise<TailscaleServeReceipt> {
  return shared('stop', async () => {
    const base = { action: 'stop' as const, command: `tailscale ${TAILSCALE_SERVE_STOP_ARGS.join(' ')}`, ...(url ? { url } : {}) };
    const result = await runCommand(runner, 'tailscale', TAILSCALE_SERVE_STOP_ARGS);
    if (result.status !== 0) return failedReceipt(base, result, 'tailscale serve could not be stopped');
    return {
      at: Date.now(),
      ...base,
      ok: true,
      detail: url ? `tailscale serve is stopped; ${url} no longer reaches this daemon` : 'tailscale serve is stopped for https port 443',
    };
  });
}

const MAX_RECEIPTS = 20;

function isReceipt(value: unknown): value is TailscaleServeReceipt {
  if (typeof value !== 'object' || value === null) return false;
  const r = value as Record<string, unknown>;
  return typeof r.at === 'number' && typeof r.command === 'string' && typeof r.ok === 'boolean' && typeof r.detail === 'string';
}

/**
 * Bounded receipt log for serve and stop attempts (newest last). The document
 * is read once, on first use, and held in memory; each append is one write and
 * one rename. A file that cannot be read is moved aside by the shared document
 * reader rather than replaced by the next append, because these receipts are
 * the only record of what was published to the tailnet.
 */
/** The receipt store this daemon records its serves in, so the browser origin rule can read the tailnet address it set up. */
let daemonServeReceipts: TailscaleServeReceiptStore | null = null;

/**
 * The https origin `tailscale serve` is fronting this daemon at, from the newest
 * successful serve on record that has not been stopped, or null. One in-memory read.
 */
export function activeTailscaleServeOrigin(): string | null {
  const url = daemonServeReceipts?.active()?.url;
  if (!url) return null;
  try { return new URL(url).origin; } catch { return null; }
}

export class TailscaleServeReceiptStore {
  private receipts: readonly TailscaleServeReceipt[] | undefined;

  constructor(private readonly filePath: string) {
    daemonServeReceipts = this;
  }

  list(): TailscaleServeReceipt[] {
    this.receipts ??= readDocument(this.filePath, {
      label: 'tailscale/serve-receipts',
      recovery: 'The tailscale serve receipt history starts empty; a serve that is still on can be stopped with tailscale.serve.stop.',
      validate: (parsed) => {
        const receipts = (parsed as { receipts?: unknown } | null)?.receipts;
        if (!Array.isArray(receipts)) throw new Error('receipts is not a list');
        return receipts.filter(isReceipt);
      },
    }) ?? [];
    return [...this.receipts];
  }

  /** Persist a receipt. Throws when it could not be written; the caller reports that. */
  append(receipt: TailscaleServeReceipt): void {
    const next = [...this.list(), receipt].slice(-MAX_RECEIPTS);
    writeDocument(this.filePath, { receipts: next });
    this.receipts = next;
  }

  latest(): TailscaleServeReceipt | null {
    const receipts = this.list();
    return receipts[receipts.length - 1] ?? null;
  }

  /** The serve the daemon last started and has not since stopped, from the newest successful receipt. */
  active(): TailscaleServeReceipt | null {
    const receipts = this.list();
    for (let i = receipts.length - 1; i >= 0; i--) {
      const receipt = receipts[i]!;
      if (!receipt.ok) continue;
      return (receipt.action ?? 'serve') === 'serve' ? receipt : null;
    }
    return null;
  }
}
