/**
 * cluster-remote-daemon-target.ts, how a `cluster` subcommand reaches a
 * daemon.
 *
 * Both a daemon's own CLI and a front-end's in-process `/cluster` command
 * must reach the same daemon the same way, so the resolution and request
 * convention live here rather than in either caller, neither a CLI
 * entrypoint nor an input-layer command imports the other's code.
 *
 * ── THE CONVENTION ────────────────────────────────────────────────────────
 *
 * This is the first daemon subcommand family that talks to a RUNNING daemon
 * rather than to systemd, so it establishes the pattern every later one
 * should follow. If you are adding `goodvibes-daemon <something>` that needs
 * the daemon itself, use this module rather than inventing a second way.
 *
 *   --host <name>   default: the control plane's configured host, which for a
 *                   default install is 127.0.0.1
 *   --port <n>      default: the control plane's configured port
 *   --token <t>     default: this machine's operator token, read from
 *                   <daemon home>/operator-tokens.json
 *
 * Authentication is `Authorization: Bearer <operator token>` against the
 * control plane, the same credential a TUI and a web UI already use.
 *
 * The defaults are the whole point. A homelab box is headless: the operator
 * has SSHed into it and wants `cluster status` to work with no flags at all.
 * Flags exist for the other case, driving a machine in the next room from a
 * laptop, and for scripting. A machine that is not this one is named with its
 * scheme (`--host https://10.0.0.7`): the operator token travels in every
 * request, and whether that machine speaks TLS is not something this machine's
 * own settings can say.
 *
 * What this module deliberately does NOT do: hold any knowledge of what the
 * verbs mean. It resolves a target, makes a request, and returns the parsed
 * body. Every decision about what the answer MEANS belongs to the daemon.
 */
import { readConnectedDaemonOrigin, readControlPlaneBinding } from '@goodvibes-jev/engine/platform/platform/config/control-plane-base-url';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { readOperatorTokenFile } from '@goodvibes-jev/engine/platform/platform/workspace/daemon-home';

/** Where to send a verb, and what to authenticate with. */
export interface RemoteDaemonTarget {
  readonly baseUrl: string;
  readonly token: string;
  /** True when the target is this machine's own daemon, for message wording. */
  readonly isLocal: boolean;
}

/** The flags every remote-capable daemon subcommand accepts. */
export interface RemoteTargetFlags {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly token?: string | undefined;
}

/**
 * Why a call to a daemon failed, as a closed list a script or an agent reads
 * instead of the wording, which is for people and may change.
 */
export const DAEMON_FAILURE_CODES = [
  'token-missing',
  'invalid-port',
  'invalid-host',
  'unreachable',
  'auth-refused',
  'route-missing',
  'unreadable-reply',
  /** The daemon answered and refused; its own `error` and `fix` are passed through. */
  'refused',
] as const;
export type DaemonFailureCode = (typeof DAEMON_FAILURE_CODES)[number];

/** A failed resolution or call: `code` for programs, `error` and `fix` for people. */
export interface DaemonFailure {
  readonly ok: false;
  readonly code: DaemonFailureCode;
  readonly error: string;
  readonly fix: string;
}

export type RemoteTargetResolution =
  | { readonly ok: true; readonly target: RemoteDaemonTarget }
  | DaemonFailure;

export interface ResolveRemoteTargetInput {
  readonly flags: RemoteTargetFlags;
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly daemonHomeDir: string;
  /** Injectable so tests never read a real token file. */
  readonly readToken?: ((daemonHomeDir: string) => string | undefined) | undefined;
}

/**
 * Pull the token out of the operator-token file's contents.
 *
 * `readOperatorTokenFile` hands back the FILE, and the file is a JSON record,
 * `{ token, peerId, createdAt }`, not a bare token. Sending the whole document
 * as a bearer credential produces a 401 that looks exactly like a stale token,
 * which is a genuinely confusing way to fail. A file that is not JSON is
 * treated as a bare token, which is what a hand-written one would be.
 */
