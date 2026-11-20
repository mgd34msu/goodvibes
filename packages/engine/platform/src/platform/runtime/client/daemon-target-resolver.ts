/**
 * daemon-target-resolver.ts, which daemon a client talks to and which
 * credential it presents there, decided by code in one place.
 *
 *   Origin chosen                     Credential used
 *   explicit URL + explicit token     the explicit token, bound to that origin
 *   explicit URL, no token            session token for that origin, else
 *   or daemon.connectedHost.url       GOODVIBES_CONNECTED_HOST_TOKEN, else the
 *                                     token stored for that origin, else the
 *                                     Agent's pairing with it, else this
 *                                     machine's daemon token ONLY IF the origin
 *                                     is one of this machine's daemon origins
 *   none (this machine)               GOODVIBES_DAEMON_TOKEN, else session for
 *                                     that origin, else the local operator token
 *
 * This machine's daemon origins are a loopback host, or an address of one of
 * this machine's interfaces, at the local `controlPlane.port`, plus the
 * declared `controlPlane.publicBaseUrl` and `web.publicBaseUrl`. A declared
 * public origin that is not loopback gets this machine's token only after it
 * answers the daemon identity challenge (daemon/identity-proof.ts) once per
 * process, kept in memory: {@link resolveDaemonTargetProven} makes that one
 * request (bounded by its timeout) and every path that would use the
 * credential waits for it; the synchronous {@link resolveDaemonTarget}
 * answers `pendingProof` with the origin until then, so a caller can hold its
 * request for the check instead of showing a refusal.
 *
 * `daemon.connectedHost.enabled` (may this surface dial a daemon at all) and
 * `daemon.enabled` (does this surface use the daemon on this machine) are read
 * here, so no caller can skip them. An explicit URL is the person's own
 * instruction for one call and is not subject to either.
 *
 * A refusal is a value: `{ ok: false, refusal }`, never a throw.
 */
import { randomBytes } from 'node:crypto';
import { refusal, type Refusal } from '@goodvibes/engine/errors';
import type { ConfigManager } from '../../config/manager.js';
import {
  deriveControlPlaneBaseUrl,
  parseDaemonOrigin,
  readConnectedDaemonOrigin,
  readControlPlaneBinding,
  type DaemonOrigin,
} from '../../config/control-plane-base-url.js';
import { resolveGoodVibesDaemonHome } from '../../config/goodvibes-home.js';
import { DAEMON_CHALLENGE_HEADER, verifyDaemonIdentityAnswer } from '../../daemon/identity-proof.js';
import { isThisMachine } from '../../daemon/http/listener-admission.js';
import { getOrCreateCompanionToken, readCompanionTokenValue } from '../../pairing/companion-token.js';
import { isLoopbackHost } from '../../utils/reachable-base-url.js';
import { readConnectedDaemonToken, readDaemonSessionToken } from './daemon-credentials.js';
import { bindCredential, daemonTarget, type BoundCredential, type DaemonTarget } from './daemon-target.js';

export type DaemonTargetResolution =
  | { readonly ok: true; readonly target: DaemonTarget }
  | {
      readonly ok: false;
      readonly refusal: Refusal;
      /**
       * Set when the only thing missing is the one identity check of this
       * machine's declared public address: the origin a caller may hold a
       * request for while {@link resolveDaemonTargetProven} makes the check.
       * Never sent anything; the credential is released only by that call.
       */
      readonly pendingProof?: DaemonOrigin | undefined;
    };

/** A config reader: the full ConfigManager, or any `get(key)`. */
type ConfigReader = Pick<ConfigManager, 'get'>;

export interface ResolveDaemonTargetInput {
  readonly configManager: ConfigReader;
  readonly homeDirectory: string | (() => string);
  /** What the person typed: --host/--daemon-url and --token. Explicit wins; nothing is inferred across origins. */
  readonly explicit?: { readonly url?: string | undefined; readonly token?: string | undefined } | undefined;
  /** `mint` creates this machine's token file when absent; `read-only` (the default) never writes. */
  readonly mode?: 'mint' | 'read-only' | undefined;
  /** The client named when minting this machine's token. Default `tui`. */
  readonly client?: string | undefined;
  /** The Agent's host-bound pairing token for an origin (terminal-shell's pairing store), or null. */
  readonly pairedToken?: ((origin: DaemonOrigin) => string | null) | undefined;
}

