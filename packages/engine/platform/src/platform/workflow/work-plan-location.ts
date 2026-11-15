/**
 * Where a project's work plan lives: `<work-plans>/project-<hash>.json`, the
 * hash taken over the exact project ID and root. The location is a pure
 * function of the project, so finding a plan needs no table, no scan and no
 * slot, and two projects never share a file because their names look alike.
 *
 * Earlier builds kept an assignment table (`.project-owners/<slot>.json` rows
 * pointing at `.native-plans/<slot>.json` or an older top-level file). The first
 * store opened in a directory that still has that table moves each assigned
 * plan to its hashed name once, then retires the table.
 */
import { createHash } from 'node:crypto';
import { linkSync, lstatSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

export interface WorkPlanProject { readonly projectId: string; readonly projectRoot: string }

const HASHED_PLAN = /^project-[0-9a-f]{32}\.json$/;
const OWNERS = '.project-owners';
const NATIVE_PLANS = '.native-plans';

/** The plan file of one project inside `directory`. */
export function workPlanPath(directory: string, project: WorkPlanProject): string {
  const hash = createHash('sha256').update(project.projectId).update('\0').update(project.projectRoot).digest('hex').slice(0, 32);
  return join(directory, `project-${hash}.json`);
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;

function readJson(path: string): Record<string, unknown> | null {
  try { return record(JSON.parse(readFileSync(path, 'utf8'))); } catch { return null; }
}

function names(directory: string): string[] {
  try { return readdirSync(directory); } catch { return []; }
}

const absent = (path: string): boolean => lstatSync(path, { throwIfNoEntry: false }) === undefined;

/**
 * Moves `source` to `target` without replacing a plan already at `target`.
 * True when the source is gone afterwards (moved here or by another process).
 */
function moveWithoutReplacing(source: string, target: string): boolean {
  try {
    linkSync(source, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return absent(source);
    if (code !== 'EEXIST') throw error;
    // Another process importing at the same moment linked the same file: same inode, safe to drop the old name.
    const held = lstatSync(source, { throwIfNoEntry: false }), existing = lstatSync(target, { throwIfNoEntry: false });
    if (!held || !existing || held.ino !== existing.ino || held.dev !== existing.dev) return !held;
  }
  try { unlinkSync(source); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  return true;
}

/** Leaves a leftover directory where the owner can inspect it, out of the way of later starts. */
function retire(path: string, unassigned: string[]): void {
  try { rmdirSync(path); return; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
  }
  const kept = `${path}.unimported-${Date.now()}`;
  try { renameSync(path, kept); unassigned.push(kept); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/**
 * Moves the plans of an earlier build's assignment table to their hashed names,
 * once. Returns the files and directories it could not attribute to a project;
 * they are left in place, untouched. Costs two `lstat` calls when there is
 * nothing to import.
 */
export function importAssignedWorkPlans(directory: string): readonly string[] {
  const owners = join(directory, OWNERS), native = join(directory, NATIVE_PLANS);
  if (absent(owners) && absent(native)) return [];
  const unassigned: string[] = [];
  try {
    for (const row of names(owners).filter(name => name.endsWith('.json')).sort()) {
      const rowPath = join(owners, row), value = readJson(rowPath);
      const planFile = value?.['planFile'];
      if (!value || typeof value['projectId'] !== 'string' || typeof value['projectRoot'] !== 'string' || typeof planFile !== 'string'
        || planFile.includes('..') || planFile.includes('\0')) continue;
      const source = join(directory, planFile);
      if (absent(source) || moveWithoutReplacing(source, workPlanPath(directory, { projectId: value['projectId'], projectRoot: value['projectRoot'] }))) {
        try { unlinkSync(rowPath); } catch { /* another process retired it */ }
      } else {
        logger.warn('Work plan import kept an earlier plan beside a newer one', { source, project: value['projectRoot'] });
        // A plan left under the table's own directory is listed with that directory when it is retired.
        if (!source.startsWith(`${native}/`)) unassigned.push(source);
      }
    }
    // Top-level plans from before the table name their project inside the file.
    for (const name of names(directory)) {
      if (!name.endsWith('.json') || HASHED_PLAN.test(name)) continue;
      const path = join(directory, name), value = readJson(path);
      if (value && typeof value['projectId'] === 'string' && typeof value['projectRoot'] === 'string'
        && moveWithoutReplacing(path, workPlanPath(directory, { projectId: value['projectId'], projectRoot: value['projectRoot'] }))) continue;
      unassigned.push(path);
    }
    retire(owners, unassigned);
    retire(native, unassigned);
  } catch (error) {
    logger.warn('Work plan import from the earlier assignment table did not finish; the remaining files were left in place', {
      directory: basename(directory), error: summarizeError(error),
    });
  }
  return Object.freeze([...new Set(unassigned)]);
}
