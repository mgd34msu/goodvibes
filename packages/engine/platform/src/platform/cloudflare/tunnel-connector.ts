import { revealOrNull } from '../security/secret.js';
import { spawn } from 'node:child_process';
import { accessSync, constants as fsConstants } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { ConfigManager } from '../config/manager.js';
import type { SecretsManager } from '../config/secrets.js';
import { unreadableSecretStore, type StoredSecretReader } from '../config/secret-store-unreadable.js';
import { summarizeError } from '../utils/error-display.js';
import { logger } from '../utils/logger.js';
import { readCloudflareConfig } from './config.js';
import { CLOUDFLARE_TUNNEL_TOKEN_KEY } from './constants.js';
import { resolveSecretRef } from './cloudflare-token-resolvers.js';
import { FenceIssuer } from '../utils/owner-fence.js';
import { OwnedScope, NOTHING_RUNNING, type CloseReport } from '../utils/owned-work.js';

export type CloudflareTunnelConnectorState =
  | 'not-configured'
  | 'not-installed'
  | 'starting'
  | 'connected'
  | 'failed'
  | 'stopped';

export interface CloudflareTunnelConnectorStatus {
  readonly state: CloudflareTunnelConnectorState;
  readonly tunnelId?: string | undefined;
  /** What the state means right now, in a sentence. */
  readonly detail: string;
  /** Times the connector was started again after it exited. */
  readonly restarts: number;
  readonly since: number;
  /** What a person or agent can do about a state that is not `connected`. */
  readonly next?: readonly string[] | undefined;
}

/** The part of a child process the supervisor uses. */
export interface TunnelConnectorProcess {
  readonly pid?: number | undefined;
  readonly stderr: NodeJS.ReadableStream | null;
  kill(signal?: NodeJS.Signals): boolean;
  on(event: 'exit', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: 'error', listener: (error: Error) => void): unknown;
}

export interface CloudflareTunnelConnectorOptions {
  /** `subscribe`, when present, lets {@link CloudflareTunnelConnector.start} follow the tunnel settings. */
  readonly configManager: Pick<ConfigManager, 'get'> & Partial<Pick<ConfigManager, 'subscribe'>>;
  readonly secretsManager?: (Pick<SecretsManager, 'get' | 'getGlobalHome'> & StoredSecretReader) | null | undefined;
  /** Path of the cloudflared binary; found on PATH when absent. */
  readonly binary?: string | undefined;
  readonly spawnConnector?: ((binary: string, args: readonly string[], env: NodeJS.ProcessEnv) => TunnelConnectorProcess) | undefined;
  readonly findBinary?: (() => string | null) | undefined;
}

/** Owned by the daemon: start, stop and observe the connector. */
export interface CloudflareTunnelConnectorHandle {
  status(): CloudflareTunnelConnectorStatus;
  /** Bring the connector in line with the settings; `force` runs it even while the integration is still off (during provisioning). */
  reconcile(options?: { readonly force?: boolean }): Promise<CloudflareTunnelConnectorStatus>;
  waitUntilSettled(timeoutMs: number): Promise<CloudflareTunnelConnectorStatus>;
  /** Resolves once the connector's child exited; the report names one whose exit was not seen. */
  stop(): Promise<CloseReport | void>;
}

const CONNECTED_LINE = /Registered tunnel connection/i;
const ERROR_LINE = /\b(ERR|error|failed)\b/i;
const MAX_BACKOFF_MS = 60_000;
const INSTALL_URL = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/';

function findOnPath(name: string): string | null {
  const exe = process.platform === 'win32' ? `${name}.exe` : name;
  for (const dir of (process.env['PATH'] ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, exe);
    try {
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // not in this directory
    }
  }
  return null;
}

/**
 * Supervises `cloudflared tunnel run` for the tunnel provisioning created. The
 * token goes to the child in TUNNEL_TOKEN, never on the command line, so it is
 * not visible in a process listing. One child process; nothing per request.
 */
