/**
 * taken-back.ts
 *
 * One project's checkpoints are shared by every session and agent working in
 * it, so putting the files back to a checkpoint can take back what another
 * session or agent changed after it. This module answers two things:
 *
 * - Whose changes a restore would take back: per file, the sessions and agents
 *   other than the one restoring that wrote it since the checkpoint
 *   (write-record.ts); for a file no tool wrote, the checkpoints made after the
 *   one restored by another session that changed it.
 * - What that other session is told: a notice kept beside the store's index
 *   (`taken-back.json`) until that session's next turn reads it, so a session
 *   in another program learns it in its own conversation. Nothing waits on a
 *   clock; the notice is read when the session next submits a turn.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JsonFileStore } from '../../state/json-file-store.js';
import type { SideGitRunner } from './side-git.js';
import type { WorkspaceCheckpoint } from './types.js';
import { recordedWrites, writesTakenBack } from './write-record.js';

/** Another session's files a restore would change. */
export interface OtherSessionChanges {
  readonly sessionId: string;
  /** Agents of that session whose run made some of these changes, when the checkpoint names one. */
  readonly agentIds: readonly string[];
  readonly files: readonly string[];
}

/** What a session is told when another session's restore took back its change. */
export interface TakenBackNotice {
  readonly sessionId: string;
  /** The session that restored. */
  readonly by: string;
  readonly at: number;
  readonly files: readonly string[];
  /** The checkpoint that was restored. */
  readonly restored: { readonly id: string; readonly label: string };
  /** The checkpoint holding the state the restore replaced (the taken-back change in it). */
  readonly keptAs: string | null;
}

interface NoticeFile { readonly notices: readonly TakenBackNotice[] }

/**
 * The other sessions' changes a restore of `target` would take back, by
 * session, limited to `wouldChange` (the files the restore changes). A
 * checkpoint with no session recorded (the baseline, a safety checkpoint, one
 * written before sessions were recorded) names nobody and is left out.
 */
export async function otherSessionsUndone(
  checkpoints: ReadonlyMap<string, WorkspaceCheckpoint>,
  sideGit: Pick<SideGitRunner, 'diffNameOnly'>,
  target: WorkspaceCheckpoint,
  own: string | undefined,
  wouldChange: ReadonlySet<string>,
): Promise<OtherSessionChanges[]> {
  const bySession = new Map<string, { agents: Set<string>; files: Set<string> }>();
  const later = [...checkpoints.values()].filter((checkpoint) => checkpoint.createdAt > target.createdAt
    && checkpoint.sessionId !== undefined && checkpoint.sessionId !== own && checkpoint.parentId !== null);
  for (const checkpoint of later) {
    const parent = checkpoints.get(checkpoint.parentId!);
    if (!parent) continue;
    const changed = (await sideGit.diffNameOnly(parent.commit, checkpoint.commit)).filter((file) => wouldChange.has(file));
    if (changed.length === 0) continue;
    const entry = bySession.get(checkpoint.sessionId!) ?? { agents: new Set<string>(), files: new Set<string>() };
    for (const file of changed) entry.files.add(file);
    if (checkpoint.agentId) entry.agents.add(checkpoint.agentId);
    bySession.set(checkpoint.sessionId!, entry);
  }
  return [...bySession].map(([sessionId, entry]) => ({ sessionId, agentIds: [...entry.agents].sort(), files: [...entry.files].sort() }));
}

/** The blob each of `files` has in `commit` (absent: not in it). */
async function blobsIn(sideGit: Pick<SideGitRunner, 'raw'>, commit: string, files: readonly string[]): Promise<Map<string, string>> {
  const held = new Map<string, string>();
  if (files.length === 0) return held;
  const out = await sideGit.raw(['ls-tree', '-r', '-z', commit, '--', ...files]);
  for (const entry of out.split('\0')) {
    const tab = entry.indexOf('\t');
    if (tab < 0) continue;
    const [, type, blob] = entry.slice(0, tab).split(' ');
    if (type === 'blob' && blob) held.set(entry.slice(tab + 1), blob);
  }
  return held;
}

/**
 * Whose changes a restore of `target` takes back, decided per FILE from what each session and agent wrote
 * (write-record.ts: the record every program and the daemon keep of their tools' writes in the project), never from
 * which session's snapshot happened to hold the change. For each file the restore would change (`wouldChange`): the
 * sessions (and their agents) that wrote it after the checkpoint was made, or whose write the checkpoint missed while
 * it was being taken; `own` (the restoring session) and its agents are never "other". A file no tool wrote since then
 * (changed by a command or outside the product) falls back to the checkpoints made after `target` that changed it.
 */
