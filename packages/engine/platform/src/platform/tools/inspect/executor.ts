import type { ApiFramework, InspectInput } from './schema.js';
import { realpathSync } from 'node:fs';
import { relative, sep } from 'node:path';
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

/** Whether `target` is `root` or inside it, comparing the root as written and as resolved (a symlinked working directory). */
function insideWriteRoot(root: string, target: string): boolean {
  const inside = (base: string): boolean => !relative(base, target).split(sep).includes('..');
  let resolved = root;
  try { resolved = realpathSync(root); } catch { /* an unresolvable root is compared as written */ }
  return inside(root) || inside(resolved);
}

export async function executeInspectMode(
  input: InspectInput,
  projectRoot: string,
  format: string,
  current?: () => void,
  /** Where scaffold may write: the working directory the tool was configured with. */
  writeRoot?: string | null,
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
        const routes = await inspectApi(projectRoot, framework, unavailable, notes, current);
        return createInspectSuccess({ routes, count: routes.length, ...coverage(unavailable, notes) }, format, input.mode);
      }

      case 'database': {
        const schemaPath = input.schemaPath
          ? requireExistingFilePath(projectRoot, input.schemaPath, 'Database schema not found at')
          : requireExistingFilePath(projectRoot, 'prisma/schema.prisma', 'Database schema not found at');
        const parsed = parsePrismaSchema(await safeRead(schemaPath));
        if (parsed.models.length === 0 && parsed.enums.length === 0) {
          return createInspectFailure(`No Prisma model or enum blocks found in ${schemaPath}${parsed.warning ? ` (${parsed.warning})` : ''}. Only Prisma schema files are parsed; other schema formats (for example Drizzle) are not supported, so this is not evidence the project has no tables.`);
        }
        return createInspectSuccess(parsed, format, input.mode);
      }

      case 'components': {
        const file = await readRequiredFile(projectRoot, input.file, 'components', 'File not found');
        if ('success' in file) return file;
        const comps = inspectComponents(file.content);
        return createInspectSuccess({ components: comps, count: comps.length }, format, input.mode);
      }

      case 'layout': {
        const file = await readRequiredFile(projectRoot, input.file, 'layout', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectLayout(file.content, input.file!), format, input.mode);
      }

      case 'accessibility': {
        const file = await readRequiredFile(projectRoot, input.file, 'accessibility', 'File not found');
        if ('success' in file) return file;
        const a11yIssues = await inspectAccessibility(file.content, input.file!);
        return createInspectSuccess({ issues: a11yIssues, count: a11yIssues.length }, format, input.mode);
      }

      case 'api_spec': {
        const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
        const unavailable: string[] = [];
        const notes: string[] = [];
        const routes = await inspectApi(projectRoot, framework, unavailable, notes, current);
        return createInspectSuccess({ ...generateApiSpec(routes), ...coverage(unavailable, notes) }, format, input.mode);
      }

      case 'api_validate': {
        if (!input.specPath) {
          return createInspectFailure('specPath is required for api_validate mode');
        }
        const resolvedSpec = await readRequiredFile(
          projectRoot,
          input.specPath,
          'api_validate',
          'Spec file not found at',
        );
        if ('success' in resolvedSpec) return resolvedSpec;
        const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
        const unavailable: string[] = [];
        const notes: string[] = [];
        const routes = await inspectApi(projectRoot, framework, unavailable, notes, current);
        return createInspectSuccess({ ...validateApiSpec(resolvedSpec.content, routes), ...coverage(unavailable, notes) }, format, input.mode);
      }

      case 'api_sync': {
        const framework: ApiFramework = (input.framework ?? 'auto') as ApiFramework;
        return createInspectSuccess(await inspectApiSync(projectRoot, framework, current), format, input.mode);
      }

      case 'scaffold': {
        if (!input.moduleName) {
          return createInspectFailure('moduleName is required for scaffold mode');
        }
        const dryRun = input.dryRun !== false;
        if (!dryRun && writeRoot && !insideWriteRoot(writeRoot, projectRoot)) {
          return createInspectFailure(`scaffold writes only inside the working directory (${writeRoot}); ${projectRoot} is outside it. Nothing was written. Use dryRun:true for the plan.`);
        }
        return createInspectSuccess(await buildScaffold(input.moduleName, projectRoot, dryRun), format, input.mode);
      }

      case 'component_state': {
        const file = await readRequiredFile(projectRoot, input.file, 'component_state', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectComponentState(file.content, input.file!), format, input.mode);
      }

      case 'render_triggers': {
        const file = await readRequiredFile(projectRoot, input.file, 'render_triggers', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectRenderTriggers(file.content, input.file!), format, input.mode);
      }

      case 'hooks': {
        const file = await readRequiredFile(projectRoot, input.file, 'hooks', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(await inspectHooks(file.content, input.file!), format, input.mode);
      }

      case 'overflow': {
        const file = await readRequiredFile(projectRoot, input.file, 'overflow', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(await inspectOverflow(file.content, input.file!), format, input.mode);
      }

      case 'sizing': {
        const file = await readRequiredFile(projectRoot, input.file, 'sizing', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(await inspectSizing(file.content, input.file!), format, input.mode);
      }

      case 'stacking': {
        const file = await readRequiredFile(projectRoot, input.file, 'stacking', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(await inspectStacking(file.content, input.file!), format, input.mode);
      }

      case 'responsive': {
        const file = await readRequiredFile(projectRoot, input.file, 'responsive', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectResponsive(file.content, input.file!), format, input.mode);
      }

      case 'events': {
        const file = await readRequiredFile(projectRoot, input.file, 'events', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectEvents(file.content, input.file!), format, input.mode);
      }

      case 'tailwind': {
        const file = await readRequiredFile(projectRoot, input.file, 'tailwind', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(inspectTailwind(file.content, input.file!), format, input.mode);
      }

      case 'client_boundary': {
        const file = await readRequiredFile(projectRoot, input.file, 'client_boundary', 'File not found');
        if ('success' in file) return file;
        return createInspectSuccess(await inspectClientBoundary(file.content, input.file!), format, input.mode);
      }

      case 'error_boundary': {
        const file = await readRequiredFile(projectRoot, input.file, 'error_boundary', 'File not found');
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
