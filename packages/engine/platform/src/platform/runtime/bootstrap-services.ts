import type { HookDispatcher } from '../hooks/dispatcher.js';
import type { RuntimeServices } from './services.js';
import { ConfigurationError } from '@goodvibes-jev/engine/errors';
import { logger } from '../utils/logger.js';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { DAEMON_CHALLENGE_HEADER, DAEMON_PROOF_HEADER, isValidDaemonIdentityProof } from '../daemon/identity-proof.js';
import { summarizeError } from '../utils/error-display.js';
import { createTimeoutController } from '../utils/fetch-with-timeout.js';
import { VERSION } from '../version.js';
import { isDaemonVersionCompatible, describeVersionIncompatibility } from './daemon-version-compat.js';
import { resolveDaemonEnabled } from '../config/index.js';
import type { DaemonOrigin } from '../config/control-plane-base-url.js';
import {
  classifyDaemonProbe,
  decideDaemonAdoption,
  type DaemonIdentityProbeResult,
} from './daemon-adoption-policy.js';

interface HttpListenerService {
  enable(config: { httpListener: boolean }, token?: string): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

interface ServiceFactories {
  /**
   * Injectable HTTP-listener constructor. There is no default: the listener
   * class lives in the daemon product's composition surface, and a client host
   * does not reach into it. With `danger.httpListener` enabled and no factory
   * here, the listener reports `unavailable` with that reason rather than
   * silently appearing to be off.
   */
  createHttpListener?: (
    hookDispatcher: HookDispatcher,
    userAuth: RuntimeServices['localUserAuthManager'],
    configManager: RuntimeServices['configManager'],
  ) => HttpListenerService;
  startupTimeoutMs?: number | undefined;
  probeDaemonPortInUse?: ((host: string, port: number) => Promise<boolean>) | undefined;
  probeDaemonIdentity?: (
    host: string,
    port: number,
    token?: string,
    scheme?: 'http' | 'https',
  ) => Promise<DaemonIdentityProbeResult>;
  /**
   * The daemon this surface was pointed at (`readConnectedDaemonOrigin`). When
   * set, discovery probes it instead of `controlPlane.host`/`controlPlane.port`,
   * which then describe only how a local daemon would bind.
   */
  daemonTarget?: Pick<DaemonOrigin, 'scheme' | 'host' | 'port'> | null | undefined;
  probeHttpListenerPortInUse?: ((host: string, port: number) => Promise<boolean>) | undefined;
  /**
   * Shared bearer token sent to the daemon's identity probe once the daemon has
   * proved it holds the same token (see probeGoodVibesDaemonIdentity).
   */
  sharedDaemonToken?: string | undefined;
  /**
   * Shared bearer token for the HTTP listener (webhook-style surfaces).
   * Independent from `sharedDaemonToken`; different surfaces may issue
   * different tokens, or both may share the same bearer.
   */
  sharedHttpListenerToken?: string | undefined;
  /**
   * This surface's own platform version, used to band-check a daemon found on the
   * configured port before adopting it. Defaults to the platform `VERSION`. Injected
   * mainly so tests can drive the compatibility gate deterministically.
   */
  localDaemonVersion?: string | undefined;
  /**
   * Override for the version-compatibility predicate. Defaults to the shared
   * `isDaemonVersionCompatible` band policy. Tests inject a stub to exercise the
   * incompatible-adoption refusal without constructing skewed daemons.
   */
  isDaemonVersionCompatible?: ((localVersion: string, remoteVersion: string | undefined) => boolean) | undefined;
}

export type HostServiceMode = 'disabled' | 'embedded' | 'external' | 'blocked' | 'incompatible' | 'unavailable';

export interface HostServiceStatus {
  readonly mode: HostServiceMode;
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly reason?: string | undefined;
  readonly status?: string | undefined;
  readonly version?: string | undefined;
  readonly authenticated?: boolean | undefined;
}

/** What a host started: the daemon it adopted (never one it runs) and the optional HTTP listener. Recent control-plane events are the daemon's (`GET /api/control-plane/recent-events`). */
export interface HostServicesHandle {
  readonly httpListener: HttpListenerService | null;
  readonly daemonStatus: HostServiceStatus;
  readonly httpListenerStatus: HostServiceStatus;
  stop(): Promise<void>;
}

export interface HostServicesConfig {
  get(
    key:
      | 'daemon.enabled'
      | 'danger.httpListener'
      | 'controlPlane.host'
      | 'controlPlane.port'
      | 'httpListener.host'
      | 'httpListener.port',
  ): boolean | string | number | undefined;
}
const DEFAULT_SERVICE_START_TIMEOUT_MS = 1500;
const TCP_PORT_PROBE_TIMEOUT_MS = 250;
const DAEMON_IDENTITY_PROBE_TIMEOUT_MS = 750;

interface StartableService {
  start(): Promise<void>;
  stop(): Promise<void>;
}

function readHostSetting(
  config: HostServicesConfig,
  key: 'controlPlane.host' | 'httpListener.host',
  fallback: string,
): string {
  const value = config.get(key);
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string') {
    throw new ConfigurationError(`Expected ${key} to be a host string, got ${typeof value}.`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new ConfigurationError(`Expected ${key} to be a non-empty host string.`);
  }
  return trimmed;
}

function readPortSetting(
  config: HostServicesConfig,
  key: 'controlPlane.port' | 'httpListener.port',
  fallback: number,
): number {
  const value = config.get(key);
  if (value === undefined || value === null) return fallback;
  const port = typeof value === 'number'
    ? value
    : typeof value === 'string' && value.trim() !== ''
      ? Number(value)
      : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigurationError(`Expected ${key} to be an integer TCP port between 1 and 65535.`);
  }
  return port;
}