export function extractOperatorToken(contents: string | undefined): string | undefined {
  const trimmed = contents?.trim();
  if (!trimmed) return undefined;
  if (!trimmed.startsWith('{')) return trimmed;
  try {
    const parsed = JSON.parse(trimmed) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token.length > 0 ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Work out which daemon to talk to.
 *
 * A missing token is a refusal rather than an anonymous attempt: sending an
 * unauthenticated request would come back 401 and the operator would be left
 * guessing whether the daemon was down or the credential was missing.
 */
export function resolveRemoteDaemonTarget(input: ResolveRemoteTargetInput): RemoteTargetResolution {
  const binding = readControlPlaneBinding((key) => input.configManager.get(key as never));
  const typed = parseHostFlag(input.flags.host?.trim() ?? '', input.flags.port);
  if (!typed.ok) return typed;
  // Without --host, the daemon this surface was pointed at, if any, then the local bind.
  const connected = typed.host ? null : readConnectedDaemonOrigin((key) => input.configManager.get(key));
  const host = typed.host || connected?.host || binding.host;
  const port = typed.port ?? input.flags.port ?? connected?.port ?? binding.port;
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
    return {
      ok: false,
      code: 'invalid-port',
      error: `'${String(port)}' is not a usable port`,
      fix: 'pass --port with a number between 1 and 65535',
    };
  }

  const isLocal = host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '0.0.0.0';
  if (typed.host && !isLocal && !typed.scheme) {
    // Inferring the remote's scheme from local config could send the operator token in cleartext across the network.
    return {
      ok: false,
      code: 'invalid-host',
      error: `'${typed.host}' is another machine, and its connection type was not stated`,
      fix: `say how to reach it: --host https://${typed.host} (encrypted), or --host http://${typed.host} to send the operator token unencrypted over the network`,
    };
  }
  const explicitToken = input.flags.token?.trim();
  const token = explicitToken
    || extractOperatorToken((input.readToken ?? readOperatorTokenFile)(input.daemonHomeDir));
  if (!token) {
    return {
      ok: false,
      code: 'token-missing',
      error: 'no operator token was found for this machine',
      fix: isLocal
        ? 'start the daemon once so it creates its operator token, or pass --token'
        : 'pass --token with the operator token from the machine you are trying to reach',
    };
  }

  return { ok: true, target: { baseUrl: buildBaseUrl(host, port, binding.tlsMode, typed.scheme ?? connected?.scheme), token, isLocal } };
}

type ParsedHostFlag =
  | { readonly ok: true; readonly host: string; readonly scheme: 'http' | 'https' | undefined; readonly port: number | undefined }
  | DaemonFailure;

/**
 * Read `--host`, which takes a host name, an IP address, or a base URL as
 * every other surface prints it (`https://10.0.0.7:3421`). A URL gives the
 * scheme and may give the port; a port stated both there and in `--port` must
 * agree. A bare value carrying a port or a path is refused with what the flag
 * expects, instead of becoming a host that cannot be reached.
 */
function parseHostFlag(typed: string, flagPort: number | undefined): ParsedHostFlag {
  if (!typed) return { ok: true, host: '', scheme: undefined, port: undefined };
  const refuse = (why: string): DaemonFailure => ({
    ok: false,
    code: 'invalid-host',
    error: `'${typed}' is not a usable --host: ${why}`,
    fix: '--host takes a host name or address (10.0.0.7, [::1]) or a base URL (https://10.0.0.7:3421); pass the port with --port',
  });
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(typed)) {
    // An IPv6 literal after the scheme without brackets (`http://fd00::5`) is not a URL, but its meaning is plain.
    const bare = /^(https?):\/\/([0-9a-f]*:[0-9a-f:.]*:[0-9a-f:.]*)\/?$/i.exec(typed);
    if (bare) return { ok: true, host: bare[2] as string, scheme: (bare[1] as string).toLowerCase() as 'http' | 'https', port: undefined };
    let url: URL;
    try {
      url = new URL(typed);
    } catch {
      return refuse('it is not a URL');
    }
    const scheme = url.protocol === 'https:' ? 'https' : url.protocol === 'http:' ? 'http' : undefined;
    if (!scheme) return refuse(`${url.protocol.replace(/:$/, '')} is not a daemon address; use http or https`);
    if (url.username || url.password) return refuse('it carries a user name or password; pass the operator token with --token');
    if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) return refuse('a daemon address has no path');
    const port = url.port ? Number(url.port) : undefined;
    if (port !== undefined && flagPort !== undefined && port !== flagPort) {
      return refuse(`it names port ${port} and --port says ${flagPort}`);
    }
    // URL keeps an IPv6 literal bracketed; the base URL builder adds the brackets back.
    const host = url.hostname.replace(/^\[(.*)\]$/, '$1');
    return { ok: true, host, scheme, port };
  }
  if (/[/?#@\s]/.test(typed)) return refuse('it has a path or other characters a host name cannot');
  const bracketed = /^\[([0-9a-f:.]+)\]$/i.exec(typed);
  if (bracketed) return { ok: true, host: bracketed[1] as string, scheme: undefined, port: undefined };
  const colons = typed.split(':').length - 1;
  // One colon is host:port; two or more is an IPv6 literal.
  if (colons === 1) return refuse('the port goes in --port');
  return { ok: true, host: typed, scheme: undefined, port: undefined };
}

/**
 * Build the URL to CALL.
 *
 * Deliberately not `deriveControlPlaneBaseUrl`. That function answers a
 * different question, where a daemon should BIND, and it applies the
 * `hostMode` policy while doing so: with the default `local` mode it forces
 * 127.0.0.1 and discards the host it was given. For a client that is precisely
 * wrong, and it silently turned `--host 10.0.0.7` into a call to this machine.
 *
 * Here the host the operator typed is the host, full stop. The scheme is the
 * one typed with it, or, for this machine's own daemon, the configured one.
 */
function buildBaseUrl(host: string, port: number, tlsMode: string | undefined, stated: string | undefined): string {
  const scheme = stated ?? (tlsMode && tlsMode !== 'off' && tlsMode !== 'none' ? 'https' : 'http');
  // An IPv6 literal has to be bracketed or the port reads as part of the address.
  const authority = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${scheme}://${authority}:${port}`;
}

/**
 * The one thing this module needs from `fetch`.
 *
 * Narrower than `typeof fetch` on purpose: the global carries runtime-specific
 * extras (Bun adds `preconnect`) that a test double has no business
 * implementing, and requiring them would push every test into an `any`.
 */
export type DaemonFetch = (input: string, init?: RequestInit) => Promise<Response>;

const DAEMON_VERB_TIMEOUT_MS = 20_000;

/** How one call is made. */
export interface DaemonCallInit {
  readonly method: 'GET' | 'POST';
  readonly body?: unknown;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  /** A POST that only reads (a gateway verb call), so a lost answer is safe to repeat. */
  readonly readOnly?: boolean;
}

/** What a verb call came back with. */
export type DaemonVerbOutcome<T> =
  | { readonly ok: true; readonly data: T }
  | DaemonFailure;

/**
 * Call a daemon verb.
 *
 * Every failure shape becomes an `error`/`fix` pair in plain language, because
 * this is the layer where "ECONNREFUSED" has to turn into something an operator
 * can act on. The daemon's OWN refusals already carry a fix and are passed
 * through unchanged rather than being reworded here.
 */
export async function callDaemonVerb<T>(
  target: RemoteDaemonTarget,
  path: string,
  init: DaemonCallInit = { method: 'GET' },
  fetchImpl: DaemonFetch = fetch,
): Promise<DaemonVerbOutcome<T>> {
  const where = target.isLocal ? 'the daemon on this machine' : `the daemon at ${target.baseUrl}`;
  // A peer that accepts the connection and never answers must not hang the command; the race also covers a fetch that ignores its signal.
  const timeoutMs = init.timeoutMs ?? DAEMON_VERB_TIMEOUT_MS;
  const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
  // A send that fails part-way may still have been applied; only a read is safe to repeat blindly.
  const mayHaveApplied = init.method === 'POST' && init.readOnly !== true
    ? ' This change may or may not have been applied: run `cluster status` before repeating it.'
    : '';
  let response: Response;
  try {
    const aborted = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => reject(new Error(`no answer within ${Math.round(timeoutMs / 1000)}s`));
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    });
    response = await Promise.race([
      fetchImpl(`${target.baseUrl}${path}`, {
        method: init.method,
        headers: {
          Authorization: `Bearer ${target.token}`,
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        signal,
      }),
      aborted,
    ]);
  } catch (error) {
    return {
      ok: false,
      code: 'unreachable',
      error: `could not reach ${where}`,
      fix: (target.isLocal
        ? 'check the daemon is running: goodvibes-daemon service-status'
        : `check that machine is switched on and reachable, and that its daemon is listening on ${target.baseUrl} `
          + `(${error instanceof Error ? error.message : 'no further detail'})`)
        + (target.isLocal ? ` (${error instanceof Error ? error.message : 'no further detail'})` : '')
        + mayHaveApplied,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: 'auth-refused',
      error: `${where} refused the operator token`,
      fix: target.isLocal
        ? 'the token may be stale, restart the daemon, or pass --token'
        : 'pass --token with the operator token from that machine (its <daemon home>/operator-tokens.json)',
    };
  }
  if (response.status === 404) {
    // A verb's own "not found" (no such session) is the daemon's answer, not a missing route.
    const refusal = await readHandlerNotFound(response);
    if (refusal) return { ok: false, code: 'refused', ...refusal };
    return {
      ok: false,
      code: 'route-missing',
      error: `${where} does not know this command`,
      fix: `either that daemon is running an older build (update it, then try again), or ${target.baseUrl} is not a goodvibes daemon at all`,
    };
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return {
      ok: false,
      code: 'unreadable-reply',
      error: `${where} sent a reply this build could not read (HTTP ${response.status})`,
      fix: (response.status >= 500
        ? 'the daemon reported an internal failure; check its log'
        : 'check that both machines are running the same version')
        + mayHaveApplied,
    };
  }
  const body = payload as { ok?: unknown; data?: unknown; error?: unknown; fix?: unknown };
  if (body.ok === true) return { ok: true, data: body.data as T };
  return {
    ok: false,
    code: 'refused',
    error: typeof body.error === 'string' ? body.error : `${where} refused the request`,
    fix: typeof body.fix === 'string' ? body.fix : 'run `cluster status` to see the current state',
  };
}

/**
 * The error a daemon handler put on a 404, or undefined when the 404 means the
 * daemon has no such route or verb (`NOT_FOUND`, `METHOD_NOT_FOUND`, or a body
 * that is not the daemon's JSON error).
 */
async function readHandlerNotFound(response: Response): Promise<{ error: string; fix: string } | undefined> {
  let body: { error?: unknown; code?: unknown; fix?: unknown; hint?: unknown; next?: unknown };
  try {
    body = await response.json() as typeof body;
  } catch {
    return undefined;
  }
  if (!body || typeof body !== 'object' || typeof body.error !== 'string') return undefined;
  if (body.code === 'NOT_FOUND' || body.code === 'METHOD_NOT_FOUND') return undefined;
  const next = Array.isArray(body.next) && typeof body.next[0] === 'string' ? body.next[0] : undefined;
  const fix = typeof body.fix === 'string' ? body.fix : typeof body.hint === 'string' ? body.hint : next;
  return { error: body.error, fix: fix ?? 'check what you named with the matching list command, then try again' };
}