export async function otherWritersUndone(
  root: string,
  checkpoints: ReadonlyMap<string, WorkspaceCheckpoint>,
  sideGit: Pick<SideGitRunner, 'diffNameOnly' | 'raw'>,
  target: WorkspaceCheckpoint,
  own: string | undefined,
  wouldChange: ReadonlySet<string>,
): Promise<OtherSessionChanges[]> {
  const bySession = new Map<string, { agents: Set<string>; files: Set<string> }>();
  const add = (sessionId: string, agentIds: readonly string[], file: string): void => {
    const entry = bySession.get(sessionId) ?? { agents: new Set<string>(), files: new Set<string>() };
    entry.files.add(file);
    for (const agent of agentIds) entry.agents.add(agent);
    bySession.set(sessionId, entry);
  };
  const recorded = recordedWrites(root, wouldChange);
  const held = await blobsIn(sideGit, target.commit, [...recorded.keys()]);
  const unwritten = new Set<string>();
  for (const file of wouldChange) {
    const takenBack = writesTakenBack(recorded.get(file) ?? [], target.createdAt, held.get(file));
    if (takenBack.length === 0) { unwritten.add(file); continue; }
    for (const write of takenBack) if (write.sessionId !== own) add(write.sessionId, write.agentId ? [write.agentId] : [], file);
  }
  for (const other of await otherSessionsUndone(checkpoints, sideGit, target, own, unwritten)) {
    for (const file of other.files) add(other.sessionId, other.agentIds, file);
  }
  return [...bySession].map(([sessionId, entry]) => ({ sessionId, agentIds: [...entry.agents].sort(), files: [...entry.files].sort() }))
    .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
}

/** The notices kept for sessions told nothing yet, in the store's folder. */
export class TakenBackNotices {
  private readonly store: JsonFileStore<NoticeFile>;
  private readonly path: string;

  constructor(checkpointRootDir: string) {
    this.path = join(checkpointRootDir, 'taken-back.json');
    this.store = new JsonFileStore<NoticeFile>(this.path);
  }

  private async read(): Promise<TakenBackNotice[]> {
    try {
      const loaded = await this.store.load();
      return Array.isArray(loaded?.notices) ? loaded.notices.filter((notice) => typeof notice?.sessionId === 'string') : [];
    } catch {
      return [];
    }
  }

  /** Keep one notice per session whose change was taken back. Call under the store's lock. */
  async add(notices: readonly TakenBackNotice[]): Promise<void> {
    if (notices.length === 0) return;
    await this.store.save({ notices: [...await this.read(), ...notices] });
  }

  /**
   * The notices for `sessionId` as the file holds them now, read at once and left in place: lets a session be told
   * before its turn's first model request is made (the removal, `take`, waits for the store's lock).
   */
  peekNow(sessionId: string): TakenBackNotice[] {
    try {
      const loaded = JSON.parse(readFileSync(this.path, 'utf8')) as Partial<NoticeFile> | null;
      return Array.isArray(loaded?.notices) ? loaded.notices.filter((notice) => notice?.sessionId === sessionId) : [];
    } catch {
      return [];
    }
  }

  /** The notices for `sessionId`, removed from the file. Call under the store's lock. */
  async take(sessionId: string): Promise<TakenBackNotice[]> {
    const all = await this.read();
    const mine = all.filter((notice) => notice.sessionId === sessionId);
    if (mine.length > 0) await this.store.save({ notices: all.filter((notice) => notice.sessionId !== sessionId) });
    return mine;
  }
}

/** The sentence the other session reads in its conversation. */
export function takenBackLine(notice: TakenBackNotice, shortId: (id: string) => string): string {
  const files = notice.files.slice(0, 10).join(', ') + (notice.files.length > 10 ? ` and ${notice.files.length - 10} more` : '');
  return `[Checkpoint] Your change to ${files} was taken back: session ${notice.by} put the files back to "${notice.restored.label}" (${shortId(notice.restored.id)}).`
    + (notice.keptAs ? ` The state it replaced, your change in it, is kept as checkpoint ${shortId(notice.keptAs)}; restoring it brings your change back.` : '');
}

/** What the session's model is told with its next request, so it does not build on a file that changed under it. */
export function takenBackModelLine(notice: TakenBackNotice): string {
  const files = notice.files.slice(0, 20).join(', ') + (notice.files.length > 20 ? ` and ${notice.files.length - 20} more` : '');
  return `Files this session changed were put back to an earlier state by another session (${notice.by}): ${files}. `
    + 'What you remember writing there is no longer what they hold. Read each of them again before you change or rely on it.';
}

/** The same notice told once: the key a session's reader uses so a notice seen early is not told again when it is taken. */
export function takenBackKey(notice: TakenBackNotice): string {
  return `${notice.at}\u0000${notice.restored.id}\u0000${notice.by}`;
}

/** The sentence the restoring person reads before a restore that takes back others' changes. */
export function othersUndoneLines(others: readonly OtherSessionChanges[]): string[] {
  return others.map((other) => {
    const files = other.files.slice(0, 10).join(', ') + (other.files.length > 10 ? ` and ${other.files.length - 10} more` : '');
    const agents = other.agentIds.length > 0 ? ` (its agent${other.agentIds.length === 1 ? '' : 's'} ${other.agentIds.join(', ')})` : '';
    return `  session ${other.sessionId}${agents}: ${files}`;
  });
}