function refuse(code: string, reason: string, next: readonly string[], retryable = false): DaemonTargetResolution {
  return { ok: false, refusal: refusal({ code, state: 'nothing was sent', reason, next, retryable }) };
}

function envToken(name: 'GOODVIBES_DAEMON_TOKEN' | 'GOODVIBES_CONNECTED_HOST_TOKEN'): string | null {
  return process.env[name]?.trim() || null;
}

/** A host (no brackets, no port) that is this machine: a loopback name or an address of one of its interfaces. */
export function isThisMachineHost(host: string): boolean {
  // isThisMachine reads `unknown` and '' as an in-process caller; as a host name they are not this machine.
  return host.length > 0 && host !== 'unknown' && (isLoopbackHost(host) || isThisMachine(host));
}

/** Whether `origin` is one of this machine's daemon origins: `yes`, a declared public origin still to prove (`declared`), or `no`. */
export function classifyDaemonOrigin(origin: DaemonOrigin, configManager: ConfigReader): 'yes' | 'declared' | 'no' {
  const read = (key: string): unknown => configManager.get(key as never);
  const binding = readControlPlaneBinding(read);
  if (origin.port === binding.port && isThisMachineHost(origin.host)) return 'yes';
  for (const key of ['controlPlane.publicBaseUrl', 'web.publicBaseUrl']) {
    const declared = parseDaemonOrigin(read(key));
    if (declared?.baseUrl !== origin.baseUrl) continue;
    return isLoopbackHost(origin.host) ? 'yes' : 'declared';
  }
  return 'no';
}

/** Origins of this machine's token that answered the identity challenge in this process, by `origin#fingerprint`. */
const provenOrigins = new Set<string>();
const proving = new Map<string, Promise<boolean>>();

function provenKey(origin: DaemonOrigin, credential: BoundCredential): string {
  return `${origin.baseUrl}#${credential.fingerprint}`;
}

/**
 * The daemon origin the configuration names when nothing explicit was typed:
 * the connected host (`daemon.connectedHost.url`), else a declared
 * `controlPlane.publicBaseUrl`, else the address derived from the bind. Null
 * when none is usable. Says nothing about credentials or switches.
 */
export function configuredDaemonOrigin(configManager: ConfigReader): DaemonOrigin | null {
  return configuredOrigin(configManager).origin;
}

function configuredOrigin(configManager: ConfigReader): { readonly origin: DaemonOrigin | null; readonly connected: boolean } {
  const connected = readConnectedDaemonOrigin((key) => configManager.get(key));
  if (connected) return { origin: connected, connected: true };
  const binding = readControlPlaneBinding((key) => configManager.get(key as never));
  const declared = parseDaemonOrigin(binding.publicBaseUrl);
  if (declared) return { origin: declared, connected: false };
  return { origin: parseDaemonOrigin(deriveControlPlaneBaseUrl(binding, 'loopback')), connected: false };
}

function localDaemonToken(homeDirectory: string, mode: 'mint' | 'read-only', client: string): { readonly token: string | null; readonly error?: string } {
  const daemonHomeDir = resolveGoodVibesDaemonHome(homeDirectory);
  try {
    if (mode === 'mint') return { token: getOrCreateCompanionToken(client, { daemonHomeDir }).token };
    return { token: readCompanionTokenValue(daemonHomeDir) };
  } catch (error) {
    return mode === 'mint'
      ? { token: null, error: error instanceof Error ? error.message : String(error) }
      : { token: null };
  }
}

interface Resolved {
  readonly resolution: DaemonTargetResolution;
  /** Set when the only thing missing is the identity proof of this machine's declared public origin. */
  readonly proof?: { readonly origin: DaemonOrigin; readonly credential: BoundCredential } | undefined;
}

