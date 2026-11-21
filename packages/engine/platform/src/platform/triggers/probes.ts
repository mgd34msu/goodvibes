/**
 * probes.ts, executing one declarative probe.
 *
 * Four kinds, all data-driven: http, file, command (argv, never a shell) and
 * platform-tool. Each returns a TriggerValue the extractor then narrows. Nothing
 * here interpolates a previously extracted value back into the probe: a probe
 * is a fixed measurement, so there is no path by which an observed value can
 * become part of the next request or command line.
 *
 * All I/O is injectable so the whole probe layer is testable without a network,
 * a filesystem or a subprocess, the policy lives here, the host supplies the
 * effects.
 */

import { statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { TriggerProbe, TriggerValue } from './types.js';
import { isCallerReachablePrivateAddress, pinnedFetch } from '../runtime/network/destination.js';
import { assertHttpScheme, resolveCheckedAddresses } from '../tools/fetch/pinned-request.js';
import {
  ALLOWED_PRIVATE_HOSTS_SETTING,
  classifyHostTrustTier,
  emitSsrfDeny,
  extractHostname,
  writtenPrivateHostAllowed,
  type TrustTierConfig,
} from '../tools/fetch/trust-tiers.js';

export interface ProbeCommandResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The effects a probe needs. A host wires the real ones; a test wires fakes.
 * `runCommand` takes argv, not a command string, there is no shell anywhere in
 * this path, so no extracted value can ever be interpreted as a metacharacter.
 * The real command runner is the process manager's (`createProcessManagerCommandRunner`
 * in hosts.ts): credential scrub, its own process group, bounded output and a
 * kill of the whole group at the deadline.
 */
export interface ProbeIo {
  readonly fetch: (url: string, init: RequestInit, timeoutMs: number) => Promise<{
    readonly status: number;
    readonly ok: boolean;
    readonly text: () => Promise<string>;
    /** Releases the connection when the body will not be read. */
    readonly close?: () => void;
  }>;
  readonly readFile: (path: string, maxBytes: number) => Promise<string>;
  readonly statFile: (path: string) => { readonly size: number; readonly mtimeMs: number } | null;
  readonly runCommand: (
    command: string,
    args: readonly string[],
    options: { readonly cwd?: string | undefined; readonly timeoutMs: number },
  ) => Promise<ProbeCommandResult>;
  /** Runs a platform-tool probe's call; `ownerSessionId` is the session that made the trigger, whose tools are preferred. */
  readonly callTool: (
    tool: string,
    input: Readonly<Record<string, TriggerValue>>,
    timeoutMs: number,
    ownerSessionId?: string,
  ) => Promise<TriggerValue>;
}

export class ProbeTimeoutError extends Error {
  constructor(kind: string, timeoutMs: number) {
    super(`${kind} probe exceeded its ${timeoutMs}ms budget`);
    this.name = 'ProbeTimeoutError';
  }
}

/** Most of an http body a probe reads; the rest is not read, so a large page cannot fill memory. */
export const HTTP_PROBE_MAX_BYTES = 1_048_576;

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - bytes;
      const chunk = value.byteLength > room ? value.subarray(0, room) : value;
      bytes += chunk.byteLength;
      text += decoder.decode(chunk, { stream: true });
      if (bytes >= maxBytes) break;
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * The host policy an http probe is held to: the fetch tool's own settings,
 * read live (fetch.trustedHosts, fetch.blockedHosts, fetch.allowLocalhost,
 * fetch.allowedPrivateHosts). One policy for the fetch tool and for probes,
 * whoever created the trigger.
 */
export interface ProbeHostPolicy {
  readonly trustedHosts: () => readonly string[] | undefined;
  readonly blockedHosts: () => readonly string[] | undefined;
  readonly localhostAllowed: () => boolean;
  readonly allowedPrivateHosts: () => readonly string[];
}