function isBindConflictMessage(message: string): boolean {
  return message.includes('EADDRINUSE') || message.includes('Address already in use');
}

async function stopAfterFailedStart(label: string, service: StartableService): Promise<void> {
  try {
    await service.stop();
  } catch (error) {
    logger.warn(`${label} cleanup after failed startup failed`, { error: summarizeError(error) });
  }
}

async function startGuardedService<TService extends StartableService>(options: {
  readonly label: string;
  readonly service: TService;
  readonly timeoutMs: number;
  readonly startedStatus: () => HostServiceStatus;
  readonly timedOutStatus: () => HostServiceStatus;
  readonly bindConflictStatus: (message: string) => Promise<HostServiceStatus> | HostServiceStatus;
}): Promise<{ readonly service: TService | null; readonly status: HostServiceStatus }> {
  try {
    const result = await startWithTimeout(
      options.label,
      () => options.service.start(),
      options.timeoutMs,
      () => options.service.stop(),
    );
    if (result === 'timed_out') {
      return { service: null, status: options.timedOutStatus() };
    }
    return { service: options.service, status: options.startedStatus() };
  } catch (error) {
    const message = summarizeError(error);
    if (!isBindConflictMessage(message)) throw error;
    await stopAfterFailedStart(options.label, options.service);
    return { service: null, status: await options.bindConflictStatus(message) };
  }
}

