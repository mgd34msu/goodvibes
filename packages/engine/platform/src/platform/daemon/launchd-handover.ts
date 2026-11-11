/** A launchd-owned, one-shot worker survives the old daemon's complete drain.
 * Admission acknowledges the helper, not replacement health. The helper starts
 * the canonical job only after COMMIT and closure of the old process's socket. */
import { spawn } from 'node:child_process';
import { chmodSync, lstatSync, mkdtempSync, realpathSync, rmdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { createConnection, createServer, type Socket } from 'node:net';
import { basename, isAbsolute, join } from 'node:path';
import type { ServiceHandoverOutcome } from './service-handover.js';

export interface LaunchdHandoverReservation {
  readonly exitRequired: true;
  assertCurrent(): void;
  commit(signal?: AbortSignal): Promise<ServiceHandoverOutcome>;
  cancel(): Promise<void>;
}
export interface LaunchdHandoverInput {
  readonly serviceName: string;
  readonly servicePath: string;
  readonly executablePath: string;
  readonly uid: number;
  readonly pid: number;
  readonly timeoutMs: number;
  /** Selected loaded job/path/current PID; deliberately not the replaced inode. */
  assertServiceCurrent(): void;
}
type Command = (args: readonly string[], timeoutMs: number, signal?: AbortSignal) => Promise<void>;
export interface LaunchdJobObservation { readonly loaded: boolean; readonly pid?: number }
type Query = (serviceName: string, timeoutMs: number, signal?: AbortSignal) => Promise<LaunchdJobObservation>;
export interface LaunchdHandoverDependencies { readonly command?: Command; readonly query?: Query }
const mode = '--internal-launchd-handover';
const frames = ['READY', 'COMMIT', 'ARMED', 'CANCEL', 'CANCELLED'] as const;
const fail = (): Error => new Error('The launchd handover worker could not be confirmed.');
function checkSignal(signal?: AbortSignal): void { if (signal?.aborted) throw signal.reason; }
function labelValid(value: string): boolean { return value.length > 0 && !/[\s/\x00-\x1f\x7f]/.test(value); }
function xml(value: string): string { return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]!); }
function directoryOwner(path: string): () => void {
  const original = lstatSync(path, { bigint: true });
  if (!original.isDirectory() || original.isSymbolicLink() || Number(original.uid) !== process.getuid?.() || (original.mode & 0o777n) !== 0o700n) throw fail();
  return () => {
    const current = lstatSync(path, { bigint: true });
    if (!current.isDirectory() || current.dev !== original.dev || current.ino !== original.ino
      || current.uid !== original.uid || current.mode !== original.mode) throw fail();
  };
}
function cleanupDirectory(directory: string, assertDirectory: () => void): void {
  try { assertDirectory(); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return;
    throw error;
  }
  for (const name of ['worker.plist', 'control.sock']) {
    try { unlinkSync(join(directory, name)); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') throw error; }
  }
  // Preserve any unexpected child rather than recursively deleting private state.
  rmdirSync(directory);
}

/** Own the manager client until close, including cancellation/timeout kills. */
function managerCommand(args: readonly string[], timeoutMs: number, signal?: AbortSignal, output?: (data: string) => void): Promise<void> { return new Promise((resolve, reject) => {
  try { checkSignal(signal); } catch (error) { reject(error); return; }
  let child: ReturnType<typeof spawn>;
  let failure: unknown;
  let failed = false;
  const record = (error: unknown): void => { if (!failed) { failed = true; failure = error; } };
  const kill = (): void => { try { if (child.pid) process.kill(-child.pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== 'ESRCH') record(error); } };
  const abort = (): void => { record(signal?.reason); kill(); };
  const timer = setTimeout(() => { record(fail()); kill(); }, timeoutMs);
  try {
    child = spawn('/bin/launchctl', [...args], { stdio: ['ignore', output ? 'pipe' : 'ignore', 'ignore'], detached: true });
    if (output && child.stdout) { child.stdout.setEncoding('utf8'); child.stdout.on('data', output); child.stdout.once('error', record); }
    child.once('error', record);
    child.once('close', code => {
      clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failed) reject(failure); else if (code === 0) resolve(); else reject(fail());
    });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  } catch (error) { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(error); }
}); }
export const runLaunchdCommand: Command = (args, timeoutMs, signal) => managerCommand(args, timeoutMs, signal);

