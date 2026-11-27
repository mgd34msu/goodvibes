/**
 * call-context.ts, the one call context a terminal program carries on every call it makes to the daemon.
 *
 * Who asks is the credential (the bearer, as before). The rest is said once, by the program, when it starts, and
 * sent as three headers on every request any part of the program makes (its places, its model's tools, its held
 * calls, its notices, its command line):
 *   - `x-goodvibes-client`:  the program (`tui` or `agent`), as it was already sent;
 *   - `x-goodvibes-project`: the project folder the program works in (URI-encoded);
 *   - `x-goodvibes-session`: the conversation the program holds now (it moves with /clear, resume, fork).
 * The daemon reads them into the invocation's `context.call` (daemon-api control-routes.ts `readCallContext`,
 * control-plane/method-catalog-shared.ts `CallContext`); `capabilities.run` folds its body fields
 * (`workingDirectory`, `program`, `sessionId`: the same context given by hand, as the web UI's project chooser and
 * an outside caller give it) over them. The daemon never fills a missing project with its own folder.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, lstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { resolveGoodVibesDaemonHome } from '../../config/goodvibes-home.js';
import { openForReading } from '../../utils/process-privacy.js';
import { shortSocketPath } from '../../utils/short-socket-path.js';
import { encodeCarriedExposure, exposureNow, exposureOf } from '../../security/conversation-exposure.js';

/** The header naming the program (unchanged: the daemon reads `tui`, `agent`, anything else as the web). */
export const CALL_PROGRAM_HEADER = 'x-goodvibes-client';
/** The header naming the project folder the call acts in, URI-encoded. */
export const CALL_PROJECT_HEADER = 'x-goodvibes-project';
/** The header naming the conversation the call came from. */
export const CALL_SESSION_HEADER = 'x-goodvibes-session';
/**
 * The header saying the program's conversation read text from outside (its own turn: a page, a tool server's answer, a
 * file from an untrusted place), and where (security/conversation-exposure.ts `encodeCarriedExposure`). The daemon cannot
 * see a read made in the program, so the program says so on every call while its conversation is exposed; the daemon
 * then decides as for its own turn after such a read. It only ever tightens: absent, nothing is cleared.
 */
export const CALL_READ_OUTSIDE_HEADER = 'x-goodvibes-read-outside';

/**
 * The header carrying the registration the daemon issued this program over its program socket: what tells the terminal
 * app, the Agent, a command line and a script apart when they hold the same operator token. Issued by the daemon of
 * this machine only, kept in this process's memory only, sent only to that daemon's own listener. Never logged or shown.
 */
export const CALL_PROGRAM_KEY_HEADER = 'x-goodvibes-program-key';

/** What a program says about itself once, read again at every call (the session moves, the folder may). */
export interface ProgramCallContext {
  readonly program: 'tui' | 'agent';
  readonly project: () => string | undefined;
  readonly sessionId: () => string | undefined;
}

/** A registration this process holds: the key, the port of the daemon listener it is for, and its open connection. */
interface HeldRegistration {
  readonly key: string;
  readonly port: number;
  readonly end: () => void;
}

/**
 * The registrations this process holds, by the program socket that issued each and the credential it was issued to:
 * asked for once, in memory only. Each lasts as long as the connection that proved it stays open (platform
 * daemon/program-socket.ts): when the daemon goes, it is dropped here, and the next call registers again.
 */
const registrations = new Map<string, Promise<HeldRegistration | undefined>>();
const REGISTRATIONS_LIMIT = 8;
/** The program socket's name in the daemon's home (platform daemon/program-socket.ts PROGRAM_SOCKET_NAME). */
const PROGRAM_SOCKET_NAME = 'programs.sock';
/** The loopback door the program names its secret at (platform daemon/program-socket.ts PROGRAM_NONCE_PATH). */
const PROGRAM_NONCE_PATH = '/api/control-plane/programs/expect';
/**
 * The longest this process lets its account read it for one registration (platform daemon/program-peer.ts
 * PROGRAM_WINDOW_CAP_MS): closed by its own timer then, whatever the far end does.
 */
