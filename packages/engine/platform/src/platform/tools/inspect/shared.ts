import { assertCapturedToolReadAccess } from '../shared/captured-input-tools.js';
import { ContractInputReadDeniedError } from '../../contract/input-authority.js';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import type {
  InspectMode,
  ProjectInfo,
  ApiRoute,
  DatabaseInfo,
  ComponentInfo,
  LayoutInfo,
  A11yIssue,
  ApiSpec,
  ApiValidateResult,
  ApiSyncResult,
  ComponentStateInfo,
  RenderTriggersInfo,
  HooksInfo,
  OverflowInfo,
  SizingInfo,
  StackingInfo,
  ResponsiveInfo,
  EventsInfo,
  TailwindInfo,
  ClientBoundaryInfo,
  ErrorBoundaryInfo,
} from './schema.js';
import { INSPECT_MODES } from './schema.js';

export const VALID_MODES: readonly InspectMode[] = INSPECT_MODES;

export const JSON_OUTPUT_INDENT = 2;
const SUMMARY_SAMPLE_LIMIT = 5;

export type InspectToolResult = { success: boolean; output?: string; error?: string };

export function resolvePath(projectRoot: string, inputPath: string): string {
  const resolved = resolve(inputPath.startsWith('/') ? inputPath : join(projectRoot, inputPath));
  const rel = relative(projectRoot, resolved);
  if (rel.startsWith('..')) {
    throw new Error(`Path '${inputPath}' resolves outside the project root`);
  }
  return resolved;
}

export function requireExistingFilePath(projectRoot: string, inputPath: string, notFoundPrefix: string): string {
  const filePath = resolvePath(projectRoot, inputPath);
  if (!existsSync(filePath)) {
    throw new Error(`${notFoundPrefix}: ${filePath}`);
  }
  return filePath;
}

function takeSample<T>(items: readonly T[] | undefined, limit = SUMMARY_SAMPLE_LIMIT): T[] {
  return Array.isArray(items) ? items.slice(0, limit) : [];
}

/** What a scan could not cover is part of the answer in every format: files left out and limits reached. */
function carriedCoverage(record: Record<string, unknown>): Record<string, unknown> {
  const carried: Record<string, unknown> = {};
  for (const key of ['unavailable_files', 'warning', 'warnings']) if (record[key] !== undefined) carried[key] = record[key];
  return carried;
}

