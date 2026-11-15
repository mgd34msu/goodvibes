import { processClassificationOptions } from './agent-harness-process-launch.ts';
import { createProcessInputProjector } from './agent-process-ingress.ts';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { assertCurrentToolExecution, type ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { backgroundProcessSummary, describeBackgroundProcess, runBackgroundProcessAction } from './agent-harness-background-processes.ts';
import { harnessCatalogExecutionGuard, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';

const READ_ONLY_PROCESS_ACTIONS = new Set(['list', 'status', 'poll', 'log', 'output', 'capabilities', 'doctor', 'parity']);

interface AgentTerminalToolArgs {
  readonly command?: unknown;
  readonly background?: unknown;
  readonly cwd?: unknown;
  readonly timeoutMs?: unknown;
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

const NOT_DONE_STATUSES = new Set(['unavailable', 'unsupported', 'blocked', 'not_found']);

/**
 * A launch, stop or wait that did nothing is a failure, not a success with a
 * status to decode. The full body stays in `output`; `error` says why.
 */
function processOutcome(result: Record<string, unknown>): { readonly success: boolean; readonly output: string; readonly error?: string } {
  const status = typeof result.status === 'string' ? result.status : '';
  if (!NOT_DONE_STATUSES.has(status)) return output(result);
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
      description: 'Start visible tracked background shell commands. A timeout terminates ordinary commands; a long_lived process (an interactive application or a server) keeps running past it unless killOnTimeout is set true.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command to start via the shared ProcessManager.' },
          background: { type: 'boolean', description: 'Must be true. Foreground shell uses exec.' },
          cwd: { type: 'string', description: 'Workspace-relative or absolute working directory.' },
          timeoutMs: { type: 'number', description: 'How long to allow before the timeout contract applies; 0 or omitted means no deadline, at most 2147483647. Whether it terminates the process depends on processClass and killOnTimeout.' },
          processClass: {
            type: 'string',
            enum: ['command', 'long_lived'],
            description: 'command: an ordinary job, terminated when timeoutMs expires. long_lived: an interactive application or a server whose lifetime is the user\'s, it keeps running past timeoutMs and must be stopped explicitly. When omitted with no deadline or with killOnTimeout given, nothing is read and the process starts at once. When omitted with a deadline, Jev reads the complete command; if that reading does not settle the process still starts and the deadline leaves it running. When Jev is not reading commands (Classic operation) an omitted class is command, so a timeout kills it unless killOnTimeout:false is given.',
          },
          killOnTimeout: { type: 'boolean', description: 'Overrides processClass: true terminates this process when timeoutMs expires, false leaves it running. Set true deliberately before a timeout may destroy something the user is using.' },
          pty: { type: 'boolean', description: 'Request PTY mode; returns unsupported until the platform publishes a typed PTY contract.' },
          confirm: { type: 'boolean', description: 'Optional historical provenance; does not grant process authority.' },
          explicitUserRequest: { type: 'string', description: 'Optional human request provenance; does not grant process authority.' },
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
          processAction: { type: 'string', description: 'Alias for action.' },
          processId: { type: 'string', description: 'Tracked background process id.' },
          processSessionId: { type: 'string', description: 'Process session id alias.' },
          sessionId: { type: 'string', description: 'Process session id alias.' },
          session_id: { type: 'string', description: 'Process session id alias.' },
          command: { type: 'string', description: 'Shell command for action:start.' },
          cwd: { type: 'string', description: 'Working directory for action:start.' },
          timeoutMs: { type: 'number', description: 'Milliseconds. For wait: default 30000, 0 returns the current status without waiting, more than 600000 is capped (wait again to keep watching). For start: 0 or omitted means no deadline. At most 2147483647.' },
          processClass: { type: 'string', enum: ['command', 'long_lived'], description: 'Explicit lifetime class for action:start. When omitted, it is read only if timeoutMs is set and killOnTimeout is not; an unsettled reading leaves the process running past the deadline. In Classic operation (Jev not reading commands) an omitted class is command and a timeout kills it.' },
          killOnTimeout: { type: 'boolean', description: 'Explicit timeout termination override for action:start.' },
          pty: { type: 'boolean', description: 'Request PTY mode; reports unsupported until a typed contract exists.' },
          data: { type: 'string', description: 'Input data for action:write to a running tracked native stdin pipe.' },
          query: { type: 'string', description: 'Search text for list or process lookup.' },
          target: { type: 'string', description: 'Process lookup text.' },
          limit: { type: 'number', description: 'Maximum list rows.' },
          includeParameters: { type: 'boolean', description: 'Include full bounded command/output metadata.' },
          confirm: { type: 'boolean', description: 'Optional historical provenance; does not grant process authority.' },
          explicitUserRequest: { type: 'string', description: 'Optional human request provenance; does not grant process authority.' },
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