/** With no host policy wired: no list, no localhost, no private host. */
const STRICTEST_HOST_POLICY: ProbeHostPolicy = {
  trustedHosts: () => undefined,
  blockedHosts: () => undefined,
  localhostAllowed: () => false,
  allowedPrivateHosts: () => [],
};

function trustTierConfigOf(policy: ProbeHostPolicy): TrustTierConfig {
  const trusted = policy.trustedHosts(), blocked = policy.blockedHosts();
  return { ...(trusted ? { trustedHosts: [...trusted] } : {}), ...(blocked ? { blockedHosts: [...blocked] } : {}) };
}

/**
 * Why an http probe of `url` may not run, worded as the fetch tool words its
 * refusals, or undefined when it may. Judged on the host as written (no DNS):
 * the create refuses with it, and every check refuses with it again before the
 * pinned request resolves and checks the addresses (DNS can change).
 */
export function probeHostRefusal(url: string, policy: ProbeHostPolicy = STRICTEST_HOST_POLICY): string | undefined {
  try {
    assertHttpScheme(url);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  const host = extractHostname(url);
  if (host === null) return 'Request blocked: not a valid URL. Nothing was sent; pass an absolute http(s) URL.';
  const trust = classifyHostTrustTier(host, trustTierConfigOf(policy));
  if (trust.tier === 'localhost') {
    return policy.localhostAllowed() ? undefined
      : `Request blocked: the probe of the localhost host "${host}" cannot run, because localhost fetches are not allowed (fetch.allowLocalhost is off). `
        + 'Ask the owner to set fetch.allowLocalhost to true, or probe a URL that is not on this machine.';
  }
  if (trust.tier !== 'blocked') return undefined;
  const literal = host.replace(/^\[|\]$/g, '');
  if (trust.isSsrf && isIP(literal) !== 0 && isCallerReachablePrivateAddress(literal)) {
    if (writtenPrivateHostAllowed(host, { callerAdmitted: false, allowedPrivateHosts: policy.allowedPrivateHosts() })) return undefined;
    return `Request blocked: ${trust.reason}. To reach it, the owner can add "${literal}" to ${ALLOWED_PRIVATE_HOSTS_SETTING} in their own settings (a project file cannot set it)`;
  }
  if (trust.isSsrf) emitSsrfDeny(host, url, trust.reason);
  return `Request blocked: ${trust.reason}`;
}

/** Most redirects a probe follows, as many as the fetch tool follows. */
const PROBE_MAX_REDIRECTS = 10;
const PROBE_REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** Request headers not sent on after a redirect to another origin. */
const CREDENTIAL_HEADERS: ReadonlySet<string> = new Set(['authorization', 'cookie', 'proxy-authorization']);

/**
 * An http probe's request, admitted as the fetch tool admits one: the written
 * host is checked against the policy, its every DNS answer is checked and the
 * connection pinned to a checked address (tools/fetch/pinned-request.ts), and
 * each redirect is checked the same way, never into a private, loopback (unless
 * the written host was an allowed loopback one) or metadata address.
 */
async function admittedProbeFetch(url: string, init: RequestInit, policy: ProbeHostPolicy): Promise<Response> {
  const trustTierConfig = trustTierConfigOf(policy);
  let current = url;
  let method = (init.method ?? 'GET').toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers);
  let writtenLoopbackAllowed = false;
  for (let hop = 0; ; hop += 1) {
    const host = extractHostname(current);
    if (host === null) throw new Error('Request blocked: not a valid URL. Nothing was sent; pass an absolute http(s) URL.');
    const trust = classifyHostTrustTier(host, trustTierConfig);
    if (hop === 0) {
      const refused = probeHostRefusal(current, policy);
      if (refused) throw new Error(refused);
      writtenLoopbackAllowed = trust.tier === 'localhost';
    } else if (trust.tier === 'blocked' || (trust.tier === 'localhost' && !writtenLoopbackAllowed)) {
      // A server may not choose an internal destination.
      emitSsrfDeny(host, current, trust.reason);
      throw new Error(`Redirect blocked: ${trust.reason}`);
    }
    const addresses = await resolveCheckedAddresses(current, {
      trustTierConfig,
      localhostApproved: trust.tier === 'localhost' && writtenLoopbackAllowed,
      callerWroteHost: hop === 0,
      privateAllowed: hop === 0 && writtenPrivateHostAllowed(host, { callerAdmitted: false, allowedPrivateHosts: policy.allowedPrivateHosts() }),
    });
    const response = await pinnedFetch(current, {
      ...init, method, headers, body: body ?? null, redirect: 'manual',
    }, addresses);
    const location = PROBE_REDIRECT_STATUSES.has(response.status) ? response.headers.get('location') : null;
    if (location === null) return response;
    await response.body?.cancel().catch(() => undefined);
    if (hop === PROBE_MAX_REDIRECTS) throw new Error(`Too many redirects after ${PROBE_MAX_REDIRECTS} hops`);
    const next = new URL(location, current);
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new Error(`Redirect blocked: the server redirected to a ${next.protocol} URL; only http(s) targets are followed`);
    }
    if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === 'POST')) {
      method = 'GET';
      body = null;
      headers.delete('content-type');
      headers.delete('content-length');
    }
    if (next.origin !== new URL(current).origin) {
      const kept = new Headers();
      headers.forEach((value, name) => { if (!CREDENTIAL_HEADERS.has(name.toLowerCase())) kept.set(name, value); });
      headers = kept;
    }
    current = next.toString();
  }
}

