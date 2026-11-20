import { assertCapturedToolAccessCurrent } from '../shared/captured-input-tools.js';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { extname, isAbsolute, join, relative } from 'node:path';
import { safeRead, scanRead, SKIPPED_DIRS } from './shared.js';
import { judgmentPort } from '@goodvibes/engine/errors';
import { declaredTestRunner, isDeclaredPackageManager, PACKAGE_MANAGER_LOCKFILES, type DeclaredPackageManager } from '../../utils/project-test-runner.js';
import { mapWithConcurrency } from '../../utils/concurrency.js';
import { entryPointView, projectTooling } from '../batteries/project-tooling.js';
import { inspectApi, walkSourceFiles } from './project-routes.js';
import { decisionOrClassic, isClassicOperation, withConfiguredDecisionModelPolicy } from '../../runtime/decision-policy.js';
import type {
  ApiFramework,
  ProjectInfo,
  ApiRoute,
  DatabaseInfo,
  DbField,
  DbModel,
  DbEnum,
  ScaffoldPlan,
  ScaffoldFile,
  ApiSpec,
  OpenApiParameter,
  ApiValidateResult,
  FetchCall,
  ApiSyncResult,
} from './schema.js';

export { declaredApiFrameworks, inspectApi } from './project-routes.js';

const PROJECT_TOOLING_SITE = 'tools.inspect.project-tooling';

/** Build manifests and the ecosystem each one marks. */
const MANIFESTS: ReadonlyArray<readonly [file: string, type: Exclude<ProjectInfo['type'], 'unknown'>]> = [
  ['package.json', 'nodejs'],
  ['Cargo.toml', 'rust'],
  ['pyproject.toml', 'python'],
  ['requirements.txt', 'python'],
  ['go.mod', 'go'],
  ['Makefile', 'make'],
];

const LOCKFILES = PACKAGE_MANAGER_LOCKFILES;

type PackageManager = DeclaredPackageManager;
const isPackageManager = isDeclaredPackageManager;

/** Count source files across the complete project tree. */
function countSourceFiles(root: string): Record<string, number> {
  const counts: Record<string, number> = {};
  const visit = (dir: string): void => {
    let entries: import('node:fs').Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIPPED_DIRS.has(entry.name) && !entry.name.startsWith('.')) visit(join(dir, entry.name));
      } else if (entry.isFile()) {
        const ext = extname(entry.name);
        if (ext) {
          counts[ext] = (counts[ext] ?? 0) + 1;
        }
      }
    }
  };
  visit(root);
  return counts;
}

/** Source file extensions an entry point candidate may have. */
const SCRIPT_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const ENTRY_POINT_CONCURRENCY = 8;

/**
 * The entry points package.json declares, as the Node package spec defines
 * them: main, module, browser, every bin target, and every target in
 * exports (under any condition except `types`, which TypeScript defines as
 * the path to declaration files, not to a module).
 */
