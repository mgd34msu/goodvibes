/**
 * Preload for every product process the run-through starts (passed through
 * BUN_OPTIONS, so child bun processes inherit it). Every connection must stay
 * on loopback, and never to a port that was already listening on this machine
 * when the run started (RUNTHROUGH_DENY_PORTS, the owner's own daemon among
 * them) or to a GoodVibes default port: an isolated home must never reach the
 * owner's services. Ports the run's own children open later (the daemon, the
 * scripted model, a browser's debugging port) are reachable.
 */
import net from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { installTestNetworkGuard } from '../../toolchain/src/test-runner/test-network-guard.ts';

const denied = new Set([...(process.env.RUNTHROUGH_DENY_PORTS ?? '').split(','), '3421', '3422', '3423', '4444'].map((port) => port.trim()).filter(Boolean));

function refuse(what: string): never {
  const line = `[runthrough guard] refused ${what}`;
  process.stderr.write(`${line}\n`);
  throw new Error(line);
}

installTestNetworkGuard((diagnostic) => { process.stderr.write(`[runthrough guard] ${diagnostic}\n`); });

function checkPort(port: unknown, what: string): void {
  if (port === undefined || port === null || port === '') return;
  const text = String(port);
  if (denied.has(text)) refuse(`${what} to loopback port ${text} (a service that was running before this run)`);
}

function checkUrl(value: unknown, what: string): void {
  let url: URL;
  try { url = new URL(value instanceof Request ? value.url : String(value)); } catch { return; }
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return;
  const port = url.port || (url.protocol === 'https:' || url.protocol === 'wss:' ? '443' : '80');
  checkPort(port, `${what} ${url.protocol}//${url.hostname}`);
}

const guardedFetch = globalThis.fetch;
const trace = process.env.RUNTHROUGH_TRACE === '1';
const portFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  checkUrl(input, 'fetch');
  if (!trace) return guardedFetch(input, init);
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const url = input instanceof Request ? input.url : String(input);
  try {
    const response = await guardedFetch(input, init);
    const body = response.status >= 400 ? ` ${(await response.clone().text()).slice(0, 400)}` : '';
    process.stderr.write(`[runthrough trace] ${method} ${url} -> ${response.status}${body}\n`);
    return response;
  } catch (error) {
    process.stderr.write(`[runthrough trace] ${method} ${url} -> ${error instanceof Error ? error.message : String(error)}\n`);
    throw error;
  }
}) as typeof fetch;
Object.assign(portFetch, guardedFetch);
globalThis.fetch = portFetch;

const guardedWebSocket = globalThis.WebSocket;
globalThis.WebSocket = new Proxy(guardedWebSocket, {
  construct(target, args, newTarget) {
    checkUrl(args[0], 'WebSocket');
    return Reflect.construct(target, args, newTarget);
  },
});

const nodeRequire = createRequire(import.meta.url);
const netModule = nodeRequire('node:net') as typeof net;
const guardedConnect = netModule.Socket.prototype.connect;
netModule.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]): net.Socket {
  // Node normalizes some overloads to one array argument.
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  const options = typeof first === 'object' && first !== null && !Array.isArray(first) ? first as Record<string, unknown> : undefined;
  if (!(options && (typeof options.path === 'string'))) {
    if (!(typeof first === 'string' && !/^\d+$/.test(first))) checkPort(options ? options.port : first, 'TCP');
  }
  return Reflect.apply(guardedConnect, this, args) as net.Socket;
} as typeof guardedConnect;
const guardedBunConnect = Bun.connect;
Reflect.set(Bun, 'connect', (...args: unknown[]) => {
  const options = args[0] as { port?: unknown; unix?: unknown } | undefined;
  if (options && typeof options.unix !== 'string') checkPort(options.port, 'Bun TCP');
  return Reflect.apply(guardedBunConnect, Bun, args);
});
syncBuiltinESMExports();
