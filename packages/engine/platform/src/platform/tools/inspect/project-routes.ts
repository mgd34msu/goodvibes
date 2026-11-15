import { assertCapturedToolAccessCurrent } from '../shared/captured-input-tools.js';
/**
 * The HTTP routes a project declares, for inspect modes `api`, `api_spec`,
 * `api_validate` and `api_sync`. Next.js App Router routes are facts of the
 * framework's file convention (a route.ts exporting a function named after
 * the method). A Next.js pages/api handler's methods, and whether a verb
 * method call registers an Express, Fastify or Hono route, are read by
 * `engine.tools.api-routes` (tools/batteries/api-routes.ts). A route is
 * listed unless its reading is a no; an uncertain one carries
 * `reading: 'uncertain'`.
 */
import { existsSync } from 'node:fs';
import { basename, dirname, join, relative, sep } from 'node:path';
import { DecisionModelsDisabledError, judgmentPort } from '@goodvibes-jev/engine/errors';
import { decisionOrClassic } from '../../runtime/decision-policy.js';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { apiRoutes, HANDLER_METHODS, handlerView, routeLineView, servesQuestion } from '../batteries/api-routes.js';
import { scanRead, walk } from './shared.js';
import type { ApiFramework, ApiRoute } from './schema.js';

const SITE = 'tools.inspect.api-routes';
const READ_CONCURRENCY = 8;
/** A route tree is walked on its own, so only these are skipped: a route directory may be named `build`, `out` or `vendor`. */
const ROUTE_TREE_SKIPS: ReadonlySet<string> = new Set(['node_modules', '.git']);

type ConcreteFramework = Exclude<ApiFramework, 'auto'>;
type RouteReading = 'listed' | 'uncertain' | 'dismissed';

/** A yes lists the route, a no dismisses it, anything else lists it as uncertain. */
function routeReading(reading: YesNoReading): RouteReading {
  if (reading.verdict === 'yes') return 'listed';
  return reading.verdict === 'no' ? 'dismissed' : 'uncertain';
}

function route(
  method: string,
  path: string,
  file: string,
  line: number,
  reading: Exclude<RouteReading, 'dismissed'>,
): ApiRoute {
  return reading === 'uncertain' ? { method, path, file, line, reading } : { method, path, file, line };
}

async function findNextjsAppRoutes(root: string, unavailable: string[], notes: string[], current?: () => void): Promise<ApiRoute[]> {
  const routes: ApiRoute[] = [];
  const appDir = join(root, 'app');
  if (!existsSync(appDir)) return routes;

  // The file must be named route.ts / route.js itself; `reroute.ts` is not a route handler.
  const files = await walk(appDir, (p) => /^route\.[tj]s$/.test(basename(p)), ROUTE_TREE_SKIPS, 0, notes, current);
  for (const file of files) {
    current?.();
    const content = await scanRead(file, unavailable);
    const relFile = relative(root, file);
    const lines = content.split('\n');
    // The URL is built from the directory segments: route groups `(name)` add nothing, `[id]` is a parameter.
    const segments = relative(appDir, dirname(file))
      .split(sep)
      .filter((segment) => segment !== '' && segment !== '.' && !/^\(.+\)$/.test(segment))
      .map((segment) => segment.replace(/\[(.+?)\]/g, ':$1'));
    const routePath = `/${segments.join('/')}`;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      for (const method of HANDLER_METHODS) {
        if (
          line.match(new RegExp(`export\\s+(async\\s+)?function\\s+${method}\\b`)) ||
          line.match(new RegExp(`export\\s+const\\s+${method}\\s*[:=]`))
        ) {
          routes.push({ method, path: routePath, file: relFile, line: i + 1 });
        }
      }
    }
  }
  return routes;
}

