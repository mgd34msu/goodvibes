/**
 * mcp-command.ts, `goodvibes-daemon mcp serve`.
 *
 * Exposes the operator surface of a RUNNING daemon as a Model Context Protocol
 * server on this process's stdio, so an MCP client (an editor, another agent)
 * can launch the installed binary and drive GoodVibes sessions through tools.
 *
 * The protocol core is the platform's `OperatorMcpServer`; this module only
 * decides WHICH daemon it talks to and proves it is reachable before the first
 * frame. The target and credential are resolved exactly as `status`, `sessions`
 * and `cluster` resolve them (--host/--port/--token, defaulting to this
 * machine's daemon and its operator token), so there is no second auth path.
 *
 * WHAT IS SERVED by default is the agent slice: the session, task, contract and
 * approval methods that only read, plus the session lifecycle (create, send a
 * message, steer). `--allow-write` adds the other methods of the chosen
 * families, `--categories` picks other families (`all` for every one), and a
 * method the contract marks dangerous is served only with `--allow-destructive`.
 * The served count goes to stderr at start, so a person can see what a client
 * was handed.
 *
 * Stdout belongs to the protocol: nothing but newline-delimited JSON-RPC frames
 * is ever written to it. Every refusal is ONE line on stderr that names the
 * missing prerequisite, and the process ends when the client closes stdin.
 */
import type { ConfigManager } from '@goodvibes/engine/platform/platform/config';
import { getOperatorContract } from '@goodvibes/engine/contracts';
import { callDaemonRoute, resolveRemoteDaemonTarget } from '@goodvibes/engine/terminal-shell';
import { createHttpJsonTransport, createOperatorRemoteClient } from '@goodvibes/engine/platform/platform/runtime/transport';
import {
  AGENT_MCP_TOOL_CATEGORIES,
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
  const target = resolved.target;

  const fetchImpl: McpFetch = input.fetchImpl;
  // Prove the daemon answers and accepts the token before the first frame, so a
  // client sees a failed launch rather than a server whose every tool errors.
  const reachable = await callDaemonRoute<unknown>(
    target,
    '/status',
    { method: 'GET', envelope: 'raw' },
    (url, init) => fetchImpl(url, init),
  );
  if (!reachable.ok) return refuse(reachable.error, reachable.fix);

  const contract = getOperatorContract();
  const known = new Set(contract.operator.methods.map((method) => method.category));
  const requested = (input.flags.categories ?? []).flatMap((entry) => entry.split(',')).map((entry) => entry.trim()).filter(Boolean);
  const everyFamily = requested.includes('all');
  const unknown = requested.filter((category) => category !== 'all' && !known.has(category));
  if (unknown.length > 0) {
    return refuse(`no operator family named ${unknown.join(', ')}`, `use one of ${[...known].sort().join(', ')}, or all`);
  }
  const toolOptions = {
    ...(everyFamily ? {} : { includeCategories: requested.length > 0 ? requested : AGENT_MCP_TOOL_CATEGORIES }),
    readOnly: input.flags.allowWrite !== true,
    includeDangerous: input.flags.allowDestructive === true,
  };
  const transport = createHttpJsonTransport({
    baseUrl: target.baseUrl,
    authToken: target.token,
    fetchImpl,
  });
  const client = createOperatorRemoteClient(transport, contract);
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
    tools: toolOptions,
    serverInfo: { name: 'goodvibes-operator', version: VERSION },
  });
  const served = server.listTools().length;
  const scope = everyFamily ? 'every family' : (requested.length > 0 ? requested : AGENT_MCP_TOOL_CATEGORIES).join(', ');
  const access = input.flags.allowWrite === true ? 'reads and writes' : 'reads and the session lifecycle';
  const widen = input.flags.allowWrite === true ? '' : '; --allow-write and --categories serve more';
  input.stderr(`goodvibes-daemon mcp serve: serving ${served} tools (${scope}; ${access}${input.flags.allowDestructive === true ? ', destructive included' : ''})${widen}`);
  await serveOperatorMcp(server, createStreamTransport(input.input, input.output));
  return 0;
}
