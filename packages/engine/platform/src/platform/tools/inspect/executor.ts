import type { ApiFramework, InspectInput } from './schema.js';
import { resolve } from 'node:path';
import { summarizeError } from '../../utils/error-display.js';
import {
  createInspectFailure,
  createInspectSuccess,
  requireExistingFilePath,
  safeRead,
  readRequiredFile,
  type InspectToolResult,
} from './shared.js';
import {
  detectProject,
  inspectApi,
  parsePrismaSchema,
  generateApiSpec,
  validateApiSpec,
  inspectApiSync,
  buildScaffold,
} from './project.js';
import {
  inspectComponents,
  inspectLayout,
  inspectAccessibility,
  inspectComponentState,
  inspectRenderTriggers,
  inspectHooks,
  inspectOverflow,
  inspectSizing,
  inspectStacking,
  inspectResponsive,
  inspectEvents,
  inspectTailwind,
  inspectClientBoundary,
  inspectErrorBoundary,
} from './frontend.js';

/** What an inspection could not cover, as fields of its result: files left out, and scan limits that were reached. */
function coverage(unavailable: readonly string[], notes: readonly string[]): Record<string, unknown> {
  const files = [...new Set(unavailable)].sort();
  const warnings = [
    ...(files.length ? [`${files.length} file(s) were denied by the read-access policy or could not be read, and were not inspected.`] : []),
    ...new Set(notes),
  ];
  return {
    ...(files.length ? { unavailable_files: files } : {}),
    ...(warnings.length ? { warning: warnings.join(' ') } : {}),
  };
}

/**
 * Creates scaffold files through the write tool of the registry running this
 * call. `ok: false` carries the reason; with an atomic write nothing was
 * written then.
 */
export type ScaffoldWriter = (files: readonly { readonly path: string; readonly content: string }[]) =>
  Promise<{ readonly ok: true; readonly output?: string | undefined } | { readonly ok: false; readonly error: string }>;