const WINDOW_CAP_MS = 150;
/** The longest one registration exchange may take, by this process's clock. */
const EXCHANGE_LIMIT_MS = 10000;
/** After an exchange that opened this process for reading and brought no answer, none is tried again before this. */
const RETRY_AFTER_MS = 2000;
/** The same after the far end closed the connection mid-exchange (a daemon stopping): a moment only. */
const RETRY_AFTER_CLOSE_MS = 250;
// Nothing is forgotten when the daemon connection comes back: a registration lasts exactly as long as its proving
// connection, which a daemon that went away (restarted, replaced) has closed already (its entry left `registrations`
// then), so one still held is this same daemon's and stays; ending it at every attach would start a second exchange
// while the first is in flight (the terminal app announces an attach twice at its start). No refusal is kept either:
// every new exchange is a new connection, asked afresh (no sooner than RETRY_AFTER_MS after one that brought no key).
let retryNotBefore = 0;

/** The credential each of this process's Agent credentials was made with (in memory only, never written). */
const delegatedFrom = new Map<string, string>();
const DELEGATED_LIMIT = 32;

/**
 * Say that `delegated` (the Agent's own credential, kind `agent` at the daemon) was made with `ordinary` (the credential
 * the program registered with): a call this program makes with `delegated` sends the registration issued for
 * `ordinary`, the only way the daemon takes that credential as this Agent's (platform daemon/method-owner-decision.ts
 * `ownersAgentProgram`).
 */
export function bindDelegatedCredential(delegated: string, ordinary: string): void {
  if (!delegated || !ordinary || delegated === ordinary) return;
  delegatedFrom.delete(delegated);
  delegatedFrom.set(delegated, ordinary);
  while (delegatedFrom.size > DELEGATED_LIMIT) {
    const oldest = delegatedFrom.keys().next().value;
    if (oldest === undefined) break;
    delegatedFrom.delete(oldest);
  }
}

