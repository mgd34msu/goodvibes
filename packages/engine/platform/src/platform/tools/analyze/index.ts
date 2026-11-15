import { assertCurrentToolExecution } from '../registry.js';
import type { Tool, ToolExecuteOptions } from '../../types/tools.js';
import { resolve } from 'node:path';
import type { ToolLLM } from '../../config/tool-llm.js';
import { analyzeSchema } from './schema.js';
import { appendSchemaFingerprint } from '../shared/schema-fingerprint.js';
import type { AnalyzeInput } from './types.js';
import { applyAnalyzeTokenBudget, resolveInsideRoot, summarizeAnalyzeResult, MAX_SCAN_MS } from './shared.js';
import {
  runBundle,
  runCoverage,
  runDeadCode,
  runDependencies,
  runEnvAudit,
  runImpact,
  runPermissions,
  runPreview,
  runSecurity,
  runSurface,
  runTestFind,
} from './scan-modes.js';
import {
  runBreaking,
  runDiff,
  runSemanticDiff,
  runUpgrade,
} from './git-modes.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';
import { summarizeError } from '../../utils/error-display.js';

export type { AnalyzeInput } from './types.js';

/** The modes that stop by themselves at MAX_SCAN_MS. */
const DEADLINE_MODES: ReadonlySet<AnalyzeInput['mode']> = new Set(['impact', 'dead_code', 'permissions']);

/** The fields that say a result is a refusal or partial; the short form keeps them so it cannot read as an empty success. */
const NOTE_KEYS = ['error', 'scan_note', 'message', 'unavailable', 'refused_files', 'unreadable_files', 'skipped', 'truncated', 'diff_truncated'] as const;
function carriedNotes(result: Record<string, unknown>): Record<string, unknown> {
  const carried = Object.fromEntries(NOTE_KEYS.filter((key) => result[key] !== undefined).map((key) => [key, result[key]]));
  // The security scan nests its coverage under `secrets`.
  const secrets = result.secrets as Record<string, unknown> | undefined;
  const permissions = result.permissions as Record<string, unknown> | undefined;
  for (const key of ['refused_files', 'unreadable_files'] as const) {
    if (carried[key] !== undefined) continue;
    const nested = [secrets?.[key], permissions?.[key]].filter(Array.isArray).flat();
    if (nested.length > 0) carried[key] = nested;
  }
  return carried;
}

export function createAnalyzeTool(
  toolLLM: Pick<ToolLLM, 'chat'>,
  featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null,
  projectRoot?: string,
  /** The clock the scan limit is measured on. */
  now: () => number = Date.now,
): Tool {
  if (typeof projectRoot !== 'string' || projectRoot.trim().length === 0) {
    throw new Error('createAnalyzeTool requires projectRoot');
  }
  return {
    definition: analyzeSchema,

    async execute(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<{ success: boolean; output?: string; error?: string }> {
      try {
        const assertCurrent = (): void => {
          options?.signal?.throwIfAborted();
          assertCurrentToolExecution(args, options);
        };
        assertCurrent();
        const walkOptions = { ...(options?.signal ? { signal: options.signal } : {}), beforeAttempt: assertCurrent };
        if (!args.mode || typeof args.mode !== 'string') {
          return { success: false, error: 'Missing required "mode" field' };
        }

        const input = args as unknown as AnalyzeInput;
        const scanStartedAt = now();
        const outputFormat = input.output?.format ?? 'json';

        // A model-supplied root is only a narrower view of the configured root;
        // containment is always judged against the tool's own root.
        const resolvedProjectRoot = typeof input.projectRoot === 'string' && input.projectRoot.trim().length > 0
          ? resolveInsideRoot(input.projectRoot, projectRoot)
          : resolve(projectRoot);

        let result: Record<string, unknown>;

        switch (input.mode) {
          case 'impact':
            result = await runImpact(input, resolvedProjectRoot, walkOptions);
            break;

          case 'dependencies':
            result = await runDependencies(input, resolvedProjectRoot, walkOptions);
            break;
          case 'dead_code':
            result = await runDeadCode(input, resolvedProjectRoot, walkOptions);
            break;
          case 'security':
            result = await runSecurity(input, resolvedProjectRoot, walkOptions);
            break;
          case 'coverage':
            result = await runCoverage(input, resolvedProjectRoot);
            break;
          case 'bundle':
            result = await runBundle(input, resolvedProjectRoot);
            break;
          case 'surface':
            result = await runSurface(input, resolvedProjectRoot);
            break;
          case 'preview':
            result = await runPreview(input, resolvedProjectRoot);
            break;
          case 'diff':
            result = await runDiff(input, resolvedProjectRoot);
            break;
          case 'breaking':
            result = await runBreaking(input, resolvedProjectRoot);
            break;
          case 'semantic_diff':
            result = await runSemanticDiff(input, resolvedProjectRoot, toolLLM);
            break;
          case 'upgrade':
            result = await runUpgrade(input, resolvedProjectRoot);
            break;
          case 'permissions':
            result = await runPermissions(input, resolvedProjectRoot, walkOptions);
            break;
          case 'env_audit':
            result = await runEnvAudit(input, resolvedProjectRoot);
            break;
          case 'test_find':
            result = await runTestFind(input, resolvedProjectRoot, walkOptions);
            break;
          default: {
            const exhaustive: never = input.mode;
            return { success: false, error: `Unknown mode: ${exhaustive as string}` };
          }
        }

        assertCurrent();
        // Only the modes that carry their own deadline stop at MAX_SCAN_MS; a result from one of them that took that long covers only part of the tree.
        // A mode that reports its own stop (`stopped_by_deadline`) is believed over the clock.
        const stopped = typeof result.stopped_by_deadline === 'boolean'
          ? result.stopped_by_deadline
          : DEADLINE_MODES.has(input.mode) && now() - scanStartedAt >= MAX_SCAN_MS;
        if (stopped) {
          result = { ...result, scan_note: `Stopped at the ${Math.round(MAX_SCAN_MS / 1000)}s scan limit: the results cover only the files read in that time. Narrow 'files' or use a more specific mode to see the rest.` };
        }
        const fingerprinted = appendSchemaFingerprint(result, 'analyze', input.mode, { featureFlags });
        const shaped = outputFormat === 'summary'
          ? { ...summarizeAnalyzeResult(input.mode, fingerprinted), ...carriedNotes(fingerprinted) }
          : fingerprinted;
        if (result.comparison_inputs !== undefined) shaped.comparison_inputs = result.comparison_inputs;
        const indent = outputFormat === 'json' ? 2 : 0;
        const serialized = JSON.stringify(shaped, null, indent);
        return { success: true, output: applyAnalyzeTokenBudget(serialized, input.output?.max_tokens) };
      } catch (err) {
        return {
          success: false,
          error: summarizeError(err),
        };
      }
    },
  };
}