function declaredEntryPoints(pkg: Record<string, unknown>): string[] {
  const targets: string[] = [];
  const collect = (value: unknown): void => {
    if (typeof value === 'string') targets.push(value);
    else if (Array.isArray(value)) value.forEach(collect);
    else if (value !== null && typeof value === 'object') {
      for (const [key, inner] of Object.entries(value)) if (key !== 'types') collect(inner);
    }
  };
  for (const field of ['main', 'module', 'browser'] as const) if (typeof pkg[field] === 'string') collect(pkg[field]);
  collect(pkg.bin);
  collect(pkg.exports);
  return [...new Set(targets.map((target) => target.replace(/^\.\//, '')))];
}

/**
 * With no declared entry point, the candidates are the source files at the
 * root and directly in src/, and the source files the scripts name; each is
 * read by `entry_point` and listed on a yes that acts.
 */
async function readEntryPoints(root: string, scripts: Record<string, string>): Promise<string[]> {
  return decisionOrClassic(() => readDecisionEntryPoints(root, scripts), async () => { await assertCapturedToolAccessCurrent(); return []; });
}
async function readDecisionEntryPoints(root: string, scripts: Record<string, string>): Promise<string[]> {
  const isFile = (file: string): boolean => {
    try {
      return statSync(join(root, file)).isFile();
    } catch {
      return false;
    }
  };
  const listed = (dir: string): string[] => {
    try {
      return readdirSync(join(root, dir)).map((name) => (dir ? `${dir}/${name}` : name));
    } catch {
      return [];
    }
  };
  // package.json is repository content: a script token that climbs out of the project (or is absolute)
  // is not a project file and is never read.
  const named = Object.values(scripts).flatMap((script) =>
    script.split(/\s+/).map((token) => token.replace(/^['"]|['"]$/g, '').replace(/^\.\//, '')),
  ).filter((token) => !isAbsolute(token) && !token.split(/[\\/]/).includes('..'));
  const candidates = [...new Set([...listed(''), ...listed('src'), ...named])].filter(
    (file) => SCRIPT_FILE.test(file) && isFile(file),
  );
  const readings = await mapWithConcurrency(candidates, ENTRY_POINT_CONCURRENCY, async (file) => {
    const content = await safeRead(join(root, file));
    await assertCapturedToolAccessCurrent();
    const run = await projectTooling.runSome(judgmentPort(PROJECT_TOOLING_SITE), entryPointView(file, content, scripts), ['entry_point'], {
      site: PROJECT_TOOLING_SITE,
    });
    const reading = run.readings.entry_point;
    // An absent reading does not list the file.
    const entry = reading !== undefined && reading.verdict === 'yes' && reading.outcome === 'act';
    run.recordAction(`${file}: ${entry ? 'entry point' : 'not listed'}`);
    return entry;
  });
  return candidates.filter((_, i) => readings[i]);
}

const TEST_FRAMEWORK_LABELS: Readonly<Record<string, string | undefined>> = {
  bun: 'bun:test',
  node: 'node:test',
  none: undefined,
};

/**
 * Inspect a project root. Files settle what they can: one ecosystem among the
 * manifests present, the package.json `packageManager` field (corepack), or
 * the only package manager among the lockfiles present. What they leave open
 * (several ecosystems, no or conflicting lockfiles, the test runner) is read
 * by `engine.tools.project-tooling` in one request; a reading that does not
 * act leaves the field unknown ('unknown' type, 'none' package manager, no
 * test framework). Entry points are the ones package.json declares; with
 * none declared, each candidate file is read (readEntryPoints).
 */
export async function detectProject(root: string): Promise<ProjectInfo> {
  return withConfiguredDecisionModelPolicy(() => detectProjectUnderPolicy(root));
}
async function detectProjectUnderPolicy(root: string): Promise<ProjectInfo> {
  const has = (f: string) => existsSync(join(root, f));

  const manifests = MANIFESTS.filter(([file]) => has(file));
  const types = [...new Set(manifests.map(([, type]) => type))];
  const lockfiles = LOCKFILES.filter(([file]) => has(file));
  const lockManagers = [...new Set(lockfiles.map(([, manager]) => manager))];

  let name: string | undefined;
  let version: string | undefined;
  let scripts: Record<string, string> = {};
  let dependencies = 0;
  let devDependencies = 0;
  let isMonorepo = false;
  let dependencyNames: string[] = [];
  let declaredManager: PackageManager | undefined;
  let declaredEntries: string[] = [];

  if (has('package.json')) {
    const raw = await safeRead(join(root, 'package.json'));
    if (raw) {
      try {
        const pkg = JSON.parse(raw);
        name = pkg.name;
        version = pkg.version;
        scripts = pkg.scripts ?? {};
        dependencies = Object.keys(pkg.dependencies ?? {}).length;
        devDependencies = Object.keys(pkg.devDependencies ?? {}).length;
        isMonorepo = !!pkg.workspaces;
        dependencyNames = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
        const field = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : undefined;
        if (field !== undefined && isPackageManager(field)) declaredManager = field;
        declaredEntries = declaredEntryPoints(pkg);
      } catch {
        // malformed JSON
      }
    }
  }

  const settledType = types.length === 1 ? types[0] : types.length === 0 ? 'unknown' : undefined;
  const mayBeNode = settledType === 'nodejs' || (settledType === undefined && types.includes('nodejs'));
  const settledManager = declaredManager ?? (lockManagers.length === 1 ? lockManagers[0] : undefined);

  const asked: Array<'project_type' | 'package_manager' | 'test_framework'> = [];
  if (settledType === undefined) asked.push('project_type');
  if (mayBeNode && settledManager === undefined) asked.push('package_manager');
  const declaredFramework = mayBeNode ? declaredTestRunner({ scripts }) : undefined;
  if (mayBeNode && declaredFramework === undefined) asked.push('test_framework');

  let type: ProjectInfo['type'] = settledType ?? 'unknown';
  let packageManager: ProjectInfo['packageManager'] =
    settledType === 'nodejs' && settledManager ? settledManager : 'none';
  let testFramework: string | undefined = settledType === 'nodejs' ? declaredFramework : undefined;

  if (asked.length > 0) {
    await assertCapturedToolAccessCurrent();
    const run = await decisionOrClassic(() => projectTooling.runSome(
      judgmentPort(PROJECT_TOOLING_SITE),
      {
        manifests: manifests.map(([file]) => file),
        lockfiles: lockfiles.map(([file]) => file),
        scripts,
        dependencies: dependencyNames,
        ...(asked.includes('project_type') ? { sourceFiles: countSourceFiles(root) } : {}),
      },
      asked,
      { site: PROJECT_TOOLING_SITE },
    ), () => undefined);
    const r = run?.readings;
    if (run && r) {
      if (r.project_type?.outcome === 'act') type = r.project_type.choice;
      if (type === 'nodejs') {
        testFramework = declaredFramework;
        if (settledManager) packageManager = settledManager;
        else if (r.package_manager?.outcome === 'act') packageManager = r.package_manager.choice;
        if (r.test_framework?.outcome === 'act') {
          const choice = r.test_framework.choice;
          testFramework = choice in TEST_FRAMEWORK_LABELS ? TEST_FRAMEWORK_LABELS[choice] : choice;
        }
      }
      run.recordAction(`type ${type}, package manager ${packageManager}, test framework ${testFramework ?? 'none'}`);
    }
  }

  // Workspaces are declared in package.json (npm, yarn, bun) or in the package manager's own file (pnpm, lerna, nx).
  if (!isMonorepo) isMonorepo = has('pnpm-workspace.yaml') || has('lerna.json') || has('nx.json');

  const hasTypeScript = has('tsconfig.json') || has('tsconfig.base.json');
  const entryPoints = declaredEntries.length > 0 ? declaredEntries : await readEntryPoints(root, scripts);

  return {
    ...(isClassicOperation() ? { provenance: 'classic' as const, entryPointsSource: declaredEntries.length > 0 ? 'manifest' as const : 'unassessed' as const } : {}),
    type,
    name,
    version,
    packageManager,
    scripts,
    dependencies,
    devDependencies,
    hasTypeScript,
    testFramework,
    isMonorepo,
    entryPoints,
  };
}

/** A field is a relation when its type names a model declared in the same schema (the Prisma schema grammar). */
function parseModelFields(body: string, modelNames: ReadonlySet<string>): DbField[] {
  const fields: DbField[] = [];
  const FIELD_RE = /^\s*(\w+)\s+(\w+)(\[\])?([?!])?/;
  for (const line of body.split('\n')) {
    const m = FIELD_RE.exec(line.trim());
    if (!m) continue;
    const name = m[1]!;
    if (['@@', '@'].some((p) => name.startsWith(p))) continue;
    const type = m[2]!;
    const isOptional = m[4]! === '?';
    const isRelation = modelNames.has(type);
    fields.push({ name, type, isRelation, isOptional });
  }
  return fields;
}

/**
 * The `keyword Name { body }` blocks of a Prisma schema. The body ends at the matching brace, so a
 * brace inside a quoted default (`@default("{}")`) or a `//` comment does not end it early. A string
 * does not run past its line. A block that never closes is named in `unterminated`.
 */
function schemaBlocks(content: string, keyword: 'model' | 'enum', unterminated: string[] = []): Array<{ name: string; body: string }> {
  const blocks: Array<{ name: string; body: string }> = [];
  const open = new RegExp(`^${keyword}\\s+(\\w+)\\s*\\{`, 'gm');
  let m: RegExpExecArray | null;
  while ((m = open.exec(content)) !== null) {
    let depth = 1;
    let inString = false;
    let i = open.lastIndex;
    for (; i < content.length && depth > 0; i++) {
      const ch = content[i]!;
      if (inString) {
        if (ch === '\\') i++;
        else if (ch === '"' || ch === '\n') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === '/' && content[i + 1] === '/') {
        while (i < content.length && content[i] !== '\n') i++;
      } else if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth !== 0) { unterminated.push(`${keyword} ${m[1]}`); break; } // nothing after an unclosed block can be trusted
    blocks.push({ name: m[1]!, body: content.slice(open.lastIndex, i - 1) });
    open.lastIndex = i;
  }
  return blocks;
}

export function parsePrismaSchema(content: string): DatabaseInfo {
  const models: DbModel[] = [];
  const enums: DbEnum[] = [];

  const unterminated: string[] = [];
  const declared = schemaBlocks(content, 'model', unterminated);
  const modelNames = new Set(declared.map((block) => block.name));
  for (const block of declared) {
    models.push({ name: block.name, fields: parseModelFields(block.body, modelNames) });
  }

  for (const block of schemaBlocks(content, 'enum', unterminated)) {
    const values = block.body
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('//'))
      .filter((l) => /^\w+$/.test(l));
    enums.push({ name: block.name, values });
  }

  return {
    models,
    enums,
    ...(unterminated.length > 0 ? { warning: `The block(s) ${unterminated.join(', ')} never close with a matching brace; the blocks after them were not read.` } : {}),
  };
}

function normalizeScaffoldModuleName(moduleName: string): { kebab: string; pascal: string } {
  const parts = moduleName
    .trim()
    .split(/[^A-Za-z0-9]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (parts.length === 0) {
    throw new Error('moduleName must include at least one alphanumeric segment');
  }
  const kebab = parts.map((part) => part.toLowerCase()).join('-');
  const pascal = parts
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1).replace(/[^A-Za-z0-9]/g, '')}`)
    .join('');
  const identifier = /^[A-Za-z]/.test(pascal) ? pascal : `Module${pascal}`;
  return { kebab, pascal: identifier };
}

/** The files a scaffold creates. Writing them is the write tool's job (see executor.ts). */
export function buildScaffold(moduleName: string, dryRun: boolean): ScaffoldPlan {
  const { kebab, pascal } = normalizeScaffoldModuleName(moduleName);

  const files: ScaffoldFile[] = [
    {
      path: `src/${kebab}/index.ts`,
      content: `export * from './${kebab}.js';\nexport * from './types.js';\n`,
    },
    {
      path: `src/${kebab}/types.ts`,
      content: `export interface ${pascal} {\n  id: string;\n}\n\nexport interface ${pascal}Input {\n  name: string;\n}\n`,
    },
    {
      path: `src/${kebab}/${kebab}.ts`,
      content: `import type { ${pascal}, ${pascal}Input } from './types.js';\n\nexport function create${pascal}(input: ${pascal}Input): ${pascal} {\n  return { id: crypto.randomUUID(), ...input };\n}\n`,
    },
    {
      path: `src/${kebab}/${kebab}.test.ts`,
      content: `import { describe, test, expect } from 'bun:test';\nimport { create${pascal} } from './${kebab}.js';\n\ndescribe('${pascal}', () => {\n  test('creates a ${pascal} object with id and input fields', () => {\n    const result = create${pascal}({ name: 'test' });\n    expect(result).toHaveProperty('id');\n    expect(result.name).toBe('test');\n  });\n});\n`,
    },
  ];

  return { moduleName, dryRun, files };
}

function toOpenApiPath(path: string): { openApiPath: string; params: string[] } {
  const params: string[] = [];
  const openApiPath = path.replace(/:([\w]+)/g, (_, name) => {
    params.push(name);
    return `{${name}}`;
  });
  return { openApiPath, params };
}

export function generateApiSpec(routes: ApiRoute[], title = 'API', version = '1.0.0'): ApiSpec {
  const paths: ApiSpec['paths'] = {};

  for (const route of routes) {
    const { openApiPath, params } = toOpenApiPath(route.path);
    if (!paths[openApiPath]) paths[openApiPath] = {};

    const method = route.method.toLowerCase();
    const opId = `${method}_${openApiPath
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .replace(/^_|_$/g, '')}`;
    const parameters: OpenApiParameter[] = params.map((p) => ({
      name: p,
      in: 'path',
      required: true,
      schema: { type: 'string' },
    }));

    paths[openApiPath][method] = {
      operationId: opId,
      ...(parameters.length ? { parameters } : {}),
      responses: { '200': { description: 'OK' } },
    };
  }

  return { openapi: '3.0.0', info: { title, version }, paths };
}

export function validateApiSpec(specContent: string, routes: ApiRoute[]): ApiValidateResult {
  let specObj: Record<string, unknown>;
  try {
    specObj = JSON.parse(specContent);
  } catch {
    throw new Error('The spec file is not valid JSON. Only JSON OpenAPI files are read; convert a YAML spec to JSON first.');
  }

  // Parameter names do not distinguish routes (`/users/{id}` and `/users/:userId` are one route),
  // the same rule api_sync applies, so both sides compare on the normalised path.
  const specPaths = (specObj.paths ?? {}) as Record<string, Record<string, unknown>>;
  const specRouteMap = new Map<string, { path: string; methods: Set<string> }>();
  for (const [rawPath, pathItem] of Object.entries(specPaths)) {
    const methods = new Set(
      Object.keys(pathItem)
        .filter((k) => ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'].includes(k))
        .map((m) => m.toUpperCase()),
    );
    const key = normalizeUrlForMatch(rawPath);
    const existing = specRouteMap.get(key);
    if (existing) for (const m of methods) existing.methods.add(m);
    else specRouteMap.set(key, { path: rawPath, methods });
  }

  const codeRouteMap = new Map<string, { path: string; methods: Set<string> }>();
  for (const route of routes) {
    const key = normalizeUrlForMatch(route.path);
    const entry = codeRouteMap.get(key) ?? { path: route.path, methods: new Set<string>() };
    entry.methods.add(route.method);
    codeRouteMap.set(key, entry);
  }

  const missing_from_spec: string[] = [];
  const missing_from_code: string[] = [];
  const mismatched_methods: ApiValidateResult['mismatched_methods'] = [];

  for (const [key, code] of codeRouteMap) {
    const spec = specRouteMap.get(key);
    if (!spec) {
      for (const m of code.methods) {
        missing_from_spec.push(`${m} ${code.path}`);
      }
    } else {
      const specArr = [...spec.methods];
      const codeArr = [...code.methods];
      const onlyInSpec = specArr.filter((m) => !code.methods.has(m));
      const onlyInCode = codeArr.filter((m) => !spec.methods.has(m));
      if (onlyInSpec.length || onlyInCode.length) {
        mismatched_methods.push({ path: code.path, spec_methods: specArr, code_methods: codeArr });
      }
    }
  }

  for (const [key, spec] of specRouteMap) {
    if (!codeRouteMap.has(key)) {
      for (const m of spec.methods) {
        missing_from_code.push(`${m} ${spec.path}`);
      }
    }
  }

  const valid = missing_from_spec.length === 0 && missing_from_code.length === 0 && mismatched_methods.length === 0;
  return {
    valid,
    missing_from_spec,
    missing_from_code,
    mismatched_methods,
    note: 'Routes are compared as written: a mount prefix (an Express router mounted at /api, a spec `servers` base path) is not resolved.',
  };
}

function normalizeUrlForMatch(url: string): string {
  return (
    url
      .replace(/\/:\w+/g, '/:p')
      .replace(/\/\{\w+\}/g, '/:p')
      .replace(/\/$/, '') || '/'
  );
}

/**
 * fetch calls whose URL literal is a path (starts with `/`). By the Fetch
 * standard a path resolves only against a document's base URL, so such a
 * call is client code wherever the file sits; the whole project is scanned.
 */
async function findFetchCalls(root: string, files: readonly string[], unavailable: string[], current?: () => void): Promise<FetchCall[]> {
  const calls: FetchCall[] = [];
  const FETCH_RE = /fetch\(\s*[`'"](\/[^`'"?#]*)[`'"]/g;
  for (const file of files) {
    current?.();
    const relFile = relative(root, file);
    (await scanRead(file, unavailable)).split('\n').forEach((line, i) => {
      for (const m of line.matchAll(FETCH_RE)) calls.push({ url: m[1]!, file: relFile, line: i + 1 });
    });
  }
  return calls;
}

export async function inspectApiSync(root: string, framework: ApiFramework, current?: () => void, signal?: AbortSignal): Promise<ApiSyncResult> {
  const unavailable: string[] = [];
  const notes: string[] = [];
  const files = await walkSourceFiles(root, notes, current);
  // The call's signal stops the per-file route readings in flight when the call is cancelled.
  const [routes, fetchCalls] = await Promise.all([inspectApi(root, framework, unavailable, notes, current, files, signal), findFetchCalls(root, files, unavailable, current)]);

  const normalizedRoutes = routes.map((r) => ({
    ...r,
    _normalized: normalizeUrlForMatch(r.path),
  }));

  const unmatched_fetches: FetchCall[] = [];
  const matchedRouteNorms = new Set<string>();

  for (const fc of fetchCalls) {
    const norm = normalizeUrlForMatch(fc.url);
    const matched = normalizedRoutes.some((r) => r._normalized === norm);
    if (matched) {
      matchedRouteNorms.add(norm);
    } else {
      unmatched_fetches.push(fc);
    }
  }

  const unmatched_routes = normalizedRoutes
    .filter((r) => !matchedRouteNorms.has(r._normalized))
    .map(({ _normalized: _, ...rest }) => rest);

  const drift_detected = unmatched_fetches.length > 0;

  return { ...(unavailable.length ? { unavailable_files: [...new Set(unavailable)].sort() } : {}), ...(notes.length ? { warnings: [...new Set(notes)] } : {}), fetch_calls: fetchCalls, unmatched_fetches, unmatched_routes, drift_detected };
}
