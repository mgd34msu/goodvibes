/**
 * program-peer.ts, whether the process at the other end of the daemon's program socket (daemon/program-socket.ts) is one
 * of the product's own terminal programs, read by the daemon from the kernel, never from what that process says.
 *
 * The process is known by the kernel's peer credentials on the socket it opened itself, and its answer to the daemon's
 * challenge came from that same process (the kernel's credentials on the message). The programs keep themselves
 * unreadable by the rest of the account (not dumpable, utils/process-privacy.ts), so for the daemon to read the
 * process the program opens itself for the length of the daemon's own step (`readPeerInWindow`, a few reads of /proc,
 * at most PROGRAM_WINDOW_CAP_MS by the program's own timer) and closes itself again; the executable is held open by
 * that read, so its content is judged afterwards (`judgePeer`), with the process private again.
 *
 * What is the product's own program:
 *  - installed: the running executable's content (sha256 of the very file the process runs, through /proc/<pid>/exe)
 *    is one recorded in the daemon's own home for `goodvibes` (the terminal app), `goodvibes-agent` or the daemon's
 *    command line (daemon/program-hashes.ts: written by the installer and every update, read once at the daemon's start
 *    and held; never the account-writable install folder's files); its name or folder count for nothing;
 *  - from source, honoured only when the daemon itself runs from source (a development convenience, not a protection:
 *    any script of the account run by the same runtime can hold the same file open): the runtime the kernel reports as
 *    the executable is the daemon's own (the same file), and the process holds the terminal app's or the Agent's entry
 *    beside the daemon's source open (the kernel's open-file table, never the rewritable command line), with no
 *    `preload` in a `bunfig.toml` of its start folder or its configuration folder.
 * Both: no variable in its environment that loads other code (INJECTING_VARIABLES), no code mapped from a file the
 * account can write other than its own executable (or a library the installer recorded; from source, files under the
 * source tree), not being traced (TracerPid), and the same user throughout.
 */
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync, type BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { resolveGoodVibesDaemonHome } from '../config/goodvibes-home.js';
import { logger } from '../utils/logger.js';
import { readRecordedProgramHashes, recordInstalledProgramHashes } from './program-hashes.js';

/** The terminal programs a registration names. */
export type PeerProgram = 'tui' | 'agent' | 'daemon';

/** A program's name in words a person reads. */
export function programWords(program: PeerProgram): string {
  return program === 'tui' ? 'the terminal app' : program === 'agent' ? 'the Agent' : 'the daemon\'s command line';
}

/**
 * Variables that make the program run code it does not hold itself: the dynamic loader's (a library preloaded,
 * audited, or found first on another path, iconv modules), the runtime's (flags and preloads, inspector, engine options,
 * `BUN_BE_BUN`, which makes an installed program run any script instead of itself), Node's (flags, module path).
 * Measured on 3.5.0: LD_PRELOAD, LD_AUDIT and BUN_OPTIONS take effect in the installed binaries and from source,
 * BUN_BE_BUN in the installed ones; the others are refused whether or not this build reads them. The environment is
 * read as the kernel shows it, which is the process's own memory: code already running inside the process can rewrite
 * it (the line stated in docs/llms/40: whoever starts the program can run code in it).
 */
const INJECTING_VARIABLES = /^(?:LD_PRELOAD|LD_AUDIT|LD_LIBRARY_PATH|LD_ORIGIN_PATH|LD_PROFILE|GCONV_PATH|HOSTALIASES|BUN_BE_BUN|BUN_OPTIONS|BUN_INSPECT[A-Z_]*|BUN_JSC_[A-Za-z0-9_]*|JSC_[A-Za-z0-9_]*|NODE_OPTIONS|NODE_PATH|NODE_INSPECT[A-Z_]*)$/;

/** The longest a program lets itself be read for the daemon's step (its own timer closes it then, whatever arrives). */
export const PROGRAM_WINDOW_CAP_MS = 150;

/** What the daemon read of the peer while it was open: everything it judges, the executable held open. */
export interface PeerReading {
  readonly pid: number;
  /** The process's executable, opened through /proc/<pid>/exe: the very file it runs. */
  readonly exeFd: number;
  readonly exeStat: BigIntStats;
  readonly environNames: readonly string[];
  readonly environ: ReadonlyMap<string, string>;
  /** The executable's path as the kernel names it. */
  readonly exePath: string;
  /**
   * The files mapped with execute permission: path and inode number as the kernel names them (the device it writes
   * there is not the one `stat` answers on every file system, so only the inode is compared, with the path).
   */
  readonly codeFiles: readonly { readonly path: string; readonly ino: string }[];
  readonly openFiles: readonly string[];
  readonly cwd: string | undefined;
}