export function summarizeInspectValue(mode: InspectMode, value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;

  switch (mode) {
    case 'project':
      return {
        ...(record.provenance === 'classic' ? { provenance: 'classic', entryPointsSource: record.entryPointsSource } : {}),
        type: record.type ?? null,
        name: record.name ?? null,
        packageManager: record.packageManager ?? null,
        hasTypeScript: record.hasTypeScript ?? false,
        testFramework: record.testFramework ?? null,
        dependencyCount: record.dependencies ?? 0,
        devDependencyCount: record.devDependencies ?? 0,
        entryPoints: takeSample(record.entryPoints as string[] | undefined),
      };
    case 'api':
      return {
        ...carriedCoverage(record),
        count: record.count ?? 0,
        routes: takeSample(record.routes as Array<Record<string, unknown>> | undefined).map((route) => ({
          method: route.method ?? null,
          path: route.path ?? null,
          file: route.file ?? null,
        })),
      };
    case 'database': {
      const models = takeSample(record.models as Array<Record<string, unknown>> | undefined).map((model) => ({
        name: model.name ?? null,
        fieldCount: Array.isArray(model.fields) ? model.fields.length : 0,
      }));
      const enums = takeSample(record.enums as Array<Record<string, unknown>> | undefined).map((entry) => ({
        name: entry.name ?? null,
        valueCount: Array.isArray(entry.values) ? entry.values.length : 0,
      }));
      return {
        ...carriedCoverage(record),
        modelCount: Array.isArray(record.models) ? record.models.length : 0,
        enumCount: Array.isArray(record.enums) ? record.enums.length : 0,
        models,
        enums,
      };
    }
    case 'components':
      return {
        count: record.count ?? 0,
        components: takeSample(record.components as Array<Record<string, unknown>> | undefined).map((component) => ({
          name: component.name ?? null,
          kind: component.kind ?? null,
          propCount: Array.isArray(component.props) ? component.props.length : 0,
          hookCount: Array.isArray(component.hooks) ? component.hooks.length : 0,
        })),
      };
    case 'layout':
      return {
        file: record.file ?? null,
        displays: takeSample(record.displays as string[] | undefined),
        flex: takeSample(record.flex as string[] | undefined),
        grid: takeSample(record.grid as string[] | undefined),
        sizing: takeSample(record.sizing as string[] | undefined),
        overflow: takeSample(record.overflow as string[] | undefined),
      };
    case 'accessibility':
      return {
        count: record.count ?? 0,
        issues: takeSample(record.issues as Array<Record<string, unknown>> | undefined).map((issue) => ({
          code: issue.code ?? null,
          line: issue.line ?? null,
          wcag: issue.wcag ?? null,
        })),
      };
    case 'api_spec':
      return {
        ...carriedCoverage(record),
        openapi: record.openapi ?? null,
        pathCount:
          record.paths && typeof record.paths === 'object'
            ? Object.keys(record.paths as Record<string, unknown>).length
            : 0,
        paths: takeSample(Object.keys((record.paths as Record<string, unknown>) ?? {})),
      };
    case 'api_validate':
      return {
        ...carriedCoverage(record),
        valid: record.valid ?? false,
        missingFromSpec: takeSample(record.missing_from_spec as string[] | undefined),
        missingFromCode: takeSample(record.missing_from_code as string[] | undefined),
        mismatchedMethods: takeSample(record.mismatched_methods as Array<Record<string, unknown>> | undefined),
      };
    case 'api_sync':
      return {
        ...carriedCoverage(record),
        driftDetected: record.drift_detected ?? false,
        fetchCallCount: Array.isArray(record.fetch_calls) ? record.fetch_calls.length : 0,
        unmatchedFetches: takeSample(record.unmatched_fetches as Array<Record<string, unknown>> | undefined).map(
          (call) => ({
            url: call.url ?? null,
            file: call.file ?? null,
          }),
        ),
        unmatchedRoutes: takeSample(record.unmatched_routes as string[] | undefined),
      };
    case 'scaffold':
      return {
        moduleName: record.moduleName ?? null,
        dryRun: record.dryRun ?? false,
        fileCount: Array.isArray(record.files) ? record.files.length : 0,
        files: takeSample(record.files as Array<Record<string, unknown>> | undefined).map((file) => file.path ?? null),
      };
    case 'component_state':
      return {
        count: record.count ?? 0,
        stateVars: takeSample(record.stateVars as Array<Record<string, unknown>> | undefined).map((item) => ({
          kind: item.kind ?? null,
          name: item.name ?? null,
        })),
      };
    case 'render_triggers':
      return {
        count: record.count ?? 0,
        triggers: takeSample(record.triggers as Array<Record<string, unknown>> | undefined).map((trigger) => ({
          kind: trigger.kind ?? null,
          name: trigger.name ?? null,
        })),
      };
    case 'hooks':
      return {
        count: Array.isArray(record.hooks) ? record.hooks.length : 0,
        hooks: takeSample(record.hooks as Array<Record<string, unknown>> | undefined).map((hook) => ({
          hookKind: hook.hookKind ?? null,
          deps: takeSample(hook.deps as string[] | undefined),
          omitsDependency: hook.omitsDependency ?? null,
        })),
      };
    case 'overflow':
      return {
        count: record.count ?? 0,
        issues: takeSample(record.issues as Array<Record<string, unknown>> | undefined).map((issue) => ({
          kind: issue.kind ?? null,
          line: issue.line ?? null,
        })),
      };
    case 'sizing':
      return {
        count: Array.isArray(record.items) ? record.items.length : 0,
        items: takeSample(record.items as Array<Record<string, unknown>> | undefined).map((item) => ({
          kind: item.kind ?? null,
          line: item.line ?? null,
          flagged: item.flagged ?? false,
        })),
      };
    case 'stacking':
      return {
        count: Array.isArray(record.zIndexItems) ? record.zIndexItems.length : 0,
        zIndexItems: takeSample(record.zIndexItems as Array<Record<string, unknown>> | undefined).map((item) => ({
          value: item.value ?? null,
          line: item.line ?? null,
        })),
        potentialConflicts: takeSample(record.potentialConflicts as Array<Record<string, unknown>> | undefined),
      };
    case 'responsive':
      return {
        hasMobileFirst: record.hasMobileFirst ?? false,
        breakpointCount: Array.isArray(record.breakpoints) ? record.breakpoints.length : 0,
        breakpoints: takeSample(record.breakpoints as Array<Record<string, unknown>> | undefined).map(
          (bp) => bp.prefix ?? null,
        ),
      };
    case 'events':
      return {
        count: record.count ?? 0,
        handlers: takeSample(record.handlers as Array<Record<string, unknown>> | undefined).map((handler) => ({
          event: handler.event ?? null,
          line: handler.line ?? null,
        })),
      };
    case 'tailwind':
      return {
        count: record.count ?? 0,
        conflicts: takeSample(record.conflicts as Array<Record<string, unknown>> | undefined).map((conflict) => ({
          reason: conflict.reason ?? null,
          classes: takeSample(conflict.classes as string[] | undefined),
        })),
      };
    case 'client_boundary':
      return {
        directive: record.directive ?? null,
        importsServerOnly: record.importsServerOnly ?? false,
        serverOnlyImports: takeSample(record.serverOnlyImports as string[] | undefined),
      };
    case 'error_boundary':
      return {
        hasErrorBoundary: record.hasErrorBoundary ?? false,
        boundaryComponents: takeSample(record.boundaryComponents as string[] | undefined),
      };
    default:
      return value;
  }
}