/** Each pages/api handler is read once for all seven methods (one request); each method it serves is a route. */
async function findNextjsPagesRoutes(root: string, unavailable: string[], notes: string[], current?: () => void): Promise<ApiRoute[]> {
  const apiDir = join(root, 'pages', 'api');
  if (!existsSync(apiDir)) return [];

  const files = await walk(apiDir, (p) => /\.[tj]sx?$/.test(p), ROUTE_TREE_SKIPS, 0, notes, current);
  const perFile = await mapWithConcurrency(files, READ_CONCURRENCY, async (file) => {
    const relFile = relative(root, file);
    const routePath =
      '/' +
      relative(join(root, 'pages'), file)
        .replace(/\.[tj]sx?$/, '')
        .replace(/\[(.+?)\]/g, ':$1');
    current?.();
    const content = await scanRead(file, unavailable);
    if (!content) return [];
    await assertCapturedToolAccessCurrent();
    const run = await apiRoutes.run(judgmentPort(SITE), handlerView(relFile, content), {
      site: SITE,
      only: HANDLER_METHODS.map(servesQuestion),
    });
    const routes = HANDLER_METHODS.flatMap((method) => {
      const reading = routeReading(run.readings[servesQuestion(method)]);
      return reading === 'dismissed' ? [] : [route(method, routePath, relFile, 1, reading)];
    });
    run.recordAction(`${relFile}: ${routes.map((r) => r.method).join(', ') || 'no methods'}`);
    return routes;
  });
  return perFile.flat();
}

/**
 * A candidate is a call of a method named after an HTTP verb whose first
 * argument is a string literal followed by another argument (or by the end
 * of the line, the arguments continuing below): the shape of a route
 * registration in Express, Fastify and Hono (path, then handlers).
 */
