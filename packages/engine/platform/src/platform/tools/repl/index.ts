import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { type ConfigManagerLike } from '../../runtime/sandbox/manager.js';
import { SandboxSessionRegistry } from '../../runtime/sandbox/session-registry.js';
import { requireSurfaceRoot } from '../../runtime/surface-root.js';
import type { Tool } from '../../types/tools.js';
import { REPL_TOOL_SCHEMA, type ReplToolInput } from './schema.js';

/**
 * Why every eval refuses. The only sandbox backend is local host execution,
 * which runs a command directly on the host and does not isolate what it runs,
 * so evaluating arbitrary code there would be evaluating it on the host. The
 * refusal is a fixed security boundary, not a judgment.
 */
export const REPL_NO_ISOLATING_BACKEND_ERROR =
  'REPL eval needs an isolating sandbox backend, and none is available: the only sandbox backend is local host execution (sandbox.vmBackend "local"), which does not isolate evaluated code.';

interface ReplHistoryEntry {
  readonly ts: number;
  readonly runtime: 'javascript' | 'typescript' | 'python' | 'sql' | 'graphql';
  readonly expression: string;
  readonly sessionId?: string | undefined;
  readonly backend?: string | undefined;
  readonly launchSummary?: string | undefined;
  readonly result?: string | undefined;
  readonly error?: string | undefined;
}

export interface ReplToolOptions {
  readonly surfaceRoot: string;
  /** The host's project directory, where the attempt history is kept. The model never supplies it. */
  readonly workingDirectory?: string | undefined;
}

function resolveHistoryPath(workspaceRoot: string, surfaceRoot: string): string {
  return join(workspaceRoot, '.goodvibes', surfaceRoot, 'repl-history.json');
}

/** A missing file is an empty history; a file that cannot be parsed is reported, never overwritten. */
async function loadHistory(historyPath: string): Promise<ReplHistoryEntry[]> {
  let raw: string;
  try {
    raw = await readFile(historyPath, 'utf-8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) throw new Error('history file is not a list');
  return parsed as ReplHistoryEntry[];
}

async function saveHistory(historyPath: string, entries: readonly ReplHistoryEntry[]): Promise<void> {
  await mkdir(dirname(historyPath), { recursive: true });
  const temporary = `${historyPath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(entries, null, 2)}\n`, 'utf-8');
  await rename(temporary, historyPath);
}

function mapRuntimeToSandboxProfile(runtime: NonNullable<ReplToolInput['runtime']>) {
  switch (runtime) {
    case 'javascript': return 'eval-js' as const;
    case 'typescript': return 'eval-ts' as const;
    case 'python': return 'eval-py' as const;
    case 'sql': return 'eval-sql' as const;
    case 'graphql': return 'eval-graphql' as const;
  }
}

export function createReplTool(
  configManager: ConfigManagerLike,
  sandboxSessionRegistry: SandboxSessionRegistry,
  options: ReplToolOptions,
): Tool {
  const surfaceRoot = requireSurfaceRoot(options.surfaceRoot, 'ReplTool surfaceRoot');
  return {
    definition: {
      name: 'repl',
      description: REPL_TOOL_SCHEMA.description,
      parameters: REPL_TOOL_SCHEMA.parameters,
      sideEffects: ['exec', 'state', 'write_fs'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as ReplToolInput;
      const workingDirectory = options.workingDirectory;
      if (input.mode === 'eval' && input.expression && !workingDirectory) {
        // Without a project directory nothing can be recorded, and the real reason is the missing backend.
        return { success: false, error: REPL_NO_ISOLATING_BACKEND_ERROR };
      }
      if (!workingDirectory) {
        return { success: false, error: 'repl history is unavailable: this host did not give the tool a project directory to keep it in.' };
      }
      const historyPath = resolveHistoryPath(workingDirectory, surfaceRoot);
      let history: ReplHistoryEntry[];
      try {
        history = await loadHistory(historyPath);
      } catch (error) {
        return { success: false, error: `repl history file ${historyPath} cannot be read (${error instanceof Error ? error.message : String(error)}). Move or delete it to start a new history.` };
      }

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

      if (!input.expression) return { success: false, error: 'eval requires expression.' };
      const runtime = input.runtime ?? 'javascript';
      const existingSessions = new Set(sandboxSessionRegistry.list().map((session) => session.id));
      const sandboxSession = await sandboxSessionRegistry.start(
        mapRuntimeToSandboxProfile(runtime),
        `repl:${runtime}`,
        configManager,
      );
      // Nothing runs in the session, so one this eval started is stopped again;
      // a shared session that was already running belongs to someone else.
      if (!existingSessions.has(sandboxSession.id)) sandboxSessionRegistry.stop(sandboxSession.id);
      await saveHistory(historyPath, [...history, {
        ts: Date.now(),
        runtime,
        expression: input.expression,
        sessionId: sandboxSession.id,
        backend: sandboxSession.resolvedBackend ?? sandboxSession.backend,
        launchSummary: sandboxSession.launchPlan?.summary,
        error: REPL_NO_ISOLATING_BACKEND_ERROR,
      }]);
      return { success: false, error: REPL_NO_ISOLATING_BACKEND_ERROR };
    },
  };
}
