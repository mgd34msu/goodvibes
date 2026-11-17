/**
 * Preload for every product process the run-through starts (passed through
 * BUN_OPTIONS, so child bun processes inherit it). Every connection must stay
 * on loopback, and on loopback only the ports this run opened
 * (RUNTHROUGH_PORTS, comma separated): the owner's own daemon listens on the
 * default ports of the same machine and must never be reached from an
 * isolated home.
 */
import net from 'node:net';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { installTestNetworkGuard } from '../../toolchain/src/test-runner/test-network-guard.ts';

const allowed = new Set((process.env.RUNTHROUGH_PORTS ?? '').split(',').map((port) => port.trim()).filter(Boolean));

function refuse(what: string): never {
  const line = `[runthrough guard] refused ${what}`;
  process.stderr.write(`${line}\n`);
  throw new Error(line);
}

installTestNetworkGuard((diagnostic) => { process.stderr.write(`[runthrough guard] ${diagnostic}\n`); });

function checkPort(port: unknown, what: string): void {
  if (port === undefined || port === null || port === '') return;
  const text = String(port);
  if (!allowed.has(text)) refuse(`${what} to loopback port ${text} (not opened by this run)`);
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
  const first = args[0];
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
