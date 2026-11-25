/**
 * The daemon's own records live in its home, never in a project folder.
 *
 * Up to 3.5.0 the daemon kept its own records under the folder it was started
 * in (`<folder>/.goodvibes/...`): the shared sessions, the approvals, the
 * device grants, the machine group's node id, the remote nodes, the channel
 * routes, drafts and inbox cursors, the Telegram offset, the plans waiting to
 * run, the decision log, the supervised triggers and the rest. Started from
 * another folder, all of them appeared gone. Now they are under
 * `<daemon home>/records/.goodvibes/...` (the same relative paths), whatever
 * folder the daemon is started from: ShellPathService `recordsRoot`.
 *
 * At the first start of this version they are carried, once, from every folder
 * a 3.5.0 daemon ran in. Those folders are found through what the tree root
 * keeps of past folders: the saved working folder (`daemon-settings.json`,
 * `runtime.workingDir`) and every folder a program or the daemon bound a project
 * identity to (`<tree>/.goodvibes/project-identities/`), plus the folder this
 * start was given. A folder counts as one a daemon ran in only when it holds a
 * record only the daemon writes (its machine-group node id or its device
 * grants). Where two folders hold the same record they are merged without
 * dropping any: JSON records by key and by id (the most recently used folder's
 * value kept where both set one), JSON lines by line, SQLite stores row by row;
 * a single value (the node id) is taken from the most recently used folder and
 * the others named. The old files are left as they were, so a 3.5.0 binary put
 * back reads them as it left them (it does not see what changed after the
 * upgrade). What was carried and merged is said once, in the owner's inbox.
 */
import { Database } from 'bun:sqlite';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { readDaemonSetting } from '@goodvibes/engine/platform/platform/workspace/daemon-home';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/** The folder under the daemon home whose `.goodvibes/` holds the daemon's own records. */
export function daemonRecordsRoot(daemonHomeDirectory: string): string {
  return join(daemonHomeDirectory, 'records');
}

/** Written once the carry has run; its presence means it never runs again. */
const CARRY_RECORD = 'carried-from-folders.json';

/**
 * Every record of the daemon's own, as a path under a folder's `.goodvibes/`. A directory is carried with
 * everything in it. A project's own things there (its checkpoints, code index, project index, contracts,
 * settings) are not the daemon's and stay where they are.
 */
const DAEMON_RECORDS: readonly string[] = [
  'tui/control-plane/sessions.json', 'tui/control-plane/sessions.folded.json', 'tui/control-plane/approvals.jsonl',
  'tui/sessions/task-graph.json',
  'tui/watchers.json', 'tui/channels', 'tui/work-plans.json', 'tui/services.json',
  'tui/cluster', 'tui/devices', 'tui/remote', 'tui/operator', 'tui/memory',
  'tui/decisions.sqlite', 'tui/triggers.db',
  // The Telegram offset, selection and review, and the facade's own cluster folder, kept under `goodvibes/`.
  'goodvibes/channels', 'goodvibes/cluster',
];

/** Files only a daemon writes: a folder holding one is a folder a daemon ran in. */
const DAEMON_MARKERS: readonly string[] = ['tui/cluster/cluster-node-id', 'tui/devices/device-grants.json'];

/** Process locks and SQLite side files are never carried as files of their own. */
function isSideFile(name: string): boolean {
  return /\.(lock|held|owner-lock)$/.test(name) || name.endsWith('.writer.sqlite') || name.endsWith('-wal') || name.endsWith('-shm')
    || name.includes('.writer.lock') || /\.unreadable-\d+/.test(name);
}

function isSqlite(name: string): boolean {
  return name.endsWith('.sqlite') || name.endsWith('.db');
}

export interface DaemonRecordsCarry {
  /** The folders records were carried from, most recently used first. */
  readonly folders: readonly string[];
  /** Records copied (path under `.goodvibes/`, and the folder). */
  readonly copied: readonly string[];
  /** Records two or more folders held, merged. */
  readonly merged: readonly string[];
  /** Single values more than one folder held: the one kept and the ones not used. */
  readonly singleValues: readonly string[];
  /** Records that could not be carried, with why. */
  readonly failed: readonly string[];
}

