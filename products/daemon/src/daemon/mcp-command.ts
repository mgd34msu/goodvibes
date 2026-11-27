/**
 * mcp-command.ts, `goodvibes-daemon mcp serve`.
 *
 * Exposes the operator surface of a RUNNING daemon as a Model Context Protocol
 * server on this process's stdio, so an MCP client (an editor, another agent)
 * can launch the installed binary and drive GoodVibes sessions through tools.
 *
 * The protocol core is the platform's `OperatorMcpServer`; this module only
 * decides WHICH daemon it talks to and proves it is reachable before the first
 * frame. The target is resolved exactly as `status`, `sessions` and `cluster`
 * resolve it (--host/--port, defaulting to this machine's daemon).
 *
 * WHICH CREDENTIAL: one of its own. On first use the daemon issues it one
 * credential (`pairing.outsideAgent.issue`, asked with the operator token: a
 * paired device named "Outside agent (goodvibes-daemon mcp serve)" holding
 * full operator authority, as the operator token does), once per daemon
 * whatever address names it; the server keeps it in the daemon's home
 * (`mcp-serve-credentials.json`, by the daemon's identity, readable only by the
 * person's account) and from then on uses only that one. It is listed among the
 * paired devices by that name, where it is revoked; a revoked one is not
 * replaced by itself (the server refuses and says how to let it in again). It
 * is the user's own credential: it names any project, and nothing is asked or
 * refused for that. `--token` gives a credential by hand instead (a paired
 * device's, for a daemon on another machine).
 *
 * WHAT IS SERVED by default is two tools, `capability_find` and
 * `capability_run`, over the daemon's `capabilities.find` and
 * `capabilities.run`: every capability, each run at once as the user's own call
 * (its credential is the user's). With any of the flags below it serves one tool per method
 * instead: the agent slice (the session, task, contract and approval methods
 * that only read, plus the session lifecycle) by default, `--allow-write` adds
 * the other methods of the chosen families, `--categories` picks other
 * families (`all` for every one), and a method the contract marks dangerous is
 * served only with `--allow-destructive`.
 * The served count goes to stderr at start, so a person can see what a client
 * was handed.
 *
 * Stdout belongs to the protocol: nothing but newline-delimited JSON-RPC frames
 * is ever written to it. Every refusal is ONE line on stderr that names the
 * missing prerequisite, and the process ends when the client closes stdin.
 */
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { whyNeverAProject } from '@goodvibes/engine/platform/platform/workspace';
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { getOperatorContract } from '@goodvibes/engine/contracts';
import { callDaemonRoute, resolveRemoteDaemonTarget } from '@goodvibes/engine/terminal-shell';
import { createHttpJsonTransport, createOperatorRemoteClient } from '@goodvibes/engine/platform/platform/runtime/transport';
import {
  AGENT_MCP_TOOL_CATEGORIES,
  CAPABILITY_MCP_INSTRUCTIONS,
  CAPABILITY_MCP_TOOL_SET,
  OperatorMcpServer,
  buildOperatorMcpTools,
  createOperatorMcpServer,
  createStreamTransport,
  serveOperatorMcp,
  type ChunkSink,
  type ChunkSource,
} from '@goodvibes/engine/platform/platform/mcp/server';
import { VERSION } from '../version.js';

export const MCP_SUBCOMMANDS = ['serve'] as const;

export const MCP_USAGE = 'Usage: goodvibes-daemon mcp serve [--categories <list|all>] [--allow-write] [--allow-destructive] [--host <http(s)://name>] [--port <n>] [--token <t>]';

type McpFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface RunMcpCommandInput {
  readonly configManager: Pick<ConfigManager, 'get'>;
  readonly daemonHomeDir: string;
  readonly flags: {
    readonly host: string | undefined;
    readonly port: number | undefined;
    readonly token: string | undefined;
    /** `--categories`: operator families to serve; `all` serves every family. Default: the agent slice. */
    readonly categories?: readonly string[] | undefined;
    /** `--allow-write`: serve the methods that change state, not only reads and the session lifecycle. */
    readonly allowWrite?: boolean | undefined;
    /** `--allow-destructive`: also serve the methods the contract marks dangerous. */
    readonly allowDestructive?: boolean | undefined;
  };
  /** Positional words after `mcp`. */
  readonly args: readonly string[];
  /** The client's frames in, newline-delimited. */
  readonly input: ChunkSource;
  /** Where frames go out. Nothing but frames is ever written here. */
  readonly output: ChunkSink;
  readonly stderr: (line: string) => void;
  /** Asks the daemon with the configured outbound TLS trust (`createDaemonCommandRemote`); never the bare global fetch. */
  readonly fetchImpl: McpFetch;
  readonly readToken?: ((daemonHomeDir: string) => string | undefined) | undefined;
  /** The project a capability acts on when a call names none: the folder the server was started in. */
  readonly workingDirectory?: string | undefined;
}

