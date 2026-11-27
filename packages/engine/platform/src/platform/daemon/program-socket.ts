/**
 * program-socket.ts, the one door through which a terminal program registers with its daemon: a Unix stream socket in
 * the daemon's home (`<daemon home>/programs.sock`, 0600, in a folder no other account may write), where the kernel
 * tells the daemon who connected.
 *
 * The exchange (one JSON object per line):
 *   (before it connects, the program hands the daemon a secret of its own over the loopback listener it calls,
 *    `expectProgramNonce`)
 *   daemon:  {"challenge": <random>}                       the moment the connection is accepted
 *   program: {"hello": <sha256 of its secret>}
 *   daemon:  {"proof": <HMAC of the challenge under the secret>}  only the daemon behind that listener can make it: a
 *            socket another process put at the path gets no token and no window from the program
 *   program: {"answer": <the challenge>, "program": "tui"|"agent", "token": <its operator token>}
 *   daemon:  {"read": true}                                 its own step is over: the program closes itself again
 *   program: {"closed": true}
 *   daemon:  {"key": <the registration>, "program", "port"}  or {"refused": <why>, "code": "PROGRAM_NOT_VERIFIED"}
 * then the connection stays open: the registration lasts exactly as long as it and the program's process.
 *
 * What proves the program (each step is the kernel's word, none the program's):
 *  1. the connecting process: the socket's peer credentials (process, user), taken when it connected, and a handle on
 *     that process (`SO_PEERPIDFD`, a pidfd), so a process number reused later is never mistaken for it; a peer of
 *     another user is refused;
 *  2. the answer came from that very process: the daemon asks the kernel to attach the sender to every message
 *     (`SO_PASSCRED`) before it sends its challenge, and the answer must carry the peer's own process number. A socket
 *     handed to or inherited by another process (a script that connects, then becomes or starts the real program, and
 *     answers from a child) proves nothing; neither does an answer sent on another connection;
 *  3. what that process is (daemon/program-peer.ts): read while the program lets itself be read, which it does from its
 *     answer until the daemon's `read` (the daemon's own step: a few small reads of /proc, made the moment the answer
 *     arrives) and never longer than its own cap; then judged with the program private again.
 * The token names the principal the registration is bound to (the operator token, from this machine: `local`).
 *
 * The registration ends when the program's process ends (its handle becomes readable), when the proving connection
 * closes, and at every daemon restart. Every handshake is its own: several at once never wait on each other; one ends
 * with its process, its connection, or a newer connection taking its place (HANDSHAKES_LIMIT), never on a clock.
 *
 * Linux only (64-bit): elsewhere no socket is opened, no registration is issued, and the programs' acts that the owner
 * decides are put to the owner (in their signed-in web session, or held for them) like any script's.
 */
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { daemonHomeCustodyRefusal } from './daemon-home-custody.js';
import { chmodSync, lstatSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { processIdentity } from '../utils/process-identity.js';
import { COMMAND_LINE_REGISTRATION, isRegisteredProgram, ProgramRegistrations, type RegisteredProgram } from './program-registrations.js';
import { judgePeer, peerPrivateAgain, peerTracedOrForeign, programWords, readPeerInWindow, recordedPrograms, type PeerReading } from './program-peer.js';
import { openUnixPeerCalls, POLLERR, POLLHUP, POLLIN, POLLNVAL, POLLRDHUP } from './unix-peer-socket.js';

/** The program socket's name in the daemon's home. */
export const PROGRAM_SOCKET_NAME = 'programs.sock';
/** The loopback door a program names its secret at before it connects (runtime/client/call-context.ts sends it). */
export const PROGRAM_NONCE_PATH = '/api/control-plane/programs/expect';
/**
 * At most this many handshakes in flight at once: a further connection takes the place of the oldest one still waiting
 * on its program's part (`accept`). No clock ends a handshake: its process ending, its connection closing, a newer
 * connection taking its place, or its own refusal does.
 */
const HANDSHAKES_LIMIT = 16;
/** How often the daemon looks at its socket with nothing in flight, and while a handshake is. */
const IDLE_STEP_MS = 50;
const BUSY_STEP_MS = 1;
/** The longest line either side sends. */
const LINE_LIMIT = 8192;

/** What the daemon hands the socket: who a token is, and the port its listener serves (the key is sent only for it). */
export interface ProgramSocketHost {
  readonly authenticate: (token: string) => { readonly principalId: string; readonly credentialKind: string } | undefined;
  readonly port: () => number;
}

type Phase = 'challenged' | 'reading' | 'judging' | 'registered';

interface Connection {
  readonly fd: number;
  readonly pid: number;
  readonly handle: number;
  readonly challenge: string;
  readonly openedAt: number;
  phase: Phase;
  buffer: string;
  outgoing: Uint8Array;
  program?: RegisteredProgram;
  /** It said it is that program's command line (`do`, `find`): judged as the program, issued as a command line. */
  commandLine?: boolean;
  token?: string;
  reading?: PeerReading;
  end?: () => void;
  /** The program asked for the daemon's proof once (`hello`). */
  proved?: boolean;
}

export interface ProgramSocket {
  readonly path: string;
  stop(): void;
}

let running: { readonly path: string; host: ProgramSocketHost; readonly stop: () => void } | undefined;

/**
 * Whether this daemon can verify its programs: its program socket is open. False on another system and where the
 * socket could not open; then the programs' acts are decided as a script's and the first act in each folder asks
 * the owner once (daemon/unverified-programs.ts).
 */
export function programVerificationAvailable(): boolean {
  return running !== undefined;
}

/** The daemon does not start: its home, or a folder above it, may be written by another account (the message says which and the fix). */
export class DaemonHomeUnsafeError extends Error {
  readonly code = 'DAEMON_HOME_UNSAFE';
  constructor(message: string) { super(message); this.name = 'DaemonHomeUnsafeError'; }
}

/**
 * The secrets programs handed the daemon over its loopback listener just before they connect to the program socket
 * (`expectProgramNonce`), by their hash: a program sends the hash over the socket and the daemon proves, with an HMAC of
 * its challenge under the secret, that it is the daemon behind that listener. A socket someone else put at the path
 * cannot (it never saw the secret), so the program opens itself and sends its token to the daemon alone.
 */
const expected = new Map<string, { readonly nonce: string }>();
/**
 * Secrets kept at once. No clock ends one: it is spent by the one connection that proves it, or, when the table is
 * full, the oldest gives way to the next. Only a program of this machine holding the operator token names one (the
 * router's door refuses anyone else and every browser page), so nobody else can push a program's secret out.
 */
const EXPECTED_LIMIT = 64;

/** Keep one program's secret for its next connection (the router's loopback-only door). False when it is malformed. */
export function expectProgramNonce(nonce: unknown): boolean {
  if (typeof nonce !== 'string' || !/^[0-9a-f]{64}$/.test(nonce)) return false;
  while (expected.size >= EXPECTED_LIMIT) { const oldest = expected.keys().next().value; if (oldest === undefined) break; expected.delete(oldest); }
  expected.set(createHash('sha256').update(nonce).digest('hex'), { nonce });
  return true;
}

/** The daemon's proof for one connection: the HMAC of its challenge under the program's secret (spent), or null. */
function proofFor(hello: unknown, challenge: string): string | null {
  if (typeof hello !== 'string') return null;
  const entry = expected.get(hello);
  if (!entry) return null;
  expected.delete(hello);
  return createHmac('sha256', entry.nonce).update(challenge).digest('hex');
}

/** What the owner does about a refusal, in the words their program shows them at its start (never only a file name). */
function refusalNext(why: string): string {
  const meanwhile = 'Until then this program works as any script would: what is yours to decide is decided under your permission mode, as any outside caller\'s call is.';
  if (/installer recorded|not one of the product's programs/.test(why)) return `Reinstall GoodVibes (its installer records its programs again), then start the program again. ${meanwhile}`;
  if (/loads other code|runs code|native addon|no file the daemon can check|preloads code/.test(why)) {
    return `Start the program on its own, with nothing loaded into it: no LD_PRELOAD, LD_AUDIT, BUN_OPTIONS or NODE_OPTIONS in its environment, no preload in a bunfig.toml where you start it, and no library or add-on from your own folders. If you loaded nothing, something on this computer did: look at what starts the program. ${meanwhile}`;
  }
  return `Start the program again; if this stays, read the daemon's log for this line. ${meanwhile}`;
}

/** The note a daemon leaves in its home while it cannot verify its programs; the programs read it at their start. */
export const UNVERIFIED_NOTE_NAME = 'programs-unverified.txt';

function noteUnverified(daemonHome: string, why: string): void {
  try {
    mkdirSync(daemonHome, { recursive: true, mode: 0o700 });
    writeFileSync(join(daemonHome, UNVERIFIED_NOTE_NAME), `${why}\n`, { mode: 0o600 });
  } catch { /* the programs then say nothing at their start; their acts are still decided as a script's */ }
}

/**
 * Open the program socket of the daemon whose home is `daemonHome` (once per process: a second call hands the same
 * socket the newer host). Undefined where none can be opened (another system, a home another account may write, a path
 * too long), with the reason logged: then no program registers.
 */
export function startProgramSocket(daemonHome: string, registrations: ProgramRegistrations, host: ProgramSocketHost): ProgramSocket | undefined {
  const path = join(daemonHome, PROGRAM_SOCKET_NAME);
  if (running?.path === path) {
    running.host = host;
    return { path, stop: running.stop };
  }
  const calls = openUnixPeerCalls();
  if (!calls) {
    logger.info('[programs] no program socket on this system: the terminal programs are not registered, and their acts the owner decides are put to the owner');
    noteUnverified(daemonHome, `this system (${process.platform}) gives the daemon no way to verify the program that connects`);
    return undefined;
  }
  const uid = calls.effectiveUser();
  // A home another account may write, or a folder above it another account may write, is refused outright: the daemon
  // does not start there (daemon-home-custody.ts), rather than running on with its programs unverified, which a process
  // of the account could otherwise bring about with one chmod (gate-review-6 G10, G16).
  mkdirSync(daemonHome, { recursive: true, mode: 0o700 });
  const unsafe = daemonHomeCustodyRefusal(daemonHome, uid) ?? (statSync(daemonHome).uid !== uid ? `The daemon will not start: its home ${daemonHome} is not this account's.` : undefined);
  if (unsafe !== undefined) {
    logger.error(`[programs] ${unsafe}`);
    throw new DaemonHomeUnsafeError(unsafe);
  }
  // A socket left at the path is replaced only when it is this account's own socket (an earlier run's); anything else
  // there is not the daemon's to remove, and it does not start.
  const left = lstatSync(path, { throwIfNoEntry: false });
  if (left && !(left.isSocket() && left.uid === uid)) {
    const why = `The daemon will not start: ${path} is not a program socket of this account, so it is not the daemon's to replace. Remove it if you put it there: rm ${path}`;
    logger.error(`[programs] ${why}`);
    throw new DaemonHomeUnsafeError(why);
  }
  const listen = (): { readonly fd: number; readonly dev: number; readonly ino: number } | undefined => {
    try { rmSync(path, { force: true }); } catch { /* none */ }
    // Bound with no access for anyone but the account from its first moment (the chmod after it only restates it).
    const mask = process.umask(0o077);
    let fd: number | undefined;
    try { fd = calls.listen(path, 32); } finally { process.umask(mask); }
    if (fd === undefined) return undefined;
    try { chmodSync(path, 0o600); } catch { /* bound 0600 already */ }
    const bound = lstatSync(path, { throwIfNoEntry: false });
    return { fd, dev: bound?.dev ?? -1, ino: bound?.ino ?? -1 };
  };
  let bound = listen();
  if (bound === undefined) {
    logger.warn(`[programs] the program socket ${path} could not be opened: the terminal programs are not registered`);
    noteUnverified(daemonHome, 'the daemon could not open its program socket');
    return undefined;
  }
  let listener = bound.fd;
  // The product's programs' recorded hashes, read once now and held for the run (program-hashes.ts).
  recordedPrograms();
  try { rmSync(join(daemonHome, UNVERIFIED_NOTE_NAME), { force: true }); } catch { /* none */ }
  const state = { path, host, stop: () => {} };
  const connections = new Map<number, Connection>();
  let stopped = false;
  let fast: ReturnType<typeof setTimeout> | undefined;

  const write = (connection: Connection, message: Record<string, unknown>): void => {
    const bytes = new TextEncoder().encode(`${JSON.stringify(message)}\n`);
    const joined = new Uint8Array(connection.outgoing.length + bytes.length);
    joined.set(connection.outgoing);
    joined.set(bytes, connection.outgoing.length);
    connection.outgoing = joined;
    flush(connection);
  };
  const flush = (connection: Connection): void => {
    while (connection.outgoing.length > 0) {
      const sent = calls.send(connection.fd, connection.outgoing);
      if (sent === undefined || sent === 0) return;
      connection.outgoing = connection.outgoing.subarray(sent);
    }
  };
  const drop = (connection: Connection): void => {
    if (!connections.delete(connection.fd)) return;
    if (connection.end) logger.info(`[programs] registration of process ${connection.pid} ended (its process or its connection ended)`);
    connection.end?.();
    if (connection.reading) { try { calls.close(connection.reading.exeFd); } catch { /* closed */ } }
    calls.close(connection.fd);
    calls.close(connection.handle);
  };
  const refuse = (connection: Connection, why: string): void => {
    logger.info(`[programs] no registration was issued to process ${connection.pid}: ${why}`);
    write(connection, { refused: `The daemon could not verify this program: ${why}. ${refusalNext(why)}`, code: 'PROGRAM_NOT_VERIFIED' });
    drop(connection);
  };
  /** Whether the connection's process still runs and its connection is open, asked now. */
  const alive = (connection: Connection): boolean => {
    if (connections.get(connection.fd) !== connection) return false;
    const ready = calls.poll([{ fd: connection.handle, events: POLLIN }, { fd: connection.fd, events: POLLRDHUP }]);
    if (!ready) return false;
    return (ready[0]! & (POLLIN | POLLHUP | POLLERR | POLLNVAL)) === 0 && (ready[1]! & (POLLRDHUP | POLLHUP | POLLERR | POLLNVAL)) === 0;
  };

  const accept = (): void => {
    for (;;) {
      const fd = calls.accept(listener);
      if (fd === undefined) return;
      const peer = calls.peerCredentials(fd);
      if (!peer || peer.uid !== uid || peer.pid <= 0 || !calls.passCredentials(fd)) {
        calls.close(fd);
        continue;
      }
      // Handshakes in flight are bounded by count, never by a clock: a new connection replaces the oldest one still
      // waiting on its program's part (a stalled peer cannot hold the door shut; a real program finishes at once). The
      // daemon's own judging is never cut. A handshake also ends when its process ends or its connection closes.
      const waiting = [...connections.values()].filter((entry) => entry.phase === 'challenged' || entry.phase === 'reading');
      if (waiting.length >= HANDSHAKES_LIMIT) refuse(waiting[0]!, 'a newer connection took its place before it finished the exchange');
      if ([...connections.values()].filter((entry) => entry.phase !== 'registered').length >= HANDSHAKES_LIMIT) {
        calls.close(fd);
        continue;
      }
      const handle = calls.peerProcessHandle(fd, peer.pid);
      if (handle === undefined) { calls.close(fd); continue; }
      const connection: Connection = { fd, pid: peer.pid, handle, challenge: randomBytes(32).toString('hex'), openedAt: Date.now(), phase: 'challenged', buffer: '', outgoing: new Uint8Array(0) };
      connections.set(fd, connection);
      // Asked after the kernel was told to name the sender of every message: any answer is attributed.
      write(connection, { challenge: connection.challenge });
    }
  };

  const onLine = (connection: Connection, line: string): void => {
    let message: Record<string, unknown>;
    try { message = JSON.parse(line) as Record<string, unknown>; } catch { refuse(connection, 'it did not speak the program socket\'s exchange'); return; }
    if (connection.phase === 'challenged' && 'hello' in message && Object.keys(message).length === 1 && !connection.proved) {
      // The program asks the daemon to prove it is the one behind the listener it named its secret to (see `expected`).
      connection.proved = true;
      write(connection, { proof: proofFor(message['hello'], connection.challenge) });
      return;
    }
    if (connection.phase === 'challenged') {
      const program = message['program'];
      if (message['answer'] !== connection.challenge || !isRegisteredProgram(program) || typeof message['token'] !== 'string') {
        refuse(connection, 'it did not answer this connection\'s challenge');
        return;
      }
      // The program is open for reading from its answer until the `read` below: read everything now, in this step.
      const reading = readPeerInWindow(connection.pid, uid);
      connection.program = program;
      // A command line (`do`, `find`) of the product's own binary: its own kind, never that program (program-registrations.ts).
      connection.commandLine = message['commandLine'] === true;
      connection.token = message['token'];
      if ('why' in reading) { refuse(connection, reading.why); return; }
      connection.reading = reading;
      connection.phase = 'reading';
      write(connection, { read: true });
      return;
    }
    if (connection.phase === 'reading' && message['closed'] === true) {
      connection.phase = 'judging';
      void judge(connection);
      return;
    }
    refuse(connection, 'it sent more than the exchange asks');
  };

  const judge = async (connection: Connection): Promise<void> => {
    const reading = connection.reading!;
    connection.reading = undefined;
    const program = connection.program!;
    try {
      // Private again, and still nobody tracing it, now that nobody of the account can start to.
      if (!peerPrivateAgain(connection.pid)) { closeQuietly(reading); refuse(connection, 'it did not make itself private again after the check'); return; }
      const traced = peerTracedOrForeign(connection.pid, uid);
      if (traced) { closeQuietly(reading); refuse(connection, traced); return; }
      const judged = await judgePeer(reading, program, uid);
      if (!connections.has(connection.fd)) return;
      if ('why' in judged) { refuse(connection, judged.why); return; }
      if (!alive(connection)) { drop(connection); return; }
      const principal = state.host.authenticate(connection.token!);
      connection.token = undefined;
      if (!principal || principal.credentialKind !== 'local') { refuse(connection, 'its token is not this daemon\'s operator token'); return; }
      // One live registration per process and program: an earlier one of the same process (a second exchange it made,
      // a reconnect) ends with the new one, so it never holds two.
      for (const other of [...connections.values()]) {
        if (other !== connection && other.pid === connection.pid && other.phase === 'registered' && other.program === program
          && other.commandLine === connection.commandLine) drop(other);
      }
      if (!registrations.hasRoom()) { refuse(connection, 'the daemon holds as many registrations as it keeps'); return; }
      // A command line is issued as its own kind whatever program's binary it runs from: never that program, never a person.
      const issuedAs = connection.commandLine === true ? COMMAND_LINE_REGISTRATION : program;
      const issued = registrations.issue({ principalId: principal.principalId, credentialKind: 'local', program: issuedAs,
        process: processIdentity(connection.pid), alive: () => alive(connection) });
      connection.end = issued.end;
      connection.phase = 'registered';
      logger.info(`[programs] registration issued to ${connection.commandLine === true ? `the command line of ${programWords(program)}` : programWords(program)}, process ${connection.pid}`);
      write(connection, { key: issued.key, program: issuedAs, port: state.host.port() });
    } catch (error) {
      refuse(connection, `the daemon could not finish its check (${error instanceof Error ? error.message : String(error)})`);
    }
  };
  const closeQuietly = (reading: PeerReading): void => { try { calls.close(reading.exeFd); } catch { /* closed */ } };

  // The daemon's own socket at its path, looked at about once a second: one a process of the account removed or put
  // something else in place of is the daemon's to put back (its home is its own), so a socket another process bound
  // there serves for a second at most, and a program it reached got nothing from it (it never proved the daemon's
  // secret, see `expected`).
  let lastCustody = 0;
  const keepOwnPath = (): void => {
    const now = Date.now();
    if (now - lastCustody < 1000) return;
    lastCustody = now;
    const at = lstatSync(path, { throwIfNoEntry: false });
    if (at && at.dev === bound!.dev && at.ino === bound!.ino) return;
    logger.warn(`[programs] the program socket ${path} was removed or replaced by another process; the daemon puts its own back`);
    const again = listen();
    if (again === undefined) return;
    calls.close(listener);
    bound = again;
    listener = again.fd;
  };

  const step = (): void => {
    if (stopped) return;
    keepOwnPath();
    const list = [...connections.values()];
    const ready = calls.poll([{ fd: listener, events: POLLIN },
      ...list.flatMap((connection) => [{ fd: connection.fd, events: POLLIN | POLLRDHUP }, { fd: connection.handle, events: POLLIN }])]);
    if (!ready) return;
    if ((ready[0]! & POLLIN) !== 0) accept();
    list.forEach((connection, index) => {
      if (!connections.has(connection.fd)) return;
      const socketReady = ready[1 + index * 2]!;
      const processReady = ready[2 + index * 2]!;
      // The process ended: its registration with it (and a handshake it never finished).
      if ((processReady & (POLLIN | POLLHUP | POLLERR)) !== 0) { drop(connection); return; }
      if (connection.outgoing.length > 0) flush(connection);
      if ((socketReady & POLLIN) !== 0) {
        const got = calls.receive(connection.fd, 4096);
        if (!got || got.length === 0) { drop(connection); return; }
        if (connection.phase === 'registered' || connection.phase === 'judging') { refuse(connection, 'it sent more than the exchange asks'); return; }
        // Every part of an answer must come from the connected process itself, as the kernel names its sender.
        if (got.sender?.pid !== connection.pid || got.sender.uid !== uid) {
          refuse(connection, got.sender && got.sender.pid > 0 ? `the answer came from another process (${got.sender.pid}) than the one that connected (${connection.pid})` : 'the answer came before the challenge or from no process the kernel names');
          return;
        }
        connection.buffer += new TextDecoder().decode(got.bytes);
        if (connection.buffer.length > LINE_LIMIT) { refuse(connection, 'it sent more than the exchange asks'); return; }
        let at = connection.buffer.indexOf('\n');
        while (at >= 0 && connections.has(connection.fd)) {
          const line = connection.buffer.slice(0, at);
          connection.buffer = connection.buffer.slice(at + 1);
          onLine(connection, line);
          at = connection.buffer.indexOf('\n');
        }
        return;
      }
      if ((socketReady & (POLLHUP | POLLERR | POLLRDHUP | POLLNVAL)) !== 0) drop(connection);
    });
    const busy = [...connections.values()].some((connection) => connection.phase === 'challenged' || connection.phase === 'reading');
    if (busy && fast === undefined) {
      fast = setTimeout(() => { fast = undefined; step(); }, BUSY_STEP_MS);
    }
  };
  const idle = setInterval(step, IDLE_STEP_MS);
  idle.unref?.();
  state.stop = () => {
    if (stopped) return;
    stopped = true;
    clearInterval(idle);
    if (fast !== undefined) clearTimeout(fast);
    for (const connection of [...connections.values()]) drop(connection);
    calls.close(listener);
    // Only the daemon's own socket is removed.
    const at = lstatSync(path, { throwIfNoEntry: false });
    if (at && at.dev === bound!.dev && at.ino === bound!.ino) { try { rmSync(path, { force: true }); } catch { /* gone */ } }
    if (running?.path === path) running = undefined;
  };
  running = state;
  logger.info('[programs] program socket open', { path });
  return { path, stop: () => state.stop() };
}
