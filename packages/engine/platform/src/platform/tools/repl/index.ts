import type { Tool, ToolExecuteOptions, ToolResult } from '../../types/tools.js';
import { runResolvedCommand, type ValidatorRunner } from '../shared/validators.js';
import { capturedReplScript } from './captured-script.js';
import { resolveEvalTimeoutMs } from './captured.js';
import { REPL_TOOL_SCHEMA, type ReplToolInput } from './schema.js';

/**
 * The `repl` tool of an ordinary session. It is registered only where the
 * per-command exec sandbox is available (tools/index.ts), and each eval is one
 * `bun -e` command through the exec tool's own path, so the sandbox plan, the
 * containment decision and the credential scrub apply exactly as to a command
 * the model runs with exec. Each eval is stateless; the history is this
 * session's attempts, held in memory.
 */

/** Attempts the history keeps, newest last. */
const HISTORY_LIMIT = 200;
/** A snippet is one command-line argument; past this the host refuses the argument, so the tool says so first. */
const MAX_SCRIPT_BYTES = 120_000;

interface ReplHistoryEntry {
  readonly ts: number;
  readonly runtime: 'javascript' | 'typescript';
  readonly expression: string;
  readonly result?: string | undefined;
  readonly error?: string | undefined;
}

export interface ReplToolOptions {
  /** The host's project directory, where evaluations run. The model never supplies it. */
  readonly workingDirectory: string;
}

export function createReplTool(runner: ValidatorRunner, options: ReplToolOptions): Tool {
  const history: ReplHistoryEntry[] = [];
  const remember = (entry: ReplHistoryEntry): void => {
    history.push(entry);
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  };
  return {
    definition: {
      name: 'repl',
      description: REPL_TOOL_SCHEMA.description,
      parameters: REPL_TOOL_SCHEMA.parameters,
      sideEffects: ['exec', 'read_fs', 'write_fs'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>, executeOptions?: ToolExecuteOptions): Promise<Omit<ToolResult, 'callId'>> {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as ReplToolInput;

      if (input.mode === 'history') {
        const offset = input.offset ?? 0;
        const limit = input.limit ?? history.length;
        const page = history.slice(offset, offset + limit);
        return { success: true, output: JSON.stringify({
          count: history.length,
          history: page,
          ...(offset > 0 || page.length < history.length ? { offset, returned: page.length, has_more: offset + page.length < history.length } : {}),
        }) };
      }
      if (input.mode !== 'eval') return { success: false, error: `Unknown mode: ${String(input.mode)}. Use eval or history.` };
      if (typeof input.expression !== 'string' || input.expression.length === 0) return { success: false, error: 'eval requires expression.' };
      const runtime = input.runtime ?? 'javascript';
      if (runtime !== 'javascript' && runtime !== 'typescript') {
        return { success: false, error: `runtime ${String(runtime)} is not available; repl evaluates javascript and typescript.` };
      }
      if (input.bindings !== undefined && (input.bindings === null || typeof input.bindings !== 'object' || Array.isArray(input.bindings))) {
        return { success: false, error: 'bindings must be an object of JSON values.' };
      }
      const timeoutMs = resolveEvalTimeoutMs(input.timeout_ms);
      if (timeoutMs === undefined) return { success: false, error: 'timeout_ms must be a nonnegative integer.' };
      const script = await capturedReplScript(input.expression, JSON.stringify(input.bindings ?? {}));
      if (Buffer.byteLength(script) > MAX_SCRIPT_BYTES) {
        return { success: false, error: `The snippet is too long to evaluate here (over ${MAX_SCRIPT_BYTES} bytes). Write it to a file and run it with exec.` };
      }
      const signal = executeOptions?.signal;
      const command = ['bun', '--no-env-file', '-e', script];
      const result = await runResolvedCommand(runner, command, options.workingDirectory, {
        assertCurrent: () => signal?.throwIfAborted(),
        ...(signal ? { signal } : {}),
        timeoutMs,
      });
      if (signal?.aborted) return { success: false, error: 'repl evaluation was cancelled.', cancelled: true };
      const error = result.passed ? undefined
        : (result.stderr.replace(/^Validator 'test'/, 'The evaluation').trim() || `The evaluation exited with code ${result.exitCode} and printed no error output.`);
      remember({ ts: Date.now(), runtime, expression: input.expression, ...(result.stdout ? { result: result.stdout } : {}), ...(error ? { error } : {}) });
      return {
        success: result.passed,
        ...(error ? { error } : {}),
        output: JSON.stringify({ runtime, result: result.stdout, ...(error ? { error } : {}), stateless: true }),
      };
    },
  };
}