/**
 * Default effects: fetch, file reads and stats. An http probe's request goes
 * through the fetch tool's host admission under `hostPolicy` (with none, no
 * localhost and no private host). Command probes run only through the runner
 * the host passes (the process manager's), and platform-tool probes only
 * through the tool host it passes (probe-tools.ts); with none, such a probe
 * fails and says so.
 */
export function createDefaultProbeIo(options: {
  readonly runCommand?: ProbeIo['runCommand'] | undefined;
  readonly callTool?: ProbeIo['callTool'] | undefined;
  readonly hostPolicy?: ProbeHostPolicy | undefined;
} = {}): ProbeIo {
  const hostPolicy = options.hostPolicy ?? STRICTEST_HOST_POLICY;
  return {
    fetch: async (url, init, timeoutMs) => {
      const controller = new AbortController();
      const timer = setTimeout(() => { controller.abort(); }, timeoutMs);
      timer.unref?.();
      // The budget covers the whole exchange: a server that sends headers and then
      // stalls must not hang the body read, so the timer outlives this call.
      const timedOut = (error: unknown): unknown => {
        clearTimeout(timer);
        return controller.signal.aborted ? new ProbeTimeoutError('http', timeoutMs) : error;
      };
      try {
        const response = await admittedProbeFetch(url, { ...init, signal: controller.signal }, hostPolicy);
        return {
          status: response.status,
          ok: response.ok,
          text: async () => {
            try { return await readBounded(response, HTTP_PROBE_MAX_BYTES); } catch (error) { throw timedOut(error); } finally { clearTimeout(timer); }
          },
          close: () => { clearTimeout(timer); controller.abort(); },
        };
      } catch (error) {
        throw timedOut(error);
      }
    },
    readFile: async (path, maxBytes) => {
      // Read at most maxBytes from the start; a large file is never loaded whole.
      const handle = await open(path, 'r');
      try {
        const buffer = Buffer.alloc(maxBytes);
        const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
        return buffer.subarray(0, bytesRead).toString('utf-8');
      } finally {
        await handle.close();
      }
    },
    statFile: (path) => {
      try {
        const stat = statSync(path);
        return { size: stat.size, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    },
    runCommand: options.runCommand ?? (() => Promise.reject(new Error('Command probes run through the process manager, and this host passed none; use an http or file probe, or run the trigger in the daemon.'))),
    callTool: options.callTool ?? (() => Promise.reject(new Error('Platform-tool probes run on the tools of a session, and this host passed none; use an http, file or command probe, or run the trigger in the daemon.'))),
  };
}

const DEFAULT_PROBE_TIMEOUT_MS = 15_000;

function isAbsentFile(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Rejects with ProbeTimeoutError when the work outlives its budget (plus any grace before it is abandoned). */
async function withinBudget<T>(kind: string, timeoutMs: number, work: Promise<T>, graceMs = 0): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => { reject(new ProbeTimeoutError(kind, timeoutMs)); }, timeoutMs + graceMs); timer.unref?.(); });
  try { return await Promise.race([work, expired]); } finally { clearTimeout(timer); }
}
const DEFAULT_FILE_MAX_BYTES = 1_048_576;
/** Time past the budget a probe that keeps its own deadline (http, command) has to report it before it is abandoned. */
const PROBE_SETTLE_GRACE_MS = 1_000;