function resolve(input: ResolveDaemonTargetInput): Resolved {
  const { configManager } = input;
  if (typeof (configManager as { get?: unknown } | null)?.get !== 'function') {
    return { resolution: refuse('SERVICE_UNAVAILABLE', 'no config manager is wired here, so no daemon can be resolved', []) };
  }
  const explicitUrl = input.explicit?.url?.trim();
  const explicitToken = input.explicit?.token?.trim() || null;
  let origin: DaemonOrigin | null;
  let named: boolean;
  if (explicitUrl) {
    origin = parseDaemonOrigin(explicitUrl);
    if (!origin) {
      return { resolution: refuse('VALIDATION_FAILED', `'${explicitUrl}' is not a daemon address`, ['name the daemon as scheme://host:port, for example https://10.0.0.7:3421']) };
    }
    named = true;
  } else {
    if (configManager.get('daemon.connectedHost.enabled') === false) {
      return { resolution: refuse('SERVICE_UNAVAILABLE', 'this surface is set not to dial a daemon (daemon.connectedHost.enabled is false)', ['set daemon.connectedHost.enabled to true in /settings, then retry']) };
    }
    const configured = configuredOrigin(configManager);
    origin = configured.origin;
    named = configured.connected;
    if (!origin) {
      return { resolution: refuse('SERVICE_UNAVAILABLE', 'no daemon address is configured (daemon.connectedHost.url, controlPlane.publicBaseUrl or controlPlane.host and port)', ['set the daemon address in /setup, Network step']) };
    }
  }
  const place = classifyDaemonOrigin(origin, configManager);
  if (!named && place !== 'no' && configManager.get('daemon.enabled') === false) {
    return { resolution: refuse('SERVICE_UNAVAILABLE', 'the daemon on this machine is disabled (daemon.enabled is false)', ['enable it in /settings, then retry']) };
  }
  const homeDirectory = typeof input.homeDirectory === 'function' ? input.homeDirectory() : input.homeDirectory;
  const target = (credential: BoundCredential | null, proven = false): Resolved => ({ resolution: { ok: true, target: daemonTarget(origin!, credential, place === 'yes' || proven) } });

  if (explicitToken) return target(bindCredential(origin, explicitToken, 'explicit'));

  // This machine's daemon, chosen by configuration: the daemon's own override first, as the daemon reads it.
  const localOverride = !named && place !== 'no' ? envToken('GOODVIBES_DAEMON_TOKEN') : null;
  if (localOverride) return withLocalProof(origin, bindCredential(origin, localOverride, 'environment'), place, target);

  const session = readDaemonSessionToken(homeDirectory, origin.baseUrl);
  if (session) return target(bindCredential(origin, session, 'session'));

  if (named || place === 'no') {
    const connectedEnv = envToken('GOODVIBES_CONNECTED_HOST_TOKEN');
    if (connectedEnv && !explicitUrl) return target(bindCredential(origin, connectedEnv, 'environment'));
    const stored = readConnectedDaemonToken(homeDirectory, origin.baseUrl);
    if (stored) return target(bindCredential(origin, stored, 'connected'));
    const paired = input.pairedToken?.(origin) ?? null;
    if (paired) return target(bindCredential(origin, paired, 'pairing'));
    // The connected host never falls back to this machine's token; an explicit address of this machine does.
    if (place === 'no' || !explicitUrl) {
      return {
        resolution: refuse('CREDENTIAL_NOT_FOR_TARGET',
          `no credential is stored for ${origin.baseUrl}; this machine's daemon token is never sent to another daemon`,
          explicitUrl
            ? ['pass --token <token>', 'store it from /setup, Network step', 'pair with it: goodvibes-agent setup pair']
            : ['connect to it again from /setup, Network step, with its token', 'pair with it: goodvibes-agent setup pair']),
      };
    }
  }

  const local = localDaemonToken(homeDirectory, input.mode ?? 'read-only', input.client ?? 'tui');
  if (!local.token) {
    const where = resolveGoodVibesDaemonHome(homeDirectory);
    return {
      resolution: local.error !== undefined
        ? refuse('AUTH_REQUIRED', `the daemon's access token could not be read or created (${local.error})`, [`check that ${where} is writable, then retry`])
        : refuse('AUTH_REQUIRED', `no daemon access token exists yet in ${where}`, ['start the daemon or run any daemon command once, then retry']),
    };
  }
  return withLocalProof(origin, bindCredential(origin, local.token, 'local-daemon'), place, target);
}