export class CloudflareTunnelConnector implements CloudflareTunnelConnectorHandle {
  private child: TunnelConnectorProcess | null = null;
  /** Owns the current child until its exit is observed: SIGTERM, 5 s, SIGKILL, 2 s. */
  private childScope: OwnedScope | null = null;
  /** Retired by dispose(): a reconcile still resolving its token then starts nothing. */
  readonly #lifetime = new FenceIssuer('cloudflare tunnel connector');
  private running: { readonly tunnelId: string; readonly token: string } | null = null;
  private current: CloudflareTunnelConnectorStatus = { state: 'not-configured', detail: 'No Cloudflare Tunnel is provisioned.', restarts: 0, since: Date.now() };
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private failuresSinceConnected = 0;
  private stopping = false;
  private readonly waiters = new Set<() => void>();
  /** Reconciles run one at a time, so a settings change and a provision cannot start two children. */
  private reconciling: Promise<unknown> = Promise.resolve();
  private unsubscribers: Array<() => void> = [];

  constructor(private readonly options: CloudflareTunnelConnectorOptions) {}

  status(): CloudflareTunnelConnectorStatus {
    return this.current;
  }

  /**
   * The daemon's entry point: bring the connector in line with the settings
   * now, and again whenever `cloudflare.enabled`, `cloudflare.tunnelId` or
   * `cloudflare.tunnelTokenRef` changes. Idempotent.
   */
  start(): void {
    if (this.unsubscribers.length === 0 && this.options.configManager.subscribe) {
      const subscribe = this.options.configManager.subscribe.bind(this.options.configManager);
      const follow = (): void => { this.reconcileInBackground(); };
      this.unsubscribers = [
        subscribe('cloudflare.enabled', follow),
        subscribe('cloudflare.tunnelId', follow),
        subscribe('cloudflare.tunnelTokenRef', follow),
      ];
    }
    this.reconcileInBackground();
  }

  /**
   * Stops following the settings and stops the connector; for daemon shutdown.
   * Waits for a reconcile in flight (which then starts nothing) before the
   * stop, so no child can be launched after it. Resolves with the stop report.
   */
  async dispose(): Promise<CloseReport> {
    this.#lifetime.retire('the daemon is stopping');
    for (const unsubscribe of this.unsubscribers) unsubscribe();
    this.unsubscribers = [];
    await this.reconciling;
    return this.stop();
  }

  private reconcileInBackground(): void {
    void this.reconcile().catch((error: unknown) => {
      logger.warn('cloudflare tunnel: the connector could not be brought in line with the settings', { error: summarizeError(error) });
    });
  }

  reconcile(options: { readonly force?: boolean } = {}): Promise<CloudflareTunnelConnectorStatus> {
    const run = this.reconciling.then(() => this.reconcileNow(options), () => this.reconcileNow(options));
    this.reconciling = run.catch(() => undefined);
    return run;
  }

