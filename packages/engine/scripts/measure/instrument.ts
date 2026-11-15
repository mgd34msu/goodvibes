/**
 * Process-wide counters for one measured scenario: file operations through
 * node:fs, node:fs/promises, Bun.file and Bun.write, bun:sqlite statement
 * executions, the kernel's own I/O accounting from /proc/self/io, and every
 * network attempt (all of which are refused).
 *
 * Import this module before any product code. Bun fixes a builtin's named ESM
 * exports when it is first imported, so the builtins are patched through
 * require and then republished with syncBuiltinESMExports; a later
 * `import { readFileSync } from 'node:fs'` sees the counting version.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { installTestNetworkGuard } from '../../toolchain/src/test-runner/test-network-guard.ts';

const nodeRequire = createRequire(import.meta.url);
const fs = nodeRequire('node:fs') as typeof import('node:fs');
const fsp = nodeRequire('node:fs/promises') as typeof import('node:fs/promises');
const net = nodeRequire('node:net') as typeof import('node:net');
const sqlite = nodeRequire('bun:sqlite') as typeof import('bun:sqlite');

export interface Counters {
  fileReads: number;
  fileWrites: number;
  fsyncs: number;
  bytesWritten: number;
  bytesRead: number;
  stats: number;
  opens: number;
  renames: number;
  readdirs: number;
  mkdirs: number;
  removes: number;
  sqliteStatements: number;
  networkAttempts: number;
}

export interface KernelIo {
  /** read(2)-family syscalls, including native code such as bun:sqlite. */
  osReadCalls: number;
  /** write(2)-family syscalls, including native code such as bun:sqlite. */
  osWriteCalls: number;
  osBytesRead: number;
  osBytesWritten: number;
}

const zero = (): Counters => ({
  fileReads: 0, fileWrites: 0, fsyncs: 0, bytesWritten: 0, bytesRead: 0, stats: 0, opens: 0,
  renames: 0, readdirs: 0, mkdirs: 0, removes: 0, sqliteStatements: 0, networkAttempts: 0,
});

let counters = zero();
/** Sync wrappers that call other patched functions count only the outer call. */
let depth = 0;

export function resetCounters(): void { counters = zero(); }
export function snapshotCounters(): Counters { return { ...counters }; }

const originalReadFileSync = fs.readFileSync.bind(fs);
export function readKernelIo(): KernelIo {
  const text = originalReadFileSync('/proc/self/io', 'utf8') as string;
  const field = (name: string): number => Number(new RegExp(`^${name}: (\\d+)$`, 'm').exec(text)?.[1] ?? 0);
  return { osReadCalls: field('syscr'), osWriteCalls: field('syscw'), osBytesRead: field('rchar'), osBytesWritten: field('wchar') };
}

type Kind = keyof Omit<Counters, 'bytesWritten' | 'bytesRead'>;

