import { processClassificationOptions } from './agent-harness-process-launch.ts';
import type { EffectResult } from './agent-harness-tool-utils.ts';
import { createProcessInputProjector } from './agent-process-ingress.ts';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolExecution, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { backgroundProcessSummary, describeBackgroundProcess, runBackgroundProcessAction } from './agent-harness-background-processes.ts';
import { harnessCatalogExecutionGuard, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';
import { confirmParameter, requestParameter } from './agent-harness-effect-admission.ts';

const READ_ONLY_PROCESS_ACTIONS = new Set(['list', 'status', 'poll', 'log', 'output', 'capabilities', 'doctor', 'parity']);

interface AgentTerminalToolArgs {
  readonly command?: unknown;
  readonly background?: unknown;
  readonly cwd?: unknown;
  readonly timeoutMs?: unknown;
  readonly lifetime?: unknown;
  readonly processClass?: unknown;
  readonly killOnTimeout?: unknown;
  readonly pty?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentProcessToolArgs {
  readonly action?: unknown;
  readonly processAction?: unknown;
  readonly processId?: unknown;
  readonly processSessionId?: unknown;
  readonly sessionId?: unknown;
  readonly session_id?: unknown;
  readonly command?: unknown;
  readonly cwd?: unknown;
  readonly timeoutMs?: unknown;
  readonly lifetime?: unknown;
  readonly processClass?: unknown;
  readonly killOnTimeout?: unknown;
  readonly pty?: unknown;
  readonly data?: unknown;
  readonly query?: unknown;
  readonly target?: unknown;
  readonly limit?: unknown;
  readonly includeParameters?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

function output(value: unknown): { readonly success: true; readonly output: string } {
  return {
    success: true,
    output: typeof value === 'string' ? value : JSON.stringify(value, null, 2),
  };
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

/**
 * A launch, stop or wait that did nothing is a failure, not a success with a
 * status to decode. The full body stays in `output`; `error` says why.
 */
function processOutcome(result: EffectResult): { readonly success: boolean; readonly output: string; readonly error?: string } {
  // The process handler says whether its action happened; only `done: true` is a success.
  if (result.done === true) return output(result);
  const status = typeof result.status === 'string' ? result.status : 'not_done';
  const id = typeof result.processId === 'string' ? result.processId : '';
  const reason = typeof result.reason === 'string' ? result.reason
    : status === 'not_found' ? `No tracked process matched ${id ? `"${id}"` : 'that id'}. Use process action:"list" to see the tracked ids.`
    : typeof result.policy === 'string' ? result.policy : status;
  return { success: false, output: JSON.stringify(result, null, 2), error: `Process ${status.replace('_', ' ')}; nothing was done. ${reason}` };
}

const PROCESS_ACTION_WORDS = ['list', 'poll', 'status', 'wait', 'log', 'output', 'kill', 'stop', 'cancel', 'write', 'start', 'capabilities', 'doctor', 'parity'] as const;
const PROCESS_ACTION_ALIASES = new Set<string>([...PROCESS_ACTION_WORDS, 'spawn', 'run']);

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function readBoolean(value: unknown): boolean {
  return value === true || (typeof value === 'string' && value.trim().toLowerCase() === 'true');
}

function readProcessAction(args: AgentProcessToolArgs): string {
  const action = readString(args.action) || readString(args.processAction);
  if (action) return action.toLowerCase();
  return readString(args.command) ? 'start' : 'list';
}

function isReadOnlyProcessAction(action: string): boolean {
  return READ_ONLY_PROCESS_ACTIONS.has(action);
}

export function createAgentTerminalTool(commandContext: CommandContext, registry?: ToolRegistry): Tool {
  return {
    definition: {
      name: 'terminal',
      description: 'Start visible tracked background shell commands. By default (lifetime "task") the process ends when the Agent closes and at timeoutMs; lifetime "detached" keeps it running after the Agent exits (a dev server, an editor), with its output in a log file and a record later sessions can list and stop.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to start via the shared ProcessManager.' },
          background: { type: 'boolean', description: 'Must be true. Foreground shell uses exec.' },
          cwd: { type: 'string', description: 'Workspace-relative or absolute working directory.' },
          timeoutMs: { type: 'number', description: 'Deadline in ms; 0 or omitted means none, at most 2147483647. A task process is ended at the deadline, a detached one is left running (killOnTimeout overrides either).' },
          lifetime: { type: 'string', enum: ['task', 'detached'], description: 'task (default): ended when the Agent closes and at timeoutMs. detached: keeps running after the Agent exits; output goes to a log file; later sessions list it, read its log and stop it.' },
          processClass: { type: 'string', enum: ['command', 'long_lived'], description: 'Older spelling: long_lived means the deadline leaves the process running (same as killOnTimeout:false).' },
          killOnTimeout: { type: 'boolean', description: 'Whether timeoutMs ends the process: true ends it, false leaves it running. Default: true for task, false for detached.' },
          pty: { type: 'boolean', description: 'Request PTY mode; returns unsupported until the platform publishes a typed PTY contract.' },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter(),
        },
        required: ['command', 'background'],
        additionalProperties: false,
      },
      sideEffects: ['exec'],
      concurrency: 'serial',
      supportsProgress: true,
      supportsStreamingOutput: true,
    },
    execute: async (args: Record<string, unknown>, options) => {
      const input = args as AgentTerminalToolArgs;
      if (!readBoolean(input.background)) {
        return error('terminal is the tracked-background adapter. Use exec for bounded foreground shell commands, or call terminal with background:true. Launch requires current recorded effect admission.');
      }
      return processOutcome(await runBackgroundProcessAction(commandContext, {
        ...input,
        processAction: 'start',
      }, processClassificationOptions(commandContext, registry, options?.signal, () => { assertCurrentToolExecution(args, options); }), args, options));
    },
  };
}

export function createAgentProcessTool(commandContext: CommandContext, registry?: ToolRegistry): Tool {
  return {
    definition: {
      name: 'process',
      description: 'List, poll, log, wait, stop tracked processes.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'poll', 'status', 'wait', 'log', 'output', 'kill', 'stop', 'cancel', 'write', 'start', 'capabilities', 'doctor', 'parity'],
            description: 'list/poll/log/wait observe processes. kill/start/write require current recorded effect admission; writes target a running tracked native stdin pipe.',
          },
          processId: { type: 'string', description: 'Tracked background process id.' },
          processSessionId: { type: 'string', description: 'Accepted as processId.' },
          sessionId: { type: 'string', description: 'Accepted as processId (not a chat session id).' },
          session_id: { type: 'string', description: 'Accepted as processId.' },
          command: { type: 'string', description: 'Shell command for action:start.' },
          cwd: { type: 'string', description: 'Working directory for action:start.' },
          timeoutMs: { type: 'number', description: 'Milliseconds. For wait: default 30000, 0 returns the current status without waiting, more than 600000 is capped (wait again to keep watching). For start: 0 or omitted means no deadline. At most 2147483647.' },
          lifetime: { type: 'string', enum: ['task', 'detached'], description: 'For action:start. task (default): ended when the Agent closes and at timeoutMs. detached: keeps running after the Agent exits, output in a log file, listed and stoppable from later sessions.' },
          processClass: { type: 'string', enum: ['command', 'long_lived'], description: 'Older spelling for action:start: long_lived means the deadline leaves the process running.' },
          killOnTimeout: { type: 'boolean', description: 'For action:start: whether timeoutMs ends the process. Default: true for task, false for detached.' },
          pty: { type: 'boolean', description: 'Request PTY mode; reports unsupported until a typed contract exists.' },
          data: { type: 'string', description: 'Input data for action:write to a running tracked native stdin pipe.' },
          query: { type: 'string', description: 'Search text for list or process lookup.' },
          target: { type: 'string', description: 'Process lookup text.' },
          limit: { type: 'number', description: 'Maximum list rows.' },
          includeParameters: { type: 'boolean', description: 'Include full bounded command/output metadata.' },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter(),
        },
        additionalProperties: false,
      },
      sideEffects: ['exec'],
      concurrency: 'serial',
      supportsProgress: true,
      supportsStreamingOutput: true,
    },
    execute: async (args: Record<string, unknown>, options) => {
      const input = args as AgentProcessToolArgs;
      const action = readProcessAction(input);
      if (!PROCESS_ACTION_ALIASES.has(action)) return error(`Unknown process action "${action}". Use one of: ${PROCESS_ACTION_WORDS.join(', ')}.`);
      const assertCurrent = harnessCatalogExecutionGuard(args, options);
      const reading = { ...processClassificationOptions(commandContext, registry, options?.signal, assertCurrent), retainCurrent: retainHarnessCatalogCurrent(args) };

      if (action === 'list') { const result = await backgroundProcessSummary(commandContext, input, reading); assertCurrent(); return output(result); }
      if (isReadOnlyProcessAction(action) && action !== 'capabilities' && action !== 'doctor' && action !== 'parity') {
        const resolved = await describeBackgroundProcess(commandContext, {
          ...input,
          processAction: action,
        }, reading);
        assertCurrent();
        if (resolved.status === 'found') return output(resolved.process);
        if (resolved.status === 'ambiguous') return error(`Ambiguous process ${resolved.input}. Candidates: ${JSON.stringify(resolved.candidates)}`);
        return error(resolved.usage);
      }

      return processOutcome(await runBackgroundProcessAction(commandContext, {
        ...input,
        processAction: action,
      }, reading, args, options));
    },
  };
}

export function registerAgentTerminalProcessTools(registry: ToolRegistry, commandContext: CommandContext): void {
  if (!registry.has('terminal')) registry.register(createAgentTerminalTool(commandContext, registry), { inputProjection: createProcessInputProjector(registry, 'terminal') });
  if (!registry.has('process')) registry.register(createAgentProcessTool(commandContext, registry), { inputProjection: createProcessInputProjector(registry, 'process') });
}