/** The name the outside agent's own credential is listed under among the paired devices. */
const OUTSIDE_AGENT_NAME = 'Outside agent (goodvibes-daemon mcp serve)';

function credentialsFile(daemonHomeDir: string): string {
  return join(daemonHomeDir, 'mcp-serve-credentials.json');
}

/**
 * The daemon's own identity, as this server can know it whatever address names it (`localhost`, `127.0.0.1`, `[::1]`):
 * a fingerprint of the operator token that daemon serves, never the token. One credential is kept per daemon.
 */
function daemonIdentity(operatorToken: string): string {
  return `daemon-${createHash('sha256').update(operatorToken).digest('hex').slice(0, 24)}`;
}

/** The kept credentials, by daemon identity. */
function keptCredentials(daemonHomeDir: string): Record<string, { readonly id?: string; readonly token: string }> {
  try {
    const parsed = JSON.parse(readFileSync(credentialsFile(daemonHomeDir), 'utf8')) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const kept: Record<string, { readonly id?: string; readonly token: string }> = {};
    for (const [address, value] of Object.entries(parsed as Record<string, unknown>)) {
      const entry = value as { readonly id?: unknown; readonly token?: unknown } | null;
      if (entry && typeof entry.token === 'string' && entry.token) kept[address] = { token: entry.token, ...(typeof entry.id === 'string' ? { id: entry.id } : {}) };
    }
    return kept;
  } catch {
    return {};
  }
}

/** What the server has of its own credential: the credential, or why it has none. */
type OwnCredential = { readonly token: string; readonly mintedId?: string; readonly project?: string } | { readonly refusal: string; readonly fix: string };

/**
 * The outside agent's own credential for this daemon: the one kept for the daemon's identity (whatever address names
 * it), or the one the daemon issues (`pairing.outsideAgent.issue`, asked with the operator token and no person's
 * claim). It holds full operator authority and names any project; nothing is asked. The agent's calls use this credential,
 * not the operator token.
 */