export async function executeInspectMode(
  input: InspectInput,
  projectRoot: string,
  format: string,
  current?: () => void,
  /** How scaffold creates its files: the write tool, so the files are approved, recorded and undoable as any write. */
  writeFiles?: ScaffoldWriter,
  /** The call's signal: a cancelled call stops the decision-model requests it started. */
  signal?: AbortSignal,
  /** Whether the owner allows paths outside the project; file arguments follow the same rule as read. */
  allowOutsideProject = false,
): Promise<InspectToolResult> {
  try {
    current?.();
    switch (input.mode) {
      case 'project':
        return createInspectSuccess(await detectProject(projectRoot), format, input.mode);

      case 'api': {
        const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
        const unavailable: string[] = [];
        const notes: string[] = [];
        const routes = await inspectApi(projectRoot, framework, unavailable, notes, current, undefined, signal);
        return createInspectSuccess({ routes, count: routes.length, ...coverage(unavailable, notes) }, format, input.mode);
      }

      case 'database': {
        const schemaPath = input.schemaPath
          ? requireExistingFilePath(projectRoot, input.schemaPath, 'Database schema not found at', allowOutsideProject)
          : requireExistingFilePath(projectRoot, 'prisma/schema.prisma', 'Database schema not found at', allowOutsideProject);
        const parsed = parsePrismaSchema(await safeRead(schemaPath));
        if (parsed.models.length === 0 && parsed.enums.length === 0) {
          return createInspectFailure(`No Prisma model or enum blocks found in ${schemaPath}${parsed.warning ? ` (${parsed.warning})` : ''}. Only Prisma schema files are parsed; other schema formats (for example Drizzle) are not supported, so this is not evidence the project has no tables.`);
        }
        return createInspectSuccess(parsed, format, input.mode);
      }

      case 'components': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'components', 'File not found');
        if ('success' in file) return file;
        const comps = inspectComponents(file.content);
        return createInspectSuccess({ components: comps, count: comps.length }, format, input.mode);
      }

      case 'layout': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'layout', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectLayout(file.content, input.file!), format, input.mode);
      }

      case 'accessibility': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'accessibility', 'File not found');
        if ('success' in file) return file;
        const { issues, ...note } = await inspectAccessibility(file.content, input.file!, signal);
        return createInspectSuccess({ issues, count: issues.length, ...note }, format, input.mode);
      }

      case 'api_spec': {
        const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
        const unavailable: string[] = [];
        const notes: string[] = [];
        const routes = await inspectApi(projectRoot, framework, unavailable, notes, current, undefined, signal);
        return createInspectSuccess({ ...generateApiSpec(routes), ...coverage(unavailable, notes) }, format, input.mode);
      }

      case 'api_validate': {
        if (!input.specPath) {
          return createInspectFailure('specPath is required for api_validate mode');
        }
        const resolvedSpec = await readRequiredFile(
          projectRoot,
          allowOutsideProject,
          input.specPath,
          'api_validate',
          'Spec file not found at',
        );
        if ('success' in resolvedSpec) return resolvedSpec;
        const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
        const unavailable: string[] = [];
        const notes: string[] = [];
        const routes = await inspectApi(projectRoot, framework, unavailable, notes, current, undefined, signal);
        return createInspectSuccess({ ...validateApiSpec(resolvedSpec.content, routes), ...coverage(unavailable, notes) }, format, input.mode);
      }

      case 'api_sync': {
        const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
        return createInspectSuccess(await inspectApiSync(projectRoot, framework, current, signal), format, input.mode);
      }

      case 'scaffold': {
        if (!input.moduleName) {
          return createInspectFailure('moduleName is required for scaffold mode');
        }
        const dryRun = input.dryRun !== false;
        const plan = buildScaffold(input.moduleName, dryRun);
        if (dryRun) return createInspectSuccess(plan, format, input.mode);
        if (!writeFiles) return createInspectFailure('scaffold with dryRun:false creates its files through the write tool, which this call cannot reach. Nothing was written. Use dryRun:true for the plan and create the files with write.');
        const written = await writeFiles(plan.files.map((file) => ({ path: resolve(projectRoot, file.path), content: file.content })));
        if (!written.ok) return createInspectFailure(`scaffold did not create ${input.moduleName}: ${written.error}`);
        return createInspectSuccess({ ...plan, ...(written.output ? { written: written.output } : {}) }, format, input.mode);
      }

      case 'component_state': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'component_state', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectComponentState(file.content, input.file!), format, input.mode);
      }

      case 'render_triggers': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'render_triggers', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectRenderTriggers(file.content, input.file!), format, input.mode);
      }

      case 'hooks': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'hooks', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(await inspectHooks(file.content, input.file!, signal), format, input.mode);
      }

      case 'overflow': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'overflow', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(await inspectOverflow(file.content, input.file!, signal), format, input.mode);
      }

      case 'sizing': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'sizing', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(await inspectSizing(file.content, input.file!, signal), format, input.mode);
      }

      case 'stacking': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'stacking', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(await inspectStacking(file.content, input.file!, signal), format, input.mode);
      }

      case 'responsive': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'responsive', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectResponsive(file.content, input.file!), format, input.mode);
      }

      case 'events': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'events', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectEvents(file.content, input.file!), format, input.mode);
      }

      case 'tailwind': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'tailwind', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectTailwind(file.content, input.file!), format, input.mode);
      }

      case 'client_boundary': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'client_boundary', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(await inspectClientBoundary(file.content, input.file!, signal), format, input.mode);
      }

      case 'error_boundary': {
        const file = await readRequiredFile(projectRoot, allowOutsideProject, input.file, 'error_boundary', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectErrorBoundary(file.content, input.file!), format, input.mode);
      }

      default:
        return createInspectFailure(`Unknown mode: ${input.mode}`);
    }
  } catch (err) {
    const message = summarizeError(err);
    return { success: false, error: `inspect (${input.mode}): ${message}` };
  }
}