/** The port of a daemon address on this machine (loopback), or undefined for any other address. */
function loopbackPort(target: string): number | undefined {
  let url: URL;
  try { url = new URL(target); } catch { return undefined; }
  if (!['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)) return undefined;
  return Number(url.port || (url.protocol === 'https:' ? 443 : 80));
}

/**
 * The program socket of this machine's daemon (`<daemon home>/programs.sock`), only when it is a socket of this account
 * in a folder no other account may write: this process never answers a socket someone else could have placed.
 */
function programSocketPath(): string | undefined {
  if (process.platform !== 'linux' || typeof process.getuid !== 'function') return undefined;
  const path = join(resolveGoodVibesDaemonHome(homedir()), PROGRAM_SOCKET_NAME);
  try {
    const socket = lstatSync(path, { throwIfNoEntry: false });
    const folder = statSync(dirname(path));
    const uid = process.getuid();
    if (!socket?.isSocket() || socket.uid !== uid || folder.uid !== uid || (folder.mode & 0o022) !== 0) return undefined;
  } catch {
    return undefined;
  }
  return path;
}

/**
 * The one sentence a terminal program says at its start where this computer cannot prove it to the daemon (another
 * system, or a daemon that left its note: platform daemon/program-socket.ts UNVERIFIED_NOTE_NAME); undefined where
 * it can.
 */
export function programVerificationNotice(): string | undefined {
  const why = programUnverifiedReason();
  return why === undefined ? undefined
    : `This computer cannot prove this program to the daemon, so the first act in each folder asks you once, and every act you decide is put to you in Waiting for you (${why}).`;
}

/**
 * The Agent's sentence where this computer cannot prove it to the daemon: its own work (a turn handed to the daemon,
 * Work, purchase windows) needs a program the daemon can prove or a device the owner paired, so it is refused here,
 * and the way through is pairing this computer as the owner's device. Undefined where the program can be proved.
 */
export function agentVerificationRefusal(): string | undefined {
  const why = programUnverifiedReason();
  return why === undefined ? undefined
    : `The Agent cannot work here yet: this computer cannot prove this program to the daemon (${why}), and the Agent's own work runs only for a program the daemon can prove or a device you paired yourself. To use it, pair it as your device from your own screen: in your signed-in web UI, Devices and network, Pair something, "Show the sign-in code once"; then run goodvibes-agent setup pair --with-code in a terminal here and type that code. (A pairing someone else asks for and you approve gives it a key of its own, never your device.)`;
}

/** Why this computer cannot prove its programs to the daemon (another system, or the daemon's note); undefined when it can. */
function programUnverifiedReason(): string | undefined {
  if (process.platform !== 'linux') return `on ${process.platform} the daemon has no way to verify the program that connects`;
  try {
    const why = readFileSync(join(resolveGoodVibesDaemonHome(homedir()), 'programs-unverified.txt'), 'utf8').trim();
    return why || undefined;
  } catch {
    return undefined;
  }
}

const refusalListeners = new Set<(why: string) => void>();
let lastRefusalTold: string | undefined;

/**
 * Be told, once per distinct refusal, why the daemon did not verify this program (the daemon's sentence: what it found
 * and what to do), so the program says it on screen as a notice. Returns the unsubscribe.
 */
export function onProgramRegistrationRefused(listener: (why: string) => void): () => void {
  refusalListeners.add(listener);
  return () => { refusalListeners.delete(listener); };
}

function tellRefused(why: string): void {
  const text = why.slice(0, 600);
  if (text === lastRefusalTold) return;
  lastRefusalTold = text;
  for (const listener of [...refusalListeners]) { try { listener(text); } catch { /* one listener cannot stop the others */ } }
}

/** The entry file this process runs from source, held open while it is read (the kernel names it); none when installed. */
function openOwnEntry(): number | undefined {
  const entry = typeof Bun !== 'undefined' ? Bun.main : undefined;
  if (!entry || entry.startsWith('/$bunfs') || !existsSync(entry)) return undefined;
  try { return openSync(entry, 'r'); } catch { return undefined; }
}

/**
 * One registration exchange over the program socket at `path` (platform daemon/program-socket.ts): the challenge
 * answered by this process on the connection it opened itself, this process open for the daemon's reading from its
 * answer until the daemon's `read` (its own timer closes it after WINDOW_CAP_MS whatever arrives), then the key. The
 * connection stays open for as long as the registration lasts; `onEnded` runs when it closes.
 */
function exchange(path: string, token: string, program: 'tui' | 'agent' | 'daemon', onEnded: () => void, asCommandLine = false, origin?: string): Promise<HeldRegistration | undefined> {
  // A secret of this process's own, named to the daemon over the loopback listener it is about to call (only the daemon
  // listening there can hold it): over the socket the daemon proves it with an HMAC of its challenge before this process
  // opens itself or sends its token, so a socket another process put at the path gets nothing (gate-review-6 G10).
  const nonce = randomBytes(32).toString('hex');
  const named = origin === undefined ? Promise.resolve(false)
    // With the operator token (the daemon names the secret only for a holder of it on this machine).
    : fetch(new URL(PROGRAM_NONCE_PATH, origin), { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify({ nonce }), redirect: 'error' })
      .then((response) => { void response.body?.cancel(); return response.status === 204; }, () => false);
  return named.then((ok) => ok ? exchangeProved(path, token, program, onEnded, asCommandLine, nonce) : undefined);
}

function exchangeProved(path: string, token: string, program: 'tui' | 'agent' | 'daemon', onEnded: () => void, asCommandLine: boolean, nonce: string): Promise<HeldRegistration | undefined> {
  return new Promise((resolve) => {
    let challenge: string | undefined;
    let buffer = '';
    let closeWindow: (() => void) | undefined;
    let entry: number | undefined;
    let settled: HeldRegistration | undefined | null = null;
    let opened = false;
    const shut = (): void => {
      closeWindow?.();
      closeWindow = undefined;
      if (entry !== undefined) { try { closeSync(entry); } catch { /* closed */ } entry = undefined; }
    };
    const finish = (value: HeldRegistration | undefined, closedByFarEnd = false): void => {
      if (settled !== null) return;
      settled = value;
      clearTimeout(limit);
      // Opened for reading and no key: no new exchange for a while (a daemon that went away mid-exchange, a restart,
      // only for a moment, so the restarted daemon is registered with at once).
      if (value === undefined && opened) retryNotBefore = Date.now() + (closedByFarEnd ? RETRY_AFTER_CLOSE_MS : RETRY_AFTER_MS);
      resolve(value);
    };
    let connection: { end(): void; write(data: string): number; unref?(): void } | undefined;
    const limit = setTimeout(() => { shut(); connection?.end(); finish(undefined); }, EXCHANGE_LIMIT_MS);
    const address = shortSocketPath(path);
    Bun.connect({
      unix: address.path,
      socket: {
        data(socket, data) {
          buffer += Buffer.from(data).toString('utf8');
          if (buffer.length > 8192) { shut(); socket.end(); finish(undefined); return; }
          let at = buffer.indexOf('\n');
          while (at >= 0) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 1);
            at = buffer.indexOf('\n');
            let message: Record<string, unknown>;
            try { message = JSON.parse(line) as Record<string, unknown>; } catch { shut(); socket.end(); finish(undefined); return; }
            if (typeof message['challenge'] === 'string' && challenge === undefined && !opened) {
              // Ask the far end to prove it is the daemon this process named its secret to.
              challenge = message['challenge'];
              socket.write(`${JSON.stringify({ hello: createHash('sha256').update(nonce).digest('hex') })}\n`);
            } else if ('proof' in message && challenge !== undefined && !opened) {
              const want = Buffer.from(createHmac('sha256', nonce).update(challenge).digest('hex'));
              const got = Buffer.from(typeof message['proof'] === 'string' ? message['proof'] : '');
              // Not the daemon: nothing opened, nothing sent, the connection closed.
              if (got.length !== want.length || !timingSafeEqual(got, want)) { socket.end(); finish(undefined); return; }
              opened = true;
              entry = openOwnEntry();
              closeWindow = openForReading(WINDOW_CAP_MS);
              // A command line says so: the daemon issues it its own kind (`cli`), never the program's registration.
              socket.write(`${JSON.stringify({ answer: challenge, program, token, ...(asCommandLine ? { commandLine: true } : {}) })}\n`);
            } else if (message['read'] === true) {
              shut();
              socket.write('{"closed":true}\n');
            } else if (typeof message['key'] === 'string' && message['key'] && typeof message['port'] === 'number') {
              shut();
              socket.unref();
              const key = message['key'];
              finish({ key, port: message['port'], end: () => socket.end() });
            } else {
              if (typeof message['refused'] === 'string') tellRefused(message['refused']);
              // A refusal (`refused`), or anything else: no registration, and the connection is closed. Never kept: the
              // next exchange is a new connection, asked afresh after RETRY_AFTER_MS.
              shut();
              socket.end();
              finish(undefined);
              return;
            }
          }
        },
        open(socket) { connection = socket; address.release(); },
        close() { shut(); finish(undefined, true); onEnded(); },
        error() { shut(); finish(undefined, true); onEnded(); },
      },
    }).catch(() => { address.release(); shut(); finish(undefined); });
  });
}

