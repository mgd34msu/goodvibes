/**
 * Work is kept per project: each project's ledger, plans waiting, conversation intake, hosted turns and native runs
 * are its own, made on the first request that names it and the same ones for every later request. A request names its
 * project by `workingDirectory` (the project folder of the program or caller asking), which is taken off the body
 * before the method reads it, so a method's own schema never sees it. A request that names none is refused (NO_PROJECT),
 * unless it is made inside a project already: the daemon's own folder is no project.
 *
 * `routeByProject(catalog, ensure)` gives a catalog whose handlers each run inside the project their request named
 * (after `ensure` has made that project's work, once); `requestProject()` says which project that is; and
 * `projectProxy(...)` is a host object whose every member is the current project's.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isAbsolute } from 'node:path';
import { projectIdentityOf } from '../workspace/project-identity.js';
import type { GatewayMethodCatalog } from './method-catalog.js';
import type { GatewayMethodHandler } from './method-catalog-shared.js';
import { GatewayVerbError } from './routes/gateway-verb-error.js';

const current = new AsyncLocalStorage<string>();

/** The project folder (resolved) the request being served named, or undefined when it named none. */
export function requestProject(): string | undefined {
  return current.getStore();
}

/**
 * A project folder as every per-project store keys it: the product's one project identity
 * (workspace/project-identity.ts): a subfolder of a project is that project; one folder by two paths is one.
 */
export function projectKey(folder: string): string {
  return projectIdentityOf(folder);
}

/** Runs `run` as a request that named `folder` (a daemon turn, a resumed record). */
export function inProject<T>(folder: string, run: () => T): T {
  return current.run(projectKey(folder), run);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A catalog that registers each handler to run in the project its request names. `ensure` makes that project's work
 * (once; later calls return at once) before the handler runs, so a host's members can be read synchronously inside it.
 */
export function routeByProject(catalog: GatewayMethodCatalog, ensure: (folder: string) => Promise<void>): GatewayMethodCatalog {
  const route = (handler: GatewayMethodHandler): GatewayMethodHandler => async (invocation) => {
    const { body, query } = invocation;
    const inBody = isRecord(body) && body['workingDirectory'] !== undefined;
    const inQuery = isRecord(query) && query['workingDirectory'] !== undefined;
    // Else the call context the calling program sends with every request, or a capability puts on the method it runs
    // (method-catalog-shared.ts `CallContext`): a nested Work method a capability calls is that caller's project's too.
    const fromContext = invocation.context.call?.project;
    if (!inBody && !inQuery && !fromContext) {
      // A call made inside a project already (a daemon turn's, a resumed record's: `inProject`) stays in it. Any other
      // call naming no project is refused: the daemon's own folder is never a project to serve it from.
      if (requestProject() !== undefined) return handler(invocation);
      throw new GatewayVerbError('No project folder came with the request, so no project\'s work was read or changed. Send workingDirectory, the absolute path of the project folder (a program sends its own with every call; the web UI the project chosen). Nothing was done.',
        'NO_PROJECT', 422, 'workingDirectory');
    }
    const given = inBody ? (body as Record<string, unknown>)['workingDirectory'] : inQuery ? (query as Record<string, unknown>)['workingDirectory'] : fromContext;
    if (typeof given !== 'string' || !given.trim() || !isAbsolute(given.trim())) {
      throw new GatewayVerbError('workingDirectory must be the absolute path of the project folder the work is in. Nothing was read or changed.', 'INVALID_ARGUMENT', 400, 'workingDirectory');
    }
    const without = (record: unknown): unknown => {
      if (!isRecord(record) || record['workingDirectory'] === undefined) return record;
      const { workingDirectory: _folder, ...rest } = record;
      return rest;
    };
    const folder = projectKey(given.trim());
    await ensure(folder);
    return current.run(folder, () => handler({ ...invocation, body: without(body), query: without(query) as typeof query }));
  };
  return new Proxy(catalog, {
    get(target, key, receiver) {
      if (key === 'register') {
        return (descriptor: Parameters<GatewayMethodCatalog['register']>[0], handler: GatewayMethodHandler, ...rest: unknown[]) =>
          (target.register as (...args: unknown[]) => unknown).call(target, descriptor, route(handler), ...rest);
      }
      const value = Reflect.get(target, key, receiver) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * A host object whose members are those of the current request's project (`pick` reads them from that project's
 * work, made already by the routing), or of the daemon's own project when the request named none.
 */
export function projectProxy<Host extends object>(pick: (folder: string | undefined) => Host): Host {
  return new Proxy({} as Host, {
    get(_target, key) {
      const host = pick(requestProject());
      const value = Reflect.get(host, key, host) as unknown;
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(host) : value;
    },
    has(_target, key) { return Reflect.has(pick(requestProject()), key); },
  });
}