/** Parse only launchctl's public tabular PID/exit-status/label listing. Never
 * retain a print dump, loaded environment, arguments, or other runtime values. */
export const queryLaunchdJob: Query = async (serviceName, timeoutMs, signal) => {
  let observation: LaunchdJobObservation = { loaded: false };
  let line = '', skipping = false;
  const consume = (value: string) => {
    const match = /^([0-9]+|-)\s+(-?[0-9]+)\s+(.+)$/.exec(value);
    if (match?.[3] === serviceName) {
      const pid = match[1] === '-' ? undefined : Number(match[1]);
      observation = { loaded: true, ...(pid !== undefined && Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}) };
    }
  };
  await managerCommand(['list'], timeoutMs, signal, data => {
    for (const char of data) {
      if (char === '\n') { if (!skipping) consume(line); line = ''; skipping = false; }
      else if (!skipping) {
        line += char;
        // A selected tabular row contains only a PID, status and exact label.
        if (line.length > serviceName.length + 64) { line = ''; skipping = true; }
      }
    }
  });
  if (line && !skipping) consume(line);
  return observation;
};
async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  checkSignal(signal);
  await new Promise<void>((resolve, reject) => {
    const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
  });
}
async function observeJob(query: Query, serviceName: string, timeoutMs: number, accept: (job: LaunchdJobObservation) => boolean, signal?: AbortSignal): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    checkSignal(signal);
    const remaining = deadline - performance.now(); if (remaining <= 0) throw fail();
    if (accept(await query(serviceName, remaining, signal))) return;
    await delay(Math.min(50, Math.max(0, deadline - performance.now())), signal);
  }
}

class Peer {
  readonly closed: Promise<void>;
  private buffer = '';
  private queue: Array<string | null> = [];
  private wake: (() => void) | undefined;
  private failure: unknown;
  private failed = false;
  ended = false;
  constructor(readonly socket: Socket) {
    this.closed = new Promise(resolve => socket.once('close', () => { this.ended = true; this.wake?.(); resolve(); }));
    socket.setEncoding('utf8');
    socket.on('error', error => { this.failed = true; this.failure = error; this.wake?.(); });
    socket.on('end', () => { this.ended = true; this.queue.push(null); this.wake?.(); });
    socket.on('data', (data: string) => {
      this.buffer += data;
      while (this.buffer.includes('\n')) {
        const index = this.buffer.indexOf('\n');
        const value = this.buffer.slice(0, index); this.buffer = this.buffer.slice(index + 1);
        if (!frames.some(frame => frame === value)) { this.failed = true; this.failure = fail(); break; }
        this.queue.push(value);
      }
      if (this.buffer && !frames.some(frame => `${frame}\n`.startsWith(this.buffer))) { this.failed = true; this.failure = fail(); }
      this.wake?.();
    });
  }
  send(value: typeof frames[number]): void { if (this.ended || this.socket.destroyed) throw fail(); this.socket.write(`${value}\n`); }
  async next(timeoutMs?: number, signal?: AbortSignal): Promise<string | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timeout = false;
    const abort = () => this.wake?.();
    signal?.addEventListener('abort', abort, { once: true });
    if (timeoutMs !== undefined) timer = setTimeout(() => { timeout = true; this.wake?.(); }, timeoutMs);
    try {
      for (;;) {
        checkSignal(signal);
        if (timeout) throw fail();
        if (this.failed) throw this.failure;
        if (this.queue.length) return this.queue.shift()!;
        if (this.ended) return null;
        await new Promise<void>(resolve => { this.wake = resolve; });
      }
    } finally { this.wake = undefined; clearTimeout(timer); signal?.removeEventListener('abort', abort); }
  }
}