export function serializeInspectOutput(value: unknown, format: string, mode: InspectMode): string {
  const shaped = format === 'summary' ? summarizeInspectValue(mode, value) : value;
  return JSON.stringify(shaped, null, format === 'json' ? JSON_OUTPUT_INDENT : 0);
}

/** Folders that hold dependencies or build output rather than the project's own source; every scan of the tree skips them. */
export const SKIPPED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  'target',
  'dist',
  'build',
  'vendor',
  '.venv',
  'venv',
  '__pycache__',
  '.next',
  '.cache',
  'out',
  'coverage',
]);

const WALK_MAX_DEPTH = 10;

/**
 * Every file under `dir` the filter accepts. What the scan could not cover (a directory it could
 * not read, the depth limit) is added to `notes` so a short result is not mistaken for a complete one.
 */
export async function walk(
  dir: string,
  filter: (p: string) => boolean,
  skipDirs: ReadonlySet<string> = SKIPPED_DIRS,
  depth = 0,
  notes?: string[],
  current?: () => void,
): Promise<string[]> {
  current?.();
  if (depth > WALK_MAX_DEPTH) {
    const note = `Directories deeper than ${WALK_MAX_DEPTH} levels were not scanned (first reached at ${dir}).`;
    if (notes && !notes.some((n) => n.startsWith('Directories deeper'))) notes.push(note);
    return [];
  }
  const results: string[] = [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    notes?.push(`Could not read directory ${dir}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!skipDirs.has(entry.name)) {
        const sub = await walk(full, filter, skipDirs, depth + 1, notes, current);
        results.push(...sub);
      }
    } else if (filter(full)) {
      results.push(full);
    }
  }
  return results;
}

/** Reads a file the caller already knows exists; any failure (a directory, permissions) is an error, never an empty file. */
export async function safeRead(filePath: string): Promise<string> {
  await assertCapturedToolReadAccess(filePath);
  return readFileSync(filePath, 'utf-8');
}

/**
 * A discovery-scan read. A captured view's read policy denying one incidental
 * file excludes that file from the scan and records it, instead of failing the
 * whole inspection; the denied file contributes nothing. A file that cannot be
 * read for another reason is excluded and recorded the same way, so it is not
 * mistaken for an empty file. Every other failure
 * still aborts: outside-project policy and captured-input ownership stay
 * separate mechanisms, and nothing here grants access the policy denied.
 */
export async function scanRead(filePath: string, unavailable?: string[]): Promise<string> {
  try {
    await assertCapturedToolReadAccess(filePath);
  } catch (error) {
    if (error instanceof ContractInputReadDeniedError) {
      unavailable?.push(filePath);
      return '';
    }
    throw error;
  }
  try {
    return readFileSync(filePath, 'utf-8');
  } catch (error) {
    // A file that is not there (a project with no package.json) is absent, not unreadable; a dangling link is.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || lstatSync(filePath, { throwIfNoEntry: false }) !== undefined) unavailable?.push(filePath);
    return '';
  }
}

export function createInspectFailure(error: string): InspectToolResult {
  return { success: false, error };
}

export function createInspectSuccess(output: unknown, format: string, mode: InspectMode): InspectToolResult {
  return { success: true, output: serializeInspectOutput(output, format, mode) };
}

export async function readRequiredFile(
  projectRoot: string,
  inputFile: string | undefined,
  mode: string,
  errorMessage: string,
): Promise<{ filePath: string; content: string } | InspectToolResult> {
  if (!inputFile) {
    return createInspectFailure(`file is required for ${mode} mode`);
  }
  const filePath = requireExistingFilePath(projectRoot, inputFile, errorMessage);
  return { filePath, content: await safeRead(filePath) };
}
