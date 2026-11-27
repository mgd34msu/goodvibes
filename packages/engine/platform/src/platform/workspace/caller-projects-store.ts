/**
 * caller-projects-store.ts, the projects the owner gave each caller that is not the owner's own program: a paired device
 * (`pairing:<id>`) or a signed-in member (its principal id). Kept in the daemon home, beside the pairing records
 * (`<daemon home>/caller-projects.json`), keyed by the principal the daemon authenticates; set by the owner from the
 * Devices place (`devices.projects`, capabilities/builtin/devices-projects.ts). A caller with none acts on shared things
 * only: workspace/caller-project.ts refuses any project it names.
 *
 * At the upgrade from 3.5.0 (which had no projects per caller: every credential worked in every folder), every credential
 * that existed is given every workspace registered at that moment, once, recorded as carried from 3.5.0 (`carryFrom350`)
 * and removable in Devices and network like any project given. A credential made afterwards gets none by default.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFileSync } from '../config/atomic-write.js';
import { realPathOf } from './caller-project.js';

interface CallerProjectsFile {
  readonly version: 1;
  readonly callers: Record<string, readonly string[]>;
  /** Of those, the projects carried from 3.5.0 at the upgrade, per caller, while it still has them. */
  readonly carried?: Record<string, readonly string[]> | undefined;
  /** When the one-time carry from 3.5.0 ran (it runs once per daemon home). */
  readonly carriedAt?: number | undefined;
  /**
   * The credentials that existed when this version last stopped cleanly: one found at the next start that is not among
   * them was made while this version did not run (by 3.5.0, after a rollback), and is carried as the others were.
   */
  readonly knownAtStop?: readonly string[] | undefined;
}

function lists(value: unknown): Record<string, readonly string[]> {
  const record = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return Object.fromEntries(Object.entries(record).filter(([, list]) => Array.isArray(list))
    .map(([id, list]) => [id, (list as readonly unknown[]).filter((entry): entry is string => typeof entry === 'string')]));
}

export class CallerProjectsStore {
  readonly path: string;
  constructor(daemonHome: string) { this.path = join(daemonHome, 'caller-projects.json'); }

  private read(): CallerProjectsFile {
    try {
      const parsed = JSON.parse(readFileSync(this.path, 'utf-8')) as Partial<CallerProjectsFile>;
      return { version: 1, callers: lists(parsed?.callers),
        ...(parsed?.carried !== undefined ? { carried: lists(parsed.carried) } : {}),
        ...(typeof parsed?.carriedAt === 'number' ? { carriedAt: parsed.carriedAt } : {}),
        ...(Array.isArray(parsed?.knownAtStop) ? { knownAtStop: parsed.knownAtStop.filter((entry): entry is string => typeof entry === 'string') } : {}) };
    } catch {
      // No file, or one that cannot be read: no caller has a project (it can only narrow what a caller may name).
      return { version: 1, callers: {} };
    }
  }

  private write(file: CallerProjectsFile): void {
    atomicWriteFileSync(this.path, `${JSON.stringify(file, null, 2)}\n`, { mkdirp: true });
  }

  /** The projects given to `principalId`, as real paths; empty when none. */
  projectsOf(principalId: string): readonly string[] {
    return this.read().callers[principalId] ?? [];
  }

  /** Every caller given a project, with its projects. */
  list(): Readonly<Record<string, readonly string[]>> {
    return this.read().callers;
  }

  /** The projects `principalId` still has that were carried from 3.5.0 (shown so in Devices and network). */
  carriedOf(principalId: string): readonly string[] {
    const file = this.read();
    const has = file.callers[principalId] ?? [];
    return (file.carried?.[principalId] ?? []).filter((project) => has.includes(project));
  }

  /** Whether the one-time carry from 3.5.0 already ran in this daemon home. */
  carryDone(): boolean {
    return this.read().carriedAt !== undefined;
  }

  /** Keep the credentials that exist as this version stops cleanly (see `knownAtStop`). */
  noteKnownAtStop(principalIds: readonly string[]): void {
    const file = this.read();
    this.write({ ...file, knownAtStop: [...new Set(principalIds)] });
  }

  /** The credentials known at the last clean stop, taken (so an unclean stop later never reads a stale list); undefined: none kept. */
  takeKnownAtStop(): readonly string[] | undefined {
    const file = this.read();
    if (file.knownAtStop === undefined) return undefined;
    const { knownAtStop, ...rest } = file;
    this.write(rest);
    return knownAtStop;
  }

  /**
   * The one-time carry at the upgrade from 3.5.0: each principal in `existing` is given every root in `roots` (the
   * workspaces registered at that moment, real paths), recorded as carried. Runs once per daemon home (`carriedAt`);
   * returns what was carried (empty when it ran before).
   */
  carryFrom350(existing: readonly string[], roots: readonly string[], at = Date.now()): Readonly<Record<string, readonly string[]>> {
    const file = this.read();
    if (file.carriedAt !== undefined) return {};
    const callers = { ...file.callers };
    const carried: Record<string, readonly string[]> = { ...(file.carried ?? {}) };
    const done: Record<string, readonly string[]> = {};
    const real = [...new Set(roots.map((root) => realPathOf(root.trim())).filter(Boolean))];
    for (const principalId of new Set(existing)) {
      const had = callers[principalId] ?? [];
      const added = real.filter((root) => !had.includes(root));
      if (added.length === 0) continue;
      callers[principalId] = [...had, ...added];
      carried[principalId] = [...(carried[principalId] ?? []), ...added];
      done[principalId] = added;
    }
    this.write({ version: 1, callers, carried, carriedAt: at });
    return done;
  }

  /**
   * Give `principalId` these projects as carried from 3.5.0 (the outside agent's first credential on a carried home takes
   * what the operator token it replaces was carried: daemon/outside-agent.ts). Kept beside what it has.
   */
  giveCarried(principalId: string, projects: readonly string[]): readonly string[] {
    const file = this.read();
    const had = file.callers[principalId] ?? [];
    const added = [...new Set(projects)].filter((project) => !had.includes(project));
    if (added.length === 0) return had;
    const callers = { ...file.callers, [principalId]: [...had, ...added] };
    const carried = { ...(file.carried ?? {}), [principalId]: [...(file.carried?.[principalId] ?? []), ...added] };
    this.write({ version: 1, callers, carried, ...(file.carriedAt !== undefined ? { carriedAt: file.carriedAt } : {}) });
    return callers[principalId]!;
  }

  /** Give `principalId` exactly these projects (real paths); none takes every project away. */
  set(principalId: string, projects: readonly string[]): readonly string[] {
    const file = this.read();
    const kept = [...new Set(projects.map((project) => realPathOf(project.trim())).filter(Boolean))];
    const callers = { ...file.callers };
    if (kept.length === 0) delete callers[principalId];
    else callers[principalId] = kept;
    // A carried project taken away is no longer carried (given again, it is the owner's gift of now).
    const carried = { ...(file.carried ?? {}) };
    const stillCarried = (carried[principalId] ?? []).filter((project) => kept.includes(project));
    if (stillCarried.length === 0) delete carried[principalId];
    else carried[principalId] = stillCarried;
    this.write({ version: 1, callers, ...(file.carried !== undefined ? { carried } : {}), ...(file.carriedAt !== undefined ? { carriedAt: file.carriedAt } : {}) });
    return kept;
  }
}