function tracerOf(pid: number): number | undefined {
  try {
    const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((entry) => entry.startsWith('TracerPid:'));
    return line ? Number(line.slice('TracerPid:'.length).trim()) : undefined;
  } catch {
    return undefined;
  }
}

function usersOf(pid: number): readonly number[] {
  try {
    const line = readFileSync(`/proc/${pid}/status`, 'utf8').split('\n').find((entry) => entry.startsWith('Uid:'));
    return line ? line.slice(4).trim().split(/\s+/).map(Number) : [];
  } catch {
    return [];
  }
}

/** Whether the peer is traced, or not wholly this user's: refused at the read and again once it is private. */
export function peerTracedOrForeign(pid: number, uid: number): string | undefined {
  const tracer = tracerOf(pid);
  if (tracer === undefined) return 'its status cannot be read';
  if (tracer !== 0) return `it is being traced (by process ${tracer})`;
  const users = usersOf(pid);
  if (users.length === 0 || users.some((user) => user !== uid)) return 'it does not run wholly as this account';
  return undefined;
}

/**
 * Read the peer while it lets itself be read: its executable (held open), environment, code mappings, open files and
 * start folder. Every read is a small file of /proc; nothing is hashed here, so the program's window is the daemon's
 * own step.
 */
export function readPeerInWindow(pid: number, uid: number): PeerReading | { readonly why: string } {
  const refused = peerTracedOrForeign(pid, uid);
  if (refused) return { why: refused };
  let exeFd: number;
  try { exeFd = openSync(`/proc/${pid}/exe`, 'r'); } catch { return { why: 'its executable cannot be read (it did not let itself be read for the check)' }; }
  try {
    const exeStat = fstatSync(exeFd, { bigint: true });
    const exePath = readlinkSync(`/proc/${pid}/exe`);
    const raw = readFileSync(`/proc/${pid}/environ`);
    const environ = new Map<string, string>();
    for (const entry of raw.toString('utf8').split('\0')) {
      if (!entry) continue;
      const at = entry.indexOf('=');
      environ.set(at < 0 ? entry : entry.slice(0, at), at < 0 ? '' : entry.slice(at + 1));
    }
    const codeFiles: { path: string; ino: string }[] = [];
    for (const line of readFileSync(`/proc/${pid}/maps`, 'utf8').split('\n')) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 6 || !fields[1]!.includes('x')) continue;
      const path = fields.slice(5).join(' ');
      if (!path.startsWith('/') && !path.startsWith('memfd:')) continue;
      codeFiles.push({ path, ino: fields[4]! });
    }
    const openFiles: string[] = [];
    for (const fd of readdirSync(`/proc/${pid}/fd`)) {
      try { openFiles.push(readlinkSync(`/proc/${pid}/fd/${fd}`)); } catch { /* closed meanwhile */ }
    }
    let cwd: string | undefined;
    try { cwd = readlinkSync(`/proc/${pid}/cwd`); } catch { cwd = undefined; }
    return { pid, exeFd, exeStat, exePath, environNames: [...environ.keys()], environ, codeFiles, openFiles, cwd };
  } catch {
    closeSync(exeFd);
    return { why: 'its environment, code or open files cannot be read (it did not let itself be read for the check)' };
  }
}

/** Whether this process may read other processes of its user even when they are private (CAP_SYS_PTRACE in effect). */
function readsPrivateProcesses(): boolean {
  try {
    const line = readFileSync('/proc/self/status', 'utf8').split('\n').find((entry) => entry.startsWith('CapEff:'));
    return line !== undefined && (BigInt(`0x${line.slice('CapEff:'.length).trim()}`) & (1n << 19n)) !== 0n;
  } catch {
    return false;
  }
}

/**
 * Whether the peer is private again after the daemon's step (its environment no longer readable by its account). A
 * daemon that may read private processes anyway (root, or root of a namespace) cannot tell, and does not refuse for it.
 */
