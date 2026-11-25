/**
 * Work per project: the daemon's own folder's work, and each other project's, made on the first request that names
 * that project (control-plane/project-routing.ts) and the same one for every later request. A failed making is not
 * kept, so the next request tries again; a closed set makes nothing more.
 */
import { projectKey } from '@goodvibes/engine/platform/platform/control-plane';

export interface ProjectWorkSet<Work> {
  /** Makes the project's work once (later calls return at once): the routing awaits it before a handler runs. */
  ensure(folder: string): Promise<void>;
  /** The project's work, made already (the daemon's own for no folder, or its own folder). */
  get(folder: string | undefined): Work;
  /** The work of the daemon's own folder and of every project made so far. */
  all(): readonly Work[];
  close(): Promise<void>;
}

export function createProjectWorkSet<Work extends { close(): Promise<void> }>(options: {
  readonly ownFolder: string;
  readonly own: Work;
  readonly build: (folder: string) => Promise<Work>;
}): ProjectWorkSet<Work> {
  const own = projectKey(options.ownFolder);
  const made = new Map<string, Work>();
  const making = new Map<string, Promise<void>>();
  let closed = false;
  return {
    ensure(folder) {
      const key = projectKey(folder);
      if (key === own || made.has(key)) return Promise.resolve();
      if (closed) return Promise.reject(new Error('The daemon is stopping; no new project\'s work is made.'));
      let pending = making.get(key);
      if (!pending) {
        pending = options.build(key).then((work) => { made.set(key, work); }).finally(() => { making.delete(key); });
        making.set(key, pending);
      }
      return pending;
    },
    get(folder) {
      if (folder === undefined) return options.own;
      const key = projectKey(folder);
      if (key === own) return options.own;
      const work = made.get(key);
      if (!work) throw new Error(`The work of project ${key} is not made yet.`);
      return work;
    },
    all: () => [options.own, ...made.values()],
    async close() {
      closed = true;
      await Promise.allSettled([...making.values()]);
      await Promise.all([...made.values()].map((work) => work.close()));
    },
  };
}
