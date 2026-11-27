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
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readDaemonSetting } from '@goodvibes/engine/platform/platform/workspace/daemon-home';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { carryRecordsBetween, type RecordsCarryResult } from '@goodvibes/engine/platform/platform/runtime/operations';

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

/**
 * The folders a 3.5.0 daemon ran in (the folders the tree root remembers that hold a record only a daemon writes), most
 * recently used first: where its records were, and the folder its "in this project" rules were saved for
 * (permissions/daemon-folder-rules-notice.ts), whatever folder this start was given.
 */
export function formerDaemonFolders(homeDirectory: string, daemonHomeDirectory: string, startedIn: string): readonly string[] {
  const recordsRoot = resolve(daemonRecordsRoot(daemonHomeDirectory));
  return rememberedFolders(homeDirectory, daemonHomeDirectory, startedIn)
    .filter((folder) => resolve(folder) !== recordsRoot)
    .filter((folder) => DAEMON_MARKERS.some((marker) => existsSync(join(folder, '.goodvibes', marker))))
    .sort((a, b) => lastUsed(b) - lastUsed(a));
}

/** When a daemon last used the folder: the newest of its marker files. */
function lastUsed(folder: string): number {
  let newest = 0;
  for (const marker of [...DAEMON_MARKERS, 'tui/control-plane/sessions.json']) {
    try { newest = Math.max(newest, statSync(join(folder, '.goodvibes', marker)).mtimeMs); } catch { /* absent */ }
  }
  return newest;
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
  const folders = formerDaemonFolders(input.homeDirectory, input.daemonHomeDirectory, input.workingDirectory)
    .filter((folder) => resolve(folder) !== resolve(input.recordsRoot));
  // One rule for every carry of records (platform runtime/records-carry.ts): copied, or merged without dropping any.
  const result: RecordsCarryResult = { copied: [], merged: [], singleValues: [], failed: [] };
  const firstFrom = new Map<string, string>();
  mkdirSync(input.recordsRoot, { recursive: true, mode: 0o700 });
  for (const folder of folders) carryRecordsBetween(join(folder, '.goodvibes'), target, DAEMON_RECORDS, folder, result, firstFrom);
  const carry: DaemonRecordsCarry = { folders, ...result };
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

/**
 * When a 3.5.0 daemon last wrote the machine group's shared settings in one of the folders it runs in, if that was
 * after this version carried them into its home: the machine was put back to 3.5.0 and ran there since. Its changes
 * from that run are in its settings but not in this version's record of the group's settings, and the group code
 * marks them the owner's once (config-replication.ts `noteOlderReleaseRun`). Undefined when 3.5.0 has not run since.
 */
export function olderReleaseGroupSettingsWrittenAt(input: Parameters<typeof carryDaemonRecordsOnce>[0]): number | undefined {
  let carriedAt: number;
  try { carriedAt = statSync(join(input.recordsRoot, CARRY_RECORD)).mtimeMs; } catch { return undefined; }
  let newest: number | undefined;
  for (const folder of formerDaemonFolders(input.homeDirectory, input.daemonHomeDirectory, input.workingDirectory)) {
    try {
      const written = statSync(join(folder, '.goodvibes', 'tui', 'cluster', 'group-config.json')).mtimeMs;
      if (written > carriedAt && (newest === undefined || written > newest)) newest = written;
    } catch { /* that folder holds none */ }
  }
  return newest === undefined ? undefined : Math.trunc(newest);
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