/** Folders the tree root remembers: the saved working folder and every folder bound to a project identity. */
function rememberedFolders(homeDirectory: string, daemonHomeDirectory: string, startedIn: string): string[] {
  const folders = new Set<string>([resolve(startedIn)]);
  try {
    const saved = readDaemonSetting(daemonHomeDirectory, 'runtime.workingDir');
    if (saved) folders.add(resolve(saved));
  } catch { /* an unreadable settings file names no folder; the start reports it itself */ }
  const identities = join(homeDirectory, '.goodvibes', 'project-identities');
  let names: string[] = [];
  try { names = readdirSync(identities); } catch { /* none yet */ }
  for (const name of names) {
    if (!name.startsWith('binding-') || !name.endsWith('.json')) continue;
    try {
      const binding = JSON.parse(readFileSync(join(identities, name), 'utf-8')) as { workspace?: unknown };
      if (typeof binding.workspace === 'string' && binding.workspace) folders.add(resolve(binding.workspace));
    } catch { /* a damaged binding names no folder */ }
  }
  return [...folders];
}

/** When a daemon last used the folder: the newest of its marker files. */
function lastUsed(folder: string): number {
  let newest = 0;
  for (const marker of [...DAEMON_MARKERS, 'tui/control-plane/sessions.json']) {
    try { newest = Math.max(newest, statSync(join(folder, '.goodvibes', marker)).mtimeMs); } catch { /* absent */ }
  }
  return newest;
}