/**
 * Runs one probe and returns its raw result for the extractor to narrow. The
 * whole probe is held to its budget, so a check always settles and the
 * trigger is never left waiting on output a stray child still holds open.
 */
export function runProbe(
  probe: TriggerProbe,
  io: ProbeIo,
  defaults: { readonly timeoutMs?: number | undefined; readonly ownerSessionId?: string | undefined } = {},
): Promise<TriggerValue> {
  // A stored budget of 0 (accepted before a budget had to be positive) is no budget: it runs with the default.
  const budget = probe.kind === 'file'
    ? (defaults.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS)
    : ((probe.timeoutMs === undefined || probe.timeoutMs === 0 ? undefined : probe.timeoutMs) ?? defaults.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS);
  // http and command probes keep their own deadline and report it first; a file
  // read has none, so the budget is its deadline.
  return withinBudget(probe.kind, budget, runProbeWork(probe, io, budget, defaults.ownerSessionId), probe.kind === 'file' ? 0 : PROBE_SETTLE_GRACE_MS);
}

async function runProbeWork(probe: TriggerProbe, io: ProbeIo, budget: number, ownerSessionId: string | undefined): Promise<TriggerValue> {
  switch (probe.kind) {
    case 'http': {
      const init: RequestInit = {
        method: probe.method ?? 'GET',
        ...(probe.headers ? { headers: { ...probe.headers } } : {}),
        ...(probe.body !== undefined ? { body: probe.body } : {}),
      };
      const response = await io.fetch(probe.url, init, budget);
      if (probe.capture === 'status') { response.close?.(); return response.status; }
      // A body that cannot be read in full is a failed check, never an empty observation.
      const text = await response.text();
      if (probe.capture === 'envelope') {
        return { status: response.status, ok: response.ok, body: text };
      }
      return text;
    }

    case 'file': {
      if (probe.capture === 'stat') {
        const stat = io.statFile(probe.path);
        return stat ? { exists: true, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) } : { exists: false };
      }
      try {
        return await io.readFile(probe.path, probe.maxBytes ?? DEFAULT_FILE_MAX_BYTES);
      } catch (error) {
        // A missing file is an observation, not a probe failure: a `change`
        // rule watching for a file to appear needs to see the absent state.
        // Any other failure (permissions, a directory, I/O) is not "absent".
        if (isAbsentFile(error)) return null;
        throw error;
      }
    }

    case 'command': {
      const result = await io.runCommand(probe.command, probe.args ?? [], {
        ...(probe.cwd !== undefined ? { cwd: probe.cwd } : {}),
        timeoutMs: budget,
      });
      if (probe.capture === 'exit-code') return result.exitCode;
      if (probe.capture === 'stderr') return result.stderr;
      if (probe.capture === 'envelope') {
        return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
      }
      return result.stdout;
    }

    case 'platform-tool':
      return io.callTool(probe.tool, probe.input ?? {}, budget, ownerSessionId);

    default:
      return null;
  }
}