function byteLength(value: unknown, encoding?: unknown): number {
  if (typeof value === 'string') return Buffer.byteLength(value, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8');
  if (ArrayBuffer.isView(value)) return value.byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  return 0;
}

function encodingOf(options: unknown): unknown {
  if (typeof options === 'string') return options;
  if (options !== null && typeof options === 'object' && 'encoding' in options) return (options as { encoding?: unknown }).encoding;
  return undefined;
}

type AnyFunction = (...args: unknown[]) => unknown;

/** Replace `target[name]` with a counting wrapper. `measure` sees the arguments and the (awaited) result. */
function wrap(target: object, name: string, kind: Kind, measure?: (args: unknown[], result: unknown) => void): void {
  const record = target as Record<string, unknown>;
  const original = record[name];
  if (typeof original !== 'function') return;
  const fn = original as AnyFunction;
  const wrapped = function (this: unknown, ...args: unknown[]): unknown {
    if (depth > 0) return fn.apply(this, args);
    counters[kind]++;
    depth++;
    let result: unknown;
    try { result = fn.apply(this, args); }
    finally { depth--; }
    if (measure) {
      if (result instanceof Promise) return result.then((value: unknown) => { measure(args, value); return value; });
      measure(args, result);
    }
    return result;
  };
  Object.defineProperty(wrapped, 'name', { value: fn.name });
  try { record[name] = wrapped; } catch { /* a frozen export stays uncounted */ }
}

const addWritten = (bytes: number): void => { counters.bytesWritten += bytes; };
const addRead = (bytes: number): void => { counters.bytesRead += bytes; };
const writtenFromData = (dataIndex: number, optionIndex: number) => (args: unknown[]): void =>
  addWritten(byteLength(args[dataIndex], encodingOf(args[optionIndex])));
const readFromResult = (_args: unknown[], result: unknown): void => addRead(byteLength(result));

// node:fs synchronous and callback forms.
wrap(fs, 'readFileSync', 'fileReads', readFromResult);
wrap(fs, 'readFile', 'fileReads');
wrap(fs, 'readSync', 'fileReads', (_args, result) => addRead(typeof result === 'number' ? result : 0));
wrap(fs, 'read', 'fileReads');
wrap(fs, 'writeFileSync', 'fileWrites', writtenFromData(1, 2));
wrap(fs, 'writeFile', 'fileWrites', writtenFromData(1, 2));
wrap(fs, 'appendFileSync', 'fileWrites', writtenFromData(1, 2));
wrap(fs, 'appendFile', 'fileWrites', writtenFromData(1, 2));
wrap(fs, 'writeSync', 'fileWrites', (_args, result) => addWritten(typeof result === 'number' ? result : 0));
wrap(fs, 'write', 'fileWrites', writtenFromData(1, 4));
wrap(fs, 'writevSync', 'fileWrites', (_args, result) => addWritten(typeof result === 'number' ? result : 0));
for (const name of ['fsyncSync', 'fsync', 'fdatasyncSync', 'fdatasync']) wrap(fs, name, 'fsyncs');
for (const name of ['statSync', 'lstatSync', 'fstatSync', 'stat', 'lstat', 'fstat', 'existsSync', 'exists', 'accessSync', 'access', 'realpathSync', 'realpath']) wrap(fs, name, 'stats');
for (const name of ['openSync', 'open']) wrap(fs, name, 'opens');
for (const name of ['renameSync', 'rename', 'copyFileSync', 'copyFile']) wrap(fs, name, 'renames');
for (const name of ['readdirSync', 'readdir']) wrap(fs, name, 'readdirs');
for (const name of ['mkdirSync', 'mkdir', 'mkdtempSync', 'mkdtemp']) wrap(fs, name, 'mkdirs');
for (const name of ['unlinkSync', 'unlink', 'rmSync', 'rm', 'rmdirSync', 'rmdir']) wrap(fs, name, 'removes');

// node:fs/promises, and the FileHandle methods behind fsp.open.
wrap(fsp, 'readFile', 'fileReads', readFromResult);
wrap(fsp, 'writeFile', 'fileWrites', writtenFromData(1, 2));
wrap(fsp, 'appendFile', 'fileWrites', writtenFromData(1, 2));
for (const name of ['stat', 'lstat', 'access', 'realpath']) wrap(fsp, name, 'stats');
wrap(fsp, 'rename', 'renames');
wrap(fsp, 'copyFile', 'renames');
wrap(fsp, 'readdir', 'readdirs');
wrap(fsp, 'mkdir', 'mkdirs');
wrap(fsp, 'mkdtemp', 'mkdirs');
for (const name of ['unlink', 'rm', 'rmdir']) wrap(fsp, name, 'removes');
let fileHandlePatched = false;
const originalOpen = fsp.open;
const patchedOpen = async function (...args: Parameters<typeof fsp.open>) {
  counters.opens++;
  const handle = await originalOpen(...args);
  if (!fileHandlePatched) {
    fileHandlePatched = true;
    const proto = Object.getPrototypeOf(handle) as object;
    wrap(proto, 'readFile', 'fileReads', readFromResult);
    wrap(proto, 'read', 'fileReads', (_args, result) => addRead(typeof result === 'object' && result !== null && 'bytesRead' in result ? Number((result as { bytesRead: number }).bytesRead) : 0));
    wrap(proto, 'writeFile', 'fileWrites', writtenFromData(0, 1));
    wrap(proto, 'appendFile', 'fileWrites', writtenFromData(0, 1));
    wrap(proto, 'write', 'fileWrites', (_args, result) => addWritten(typeof result === 'object' && result !== null && 'bytesWritten' in result ? Number((result as { bytesWritten: number }).bytesWritten) : 0));
    wrap(proto, 'sync', 'fsyncs');
    wrap(proto, 'datasync', 'fsyncs');
    wrap(proto, 'stat', 'stats');
  }
  return handle;
};
(fsp as { open: typeof fsp.open }).open = patchedOpen as typeof fsp.open;
if (fs.promises && fs.promises !== fsp) {
  for (const name of ['readFile', 'writeFile', 'appendFile', 'stat', 'lstat', 'access', 'realpath', 'rename', 'readdir', 'mkdir', 'unlink', 'rm']) {
    try { (fs.promises as unknown as Record<string, unknown>)[name] = (fsp as unknown as Record<string, unknown>)[name]; } catch { /* left uncounted */ }
  }
  try { (fs.promises as { open: typeof fsp.open }).open = patchedOpen as typeof fsp.open; } catch { /* left uncounted */ }
}

// Bun.write and Bun.file.
const bun = Bun as unknown as Record<string, unknown>;
const originalBunWrite = Bun.write.bind(Bun) as AnyFunction;
try {
  bun['write'] = function (...args: unknown[]): unknown {
    counters.fileWrites++;
    addWritten(byteLength(args[1]));
    return originalBunWrite(...args);
  };
} catch { /* left uncounted */ }
const originalBunFile = Bun.file.bind(Bun) as AnyFunction;
try {
  bun['file'] = function (...args: unknown[]): unknown {
    const file = originalBunFile(...args) as Record<string, unknown>;
    for (const name of ['text', 'json', 'arrayBuffer', 'bytes']) {
      const method = file[name];
      if (typeof method !== 'function') continue;
      try {
        Object.defineProperty(file, name, { configurable: true, value: (...inner: unknown[]) => {
          counters.fileReads++;
          return (method as AnyFunction).apply(file, inner);
        } });
      } catch { /* left uncounted */ }
    }
    const exists = file['exists'];
    if (typeof exists === 'function') {
      try { Object.defineProperty(file, 'exists', { configurable: true, value: () => { counters.stats++; return (exists as AnyFunction).call(file); } }); } catch { /* left uncounted */ }
    }
    return file;
  };
} catch { /* left uncounted */ }

// bun:sqlite: every statement execution (native I/O shows up in the kernel counters).
// Statement methods are own properties of each statement, so they are wrapped
// as prepare/query hand a statement out (query caches, hence the WeakSet).
for (const name of ['run', 'exec']) wrap(sqlite.Database.prototype, name, 'sqliteStatements');
const wrappedStatements = new WeakSet<object>();
for (const name of ['prepare', 'query']) {
  const original = sqlite.Database.prototype[name as 'prepare'] as AnyFunction;
  (sqlite.Database.prototype as unknown as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]): unknown {
    const statement = original.apply(this, args) as object;
    if (!wrappedStatements.has(statement)) {
      wrappedStatements.add(statement);
      for (const method of ['run', 'all', 'get', 'values', 'iterate']) wrap(statement, method, 'sqliteStatements');
    }
    return statement;
  };
}