const VERB_CALL = /\.(get|post|put|delete|patch|options|head)\s*\(\s*(['"`])(.*?)\2\s*(?:,|$)/;

/** Most verb-call candidates read for one inspection; each is one decision-model request. */
const MAX_CALL_CANDIDATES = 300;

interface CallCandidate { relFile: string; lines: string[]; index: number; method: string; path: string }

/** The verb calls in the project's source files, found once however many frameworks are asked about. */
async function collectCallCandidates(root: string, files: readonly string[], unavailable: string[], notes: string[], current?: () => void): Promise<CallCandidate[]> {
  const candidates = (
    await mapWithConcurrency(files, READ_CONCURRENCY, async (file) => {
      current?.();
      const relFile = relative(root, file);
      const lines = (await scanRead(file, unavailable)).split('\n');
      return lines.flatMap((text, index) => {
        const m = VERB_CALL.exec(text);
        return m ? [{ relFile, lines, index, method: m[1]!.toUpperCase(), path: m[3] || '/' }] : [];
      });
    })
  ).flat();
  if (candidates.length > MAX_CALL_CANDIDATES) {
    // A `.get('x', ...)` call also matches a Map, Headers or cache; past the cap the rest are not read.
    notes.push(`Found ${candidates.length} possible route registrations; only the first ${MAX_CALL_CANDIDATES} were read, so routes beyond them are missing. Inspect a narrower projectRoot to cover the rest.`);
    return candidates.slice(0, MAX_CALL_CANDIDATES);
  }
  return candidates;
}

/**
 * Verb calls read by `route_registration`, each once, with every framework in play named in the question
 * (a call is a route when it registers with any of them); each is a route unless the reading is a no.
 * A candidate whose reading fails is listed as uncertain and counted in a note; when every reading fails
 * the failure is raised, since nothing was learned.
 */
async function findCallRoutes(candidates: readonly CallCandidate[], frameworks: readonly ConcreteFramework[], notes: string[], current?: () => void): Promise<ApiRoute[]> {
  const framework = frameworks.length > 1 ? `${frameworks.slice(0, -1).join(', ')} or ${frameworks[frameworks.length - 1]}` : frameworks[0]!;
  const failures: unknown[] = [];
  const readings = await mapWithConcurrency(candidates, READ_CONCURRENCY, async ({ relFile, lines, index }): Promise<RouteReading> => {
    current?.();
    await assertCapturedToolAccessCurrent();
    try {
      const run = await apiRoutes.run(judgmentPort(SITE), routeLineView(framework, relFile, lines, index), {
        site: SITE,
        only: ['route_registration'],
      });
      const reading = routeReading(run.readings.route_registration);
      run.recordAction(`${relFile}:${index + 1} ${framework}: ${reading}`);
      return reading;
    } catch (error) {
      current?.();
      await assertCapturedToolAccessCurrent();
      failures.push(error);
      return 'uncertain';
    }
  });
  if (failures.length > 0 && failures.length === candidates.length) throw failures[0];
  if (failures.length > 0) notes.push(`${failures.length} of ${candidates.length} possible route registrations could not be read and are listed as uncertain.`);
  return candidates.flatMap(({ relFile, index, method, path }, i) => {
    const reading = readings[i]!;
    return reading === 'dismissed' ? [] : [route(method, path, relFile, index + 1, reading)];
  });
}

const FRAMEWORK_PACKAGES: ReadonlyArray<readonly [pkg: string, framework: ConcreteFramework]> = [
  ['next', 'nextjs'],
  ['fastify', 'fastify'],
  ['hono', 'hono'],
  ['express', 'express'],
];

/** The API frameworks package.json declares as dependencies (facts, no preference among them). */
export async function declaredApiFrameworks(root: string, unavailable: string[] = []): Promise<ConcreteFramework[]> {
  const raw = await scanRead(join(root, 'package.json'), unavailable);
  if (!raw) return [];
  try {
    const pkg = JSON.parse(raw);
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    return FRAMEWORK_PACKAGES.filter(([name]) => all[name]).map(([, framework]) => framework);
  } catch {
    return [];
  }
}

/**
 * Routes of the given framework, or for 'auto' the routes of every framework
 * package.json declares; with none declared, every framework is scanned.
 * Each verb-call candidate is read once, asking whether it registers a route
 * with any of the frameworks in play, so nothing is preferred.
 * `notes` receives what the scan could not cover; `current` throws when the call was cancelled.
 */
export async function inspectApi(
  root: string,
  framework: ApiFramework,
  unavailable: string[] = [],
  notes: string[] = [],
  current?: () => void,
  /** The project's source files when the caller has already walked the tree. */
  sourceFiles?: readonly string[],
): Promise<ApiRoute[]> {
  return decisionOrClassic(() => inspectDecisionApi(root, framework, unavailable, notes, current, sourceFiles), () => {
    throw new DecisionModelsDisabledError('infer and verify API registrations from source code');
  });
}
/** The project's `.js`, `.jsx`, `.ts` and `.tsx` files, outside build output and dependencies. */
export function walkSourceFiles(root: string, notes: string[], current?: () => void): Promise<string[]> {
  return walk(root, (p) => /\.[tj]sx?$/.test(p), undefined, 0, notes, current);
}

async function inspectDecisionApi(root: string, framework: ApiFramework, unavailable: string[], notes: string[], current?: () => void, sourceFiles?: readonly string[]): Promise<ApiRoute[]> {
  let frameworks: ConcreteFramework[];
  if (framework !== 'auto') frameworks = [framework];
  else {
    const declared = await declaredApiFrameworks(root, unavailable);
    frameworks = declared.length > 0 ? declared : FRAMEWORK_PACKAGES.map(([, fw]) => fw);
  }
  const found = new Map<string, ApiRoute>();
  const add = (routes: readonly ApiRoute[]): void => {
    for (const r of routes) {
      const key = `${r.method} ${r.path} ${r.file}:${r.line}`;
      const existing = found.get(key);
      // A definite reading from one framework outranks an uncertain one from another.
      if (!existing || (existing.reading !== undefined && r.reading === undefined)) found.set(key, r);
    }
  };
  if (frameworks.includes('nextjs')) {
    add([...(await findNextjsAppRoutes(root, unavailable, notes, current)), ...(await findNextjsPagesRoutes(root, unavailable, notes, current))]);
  }
  // Every other framework shares one reading per candidate, so asking about three costs no more than asking about one.
  const calling = frameworks.filter((fw) => fw !== 'nextjs');
  if (calling.length > 0) {
    const files = sourceFiles ?? await walkSourceFiles(root, notes, current);
    add(await findCallRoutes(await collectCallCandidates(root, files, unavailable, notes, current), calling, notes, current));
  }
  return [...found.values()];
}