export function peerPrivateAgain(pid: number): boolean {
  if (readsPrivateProcesses()) return true;
  try {
    readFileSync(`/proc/${pid}/environ`);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EACCES' || (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function realOf(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** The daemon's own source tree (`<root>`, holding `products/daemon`), when it runs from source. */
function sourceRoot(): string | undefined {
  const entry = process.argv[1];
  if (!entry) return undefined;
  const real = realOf(entry);
  const at = real.lastIndexOf(`${sep}products${sep}daemon${sep}`);
  return at >= 0 ? real.slice(0, at) : undefined;
}

/** The installed product's folder: the daemon's own executable's, when it is the installed daemon. */
function installedFolder(): string | undefined {
  const exe = realOf(process.execPath);
  return basename(exe) === 'goodvibes-daemon' || basename(exe) === 'goodvibes-daemon.exe' ? dirname(exe) : undefined;
}

interface Recorded {
  readonly programs: ReadonlyMap<string, PeerProgram>;
  /** Libraries the installer placed (their sha256), which the programs may map. */
  readonly libraries: ReadonlySet<string>;
}

let recordedCache: { readonly folder: string; readonly recorded: Recorded } | undefined;

/**
 * The content hashes of the product's programs as the daemon trusts them: the record in the daemon's own home
 * (daemon/program-hashes.ts, written by the installer and by every update), never the reader files in the install
 * folder the account's other programs write. Read once, the first time it is needed in this run, and held for the run.
 * A daemon that finds no record (an update made by a release that did not write one) records it once from the reader
 * files the installer placed, and from then on reads only the record.
 */
export function recordedPrograms(): Recorded | undefined {
  const folder = installedFolder();
  if (!folder) return undefined;
  if (recordedCache?.folder === folder) return recordedCache.recorded;
  const daemonHome = resolveGoodVibesDaemonHome(homedir());
  let recorded: Recorded | undefined = readRecordedProgramHashes(daemonHome);
  if (!recorded) {
    try {
      recorded = recordInstalledProgramHashes(folder, daemonHome);
      logger.info('[programs] the product\'s programs were recorded in the daemon\'s home once, from the installer\'s files', { daemonHome });
    } catch (error) {
      logger.warn('[programs] the product\'s programs could not be recorded in the daemon\'s home; no program is verified by content this run', { error: error instanceof Error ? error.message : String(error) });
      recorded = { programs: new Map(), libraries: new Set() };
    }
  }
  recordedCache = { folder, recorded };
  return recorded;
}

/** Content hashes already computed, by the file's identity (device, inode, size, change time): a rewrite changes it. */
const hashes = new Map<string, string>();
const HASHES_KEPT = 32;

async function hashOfFd(fd: number, stat: BigIntStats): Promise<string> {
  const identity = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  const kept = hashes.get(identity);
  if (kept) return kept;
  const hash = createHash('sha256');
  const chunk = Buffer.alloc(4 * 1024 * 1024);
  let position = 0;
  for (;;) {
    // One chunk per turn of the event loop, so a large executable never holds the daemon up.
    const got = await new Promise<number>((done, fail) => {
      setImmediate(() => { try { done(readSync(fd, chunk, 0, chunk.length, position)); } catch (error) { fail(error); } });
    });
    if (got <= 0) break;
    hash.update(chunk.subarray(0, got));
    position += got;
  }
  const digest = hash.digest('hex');
  hashes.set(identity, digest);
  while (hashes.size > HASHES_KEPT) hashes.delete(hashes.keys().next().value!);
  return digest;
}

function hashOfPath(path: string): Promise<string | undefined> {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch { return Promise.resolve(undefined); }
  const stat = fstatSync(fd, { bigint: true });
  return hashOfFd(fd, stat).finally(() => closeSync(fd)).catch(() => undefined);
}

/**
 * Whether the account (`uid`) can write this file or replace it in its folder: it owns either, or either is writable by
 * group or others (a folder with the sticky bit excepted for the file it does not own).
 */
function accountWrites(path: string, uid: number): boolean {
  // The file and every folder above it up to `/`: a library in a root-owned folder inside a folder the account owns can
  // be replaced by renaming that folder (gate-review-6 G16).
  let at = path;
  for (;;) {
    let stat;
    try { stat = statSync(at); } catch { return true; }
    if (stat.uid === uid) return true;
    if ((stat.mode & 0o022) !== 0 && !(stat.isDirectory() && (stat.mode & 0o1000) !== 0)) return true;
    const up = dirname(at);
    if (up === at) return false;
    at = up;
  }
}

/** A `bunfig.toml` that preloads code (a `preload` key at its top or in any of its tables), at `path`. */
function preloadsCode(path: string): boolean {
  if (!existsSync(path)) return false;
  try {
    const parsed = Bun.TOML.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const has = (table: Record<string, unknown>): boolean => Object.entries(table).some(([key, value]) => key === 'preload'
      || (key !== 'test' && value !== null && typeof value === 'object' && !Array.isArray(value) && has(value as Record<string, unknown>)));
    return has(parsed);
  } catch {
    // A file that cannot be read as configuration may still be read by the runtime: refused.
    return true;
  }
}

/**
 * The program the read peer is, judged as described above, or why it is none. Takes ownership of the reading's open
 * executable (closed here).
 */
export async function judgePeer(reading: PeerReading, claimed: PeerProgram, uid: number): Promise<{ readonly program: PeerProgram } | { readonly why: string }> {
  try {
    const injecting = reading.environNames.filter((name) => INJECTING_VARIABLES.test(name));
    if (injecting.length > 0) return { why: `its environment loads other code into it (${injecting.join(', ')})` };
    const exeIdentity = `${reading.exeStat.dev}:${reading.exeStat.ino}`;
    const recorded = recordedPrograms();
    const root = sourceRoot();
    let program: PeerProgram | undefined;
    if (recorded) {
      const digest = await hashOfFd(reading.exeFd, reading.exeStat);
      program = recorded.programs.get(digest);
      if (!program) return { why: 'its executable is not one of the product\'s programs the installer recorded (by content)' };
    } else if (root) {
      const own = statSync(process.execPath, { bigint: true });
      if (`${own.dev}:${own.ino}` !== exeIdentity) return { why: 'it does not run the daemon\'s own runtime, and the daemon runs from source' };
      const entries = new Map<string, PeerProgram>([[join(root, 'products', 'tui', 'src', 'main.ts'), 'tui'], [join(root, 'products', 'agent', 'src', 'main.ts'), 'agent'],
        [join(root, 'products', 'daemon', 'src', 'cli', 'entrypoint.ts'), 'daemon']]);
      // The entry may be open more than once (two exchanges of the same process at once): one program, not two.
      const held = [...new Set(reading.openFiles.map((path) => entries.get(path)).filter((entry): entry is PeerProgram => entry !== undefined))];
      if (held.length !== 1) return { why: 'it does not hold the terminal app\'s or the Agent\'s source entry open (from source, the program does while it is read)' };
      program = held[0];
      const configFolder = reading.environ.get('XDG_CONFIG_HOME') ?? (reading.environ.get('HOME') ? join(reading.environ.get('HOME')!, '.config') : undefined);
      const configs = [reading.cwd ? join(reading.cwd, 'bunfig.toml') : undefined, configFolder ? join(configFolder, '.bunfig.toml') : undefined,
        reading.environ.get('HOME') ? join(reading.environ.get('HOME')!, '.bunfig.toml') : undefined].filter((path): path is string => path !== undefined);
      const preloading = configs.find(preloadsCode);
      if (preloading) return { why: `the runtime loads other code into it (${preloading} preloads code)` };
    } else {
      return { why: 'the daemon is neither the installed product (no recorded programs beside it) nor run from source' };
    }
    if (program !== claimed) return { why: `it is ${programWords(program)}, not the program it named` };
    const exeIno = String(reading.exeStat.ino);
    // Code mapped from a file the account can write: a library the dynamic loader was told to load (LD_PRELOAD, LD_AUDIT,
    // LD_LIBRARY_PATH from a writable folder), seen even when the process rewrote its environment. Code with no file the
    // daemon can look at (a memory file, a file deleted since it was mapped) is refused outright: nothing ties it to the
    // verified program, and a library that unlinks itself or loads from memory is exactly how injected code hides
    // (gate-review-6 G6). A native addon (`*.node`) is code like any library: only one the daemon can tie to what it
    // trusts runs in a verified program (installed: its content among the recorded libraries; from source: a file of the
    // source tree), never one merely named so.
    for (const code of reading.codeFiles) {
      if (code.path === reading.exePath && code.ino === exeIno) continue;
      if (code.path.includes('memfd:') || code.path.endsWith(' (deleted)')) {
        return { why: `it runs code that has no file the daemon can check (${code.path})` };
      }
      if (code.path.endsWith('.node') && !(root && !recorded && code.path.startsWith(`${root}${sep}`))) {
        let stat;
        try { stat = statSync(code.path, { bigint: true }); } catch { stat = undefined; }
        const digest = recorded && stat && String(stat.ino) === code.ino ? await hashOfPath(code.path) : undefined;
        if (digest && recorded!.libraries.has(digest)) continue;
        return { why: `it runs a native addon (${code.path}) the daemon cannot tie to the product's own files` };
      }
      if (!accountWrites(code.path, uid)) continue;
      if (root && !recorded && code.path.startsWith(`${root}${sep}`)) continue;
      if (recorded) {
        let stat;
        try { stat = statSync(code.path, { bigint: true }); } catch { stat = undefined; }
        const digest = stat && String(stat.ino) === code.ino ? await hashOfPath(code.path) : undefined;
        if (digest && recorded.libraries.has(digest)) continue;
      }
      return { why: `it runs code from ${code.path}, a file this account can write that the product did not place` };
    }
    return { program };
  } finally {
    try { closeSync(reading.exeFd); } catch { /* closed */ }
  }
}
