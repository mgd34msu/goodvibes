import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { projectIdentityOf } from '@goodvibes/engine/platform/platform/workspace';
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/**
 * A record the daemon keeps per project with its records (`recordsPath`, under its records root), carried once from
 * where an earlier build kept it (`formerPath`, the home's terminal folder): copied when the records hold none yet, the
 * former file left exactly as it was (a rollback reads it there). Returns `recordsPath`.
 */
export function carriedRecordsFile(recordsPath: string, formerPath: string): string {
  if (existsSync(recordsPath) || !existsSync(formerPath)) return recordsPath;
  try {
    mkdirSync(dirname(recordsPath), { recursive: true });
    copyFileSync(formerPath, recordsPath);
  } catch (error) {
    logger.warn('a project record was not carried to the daemon\'s records; it is kept where it was', { from: formerPath, error: summarizeError(error) });
  }
  return recordsPath;
}

/**
 * Where the daemon keeps the run records (agent journals, run state) of a run of its own working in `folder`: under
 * its records root, one folder per project (`<records>/projects/<name>-<key>`, the key from the project's identity, so
 * two projects of one name never share one), never in the daemon's own folder and never in the project. A run in the
 * daemon's own folder (none is a project) keeps them at the records root itself.
 */
export function daemonRunRecordsRoot(recordsRoot: string, ownFolder: string, folder: string): string {
  if (resolve(folder) === resolve(ownFolder)) return recordsRoot;
  const project = projectIdentityOf(folder);
  const key = createHash('sha256').update(project).digest('hex').slice(0, 12);
  const name = basename(project).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'project';
  return join(recordsRoot, 'projects', `${name}-${key}`);
}