export async function reserveLaunchdHandover(input: LaunchdHandoverInput, signal?: AbortSignal, dependencies: LaunchdHandoverDependencies = {}): Promise<LaunchdHandoverReservation> {
  checkSignal(signal); input.assertServiceCurrent();
  if (!labelValid(input.serviceName) || !Number.isSafeInteger(input.uid) || input.uid < 0
    || input.uid !== process.getuid?.() || input.pid !== process.pid || !isAbsolute(input.executablePath) || !isAbsolute(input.servicePath)
    || !Number.isFinite(input.timeoutMs) || input.timeoutMs <= 0) throw fail();
  const command = dependencies.command ?? runLaunchdCommand;
  const query = dependencies.query ?? queryLaunchdJob;
  // Darwin's Unix socket pathname is short. /tmp is canonicalized before use.
  const directory = mkdtempSync(join(realpathSync('/tmp'), 'gv-handover-'));
  chmodSync(directory, 0o700);
  const assertDirectory = directoryOwner(directory);
  const helperLabel = `sh.goodvibes.handover.${basename(directory)}`;
  const domain = `gui/${input.uid}`;
  const target = `${domain}/${input.serviceName}`;
  const helperTarget = `${domain}/${helperLabel}`;
  const socketPath = join(directory, 'control.sock');
  const plistPath = join(directory, 'worker.plist');
  let peer: Peer | undefined;
  let listenFailure: unknown;
  let connectionWake: (() => void) | undefined;
  let cancelled = false;
  let armed = false;
  let attemptedBootstrap = false;
  let cancellation: Promise<void> | undefined;
  const server = createServer(socket => {
    if (peer || cancelled) { socket.destroy(); return; }
    peer = new Peer(socket); connectionWake?.();
  });
  server.on('error', error => { listenFailure = error; connectionWake?.(); });
  const cancel = (): Promise<void> => cancellation ??= (async () => {
    cancelled = true;
    const failures: unknown[] = [];
    // Do not turn cancellation into the ARMED worker's EOF trigger. Obtain
    // its unarmed acknowledgement before closing, or keep IPC open until the
    // manager proves that this exact helper has retired.
    let unarmed = false;
    if (peer && !peer.ended) {
      try {
        peer.send('CANCEL');
        const deadline = performance.now() + input.timeoutMs;
        while (performance.now() < deadline) {
          const message = await peer.next(Math.max(1, deadline - performance.now()));
          if (message === 'CANCELLED') { unarmed = true; break; }
          if (message === null) break;
          if (message !== 'READY' && message !== 'ARMED') throw fail();
        }
      } catch { /* exact manager retirement remains authoritative below */ }
    }
    if (unarmed) peer!.socket.end();
    if (attemptedBootstrap) {
      // LaunchOnlyOnce can remove a successfully canceled/exited job before
      // bootout runs. Only a fresh absent-job observation resolves that race.
      let bootoutFailure: unknown;
      try { await command(['bootout', helperTarget], input.timeoutMs); } catch (error) { bootoutFailure = error; }
      try { await observeJob(query, helperLabel, input.timeoutMs, job => !job.loaded); }
      catch (error) { if (bootoutFailure !== undefined) failures.push(bootoutFailure); failures.push(error); }
    }
    if (failures.length) {
      // Preserve a possibly armed live connection and its private state. The
      // caller receives a retirement failure, never a successful drain receipt.
      throw new AggregateError(failures, 'The launchd handover helper could not be fully retired.');
    }
    peer?.socket.destroy();
    if (peer) await peer.closed;
    await new Promise<void>(resolve => server.close(() => resolve()));
    cleanupDirectory(directory, assertDirectory);
  })();
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError); server.once('listening', onListening); server.listen(socketPath);
    });
    chmodSync(socketPath, 0o600);
    const args = [input.executablePath, mode, directory, helperLabel, target, String(input.pid), String(input.timeoutMs)];
    writeFileSync(plistPath, `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>${xml(helperLabel)}</string><key>ProgramArguments</key><array>${args.map(arg => `<string>${xml(arg)}</string>`).join('')}</array><key>RunAtLoad</key><true/><key>KeepAlive</key><false/><key>LaunchOnlyOnce</key><true/><key>StandardOutPath</key><string>/dev/null</string><key>StandardErrorPath</key><string>/dev/null</string></dict></plist>`, { mode: 0o600, flag: 'wx' });
    checkSignal(signal); input.assertServiceCurrent(); assertDirectory();
    attemptedBootstrap = true;
    await command(['bootstrap', domain, plistPath], input.timeoutMs, signal);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const wake = () => connectionWake?.();
    signal?.addEventListener('abort', wake, { once: true });
    try {
      timer = setTimeout(() => { timedOut = true; wake(); }, input.timeoutMs);
      while (!peer) {
        checkSignal(signal); if (listenFailure) throw listenFailure; if (timedOut) throw fail();
        await new Promise<void>(resolve => { connectionWake = resolve; });
      }
    } finally { clearTimeout(timer); connectionWake = undefined; signal?.removeEventListener('abort', wake); }
    if (await peer.next(input.timeoutMs, signal) !== 'READY') throw fail();
    const assertCurrent = (): void => {
      if (cancelled || armed || !peer || peer.ended || peer.socket.destroyed) throw fail();
      assertDirectory(); input.assertServiceCurrent();
    };
    assertCurrent();
    return Object.freeze({
      exitRequired: true as const,
      assertCurrent,
      async commit(commitSignal?: AbortSignal): Promise<ServiceHandoverOutcome> {
        try {
          checkSignal(commitSignal); assertCurrent(); peer!.send('COMMIT');
          if (await peer!.next(input.timeoutMs, commitSignal) !== 'ARMED') throw fail();
          checkSignal(commitSignal); armed = true;
          // The socket remains open until actual process exit. No command may
          // kill this process before the helper admission has been observed.
          peer!.socket.unref(); server.unref();
          return { status: 'accepted', detail: 'launchd accepted the one-shot handover; replacement health is pending' };
        } catch (error) {
          try { await cancel(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Launchd handover admission and retirement failed.'); }
          throw error;
        }
      },
      cancel,
    });
  } catch (error) {
    try { await cancel(); } catch (cleanup) { throw new AggregateError([error, cleanup], 'Launchd handover reservation and retirement failed.'); }
    throw error;
  }
}