async function isTcpPortInUse(host: string, port: number, timeoutMs = TCP_PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function normalizeProbeHost(host: string): string {
  if (host === '0.0.0.0' || host === '::') return '127.0.0.1';
  return host;
}

function formatBaseUrl(host: string, port: number, scheme: 'http' | 'https' = 'http'): string {
  const normalized = normalizeProbeHost(host);
  const urlHost = normalized.includes(':') && !normalized.startsWith('[') ? `[${normalized}]` : normalized;
  return `${scheme}://${urlHost}:${port}`;
}

function createServiceStatus(
  mode: HostServiceMode,
  host: string,
  port: number,
  details: Omit<HostServiceStatus, 'mode' | 'host' | 'port' | 'baseUrl'> = {},
  scheme: 'http' | 'https' = 'http',
): HostServiceStatus {
  return {
    mode,
    host,
    port,
    baseUrl: formatBaseUrl(host, port, scheme),
    ...details,
  };
}

async function probeGoodVibesDaemonIdentity(
  host: string,
  port: number,
  token?: string,
  scheme: 'http' | 'https' = 'http',
): Promise<DaemonIdentityProbeResult> {
  const url = `${formatBaseUrl(host, port, scheme)}/status`;
  const bearer = token?.trim();
  // Each request has its own timeout, kept until the body is read.
  const disposers: Array<() => void> = [];
  const challenge = randomBytes(16).toString('hex');
  const request = (withToken: boolean): Promise<Response> => {
    const { signal, dispose } = createTimeoutController(DAEMON_IDENTITY_PROBE_TIMEOUT_MS);
    disposers.push(dispose);
    const headers: Record<string, string> = { [DAEMON_CHALLENGE_HEADER]: challenge };
    if (withToken && bearer) headers.Authorization = `Bearer ${bearer}`;
    return fetch(url, { headers, signal });
  };
  try {
    // Whatever answers the port has not shown it is the daemon yet, so the token is not sent to it first.
    let response = await request(false);
    if (bearer) {
      // The daemon proves on every answer, whatever its status, that it holds the
      // token and listens on the port dialled here; anything else on the port never
      // receives the token, and a proof-less answer (a 200 included) is not the daemon.
      const proof = response.headers.get(DAEMON_PROOF_HEADER);
      if (!proof) {
        // A daemon started before proofs existed keeps running across a host upgrade; it cannot be told apart from a stranger, so the token stays unsent.
        return {
          kind: 'unauthorized',
          reason: `The configured token was not sent: whatever answers ${host}:${port} gave no identity proof, which a GoodVibes daemon started by an older version does not give either. If that is the daemon, stop it so this host can start a current one`,
        };
      }
      if (!isValidDaemonIdentityProof(bearer, challenge, proof, port)) {
        return {
          kind: 'unauthorized',
          reason: `The configured token was not sent: whatever answers ${host}:${port} did not prove it is the GoodVibes daemon listening there that holds it`,
        };
      }
      if (response.status === 401 || response.status === 403) response = await request(true);
    }
    if (response.status === 401 || response.status === 403) {
      return {
        kind: 'unauthorized',
        reason: bearer
          ? 'GoodVibes daemon identity probe was rejected by the configured token'
          : 'GoodVibes daemon identity probe needs an auth token',
      };
    }
    if (!response.ok) {
      return { kind: 'unknown', reason: `Identity probe returned HTTP ${response.status}` };
    }
    let body: { status?: unknown; version?: unknown; platformVersion?: unknown } | null = null;
    try {
      body = await response.json() as { status?: unknown; version?: unknown; platformVersion?: unknown };
    } catch (error) {
      return {
        kind: 'unknown',
        reason: `Identity probe response was not valid JSON: ${summarizeError(error)}`,
      };
    }
    if (body?.status === 'running' && typeof body.version === 'string') {
      return {
        kind: 'goodvibes',
        status: body.status,
        version: body.version,
        ...(typeof body.platformVersion === 'string' && body.platformVersion.trim()
          ? { platformVersion: body.platformVersion }
          : {}),
      };
    }
    return { kind: 'unknown', reason: 'Identity probe response did not match GoodVibes daemon status shape' };
  } catch (error) {
    return { kind: 'unknown', reason: summarizeError(error) };
  } finally {
    for (const dispose of disposers) dispose();
  }
}

async function startWithTimeout(
  label: string,
  start: () => Promise<void>,
  timeoutMs: number,
  cleanup?: () => Promise<void>,
): Promise<'started' | 'timed_out'> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const startPromise = start().then(() => 'started' as const);
  try {
    const result = await Promise.race([
      startPromise,
      new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (result === 'timed_out') {
      logger.warn(`${label} startup timed out; continuing without it in this host instance`, { timeoutMs });
      if (cleanup) {
        void cleanup().catch((error) => {
          logger.warn(`${label} cleanup after startup timeout failed`, { error: summarizeError(error) });
        });
        void startPromise.then(
          async () => {
            try {
              await cleanup();
            } catch (error) {
              logger.warn(`${label} delayed cleanup after startup timeout failed`, { error: summarizeError(error) });
            }
          },
          (error) => {
            logger.warn(`${label} startup rejected after timeout`, { error: summarizeError(error) });
          },
        );
      }
    }
    return result;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

/**
 * Find the daemon a client surface works with, and start the HTTP listener
 * when the setting asks for one and the caller can compose it.
 *
 * The daemon is its own product with its own binary and service unit: a host
 * adopts a compatible daemon already running on the configured host and port,
 * and otherwise reports why it did not (absent, blocked by another process, or
 * on an incompatible version). Starting an installed-but-stopped daemon is the
 * service manager's job (client/daemon-autostart.ts), not this function's.
 *
 * This module reaches `platform/daemon` neither statically nor dynamically. The
 * daemon's composition (DaemonServer, HttpListener) belongs to the
 * `goodvibes-daemon` product, which imports those classes directly in its own
 * entrypoint. A client that could reach them, even behind an `await import()`
 * never taken at runtime, drags the whole daemon graph into its bundle.
 */
export async function startHostServices(
  config: HostServicesConfig,
  hookDispatcher: HookDispatcher,
  runtimeServices: RuntimeServices,
  factories: ServiceFactories = {},
): Promise<HostServicesHandle> {
  const sharedUserAuth = runtimeServices.localUserAuthManager;
  const startupTimeoutMs = factories.startupTimeoutMs ?? DEFAULT_SERVICE_START_TIMEOUT_MS;
  // A surface pointed at a daemon elsewhere looks there; otherwise at the local bind.
  const daemonTarget = factories.daemonTarget ?? null;
  const daemonHost = daemonTarget?.host ?? readHostSetting(config, 'controlPlane.host', '127.0.0.1');
  const daemonPort = daemonTarget?.port ?? readPortSetting(config, 'controlPlane.port', 3421);
  const daemonScheme = daemonTarget?.scheme ?? 'http';
  const daemonServiceStatus = (
    mode: HostServiceMode,
    details: Omit<HostServiceStatus, 'mode' | 'host' | 'port' | 'baseUrl'> = {},
  ): HostServiceStatus => createServiceStatus(mode, daemonHost, daemonPort, details, daemonScheme);
  const httpListenerHost = readHostSetting(config, 'httpListener.host', '127.0.0.1');
  const httpListenerPort = readPortSetting(config, 'httpListener.port', 3422);
  const probeDaemonPortInUse = factories.probeDaemonPortInUse ?? ((host: string, port: number) => isTcpPortInUse(host, port));
  const probeDaemonIdentity = factories.probeDaemonIdentity ?? probeGoodVibesDaemonIdentity;
  const probeHttpListenerPortInUse = factories.probeHttpListenerPortInUse ?? ((host: string, port: number) => isTcpPortInUse(host, port));
  const localDaemonVersion = factories.localDaemonVersion ?? VERSION;
  const versionCompatible = factories.isDaemonVersionCompatible ?? isDaemonVersionCompatible;
  // The config schema owns the setting's type; only an explicit true starts a listener.
  const httpListenerEnabled = config.get('danger.httpListener') === true;

  let embeddedHttpListener: HttpListenerService | null = null;
  let daemonStatus = daemonServiceStatus('disabled', { reason: 'daemon.enabled is false' });
  let httpListenerStatus = createServiceStatus('disabled', httpListenerHost, httpListenerPort, {
    reason: 'danger.httpListener is disabled',
  });

  if (resolveDaemonEnabled(config)) {
    // The one adopt decision (daemon-adoption-policy.ts): probe the port and the
    // identity, then map the ruling onto a status. The version band-check is
    // inside the policy and is applied before any adopt.
    const portInUse = await probeDaemonPortInUse(daemonHost, daemonPort);
    const identity = portInUse
      ? await probeDaemonIdentity(daemonHost, daemonPort, factories.sharedDaemonToken, daemonScheme)
      : null;
    const decision = decideDaemonAdoption({
      enabled: true,
      portInUse,
      identity,
      localVersion: localDaemonVersion,
      versionCompatible,
    });
    switch (decision.action) {
      case 'adopt':
      case 'incompatible': {
        const found = decision.identity!;
        // With a token configured the probe adopts only a daemon that proved it holds it; without one nothing was proven.
        const authenticated = Boolean(factories.sharedDaemonToken?.trim());
        if (classifyDaemonProbe({ identity: found, localVersion: localDaemonVersion, versionCompatible }) === 'adopt') {
          daemonStatus = daemonServiceStatus('external', {
            authenticated,
            status: found.status,
            version: found.version,
            reason: authenticated
              ? 'Existing GoodVibes daemon verified on configured host/port'
              : 'A GoodVibes daemon answers on the configured host/port; with no operator token configured its identity was not proven',
          });
          logger.info('Existing GoodVibes daemon detected; using it', { host: daemonHost, port: daemonPort, version: found.version });
        } else {
          logger.warn('Daemon on configured port reports an incompatible version; not adopting it', {
            host: daemonHost,
            port: daemonPort,
            foundVersion: found.version,
            localVersion: localDaemonVersion,
          });
          daemonStatus = daemonServiceStatus('incompatible', {
            authenticated,
            status: found.status,
            version: found.version,
            reason: describeVersionIncompatibility(daemonHost, daemonPort, localDaemonVersion, found.platformVersion ?? found.version),
          });
        }
        break;
      }
      case 'blocked': {
        daemonStatus = daemonServiceStatus('blocked', {
          authenticated: decision.identity?.kind !== 'unauthorized' ? undefined : false,
          reason: decision.identity?.reason ?? 'Configured daemon port is occupied by an unverified process',
        });
        logger.warn('Daemon port is in use by an unverified process; running without a daemon in this host instance',
          { host: daemonHost, port: daemonPort, reason: decision.identity?.reason });
        break;
      }
      case 'absent': {
        daemonStatus = daemonServiceStatus('unavailable', {
          reason: 'No GoodVibes daemon is running on the configured host/port; install and start it with: goodvibes-daemon install-service',
        });
        logger.info('No daemon reachable on the configured host/port; running without a daemon', { host: daemonHost, port: daemonPort });
        break;
      }
      case 'disabled':
        break;
    }
  }

  if (httpListenerEnabled) {
    if (await probeHttpListenerPortInUse(httpListenerHost, httpListenerPort)) {
      httpListenerStatus = createServiceStatus('blocked', httpListenerHost, httpListenerPort, {
        reason: 'Configured HTTP listener port is already in use',
      });
      logger.warn('HTTP listener port already in use; continuing without local listener in this host instance', {
        host: httpListenerHost,
        port: httpListenerPort,
      });
    } else if (!factories.createHttpListener) {
      // Enabled, port free, and nothing to build it with. The HttpListener class
      // is part of the daemon product's composition, not this host's, so say that
      // instead of returning a 'disabled' status the setting contradicts.
      httpListenerStatus = createServiceStatus('unavailable', httpListenerHost, httpListenerPort, {
        reason: 'The HTTP listener is composed by the daemon product (goodvibes-daemon); this host does not compose one',
      });
      logger.warn(
        'danger.httpListener is enabled but this host does not compose an HTTP listener; it is composed by the daemon product (goodvibes-daemon)',
        { host: httpListenerHost, port: httpListenerPort },
      );
    } else {
      const service = factories.createHttpListener(hookDispatcher, sharedUserAuth, runtimeServices.configManager);
      service.enable({ httpListener: true }, factories.sharedHttpListenerToken);
      const started = await startGuardedService({
        label: 'HTTP listener',
        service,
        timeoutMs: startupTimeoutMs,
        timedOutStatus: () => createServiceStatus('unavailable', httpListenerHost, httpListenerPort, {
          reason: 'HTTP listener startup timed out',
        }),
        startedStatus: () => createServiceStatus('embedded', httpListenerHost, httpListenerPort, {
          reason: 'Embedded HTTP listener started in this host instance',
        }),
        bindConflictStatus: (message) => {
          logger.warn('HTTP listener port already in use; continuing without local listener in this host instance', { error: message });
          return createServiceStatus('blocked', httpListenerHost, httpListenerPort, { reason: message });
        },
      });
      embeddedHttpListener = started.service;
      httpListenerStatus = started.status;
    }
  }

  return {
    httpListener: embeddedHttpListener,
    daemonStatus,
    httpListenerStatus,
    async stop(): Promise<void> {
      // allSettled, as before: a listener that fails to stop must not turn
      // shutdown into a rejection the caller has to catch.
      await Promise.allSettled([embeddedHttpListener?.stop()]);
    },
  };
}
