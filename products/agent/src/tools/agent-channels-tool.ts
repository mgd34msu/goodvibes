import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createHarnessFacade, registerHarnessFacade, type HarnessFacadeDeps } from './agent-harness-facade.ts';
import { readString } from '@goodvibes-jev/engine/terminal-shell/agent-turn/tool-args';

type AgentChannelsAction = 'status' | 'channel' | 'setup' | 'triage' | 'deliveries';

interface AgentChannelsToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly channelId?: unknown;
  readonly id?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type AgentChannelsToolDeps = HarnessFacadeDeps;

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function normalizeChannelsAction(value: unknown): AgentChannelsAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'summary' || action === 'list' || action === 'readiness' || action === 'channels') return 'status';
  if (action === 'channel' || action === 'show' || action === 'inspect') return 'channel';
  if (action === 'setup' || action === 'guide' || action === 'setup_guide' || action === 'channel_setup_guide') return 'setup';
  if (action === 'triage' || action === 'inbox' || action === 'blockers' || action === 'retries' || action === 'channel_triage') return 'triage';
  if (action === 'deliveries' || action === 'delivery' || action === 'receipts' || action === 'history' || action === 'channel_deliveries') return 'deliveries';
  return null;
}

function readAction(args: AgentChannelsToolArgs): AgentChannelsAction | null {
  const explicit = normalizeChannelsAction(args.action) ?? normalizeChannelsAction(args.mode);
  if (explicit) return explicit;
  // An action or mode that was given but is not one of ours is not a request to guess: answering with another view would read as the requested one.
  if (readString(args.action) || readString(args.mode)) return null;
  if (readString(args.channelId) || readString(args.id)) return 'channel';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function channelIdArg(args: AgentChannelsToolArgs): unknown {
  return readString(args.channelId) || readString(args.id) || undefined;
}

export function createAgentChannelsTool(deps: AgentChannelsToolDeps): Tool {
  return createHarnessFacade<AgentChannelsToolArgs>(deps, {
    definition: {
      name: 'channels',
      activity: {
        doing: 'Checking', did: 'checked', object: 'message channels',
        byAction: { change: { doing: 'Setting up', did: 'set up', object: 'a message channel', objects: 'message channels' } },
      },
      description: 'Inspect channel readiness, setup, triage, and receipts.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'channel', 'setup', 'triage', 'deliveries'],
            description: 'Read channel status, setup, triage, or receipts.',
          },
          channelId: { type: 'string', description: 'Channel id to inspect.' },
          id: { type: 'string', description: 'Alias for channelId.' },
          target: { type: 'string', description: 'Channel lookup target.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include route detail and safe config-key names.' },
          limit: { type: 'number', description: 'Maximum triage, delivery, or channel rows.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    route({ args, forward }) {
      const action = readAction(args);
      if (action === null) return error('Unknown channels action. Use action (or mode) as one of: status, channel, setup, triage, deliveries.');

      if (action === 'channel') {
        return forward(compactArgs({
          mode: 'channel',
          channelId: channelIdArg(args),
          target: args.target,
          query: args.query,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'setup') {
        return forward(compactArgs({
          mode: 'channel_setup_guide',
          channelId: channelIdArg(args),
          target: args.target,
          query: args.query,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'triage') {
        return forward(compactArgs({
          mode: 'channel_triage',
          limit: args.limit,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'deliveries') {
        return forward(compactArgs({
          mode: 'channel_deliveries',
          limit: args.limit,
          includeParameters: args.includeParameters,
        }));
      }
      return forward(compactArgs({
        mode: 'channels',
        query: args.query ?? args.target,
        limit: args.limit,
        includeParameters: args.includeParameters,
      }));
    },
  });
}

export function registerAgentChannelsTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  registerHarnessFacade(registry, createAgentChannelsTool({ commandRegistry, commandContext, toolRegistry: registry }), commandContext);
}
