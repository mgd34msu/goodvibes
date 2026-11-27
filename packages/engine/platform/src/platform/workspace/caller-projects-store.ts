/**
 * caller-projects-store.ts, the projects the owner gave each caller that is not his own program: a paired device
 * (`pairing:<id>`) or a signed-in member (its principal id). Kept in the daemon home, beside the pairing records
 * (`<daemon home>/caller-projects.json`), keyed by the principal the daemon authenticates; set by the owner from the
 * Devices place (`devices.projects`, capabilities/builtin/devices-projects.ts). A caller with none acts on shared things
 * only: workspace/caller-project.ts refuses any project it names.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../config/atomic-write.js';
import { realPathOf } from './caller-project.js';

interface CallerProjectsFile { readonly version: 1; readonly callers: Record<string, readonly string[]> }

export class CallerProjectsStore {
  readonly path: string;
  constructor(daemonHome: string) { this.path = join(daemonHome, 'caller-projects.json'); }

  private read(): CallerProjectsFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<CallerProjectsFile>;
      const callers = parsed && typeof parsed.callers === 'object' && parsed.callers !== null ? parsed.callers : {};
      return { version: 1, callers: Object.fromEntries(Object.entries(callers).filter(([, list]) => Array.isArray(list)).map(([id, list]) => [id, list.filter((entry): entry is string => typeof entry === 'string')])) };
    } catch {
      // No file, or one that cannot be read: no caller has a project (it can only narrow what a caller may name).
      return { version: 1, callers: {} };
    }
  }

  /** The projects given to `principalId`, as real paths; empty when none. */
  projectsOf(principalId: string): readonly string[] {
    return this.read().callers[principalId] ?? [];
  }

  /** Every caller given a project, with its projects. */
  list(): Readonly<Record<string, readonly string[]>> {
    return this.read().callers;
  }

  /** Give `principalId` exactly these projects (real paths); none takes every project away. */
  set(principalId: string, projects: readonly string[]): readonly string[] {
    const file = this.read();
    const kept = [...new Set(projects.map((project) => realPathOf(project.trim())).filter(Boolean))];
    const callers = { ...file.callers };
    if (kept.length === 0) delete callers[principalId];
    else callers[principalId] = kept;
    atomicWriteFileSync(this.path, `${JSON.stringify({ version: 1, callers }, null, 2)}\n`, { mkdirp: true });
    return kept;
  }
}
