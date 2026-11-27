/**
 * project-folder-records.ts, where a terminal program keeps its project's records when it is opened in a subfolder.
 *
 * A program opened in a subfolder of a project is in that project: every record it keeps for the project (sessions,
 * crash recovery, its local session broker and approvals, the decision log, recorded runs, watchers, the worktrees
 * list, its activity log and telemetry, checkpoints, the code index and the project index) sits with the project's
 * (`<project>/.goodvibes/...`, shell-paths.ts `projectFolderOf`), so a program opened in the project's root and one
 * opened in its subfolder keep one set. What an earlier release kept under the subfolder (`<subfolder>/.goodvibes/...`)
 * is carried once (runtime/records-carry.ts: copied where the project holds none, merged where it does, nothing
 * dropped), and the subfolder's files are left exactly as they were (the release before reads them there). The
 * checkpoint store is carried by the checkpoint manager itself (manager.ts). Not carried: the subfolder's code index
 * and project index, caches of the subfolder's files that the project's are built again from (one per project).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { assertProjectFolderReachable } from '../workspace/project-folder-guard.js';
import { join, resolve } from 'node:path';
import { projectFolderOf } from './shell-paths.js';
import { projectStoreLockPath } from './session-surface.js';
import { withCrossProcessLockSync } from '../workspace/checkpoint/cross-process-lock.js';
import { carryRecordsBetween, type RecordsCarryResult } from './records-carry.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** The folder a program opened in `folder` keeps its project records under: the project's, or the folder itself. */
export function projectRecordsFolder(folder: string): string {
  return projectFolderOf(folder);
}

/** A program's records under a folder's `.goodvibes/`, each a file or a directory carried with everything in it. */
const PROGRAM_RECORDS: readonly string[] = [
  ...['tui', 'agent'].flatMap((surface) => [
    'sessions', 'recovery', 'state', 'control-plane', 'replay', 'research', 'documents', 'remote', 'channels', 'memory',
    'decisions.sqlite', 'watchers.json',
  ].map((name) => `${surface}/${name}`)),
  'worktrees.json', 'logs', 'telemetry',
];

/** Where the carry from a folder is recorded, so it runs once. */
const CARRIED_FROM = 'carried-from-subfolders.json';

/**
 * Carry the records an earlier release kept under the opened subfolder into the project's, once. Run before any of
 * the program's stores opens. A failure is logged, the old files stay where they are, and the next start tries again.
 */
export function carrySubfolderRecords(openedFolder: string, projectFolder: string): RecordsCarryResult | undefined {
  if (resolve(openedFolder) === resolve(projectFolder)) return undefined;
  const source = join(openedFolder, '.goodvibes');
  if (!existsSync(source)) return undefined;
  const target = join(projectFolder, '.goodvibes');
  const marker = join(target, CARRIED_FROM);
  const carriedNow = (): string[] => {
    try { return (JSON.parse(readFileSync(marker, 'utf8')) as { from?: string[] }).from ?? []; } catch { return []; }
  };
  if (carriedNow().includes(resolve(openedFolder))) return undefined;
  const result: RecordsCarryResult = { copied: [], merged: [], singleValues: [], failed: [] };
  try {
    assertProjectFolderReachable(target);
    mkdirSync(target, { recursive: true });
    // The whole carry runs alone among every program and the daemon in the project: under the project's checkpoint
    // store lock (session-surface.ts projectStoreLockPath), with the record of what was carried read again under it,
    // so two programs opening together carry once and neither's entry in the record is lost.
    withCrossProcessLockSync(projectStoreLockPath(projectFolder), () => {
      const carried = carriedNow();
      if (carried.includes(resolve(openedFolder))) return;
      carryRecordsBetween(source, target, PROGRAM_RECORDS, openedFolder, result);
      if (result.failed.length > 0) return;
      const temporary = `${marker}.carry-${process.pid}`;
      writeFileSync(temporary, JSON.stringify({ from: [...carried, resolve(openedFolder)] }));
      renameSync(temporary, marker);
    }, { waitMs: CARRY_LOCK_WAIT_MS });
    if (result.copied.length + result.merged.length > 0 || result.failed.length > 0) {
      logger.info('a subfolder\'s records were carried into its project\'s; the subfolder\'s files are left as they were', { from: openedFolder, to: projectFolder, ...result });
    }
  } catch (error) {
    logger.warn('a subfolder\'s earlier records were not carried; they stay where they are', { from: openedFolder, error: summarizeError(error) });
  }
  return result;
}

/** How long a program's start waits for another holder of its project's store lock before the carry is left for later. */
const CARRY_LOCK_WAIT_MS = 15_000;
