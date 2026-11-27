/**
 * Work per project: each project's work, made on the first request that names that project
 * (control-plane/project-routing.ts) and the same one for every later request. The daemon's own folder is no project
 * and has no Work: a request naming no project is refused before it reaches here (`routeByProject`, NO_PROJECT). A
 * failed making is not kept, so the next request tries again; a closed set makes nothing more.
 *
 * At most PROJECT_WORK_KEPT projects' Work is kept open, as the project facilities and the tool registries they hang on
 * are kept (agents/orchestrator.ts IDLE_REGISTRIES_KEPT): when making one passes the bound, the least recently used Work
 * that nothing holds (no request is being served from it, `acquire`; nothing of it runs, `busy`) is closed (its
 * background and the project facilities it held go with it) and made again by the next request that names the
 * project. Its records are on disk: nothing is lost. Nothing is closed because time went by. So a daemon that made the
 * Work of thousands of projects (one per chat with no project of its own) keeps only a bounded number open.
 */
import { projectKey } from '@goodvibes/engine/platform/platform/control-plane';
import { logger, outsideEveryCall, summarizeError } from '@goodvibes/engine/platform/platform/utils';

export interface ProjectWorkSet<Work> {
  /** Makes the project's work once (later calls return at once). */
  ensure(folder: string): Promise<void>;
  /**
   * Makes the project's work once and holds it until the returned release is called: the routing holds it for the
   * request it serves, so it is never closed under that request.
   */
  acquire(folder: string): Promise<() => void>;
  /** The project's work, made already; no project is refused (the daemon's own folder has no Work). */
  get(folder: string | undefined): Work;
  /** The work of every project open now. */
  all(): readonly Work[];
  close(): Promise<void>;
}

/** How many projects' Work is kept open at most, by default (the least recently used one nothing holds goes first). */
export const PROJECT_WORK_KEPT = 8;

export function createProjectWorkSet<Work extends { close(): Promise<void> }>(options: {
  readonly build: (folder: string) => Promise<Work>;
  /** Whether something of the project's Work runs now (its fleet, its open continuations): such Work is kept. */
  readonly busy?: ((work: Work) => boolean) | undefined;
  readonly kept?: number | undefined;
}): ProjectWorkSet<Work> {
  // Most recently used last (a use moves the project to the end).
  const made = new Map<string, Work>();
  const making = new Map<string, Promise<void>>();
  const closing = new Map<string, Promise<void>>();
  const holds = new Map<string, number>();
  const kept = Math.max(1, options.kept ?? PROJECT_WORK_KEPT);
  let closed = false;
  const touch = (key: string): void => {
    const work = made.get(key);
    if (work === undefined) return;
    made.delete(key);
    made.set(key, work);
  };
  /** Past the bound: the least recently used Work nothing holds is closed, until within it or none can go. */
  const keepWithinBound = (): void => {
    while (made.size > kept) {
      let oldest: [string, Work] | undefined;
      for (const entry of made) {
        const [key, work] = entry;
        if (making.has(key) || (holds.get(key) ?? 0) > 0) continue;
        let running = false;
        try { running = options.busy?.(work) === true; } catch { running = true; }
        if (running) continue;
        oldest = entry;
        break;
      }
      if (!oldest) return;
      const [key, work] = oldest;
      made.delete(key);
      const done = outsideEveryCall(() => work.close()).catch((error: unknown) => {
        logger.warn('[Work] a project\'s Work was not let go cleanly', { project: key, error: summarizeError(error) });
      }).finally(() => { if (closing.get(key) === done) closing.delete(key); });
      closing.set(key, done);
    }
  };
  const set: ProjectWorkSet<Work> = {
    ensure(folder) {
      const key = projectKey(folder);
      if (made.has(key)) { touch(key); return Promise.resolve(); }
      if (closed) return Promise.reject(new Error('The daemon is stopping; no new project\'s work is made.'));
      let pending = making.get(key);
      if (!pending) {
        // Made by whichever request first names the project: built in the process's own context, so its background (its
        // intake, its activation, its cause questions, its timers) runs as no caller (engine utils/outside-every-call.ts).
        // A release of the project's earlier Work still closing is waited for first: one Work per project at a time.
        pending = outsideEveryCall(() => (closing.get(key) ?? Promise.resolve())
          .then(() => options.build(key)).then((work) => { made.set(key, work); }).finally(() => { making.delete(key); keepWithinBound(); }));
        making.set(key, pending);
      }
      return pending;
    },
    async acquire(folder) {
      const key = projectKey(folder);
      // Held before it is made, so making another project's Work meanwhile never closes this one.
      holds.set(key, (holds.get(key) ?? 0) + 1);
      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        const left = (holds.get(key) ?? 1) - 1;
        if (left > 0) holds.set(key, left); else holds.delete(key);
      };
      try { await set.ensure(folder); }
      catch (error) { release(); throw error; }
      return release;
    },
    get(folder) {
      if (folder === undefined) {
        throw Object.assign(new Error('No project folder came with the request, so no project\'s work was read or changed. Send workingDirectory, the absolute path of the project folder. Nothing was done.'),
          { code: 'NO_PROJECT', status: 422 });
      }
      const key = projectKey(folder);
      const work = made.get(key);
      if (!work) throw new Error(`The work of project ${key} is not made yet.`);
      touch(key);
      return work;
    },
    all: () => [...made.values()],
    async close() {
      closed = true;
      await Promise.allSettled([...making.values()]);
      await Promise.allSettled([...closing.values()]);
      const open = [...made.values()];
      made.clear();
      await Promise.all(open.map((work) => work.close()));
    },
  };
  return set;
}
