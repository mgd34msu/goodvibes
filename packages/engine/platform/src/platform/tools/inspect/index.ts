import type { Tool, ToolDefinition, ToolExecuteOptions } from '../../types/tools.js';
import { resolveAndValidatePath } from '../../utils/path-safety.js';
import { summarizeError } from '../../utils/error-display.js';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runRegisteredTool } from '../registry.js';
import { INSPECT_TOOL_SCHEMA } from './schema.js';
import { DEFAULT_CEILING_TOKENS, capToolText } from '../../runtime/tools/output-policy.js';
import { appendSchemaFingerprint } from '../shared/schema-fingerprint.js';
import type { InspectInput } from './schema.js';
import { VALID_MODES, JSON_OUTPUT_INDENT, type InspectToolResult } from './shared.js';
import { executeInspectMode, type ScaffoldWriter } from './executor.js';
import type { FeatureFlagManager } from '../../runtime/feature-flags/index.js';

export class InspectTool implements Tool {
  public constructor(
    private readonly featureFlags?: Pick<FeatureFlagManager, 'isEnabled'> | null,
    private readonly projectRoot: string | null = null,
    private readonly allowOutsideProject: () => boolean = () => false,
  ) {}

  readonly definition: ToolDefinition = {
    name: 'inspect',
    activity: { doing: 'Inspecting', did: 'inspected', object: 'the project' },
    description:
      'Inspect and analyze a project or file. Modes: project (structure), api (routes),'
      + ' api_spec (generate OpenAPI 3.0 spec), api_validate (compare spec to code),'
      + ' api_sync (detect frontend/backend drift),'
      + ' database (schema), components (React), layout (CSS/Tailwind),'
      + ' accessibility (a11y issues), scaffold (module skeleton generator).',
    parameters: INSPECT_TOOL_SCHEMA,
    sideEffects: ['read_fs'],
    // The three file arguments resolve under projectRoot; scaffold's files go through the write tool's own admission.
    subjects: { paths: ['projectRoot', 'file', 'specPath', 'schemaPath'] },
    concurrency: 'parallel',
    supportsProgress: true,
  };

  private _withFingerprint(output: string, mode: string, indent: number): string {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const fingerprinted = appendSchemaFingerprint(parsed as Record<string, unknown>, 'inspect', mode, {
          featureFlags: this.featureFlags,
        });
        return JSON.stringify(fingerprinted, null, indent || 0);
      }
    } catch {
      // ignore non-JSON output
    }
    return output;
  }

  async execute(args: Record<string, unknown>, options?: ToolExecuteOptions): Promise<InspectToolResult> {
    if (!args.mode || typeof args.mode !== 'string') {
      return { success: false, error: 'mode is required' };
    }

    const input = args as unknown as InspectInput;
    if (!VALID_MODES.includes(input.mode)) {
      return { success: false, error: `Invalid mode: ${input.mode}. Valid modes: ${VALID_MODES.join(', ')}` };
    }

    const requestedRoot = (typeof input.projectRoot === 'string' && input.projectRoot.trim().length > 0)
      ? input.projectRoot
      : undefined;
    const explicitRoot = requestedRoot ?? this.projectRoot;
    if (!explicitRoot) {
      return { success: false, error: 'projectRoot is required' };
    }
    // The root comes from the model's own arguments, so it is held to the same rule as read and find:
    // inside the working directory unless access outside the project is allowed.
    let projectRoot: string;
    try {
      projectRoot = requestedRoot !== undefined && this.projectRoot
        ? resolveAndValidatePath(requestedRoot, this.projectRoot, this.allowOutsideProject())
        : resolve(explicitRoot);
    } catch (err) {
      return { success: false, error: `projectRoot refused: ${summarizeError(err)}. Use a directory inside ${this.projectRoot}.` };
    }
    const current = () => { options?.signal?.throwIfAborted(); };
    const format = input.output?.format ?? 'detailed';
    // scaffold creates files only through the write tool of the registry running this call, so they
    // are approved, recorded for undo and in the changed files as any write, and an agent without
    // write cannot create them.
    const writeFiles: ScaffoldWriter = async (files) => {
      const written = await runRegisteredTool(`inspect-scaffold-${randomUUID()}`, 'write',
        { files: files.map((file) => ({ path: file.path, content: file.content, mode: 'fail_if_exists' })), transaction: { mode: 'atomic' } }, options);
      if (!written) return { ok: false, error: 'this agent has no write tool, so scaffold cannot create files. Nothing was written. Use dryRun:true for the plan.' };
      return written.success ? { ok: true, output: written.output } : { ok: false, error: written.error ?? 'the write tool refused the files; nothing was written' };
    };
    const rawResult = await executeInspectMode(input, projectRoot, format, current, writeFiles, options?.signal);
    const shaped = this._fingerprintResult(rawResult, input.mode, format);
    if (!shaped.success || shaped.output === undefined) return shaped;
    // The schema advertises output.max_tokens; without one the shared default ceiling still applies.
    return { ...shaped, output: capToolText(shaped.output, input.output?.max_tokens ?? DEFAULT_CEILING_TOKENS.analyze,
      "Pass output.format 'summary', pick a narrower mode, or raise output.max_tokens to see more.") };
  }

  private _fingerprintResult(
    result: InspectToolResult,
    mode: string,
    format: string,
  ): InspectToolResult {
    if (result.success && result.output !== undefined) {
      return { ...result, output: this._withFingerprint(result.output, mode, format === 'json' ? JSON_OUTPUT_INDENT : 0) };
    }
    return result;
  }
}