  private async reconcileNow(options: { readonly force?: boolean }): Promise<CloudflareTunnelConnectorStatus> {
    const fence = this.#lifetime.peek();
    if (!fence.current) return this.current;
    const config = readCloudflareConfig(this.options.configManager);
    if (!config.tunnelId) {
      await this.stop();
      this.set({ state: 'not-configured', detail: 'No Cloudflare Tunnel is provisioned.' });
      return this.current;
    }
    if (!config.enabled && options.force !== true) {
      await this.stop();
      this.set({ state: 'stopped', tunnelId: config.tunnelId, detail: 'The Cloudflare integration is off, so the tunnel connector is not running.', next: ['Deploy from the Cloudflare tab of Devices and network to turn it on'] });
      return this.current;
    }
    const token = await this.resolveToken(config.tunnelTokenRef);
    // Disposed while the token was being read: start nothing.
    if (!fence.current) return this.current;
    // A secret store this computer could not read is not "no token": the token is not asked for again.
    const unreadable = token ? null : await unreadableSecretStore(this.options.secretsManager, CLOUDFLARE_TUNNEL_TOKEN_KEY, 'the Cloudflare Tunnel token');
    if (!fence.current) return this.current;
    if (unreadable) {
      await this.stop();
      this.set({ state: 'not-configured', tunnelId: config.tunnelId, detail: `${unreadable} The tunnel connector is not started until it can be read.` });
      return this.current;
    }
    if (!token) {
      await this.stop();
      this.set({
        state: 'not-configured',
        tunnelId: config.tunnelId,
        detail: `Tunnel ${config.tunnelId} is provisioned but no tunnel token is stored.`,
        next: [`Store the token as goodvibes://secrets/goodvibes/${CLOUDFLARE_TUNNEL_TOKEN_KEY} (or set cloudflare.tunnelTokenRef), or deploy again from the Cloudflare tab of Devices and network`],
      });
      return this.current;
    }
    if (this.running && this.running.tunnelId === config.tunnelId && this.running.token === token && this.child) return this.current;
    await this.stop();
    const binary = this.options.binary ?? (this.options.findBinary ?? (() => findOnPath('cloudflared')))();
    if (!binary) {
      this.set({
        state: 'not-installed',
        tunnelId: config.tunnelId,
        detail: 'cloudflared is not installed, so nothing connects the tunnel and the daemon hostname does not reach this daemon.',
        next: [`Install cloudflared (${INSTALL_URL}), then deploy again from the Cloudflare tab of Devices and network, or restart the daemon`],
      });
      return this.current;
    }
    if (!fence.current) return this.current;
    this.running = { tunnelId: config.tunnelId, token };
    this.stopping = false;
    this.failuresSinceConnected = 0;
    this.launch(binary);
    return this.current;
  }

  waitUntilSettled(timeoutMs: number): Promise<CloudflareTunnelConnectorStatus> {
    if (this.current.state !== 'starting') return Promise.resolve(this.current);
    return new Promise((resolve) => {
      const done = (): void => {
        if (this.current.state === 'starting') return;
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve(this.current);
      };
      const timer = setTimeout(() => {
        this.waiters.delete(done);
        resolve(this.current);
      }, timeoutMs);
      timer.unref?.();
      this.waiters.add(done);
    });
  }

  /**
   * Stops the connector: SIGTERM, 5 s, SIGKILL, 2 s. Reports `stopped` only
   * once the child's exit was observed; a child that outlives SIGKILL leaves
   * the state `failed`, naming its pid, and is named in the returned report.
   */
  async stop(): Promise<CloseReport> {
    this.stopping = true;
    const wasActive = this.running !== null;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    const scope = this.childScope;
    this.child = null;
    this.childScope = null;
    this.running = null;
    if (!child || !scope) {
      if (wasActive) this.set({ state: 'stopped', tunnelId: this.current.tunnelId, detail: 'The tunnel connector was stopped.' });
      return NOTHING_RUNNING;
    }
    const report = await scope.close('the tunnel connector was stopped');
    if (report.stillRunning.length > 0) {
      this.set({
        state: 'failed',
        tunnelId: this.current.tunnelId,
        detail: `cloudflared${child.pid !== undefined ? ` (pid ${child.pid})` : ''} was told to stop and killed, but its exit was not seen; it may still be connecting the tunnel.`,
        next: [child.pid !== undefined ? `End it yourself: kill -9 ${child.pid}` : 'End the cloudflared process yourself'],
      });
      return report;
    }
    this.set({ state: 'stopped', tunnelId: this.current.tunnelId, detail: 'The tunnel connector was stopped.' });
    return report;
  }

  private async resolveToken(ref: string): Promise<string | null> {
    const ctx = { secretsManager: this.options.secretsManager, readConfig: () => readCloudflareConfig(this.options.configManager) };
    if (ref) {
      const fromRef = await resolveSecretRef(ctx, ref);
      if (fromRef.value) return fromRef.value;
    }
    try {
      return revealOrNull(await this.options.secretsManager?.get(CLOUDFLARE_TUNNEL_TOKEN_KEY), 'child-env');
    } catch (error: unknown) {
      logger.warn('cloudflare tunnel: stored token could not be read', { error: summarizeError(error) });
      return null;
    }
  }