async function outsideAgentCredential(target: { readonly baseUrl: string; readonly token: string }, daemonHomeDir: string, fetchImpl: McpFetch,
  project?: string): Promise<OwnCredential> {
  const identity = daemonIdentity(target.token);
  const kept = keptCredentials(daemonHomeDir)[identity];
  if (kept) return { token: kept.token };
  let minted: { readonly id?: unknown; readonly token?: unknown } | undefined;
  try {
    const transport = createHttpJsonTransport({ baseUrl: target.baseUrl, authToken: target.token, fetchImpl });
    const answer = await transport.requestJson('/api/control-plane/methods/pairing.outsideAgent.issue/invoke', {
      method: 'POST', methodId: 'pairing.outsideAgent.issue', body: { body: project !== undefined ? { project } : {} },
    }) as { readonly id?: unknown; readonly token?: unknown } | null;
    minted = answer ?? undefined;
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    if (/OUTSIDE_AGENT_ISSUED|already has its credential/.test(said)) {
      return { refusal: `this daemon issued its credential before (the paired device "${OUTSIDE_AGENT_NAME}") and it is not kept in ${credentialsFile(daemonHomeDir)}`,
        fix: 'revoke it among the paired devices (Devices and network), then start it again; a new one is issued' };
    }
    return { refusal: `a credential of its own could not be had at ${target.baseUrl} (${said})`,
      fix: 'check the daemon with goodvibes-daemon status, or give a paired device\'s token with --token' };
  }
  if (!minted || typeof minted.token !== 'string' || !minted.token) {
    return { refusal: `the daemon at ${target.baseUrl} gave no credential for it`, fix: 'check the daemon with goodvibes-daemon status, or give a paired device\'s token with --token' };
  }
  try {
    mkdirSync(daemonHomeDir, { recursive: true, mode: 0o700 });
    const file = credentialsFile(daemonHomeDir);
    const next = { ...keptCredentials(daemonHomeDir), [identity]: { token: minted.token, ...(typeof minted.id === 'string' ? { id: minted.id } : {}) } };
    writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (error) {
    return { refusal: `its own credential could not be kept in ${credentialsFile(daemonHomeDir)} (${error instanceof Error ? error.message : String(error)})`,
      fix: 'make that folder writable for this account; the credential made now is listed among the paired devices, where it can be revoked' };
  }
  // The project it was started in, said to the person; none is given (any project is named by a call).
  return { token: minted.token, ...(typeof minted.id === 'string' ? { mintedId: minted.id } : {}), ...(project !== undefined ? { project } : {}) };
}

/**
 * The project its calls name when they name none: the folder it was started in, unless that folder can never be a
 * project (the root, the home folder itself, anything in or above the GoodVibes or daemon home): then none, and a call
 * that needs a project names one itself (any project, nothing asked).
 */
function startProject(folder: string, daemonHomeDir: string): { readonly project?: string; readonly why?: string } {
  const home = homedir();
  const never = whyNeverAProject(folder, { homeDirectory: home, goodVibesHome: join(home, '.goodvibes'), daemonHome: daemonHomeDir });
  return never === undefined ? { project: folder } : { why: never };
}

/**
 * Returns the process exit code: 0 when the client closed the stream, 1 when a
 * prerequisite is missing, 2 for a usage error.
 */
export async function runMcpCommand(input: RunMcpCommandInput): Promise<number> {
  if (input.args[0] !== 'serve' || input.args.length > 1) {
    input.stderr(MCP_USAGE);
    return 2;
  }
  const refuse = (what: string, fix: string): number => {
    input.stderr(`goodvibes-daemon mcp serve: ${what}; ${fix}`);
    return 1;
  };

  const resolved = resolveRemoteDaemonTarget({
    flags: {
      ...(input.flags.host === undefined ? {} : { host: input.flags.host }),
      ...(input.flags.port === undefined ? {} : { port: input.flags.port }),
      ...(input.flags.token === undefined ? {} : { token: input.flags.token }),
    },
    configManager: input.configManager,
    daemonHomeDir: input.daemonHomeDir,
    ...(input.readToken ? { readToken: input.readToken } : {}),
  });
  if (!resolved.ok) return refuse(resolved.error, resolved.fix);
  const fetchImpl: McpFetch = input.fetchImpl;
  // The folder it was started in is the project its calls name when they name none, unless it can never be one.
  const started = startProject(input.workingDirectory ?? process.cwd(), input.daemonHomeDir);
  // A credential of its own (see the header); one given by hand is used as given.
  const own: OwnCredential | undefined = input.flags.token === undefined ? await outsideAgentCredential(resolved.target, input.daemonHomeDir, fetchImpl, started.project) : undefined;
  if (own !== undefined && 'refusal' in own) return refuse(own.refusal, own.fix);
  const ownToken = (): string | undefined => own !== undefined && 'token' in own ? own.token : undefined;
  const target = ownToken() !== undefined ? { ...resolved.target, token: ownToken()! } : resolved.target;
  // Issued just now (daemon/capability-wiring.ts, the issue's handler): full authority, any project.
  if (own !== undefined && 'mintedId' in own && own.mintedId !== undefined) {
    input.stderr(`goodvibes-daemon mcp serve: it has a credential of its own now, listed among your paired devices as "${OUTSIDE_AGENT_NAME}"; it works in any project${own.project !== undefined ? ` (it was started in ${own.project})` : ''}`);
  }
  if (started.project === undefined) {
    input.stderr(`goodvibes-daemon mcp serve: started in ${input.workingDirectory ?? process.cwd()}, which cannot be a project (${started.why}): a call that needs a project names one (workingDirectory)`);
  }
  // Prove the daemon answers and accepts the token before the first frame, so a
  // client sees a failed launch rather than a server whose every tool errors.
  const reachable = await callDaemonRoute<unknown>(
    target,
    '/status',
    { method: 'GET', envelope: 'raw' },
    (url, init) => fetchImpl(url, init),
  );
  if (!reachable.ok) {
    // Its own credential refused: the owner revoked it among the paired devices. It is not replaced by itself.
    if (own !== undefined && /AUTH|401|403|credential|token/i.test(`${reachable.error} ${reachable.fix}`)) {
      return refuse(`its own credential (the paired device "${OUTSIDE_AGENT_NAME}") is not accepted by ${resolved.target.baseUrl}: it was revoked`,
        `to let it connect again, delete ${credentialsFile(input.daemonHomeDir)} and start it again; it is then given a new one`);
    }
    return refuse(reachable.error, reachable.fix);
  }

  // By default two tools, capability_find and capability_run, through the daemon's capabilities.find and
  // capabilities.run; the one-tool-per-method listing is behind --categories, --allow-write and --allow-destructive.
  const perMethod = (input.flags.categories ?? []).length > 0 || input.flags.allowWrite === true || input.flags.allowDestructive === true;
  if (!perMethod) {
    const workingDirectory = started.project;
    const transport = createHttpJsonTransport({ baseUrl: target.baseUrl, authToken: target.token, fetchImpl });
    const server = new OperatorMcpServer({
      toolSet: CAPABILITY_MCP_TOOL_SET,
      // Reached by id over the daemon's invoke endpoint, behind the same access gate; the client's cancel aborts it.
      invoke: async (methodId, params, { signal }) => {
        return transport.requestJson(`/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`, {
          method: 'POST', methodId, signal,
          body: { body: methodId === 'capabilities.run' && workingDirectory !== undefined && typeof params['workingDirectory'] !== 'string' ? { ...params, workingDirectory } : params },
        });
      },
      serverInfo: { name: 'goodvibes-operator', version: VERSION },
      instructions: CAPABILITY_MCP_INSTRUCTIONS,
    });
    input.stderr('goodvibes-daemon mcp serve: serving 2 tools (capability_find, capability_run: every GoodVibes capability, decided under your permission mode); --categories, --allow-write or --allow-destructive serve one tool per method instead');
    await serveOperatorMcp(server, createStreamTransport(input.input, input.output));
    return 0;
  }

  const contract = getOperatorContract();
  const known = new Set(contract.operator.methods.map((method) => method.category));
  const requested = (input.flags.categories ?? []).flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
  const everyFamily = requested.includes('all');
  const unknown = requested.filter((category) => category !== 'all' && !known.has(category));
  if (unknown.length > 0) {
    return refuse(`no operator family named ${unknown.join(', ')}`, `use one of ${[...known].sort().join(', ')}, or all`);
  }
  const transport = createHttpJsonTransport({
    baseUrl: target.baseUrl,
    authToken: target.token,
    fetchImpl,
  });
  const client = createOperatorRemoteClient(transport, contract);
  // Offer only the methods the target daemon serves: one catalog read at start.
  // A daemon on another release may lack some of this binary's methods; those
  // tools are left out rather than failing with METHOD_NOT_FOUND when called.
  let servedIds: ReadonlySet<string>;
  try {
    const catalog = await client.invoke('control.methods.list', {}) as { readonly methods?: readonly { readonly id?: unknown }[] };
    servedIds = new Set((catalog.methods ?? []).map((method) => method.id).filter((id): id is string => typeof id === 'string'));
  } catch (error) {
    return refuse(`the daemon at ${target.baseUrl} did not list its methods (${error instanceof Error ? error.message : String(error)})`,
      'check that it is running this release or a recent one: goodvibes-daemon status');
  }
  const toolOptions = {
    ...(everyFamily ? {} : { includeCategories: requested.length > 0 ? requested : AGENT_MCP_TOOL_CATEGORIES }),
    readOnly: input.flags.allowWrite !== true,
    includeDangerous: input.flags.allowDestructive === true,
  };
  const dropped = buildOperatorMcpTools(contract, toolOptions).tools.filter((tool) => !servedIds.has(tool.operatorMethodId)).length;
  const restBound = new Set(contract.operator.methods.filter((method) => method.http).map((method) => method.id));
  const server = createOperatorMcpServer({
    contract,
    // A method with no REST path (published for the WebSocket only) is reached
    // through the daemon's invoke-by-id endpoint, which runs the same handler
    // behind the same access gate.
    // The client's cancel aborts the request to the daemon.
    invoke: (methodId, params, { signal }) => restBound.has(methodId)
      ? client.invoke(methodId, params, { signal })
      : transport.requestJson(`/api/control-plane/methods/${encodeURIComponent(methodId)}/invoke`, {
        method: 'POST', body: { body: params }, methodId, signal,
      }),
    tools: { ...toolOptions, includeMethods: servedIds },
    serverInfo: { name: 'goodvibes-operator', version: VERSION },
  });
  const served = server.listTools().length;
  const scope = everyFamily ? 'every family' : (requested.length > 0 ? requested : AGENT_MCP_TOOL_CATEGORIES).join(', ');
  const access = input.flags.allowWrite === true ? 'reads and writes' : 'reads and the session lifecycle';
  const widen = input.flags.allowWrite === true ? '' : '; --allow-write and --categories serve more';
  const absent = dropped > 0 ? `; ${dropped} left out because that daemon does not serve them` : '';
  input.stderr(`goodvibes-daemon mcp serve: serving ${served} tools (${scope}; ${access}${input.flags.allowDestructive === true ? ', destructive included' : ''})${absent}${widen}`);
  await serveOperatorMcp(server, createStreamTransport(input.input, input.output));
  return 0;
}