function filesUnder(path: string): string[] {
  let stat;
  try { stat = statSync(path); } catch { return []; }
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

function isObject(value: Json | undefined): value is { [key: string]: Json } {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The key an array item is known by: its id (or sessionId, key, name), else its whole text. */
function itemKey(item: Json): string {
  if (isObject(item)) {
    for (const field of ['id', 'sessionId', 'key', 'name']) {
      const value = item[field];
      if (typeof value === 'string' || typeof value === 'number') return `${field}:${value}`;
    }
  }
  return `json:${JSON.stringify(item)}`;
}

/** `kept` (the most recently used folder's) merged with `other`: nothing either holds is dropped. */
function mergeJson(kept: Json, other: Json): Json {
  if (isObject(kept) && isObject(other)) {
    const out: { [key: string]: Json } = { ...kept };
    for (const [key, value] of Object.entries(other)) out[key] = key in kept ? mergeJson(kept[key]!, value) : value;
    return out;
  }
  if (Array.isArray(kept) && Array.isArray(other)) {
    const seen = new Set(kept.map(itemKey));
    return [...kept, ...other.filter((item) => !seen.has(itemKey(item)))];
  }
  return kept;
}

function copyWithSideFiles(from: string, to: string): void {
  mkdirSync(dirname(to), { recursive: true, mode: 0o700 });
  copyFileSync(from, to);
  for (const suffix of ['-wal', '-shm']) if (existsSync(from + suffix)) copyFileSync(from + suffix, to + suffix);
}

/** Every row of `other` added to `target` where a table of that name exists in both; a row already there is kept. */
function mergeSqlite(target: string, other: string): void {
  const db = new Database(target);
  try {
    db.run('PRAGMA busy_timeout = 5000');
    db.query('ATTACH DATABASE ? AS other').run(other);
    const tables = db.query<{ name: string }, []>("SELECT name FROM other.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all();
    const mine = new Set(db.query<{ name: string }, []>("SELECT name FROM main.sqlite_master WHERE type = 'table'").all().map((row) => row.name));
    db.transaction(() => {
      for (const { name } of tables) {
        if (!mine.has(name)) continue;
        const quoted = `"${name.replace(/"/g, '""')}"`;
        const columns = db.query<{ name: string }, []>(`PRAGMA main.table_info(${quoted})`).all().map((row) => `"${row.name.replace(/"/g, '""')}"`);
        const theirs = new Set(db.query<{ name: string }, []>(`PRAGMA other.table_info(${quoted})`).all().map((row) => `"${row.name.replace(/"/g, '""')}"`));
        const shared = columns.filter((column) => theirs.has(column));
        if (shared.length === 0) continue;
        db.run(`INSERT OR IGNORE INTO main.${quoted} (${shared.join(', ')}) SELECT ${shared.join(', ')} FROM other.${quoted}`);
      }
    })();
    db.run('DETACH DATABASE other');
  } finally {
    db.close();
  }
}

/**
 * Carry the daemon's own records into its home once, from every folder a 3.5.0 daemon ran in. Returns what was
 * done, or undefined when it ran before. Synchronous and run before any store opens; a start with nothing to carry
 * costs one existence check after the first.
 */
export function carryDaemonRecordsOnce(input: {
  readonly recordsRoot: string;
  readonly homeDirectory: string;
  readonly daemonHomeDirectory: string;
  readonly workingDirectory: string;
}): DaemonRecordsCarry | undefined {
  const record = join(input.recordsRoot, CARRY_RECORD);
  if (existsSync(record)) return undefined;
  const target = join(input.recordsRoot, '.goodvibes');
  const folders = rememberedFolders(input.homeDirectory, input.daemonHomeDirectory, input.workingDirectory)
    .filter((folder) => resolve(folder) !== resolve(input.recordsRoot))
    .filter((folder) => DAEMON_MARKERS.some((marker) => existsSync(join(folder, '.goodvibes', marker))))
    .sort((a, b) => lastUsed(b) - lastUsed(a));
  const copied: string[] = [];
  const merged = new Set<string>();
  const singleValues: string[] = [];
  const failed: string[] = [];
  const firstFrom = new Map<string, string>();
  mkdirSync(input.recordsRoot, { recursive: true, mode: 0o700 });
  for (const folder of folders) {
    const source = join(folder, '.goodvibes');
    for (const entry of DAEMON_RECORDS) {
      for (const file of filesUnder(join(source, entry))) {
        const rel = relative(source, file);
        const name = file.split('/').pop() ?? file;
        if (isSideFile(name)) continue;
        const to = join(target, rel);
        try {
          if (!existsSync(to)) {
            copyWithSideFiles(file, to);
            firstFrom.set(rel, folder);
            copied.push(`${rel} (from ${folder})`);
          } else if (isSqlite(name)) {
            mergeSqlite(to, file);
            merged.add(rel);
          } else if (name.endsWith('.jsonl')) {
            const have = readFileSync(to, 'utf-8');
            const lines = new Set(have.split('\n').filter(Boolean));
            const added = readFileSync(file, 'utf-8').split('\n').filter((line) => line && !lines.has(line));
            if (added.length > 0) writeFileSync(to, `${have}${have.endsWith('\n') || have === '' ? '' : '\n'}${added.join('\n')}\n`, { mode: 0o600 });
            merged.add(rel);
          } else if (name.endsWith('.json')) {
            const kept = JSON.parse(readFileSync(to, 'utf-8')) as Json;
            const other = JSON.parse(readFileSync(file, 'utf-8')) as Json;
            writeFileSync(to, `${JSON.stringify(mergeJson(kept, other), null, 2)}\n`, { mode: 0o600 });
            merged.add(rel);
          } else if (readFileSync(to).equals(readFileSync(file))) {
            // The same value in both: nothing to choose.
          } else {
            singleValues.push(`${rel}: kept the one from ${firstFrom.get(rel) ?? 'the first folder'}; the one in ${folder} was not used (it is still there)`);
          }
        } catch (error) {
          failed.push(`${rel} from ${folder}: ${summarizeError(error)}`);
        }
      }
    }
  }
  const carry: DaemonRecordsCarry = { folders, copied, merged: [...merged], singleValues, failed };
  writeFileSync(record, `${JSON.stringify({ version: 1, carriedAt: new Date().toISOString(), ...carry }, null, 2)}\n`, { mode: 0o600 });
  if (folders.length > 0) logger.info('[daemon] its own records were carried into its home', { recordsRoot: input.recordsRoot, ...carry });
  return carry;
}

/** The owner's one line about the carry, or undefined when there was nothing to carry. */
export function describeDaemonRecordsCarry(carry: DaemonRecordsCarry): string | undefined {
  if (carry.folders.length === 0) return undefined;
  const parts = [
    `The daemon now keeps its own records (sessions, approvals, paired devices, the machine group's node id, channel routes and offsets, plans waiting to run, triggers and the rest) in its home, so they are the same whatever folder it starts in. They were carried from ${carry.folders.join(', ')}; the files there are left as they were.`,
  ];
  if (carry.merged.length > 0) parts.push(`Held in more than one of those folders and merged, nothing dropped: ${carry.merged.join(', ')}.`);
  if (carry.singleValues.length > 0) parts.push(`One value each: ${carry.singleValues.join('; ')}.`);
  if (carry.failed.length > 0) parts.push(`Not carried: ${carry.failed.join('; ')}.`);
  return parts.join(' ');
}

/** Carry, then say it once; a failure is logged and the start goes on with what was carried. */
export function carryDaemonRecordsAtStart(input: Parameters<typeof carryDaemonRecordsOnce>[0], say: (line: string) => void): void {
  try {
    const carry = carryDaemonRecordsOnce(input);
    const line = carry ? describeDaemonRecordsCarry(carry) : undefined;
    if (line) say(line);
  } catch (error) {
    logger.warn('[daemon] its own records could not be carried into its home; the next start tries again', { error: summarizeError(error) });
  }
}