/**
 * This program's registration for a call to the daemon at `target` with the credential `sent`: asked for the first
 * time over this machine's program socket, then the same one while its connection lasts. Undefined when no program
 * context is set (and this is no program's command line), for a daemon address that is not this machine's (a connected host on another
 * machine never issues one: there the owner's presses are theirs only through their own sign-in on that host), for a
 * listener that is not the registering daemon's, or when the daemon issues none: the program's calls then carry none,
 * as a script's.
 */
export function programRegistrationFor(target: string, sent: string | undefined): Promise<string | undefined> {
  const context = programContext;
  // A call made with the Agent's own credential carries the registration of the credential it was made with: the
  // daemon issues registrations to the operator token only, and believes that credential as the Agent's only with it.
  const token = sent !== undefined ? delegatedFrom.get(sent) ?? sent : undefined;
  const port = loopbackPort(target);
  // The program that registers: the one whose context is set, or, on a command line (`do`, `find`), the program whose
  // command line it is, registered as a command line: the daemon issues it its own kind (`cli`), which is never that
  // program and never a person (daemon/program-registrations.ts `COMMAND_LINE_REGISTRATION`).
  const program = commandLine ? commandLineProgram : context?.program;
  if (!program || port === undefined || !token) return Promise.resolve(undefined);
  const path = programSocketPath();
  if (!path) return Promise.resolve(undefined);
  const key = `${path}\n${token}\n${program}${commandLine ? '\ncli' : ''}`;
  let kept = registrations.get(key);
  if (!kept) {
    if (Date.now() < retryNotBefore) return Promise.resolve(undefined);
    // When its connection closes (the daemon went, or ended it), the next call registers again.
    const ended = (): void => { if (registrations.get(key) === kept) registrations.delete(key); };
    let origin: string | undefined;
    try { origin = new URL(target).origin; } catch { origin = undefined; }
    kept = exchange(path, token, program, ended, commandLine, origin).then((held) => {
      // No answer (a refusal included): a later call asks again, on a new connection, no sooner than RETRY_AFTER_MS
      // when this process was opened for reading for nothing.
      if (!held) ended();
      return held;
    });
    registrations.set(key, kept);
    while (registrations.size > REGISTRATIONS_LIMIT) {
      const oldest = registrations.keys().next().value;
      if (oldest === undefined) break;
      void registrations.get(oldest)?.then((entry) => entry?.end());
      registrations.delete(oldest);
    }
  }
  return kept.then((held) => (held && held.port === port ? held.key : undefined));
}

