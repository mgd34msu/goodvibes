/**
 * The inspect tool stays inside the project it was given, says what a scan did not cover, keeps its
 * sibling modes consistent, and stops when cancelled.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InspectTool } from '../platform/src/platform/tools/inspect/index.ts';
import { detectProject, inspectApi, inspectApiSync, parsePrismaSchema, validateApiSpec } from '../platform/src/platform/tools/inspect/project.ts';
import { serializeInspectOutput } from '../platform/src/platform/tools/inspect/shared.ts';
import { inspectClientBoundary } from '../platform/src/platform/tools/inspect/frontend.ts';
import { useToolReadings } from './_helpers/tool-readings.ts';

const readings = useToolReadings([
  [`"line":"app.get('/health', handler);"`, { route: true }],
  ['"file":"server/app.js"', { entryPoint: true }],
  ['"module":"next/headers"', { finding: true }],
  ['"module":"maybe-server"', { finding: 'uncertain' }],
]);

let root: string;
let outside: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gv-inspect-bounds-'));
  outside = mkdtempSync(join(tmpdir(), 'gv-inspect-outside-'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); });

const write = (file: string, content: string, base = root) => {
  mkdirSync(join(base, file, '..'), { recursive: true });
  writeFileSync(join(base, file), content);
};

describe('projectRoot', () => {
  test('a root outside the working directory is refused, and scaffold writes nothing there', async () => {
    const tool = new InspectTool(undefined, root);
    const result = await tool.execute({ mode: 'scaffold', moduleName: 'x', projectRoot: outside, dryRun: false });
    expect(result.success).toBe(false);
    expect(result.error).toContain('projectRoot refused');
    expect(existsSync(join(outside, 'src'))).toBe(false);
  });

  test('a read mode on a root outside is refused too', async () => {
    write('package.json', '{"name":"other"}', outside);
    const result = await new InspectTool(undefined, root).execute({ mode: 'project', projectRoot: outside });
    expect(result.success).toBe(false);
    expect(result.error).toContain('projectRoot refused');
  });

  test('where outside access is allowed a read works, but scaffold still writes only inside the working directory', async () => {
    write('package.json', '{"name":"other"}', outside);
    const tool = new InspectTool(undefined, root, () => true);
    expect((await tool.execute({ mode: 'project', projectRoot: outside })).success).toBe(true);
    const scaffold = await tool.execute({ mode: 'scaffold', moduleName: 'x', projectRoot: outside, dryRun: false });
    expect(scaffold.success).toBe(false);
    expect(scaffold.error).toContain('writes only inside the working directory');
    expect(existsSync(join(outside, 'src'))).toBe(false);
    expect((await tool.execute({ mode: 'scaffold', moduleName: 'x', projectRoot: outside })).success).toBe(true);
  });

  test('a root inside the working directory works', async () => {
    write('sub/package.json', '{"name":"inner"}');
    const result = await new InspectTool(undefined, root).execute({ mode: 'project', projectRoot: 'sub' });
    expect(JSON.parse(result.output!).name).toBe('inner');
  });
});

describe('reads that fail', () => {
  test('a directory given as the file is an error, not an empty analysis', async () => {
    mkdirSync(join(root, 'src'));
    const result = await new InspectTool(undefined, root).execute({ mode: 'components', file: 'src' });
    expect(result.success).toBe(false);
  });

  test('a route file that cannot be read is listed as unavailable on api_validate', async () => {
    write('package.json', JSON.stringify({ dependencies: { next: '14' } }));
    write('openapi.json', JSON.stringify({ paths: {} }));
    mkdirSync(join(root, 'app', 'users'), { recursive: true });
    symlinkSync(join(root, 'nowhere.ts'), join(root, 'app', 'users', 'route.ts'));
    const result = await new InspectTool(undefined, root).execute({ mode: 'api_validate', specPath: 'openapi.json' });
    expect(result.success).toBe(true);
    expect(JSON.parse(result.output!).unavailable_files).toEqual([join(root, 'app', 'users', 'route.ts')]);
  });
});

describe('summary format', () => {
  test('keeps the fields each mode exists to report', () => {
    const summarize = (mode: Parameters<typeof serializeInspectOutput>[2], value: unknown) => JSON.parse(serializeInspectOutput(value, 'summary', mode));
    expect(summarize('stacking', { zIndexItems: [], potentialConflicts: [{ values: ['z-50'], lines: [1, 2] }] }).potentialConflicts).toHaveLength(1);
    expect(summarize('hooks', { hooks: [{ hookKind: 'useEffect', deps: [], omitsDependency: 'yes' }] }).hooks[0].omitsDependency).toBe('yes');
    expect(summarize('render_triggers', { triggers: [{ kind: 'state_setter', name: 'setCount', line: 3 }] }).triggers[0].name).toBe('setCount');
    expect(summarize('sizing', { items: [{ kind: 'fixed_px', line: 1, flagged: true }] }).items[0].flagged).toBe(true);
    for (const mode of ['api', 'api_spec', 'api_validate', 'api_sync'] as const) {
      const summary = summarize(mode, { valid: false, missing_from_code: ['/a'], unavailable_files: ['src/routes.ts'], warning: '1 file(s) were denied' });
      expect([mode, summary.unavailable_files, summary.warning]).toEqual([mode, ['src/routes.ts'], '1 file(s) were denied']);
    }
    expect(summarize('api_validate', { valid: false, mismatched_methods: [{ path: '/a', spec_methods: ['GET'], code_methods: ['POST'] }] }).mismatchedMethods).toHaveLength(1);
  });
});

describe('database', () => {
  test('a schema that is not Prisma is an error, not a project with no tables', async () => {
    write('src/db/schema.ts', "export const users = pgTable('users', { id: serial('id') });\n");
    const result = await new InspectTool(undefined, root).execute({ mode: 'database', schemaPath: 'src/db/schema.ts' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('not supported');
  });

  test('a brace inside a quoted default does not cut the model short', () => {
    const parsed = parsePrismaSchema('model Doc {\n  id Int @id\n  meta Json @default("{}")\n  title String\n}\n');
    expect(parsed.models[0]!.fields.map((field) => field.name)).toEqual(['id', 'meta', 'title']);
  });
});

describe('prisma comments and unclosed blocks', () => {
  test('a quote or brace in a comment does not cut a model short or drop the next one', () => {
    const quote = parsePrismaSchema('model A {\n  id Int @id\n  // 5" pipe\n}\nmodel B {\n  id Int\n}\n');
    expect(quote.models.map((model) => model.name)).toEqual(['A', 'B']);
    const brace = parsePrismaSchema('model A {\n  id Int @id // note }\n  title String\n}\n');
    expect(brace.models[0]!.fields.map((field) => field.name)).toEqual(['id', 'title']);
  });

  test('a block that never closes is named instead of silently dropping what follows', () => {
    const parsed = parsePrismaSchema('model A {\n  id Int\n}\nmodel B {\n  id Int\n');
    expect(parsed.models.map((model) => model.name)).toEqual(['A']);
    expect(parsed.warning).toContain('model B');
  });
});

describe('api spec comparison', () => {
  test('parameter names do not make a route differ', () => {
    const routes = [{ method: 'GET', path: '/users/:userId', file: 'a.ts', line: 1 }];
    const result = validateApiSpec(JSON.stringify({ paths: { '/users/{id}': { get: {} } } }), routes);
    expect(result).toMatchObject({ valid: true, missing_from_spec: [], missing_from_code: [] });
    expect(result.note).toContain('mount prefix');
  });

  test('a spec that is not JSON says what is supported', () => {
    expect(() => validateApiSpec('openapi: 3.0.0', [])).toThrow('convert a YAML spec to JSON');
  });
});

describe('project', () => {
  test('a pnpm workspace is a monorepo although package.json has no workspaces key', async () => {
    write('package.json', '{"name":"root"}');
    write('pnpm-workspace.yaml', "packages:\n  - 'packages/*'\n");
    expect((await detectProject(root)).isMonorepo).toBe(true);
  });

  test('a script naming a file outside the project is never read as an entry point', async () => {
    const project = join(root, 'proj');
    write('package.json', JSON.stringify({ scripts: { start: 'node ../outside-entry.js', serve: 'node server/app.js' } }), project);
    write('server/app.js', 'listen();\n', project);
    write('outside-entry.js', 'secret();\n');
    await detectProject(project);
    const asked = readings.requests.filter((request) => 'entry_point' in (request.questions ?? {})).map((request) => (request.state as { file: string }).file);
    expect(asked).toEqual(['server/app.js']);
  });
});

describe('route discovery', () => {
  test('build output is not scanned for routes', async () => {
    write('package.json', JSON.stringify({ dependencies: { express: '4' } }));
    write('src/server.ts', "app.get('/health', handler);\n");
    write('build/server.js', "app.get('/health', handler);\n");
    write('coverage/lcov-report/x.js', "app.get('/health', handler);\n");
    const routes = await inspectApi(root, 'express');
    expect(routes.map((route) => route.file)).toEqual(['src/server.ts']);
  });

  test('a directory nested past the depth limit is reported, not silently dropped', async () => {
    write('package.json', JSON.stringify({ dependencies: { express: '4' } }));
    write(`${Array.from({ length: 12 }, (_, i) => `d${i}`).join('/')}/deep.ts`, "app.get('/deep', handler);\n");
    const notes: string[] = [];
    await inspectApi(root, 'express', [], notes);
    expect(notes.join(' ')).toContain('deeper than 10 levels');
  });

  test('Next.js route files: only route.ts itself, groups add nothing, the root route is /', async () => {
    write('app/route.ts', 'export async function GET() {}\n');
    write('app/(shop)/cart/[id]/route.ts', 'export const POST: Handler = async () => {};\n');
    write('app/api/reroute.ts', 'export async function GET() {}\n');
    const routes = await inspectApi(root, 'nextjs');
    expect(routes.map((route) => `${route.method} ${route.path}`).sort()).toEqual(['GET /', 'POST /cart/:id']);
  });

  test('a file full of verb calls is read up to a cap and the cap is stated', async () => {
    write('package.json', JSON.stringify({ dependencies: { express: '4' } }));
    write('big.ts', Array.from({ length: 500 }, (_, i) => `cache.get('k${i}', fallback);`).join('\n'));
    const notes: string[] = [];
    await inspectApi(root, 'express', [], notes);
    expect(readings.requests.length).toBe(300);
    expect(notes.join(' ')).toContain('only the first 300 were read');
  });

  test('with no framework declared each candidate is read once, not once per framework', async () => {
    write('server.ts', "app.get('/health', handler);\n");
    const routes = await inspectApi(root, 'auto');
    expect(routes).toHaveLength(1);
    expect(readings.requests.filter((request) => 'route_registration' in request.questions!)).toHaveLength(1);
  });

  test('a project with no package.json does not report it as denied or unreadable', async () => {
    write('server.ts', "app.get('/health', handler);\n");
    const unavailable: string[] = [];
    await inspectApi(root, 'auto', unavailable);
    expect(unavailable).toEqual([]);
  });

  test('a tree walked once for api_sync is not walked again by route discovery', async () => {
    write('package.json', JSON.stringify({ dependencies: { express: '4' } }));
    write('server.ts', "app.get('/health', handler);\n");
    write('other.ts', "app.get('/health', handler);\n");
    const routes = await inspectApi(root, 'express', [], [], undefined, [join(root, 'server.ts')]);
    expect(routes.map((route) => route.file)).toEqual(['server.ts']);
    write('client.ts', "fetch('/health');\nfetch('/gone');\n");
    const sync = await inspectApiSync(root, 'express');
    expect(sync.unmatched_fetches.map((call) => call.url)).toEqual(['/gone']);
    expect(sync.unmatched_routes).toEqual([]);
  });

  test('one reading that fails lists its call as uncertain and says so; every reading failing is an error', async () => {
    write('package.json', JSON.stringify({ dependencies: { express: '4' } }));
    write('a.ts', "app.get('/health', handler);\n");
    write('b.ts', "app.get('/broken', handler);\n");
    const working = installJudgmentPort(undefined)!;
    const failing = (marker: string) => installJudgmentPort({ ...working, ask: (request: Parameters<typeof working.ask>[0]) => JSON.stringify(request.state).includes(marker) ? Promise.reject(new Error('reading failed')) : working.ask(request) } as typeof working);
    failing('/broken');
    const notes: string[] = [];
    const routes = await inspectApi(root, 'express', [], notes);
    expect(routes.map((route) => `${route.path}:${route.reading ?? 'listed'}`).sort()).toEqual(['/broken:uncertain', '/health:listed']);
    expect(notes.join(' ')).toContain('1 of 2 possible route registrations could not be read');
    failing('app.get');
    await expect(inspectApi(root, 'express')).rejects.toThrow('reading failed');
  });

  test('a route directory named like a build directory is still a route', async () => {
    write('app/api/build/route.ts', 'export async function POST() {}\n');
    write('app/api/health/route.ts', 'export async function GET() {}\n');
    write('pages/api/out.ts', 'export default function handler() {}\n');
    const routes = await inspectApi(root, 'nextjs');
    expect(routes.map((route) => `${route.method} ${route.path}`)).toContain('POST /api/build');
  });

  test('a call two frameworks both list is one route', async () => {
    write('package.json', JSON.stringify({ dependencies: { express: '4', fastify: '4' } }));
    write('server.ts', "app.get('/health', handler);\n");
    const routes = await inspectApi(root, 'auto');
    expect(routes).toHaveLength(1);
  });
});

describe('cancellation', () => {
  test('an already cancelled inspection makes no readings', async () => {
    write('package.json', JSON.stringify({ dependencies: { express: '4' } }));
    write('server.ts', "app.get('/health', handler);\n");
    const controller = new AbortController();
    controller.abort();
    const result = await new InspectTool(undefined, root).execute({ mode: 'api' }, { signal: controller.signal } as never);
    expect(result.success).toBe(false);
    expect(readings.requests).toHaveLength(0);
  });
});

describe('server-only readings', () => {
  const asked = (module: string) => readings.requests.filter((request) => (request.state as { module?: string }).module === module).length;

  test('a definite verdict is remembered, an uncertain one is asked again', async () => {
    const source = "import { headers } from 'next/headers';\nimport thing from 'maybe-server';\n";
    await inspectClientBoundary(source, 'a.tsx');
    await inspectClientBoundary(source, 'b.tsx');
    expect(asked('next/headers')).toBe(1);
    expect(asked('maybe-server')).toBe(2);
  });
});
