/**
 * Work per project: each project's work, made on the first request that names that project
 * (control-plane/project-routing.ts) and the same one for every later request. The daemon's own folder is no project
 * and has no Work: a request naming no project is refused before it reaches here (`routeByProject`, NO_PROJECT). A
 * failed making is not kept, so the next request tries again; a closed set makes nothing more.
 */
import { projectKey } from '@goodvibes/engine/platform/platform/control-plane';
import { outsideEveryCall } from '@goodvibes/engine/platform/platform/utils';

export interface ProjectWorkSet<Work> {
  /** Makes the project's work once (later calls return at once): the routing awaits it before a handler runs. */
  ensure(folder: string): Promise<void>;
  /** The project's work, made already; no project is refused (the daemon's own folder has no Work). */
  get(folder: string | undefined): Work;
  /** The work of every project made so far. */
  all(): readonly Work[];
  close(): Promise<void>;
}

export function createProjectWorkSet<Work extends { close(): Promise<void> }>(options: {
  readonly build: (folder: string) => Promise<Work>;
}): ProjectWorkSet<Work> {
  const made = new Map<string, Work>();
  const making = new Map<string, Promise<void>>();
  let closed = false;
  return {
    ensure(folder) {
      const key = projectKey(folder);
      if (made.has(key)) return Promise.resolve();
      if (closed) return Promise.reject(new Error('The daemon is stopping; no new project\'s work is made.'));
      let pending = making.get(key);
      if (!pending) {
        // Made by whichever request first names the project: built in the process's own context, so its background (its
        // intake, its activation, its cause questions, its timers) runs as no caller (engine utils/outside-every-call.ts).
        pending = outsideEveryCall(() => options.build(key).then((work) => { made.set(key, work); }).finally(() => { making.delete(key); }));
        making.set(key, pending);
      }
      return pending;
    },
    get(folder) {
      if (folder === undefined) {
        throw Object.assign(new Error('No project folder came with the request, so no project\'s work was read or changed. Send workingDirectory, the absolute path of the project folder. Nothing was done.'),
          { code: 'NO_PROJECT', status: 422 });
      }
      const key = projectKey(folder);
      const work = made.get(key);
      if (!work) throw new Error(`The work of project ${key} is not made yet.`);
      return work;
    },
    all: () => [...made.values()],
    async close() {
      closed = true;
      await Promise.allSettled([...making.values()]);
      await Promise.all([...made.values()].map((work) => work.close()));
    },
  };
}