/** Invoked before all native SQLite/installation admission by the shipped binary.
 * No application runtime, database, payload reread, or PID-kill occurs here. */
export async function runLaunchdHandoverWorker(args: readonly string[], signal?: AbortSignal, dependencies: LaunchdHandoverDependencies = {}): Promise<number> {
  const [directory, helperLabel, target, pidText, timeoutText] = args;
  const originalPid = Number(pidText);
  const timeoutMs = Number(timeoutText);
  const domain = `gui/${process.getuid?.()}`;
  if (args.length !== 5 || !directory || !isAbsolute(directory) || !helperLabel || !labelValid(helperLabel)
    || !helperLabel.startsWith('sh.goodvibes.handover.') || !target?.startsWith(`${domain}/`)
    || !labelValid(target.slice(domain.length + 1)) || !Number.isSafeInteger(originalPid) || originalPid <= 0 || !Number.isFinite(timeoutMs) || timeoutMs <= 0) return 1;
  checkSignal(signal);
  const assertDirectory = directoryOwner(directory);
  const socket = createConnection(join(directory, 'control.sock'));
  const peer = new Peer(socket);
  let committed = false;
  let canceled = false;
  let failed = false;
  let primaryFailure: unknown;
  const abort = () => socket.destroy();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      const clear = () => { socket.removeListener('connect', connected); socket.removeListener('error', errored); socket.removeListener('close', closed); };
      const connected = () => { clear(); resolve(); };
      const errored = (error: Error) => { clear(); reject(signal?.aborted ? signal.reason : error); };
      const closed = () => { clear(); reject(signal?.aborted ? signal.reason : fail()); };
      socket.once('connect', connected); socket.once('error', errored); socket.once('close', closed);
      if (signal?.aborted) { socket.destroy(); closed(); }
    });
    checkSignal(signal); assertDirectory(); peer.send('READY');
    for (;;) {
      const message = await peer.next(undefined, signal);
      if (message === 'COMMIT' && !committed && !canceled) { committed = true; peer.send('ARMED'); }
      else if (message === 'CANCEL') {
        canceled = true; committed = false; peer.send('CANCELLED');
        // The parent bootouts this exact helper and waits for manager + IPC
        // retirement; don't close an armed channel ahead of that operation.
      } else if (message === null) {
        checkSignal(signal);
        if (committed) {
          assertDirectory();
          await peer.closed;
          await observeJob(dependencies.query ?? queryLaunchdJob, target.slice(domain.length + 1), timeoutMs, job => {
            if (!job.loaded) throw fail();
            return job.pid !== originalPid;
          }, signal);
          checkSignal(signal);
          await (dependencies.command ?? runLaunchdCommand)(['kickstart', target], timeoutMs, signal);
        }
        return 0;
      } else throw fail();
    }
  } catch (error) { failed = true; primaryFailure = error; throw error; }
  finally {
    signal?.removeEventListener('abort', abort);
    socket.destroy(); await peer.closed;
    try { cleanupDirectory(directory, assertDirectory); }
    catch (error) { if (failed) throw new AggregateError([primaryFailure, error], 'Launchd worker and private-state retirement failed.'); throw error; }
  }
}