  private launch(binary: string): void {
    const running = this.running;
    if (!running) return;
    this.set({ state: 'starting', tunnelId: running.tunnelId, detail: 'cloudflared is starting and has not registered a connection yet.' });
    const spawnConnector = this.options.spawnConnector ?? ((command, args, env) => spawn(command, [...args], { env, stdio: ['ignore', 'ignore', 'pipe'] }));
    let child: TunnelConnectorProcess;
    try {
      child = spawnConnector(binary, ['tunnel', '--no-autoupdate', 'run'], { ...process.env, TUNNEL_TOKEN: running.token });
    } catch (error: unknown) {
      this.onExit(binary, `could not start: ${summarizeError(error)}`);
      return;
    }
    this.child = child;
    const exited = new Promise<void>((resolve) => {
      child.on('exit', () => resolve());
      // A child that never started raises 'error' and no 'exit'.
      child.on('error', () => { if (child.pid === undefined) resolve(); });
    });
    const scope = new OwnedScope('cloudflare tunnel connector');
    scope.child('cloudflared', {
      pid: child.pid,
      kill: (signal) => { child.kill(signal === 'SIGKILL' || signal === 9 ? 'SIGKILL' : 'SIGTERM'); },
      exited,
    });
    this.childScope = scope;
    let lastError = '';
    let buffered = '';
    child.stderr?.on('data', (chunk: Buffer | string) => {
      buffered += chunk.toString();
      let newline = buffered.indexOf('\n');
      while (newline >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        newline = buffered.indexOf('\n');
        if (child !== this.child) continue;
        if (CONNECTED_LINE.test(line)) {
          this.failuresSinceConnected = 0;
          if (this.current.state !== 'connected') {
            this.set({ state: 'connected', tunnelId: running.tunnelId, detail: 'cloudflared registered a connection; the daemon hostname reaches this daemon.' });
          }
        } else if (ERROR_LINE.test(line)) {
          lastError = line.slice(0, 300);
        }
      }
    });
    child.on('error', (error: Error) => {
      if (child !== this.child) return;
      lastError = summarizeError(error);
      // A child that never started raises no 'exit': it is failed here and restarted on the backoff.
      if (child.pid !== undefined) return;
      this.child = null;
      this.childScope = null;
      if (this.stopping) return;
      this.onExit(binary, `could not start: ${lastError}`);
    });
    child.on('exit', (code, signal) => {
      if (child !== this.child) return;
      this.child = null;
      this.childScope = null;
      if (this.stopping) return;
      this.onExit(binary, `exited (${signal ?? `code ${code ?? 'unknown'}`})${lastError ? `: ${lastError}` : ''}`);
    });
  }

  private onExit(binary: string, reason: string): void {
    const running = this.running;
    if (!running) return;
    this.failuresSinceConnected += 1;
    const delayMs = Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(this.failuresSinceConnected - 1, 6));
    logger.warn('cloudflare tunnel: connector stopped; starting it again', { reason, delayMs });
    this.set({
      state: 'failed',
      tunnelId: running.tunnelId,
      detail: `cloudflared ${reason}. It is started again in ${Math.round(delayMs / 1000)} s.`,
      restarts: this.current.restarts + 1,
      next: ['Check the daemon log for cloudflared errors', 'If the tunnel was deleted in Cloudflare, deploy again from the Cloudflare tab of Devices and network'],
    });
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.running === running && !this.stopping) this.launch(binary);
    }, delayMs);
    this.restartTimer.unref?.();
  }

  private set(next: Omit<CloudflareTunnelConnectorStatus, 'since' | 'restarts'> & { readonly restarts?: number }): void {
    this.current = { restarts: this.current.restarts, ...next, since: Date.now() };
    for (const waiter of [...this.waiters]) waiter();
  }
}