/** This machine's token for a declared public origin: only once that origin proved it is this machine's daemon. */
function withLocalProof(origin: DaemonOrigin, credential: BoundCredential, place: 'yes' | 'declared' | 'no',
  target: (credential: BoundCredential, proven?: boolean) => Resolved): Resolved {
  if (place === 'yes') return target(credential);
  if (provenOrigins.has(provenKey(origin, credential))) return target(credential, true);
  return {
    resolution: refuse('CREDENTIAL_NOT_FOR_TARGET',
      `${origin.baseUrl} is declared as this machine's daemon address but has not yet proved it is; this machine's daemon token is sent there only after it does`,
      ['retry: the next daemon call makes the one identity check', `check that ${origin.baseUrl} reaches the daemon on this machine`], true),
    proof: { origin, credential },
  };
}

/**
 * The daemon a client talks to and the credential bound to it, or why not.
 * Synchronous and free of I/O beyond reading the credential records; a
 * declared public origin not yet proven is refused (see {@link resolveDaemonTargetProven}).
 */
export function resolveDaemonTarget(input: ResolveDaemonTargetInput): DaemonTargetResolution {
  const resolved = resolve(input);
  return resolved.proof && !resolved.resolution.ok ? { ...resolved.resolution, pendingProof: resolved.proof.origin } : resolved.resolution;
}

/**
 * Ask the daemon at `origin` to prove it holds `credential`'s token, without
 * sending the token: one request with a fresh challenge, answered with an HMAC
 * bound to the port dialled or a public address the daemon declares. Kept for
 * the process once it verifies; a concurrent second ask shares the first.
 */
export function proveDaemonOrigin(origin: DaemonOrigin, credential: BoundCredential, token: string,
  fetchImpl: typeof fetch = fetch, timeoutMs = 2_000): Promise<boolean> {
  const key = provenKey(origin, credential);
  if (provenOrigins.has(key)) return Promise.resolve(true);
  const pending = proving.get(key);
  if (pending) return pending;
  const challenge = randomBytes(16).toString('hex');
  const run = (async (): Promise<boolean> => {
    try {
      const response = await fetchImpl(`${origin.baseUrl}/status`, {
        method: 'GET',
        headers: { [DAEMON_CHALLENGE_HEADER]: challenge },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response.body?.cancel().catch(() => undefined);
      const verified = verifyDaemonIdentityAnswer(token, challenge, response.headers, { port: origin.port, scheme: origin.scheme });
      if (verified) provenOrigins.add(key);
      return verified;
    } catch {
      return false;
    } finally {
      proving.delete(key);
    }
  })();
  proving.set(key, run);
  return run;
}

/**
 * {@link resolveDaemonTarget}, and when the only thing missing is the identity
 * proof of this machine's declared public origin, make that one request and
 * resolve again. Costs nothing once the origin is proven in this process.
 */
export async function resolveDaemonTargetProven(input: ResolveDaemonTargetInput & { readonly fetch?: typeof fetch | undefined }): Promise<DaemonTargetResolution> {
  const first = resolve(input);
  if (first.resolution.ok || !first.proof) return first.resolution;
  const { origin, credential } = first.proof;
  const homeDirectory = typeof input.homeDirectory === 'function' ? input.homeDirectory() : input.homeDirectory;
  const token = credential.source === 'environment'
    ? envToken('GOODVIBES_DAEMON_TOKEN')
    : localDaemonToken(homeDirectory, 'read-only', input.client ?? 'tui').token;
  if (!token || !await proveDaemonOrigin(origin, credential, token, input.fetch ?? fetch)) {
    return refuse('CREDENTIAL_NOT_FOR_TARGET',
      `${origin.baseUrl} did not prove it is the daemon on this machine, so this machine's daemon token was not sent to it`,
      [`check that ${origin.baseUrl} reaches the daemon on this machine (controlPlane.publicBaseUrl, web.publicBaseUrl)`, 'or connect to it with its own token from /setup, Network step']);
  }
  return resolve(input).resolution;
}