syncBuiltinESMExports();

// Network: nothing may leave the process. External destinations are refused by
// the test guard; loopback is refused here as well unless MEASURE_ALLOW_LOOPBACK=1
// (only the daemon start-up timing sets it, to talk to its own listener), or the
// port belongs to an in-process fixture server a scenario registered with
// allowFixturePort; those requests are counted, not refused.
export const networkLog: string[] = [];
const fixturePorts = new Set<string>();
export const fixtureTraffic = { requests: 0, bytes: 0 };
export function allowFixturePort(port: number): void { fixturePorts.add(String(port)); }
export function resetFixtureTraffic(): void { fixtureTraffic.requests = 0; fixtureTraffic.bytes = 0; }
// A server started in this process (only test fixtures do, in these scenarios) may be reached.
const originalServe = Bun.serve.bind(Bun) as AnyFunction;
try {
  bun['serve'] = (...args: unknown[]): unknown => {
    const server = originalServe(...args) as { port?: number };
    if (typeof server.port === 'number') allowFixturePort(server.port);
    return server;
  };
} catch { /* fixture servers stay unreachable */ }
installTestNetworkGuard((diagnostic) => { counters.networkAttempts++; networkLog.push(diagnostic); });
if (process.env.MEASURE_ALLOW_LOOPBACK !== '1') {
  const refuse = (what: string): never => {
    counters.networkAttempts++;
    networkLog.push(what);
    throw new Error(`measure harness: network refused (${what})`);
  };
  const guardedFetch = globalThis.fetch;
  const strictFetch = (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('file:')) return guardedFetch(input, init);
    const parsed = URL.canParse(url) ? new URL(url) : undefined;
    if (parsed && (parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost') && fixturePorts.has(parsed.port)) {
      fixtureTraffic.requests++;
      fixtureTraffic.bytes += byteLength(init?.body);
      return guardedFetch(input, init);
    }
    counters.networkAttempts++;
    networkLog.push(`fetch ${url}`);
    return Promise.reject(new Error(`measure harness: network refused (fetch ${url})`));
  };
  globalThis.fetch = Object.assign(strictFetch, { preconnect: () => undefined }) as unknown as typeof fetch;
  const socketConnect = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function (this: import('node:net').Socket, ...args: unknown[]) {
    // node:net hands its own normalized [options, callback] array to connect.
    const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
    const path = typeof first === 'string' && !/^\d+$/.test(first) ? first
      : first !== null && typeof first === 'object' && 'path' in first ? (first as { path?: unknown }).path : undefined;
    if (typeof path === 'string') return (socketConnect as AnyFunction).apply(this, args) as import('node:net').Socket;
    const options = first !== null && typeof first === 'object' ? first as { port?: unknown; host?: unknown } : undefined;
    const port = String(options ? options.port : first);
    const host = String((options ? options.host : args[1]) ?? '127.0.0.1');
    if ((host === '127.0.0.1' || host === 'localhost' || host === '::1') && fixturePorts.has(port)) {
      fixtureTraffic.requests++;
      return (socketConnect as AnyFunction).apply(this, args) as import('node:net').Socket;
    }
    return refuse(`tcp connect ${host}:${port} ${new Error().stack?.split('\n').slice(2, 7).map((line) => line.trim()).join(' < ') ?? ''}`);
  } as typeof net.Socket.prototype.connect;
  const bunConnect = Bun.connect.bind(Bun) as AnyFunction;
  try {
    bun['connect'] = (options: { unix?: string }) => options?.unix !== undefined ? bunConnect(options) : refuse('Bun.connect');
  } catch { /* the test guard still blocks external hosts */ }
}