/**
 * The headers of this program's call context for a call to the daemon at `target` with `token`: the call context, and
 * the registration this machine's daemon issued this program when `target` is that daemon's listener (a command line's
 * too: the registration of the program whose command line it is). (`_fetchImpl` is not used: the registration is never asked for over HTTP.)
 */
export async function programCallHeadersFor(target: string, token: string | undefined, _fetchImpl?: typeof fetch, program?: 'tui' | 'agent'): Promise<Record<string, string>> {
  const headers = programCallHeaders(program);
  const registration = await programRegistrationFor(target, token);
  return registration ? { ...headers, [CALL_PROGRAM_KEY_HEADER]: registration } : headers;
}

let programContext: ProgramCallContext | undefined;

/**
 * The client kind a command line names itself with (`do` and `find` on any program's command line), never `tui` or
 * `agent`. The daemon holds such a call for the owner when it weakens a protection, cannot be undone, spends money,
 * writes a secret or is the owner's own act (capabilities/command-line-hold.ts), whatever registration it carries.
 */
export const COMMAND_LINE_CLIENT = 'cli';
let commandLine = false;
let commandLineProgram: 'tui' | 'agent' | 'daemon' | undefined;

/**
 * This process is a command line (`<program> do` or `find`) of `program` (the terminal app's, the Agent's or the
 * daemon's): every call it makes names the command-line client kind, and carries the registration of that program.
 */
export function markCommandLineCall(program?: 'tui' | 'agent' | 'daemon'): void {
  commandLine = true;
  commandLineProgram = program;
}

/** Whether this process said it is a command line. */
export function isCommandLineCall(): boolean {
  return commandLine;
}

/** Set by the program once it knows its folder and its conversation (bootstrap); every client then sends it. */
export function setProgramCallContext(context: ProgramCallContext | undefined): void {
  programContext = context;
}

function safely(read: () => string | undefined): string | undefined {
  try {
    const value = read();
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/** This program's call context as it stands now (what an item it posts says it is for), or undefined before it is set. */
export function programCallContextNow(): { readonly program: 'tui' | 'agent'; readonly project?: string; readonly sessionId?: string } | undefined {
  const context = programContext;
  if (!context) return undefined;
  const project = safely(context.project);
  const sessionId = safely(context.sessionId);
  return { program: context.program, ...(project ? { project } : {}), ...(sessionId ? { sessionId } : {}) };
}

/**
 * The headers of this program's call context, for a client to add to every request to the daemon. `program` names
 * the program when no context was set yet (a command-line call before bootstrap): the header it always sent.
 */
export function programCallHeaders(program?: 'tui' | 'agent'): Record<string, string> {
  if (commandLine) return { [CALL_PROGRAM_HEADER]: COMMAND_LINE_CLIENT };
  const context = programContext;
  const named = context?.program ?? program;
  const project = context ? safely(context.project) : undefined;
  const sessionId = context ? safely(context.sessionId) : undefined;
  const readOutside = context ? readOutsideNow(sessionId) : undefined;
  return {
    ...(named ? { [CALL_PROGRAM_HEADER]: named } : {}),
    ...(project ? { [CALL_PROJECT_HEADER]: encodeURIComponent(project) } : {}),
    ...(sessionId ? { [CALL_SESSION_HEADER]: encodeURIComponent(sessionId) } : {}),
    ...(readOutside ? { [CALL_READ_OUTSIDE_HEADER]: readOutside } : {}),
  };
}

/**
 * What this program's conversation has read from outside (its own turns: the conversation `conversation:<session>` the
 * orchestrator runs each turn in, and whatever conversation the call is made inside), as the header carries it.
 */
function readOutsideNow(sessionId: string | undefined): string | undefined {
  const seen = new Set<string>();
  const read = [...exposureNow(), ...(sessionId ? exposureOf(`conversation:${sessionId}`) : [])].filter((entry) => {
    const id = `${entry.surface}\u0000${entry.origin}`;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  return encodeCarriedExposure(read);
}
