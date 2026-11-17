import { createPersonalOpsInputProjector } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { facadeHarness } from './agent-harness-facade.ts';
import { captureCatalogData } from '@goodvibes-jev/engine/terminal-shell/agent-turn';
import { forwardHarnessCatalogCall, protectHarnessCatalogTool } from './agent-harness-catalog-ingress.ts';
import { confirmParameter, requestParameter } from '@goodvibes-jev/engine/terminal-shell/agent-turn';

type AgentPersonalOpsAction = 'briefing' | 'status' | 'queue' | 'intake' | 'lane' | 'read';

interface AgentPersonalOpsToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly laneId?: unknown;
  readonly recordId?: unknown;
  readonly query?: unknown;
  readonly target?: unknown;
  readonly fields?: unknown;
  readonly saveReviewCards?: unknown;
  readonly saveReview?: unknown;
  readonly artifactTitle?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentPersonalOpsToolDeps {
  readonly commandRegistry: CommandRegistry;
  readonly commandContext: CommandContext;
  readonly toolRegistry: ToolRegistry;
  readonly harnessTool?: Tool;
}

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizePersonalOpsAction(value: unknown): AgentPersonalOpsAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'briefing' || action === 'brief' || action === 'daily' || action === 'daily_brief' || action === 'morning') return 'briefing';
  if (action === 'status' || action === 'summary' || action === 'overview' || action === 'map' || action === 'list') return 'status';
  if (action === 'queue' || action === 'queues' || action === 'review_queue' || action === 'review_queues' || action === 'personal_queue' || action === 'ops_queue') return 'queue';
  if (action === 'intake' || action === 'request' || action === 'route' || action === 'plan' || action === 'triage' || action === 'draft') return 'intake';
  if (action === 'lane' || action === 'inspect' || action === 'show') return 'lane';
  if (action === 'read' || action === 'run' || action === 'execute' || action === 'fresh_read' || action === 'refresh') return 'read';
  return null;
}

const PERSONAL_OPS_ACTIONS = ['briefing', 'status', 'queue', 'intake', 'lane', 'read'] as const;

/** Null when an action or mode was named but is not one of ours: a typo must not become a different read. */
function readAction(args: AgentPersonalOpsToolArgs): AgentPersonalOpsAction | null {
  const action = normalizePersonalOpsAction(args.action), mode = normalizePersonalOpsAction(args.mode);
  // Both are checked: a recognised mode must not hide an action that is not ours (action:"delete" mode:"read").
  if ((readString(args.action) && !action) || (readString(args.mode) && !mode)) return null;
  const explicit = action ?? mode;
  if (explicit) return explicit;
  if (readString(args.recordId)) return 'read';
  if (readString(args.laneId)) return 'lane';
  if (readString(args.query) || readString(args.target)) return 'intake';
  return 'briefing';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function readFields(args: AgentPersonalOpsToolArgs): Record<string, unknown> | undefined {
  const fields = args.fields && typeof args.fields === 'object' && !Array.isArray(args.fields)
    ? { ...(args.fields as Record<string, unknown>) }
    : {};
  if (args.saveReviewCards !== undefined) fields.saveReviewCards = args.saveReviewCards;
  if (args.saveReview !== undefined) fields.saveReview = args.saveReview;
  const artifactTitle = readString(args.artifactTitle);
  if (artifactTitle) fields.artifactTitle = artifactTitle;
  return Object.keys(fields).length > 0 ? fields : undefined;
}

function briefingArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'personal_ops_briefing',
    query: args.query,
    target: args.target,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function statusArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'personal_ops',
    includeParameters: args.includeParameters,
  });
}

function intakeArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'personal_ops_intake',
    query: args.query,
    target: args.target,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function queueArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'personal_ops_queue',
    query: args.query,
    target: args.target,
    limit: args.limit,
    includeParameters: args.includeParameters,
  });
}

function laneArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'personal_ops_lane',
    laneId: args.laneId,
    target: args.target,
    query: args.query,
    includeParameters: args.includeParameters,
  });
}

function readArgs(args: AgentPersonalOpsToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'run_personal_ops_read',
    laneId: args.laneId,
    recordId: args.recordId,
    target: args.target,
    query: args.query,
    fields: readFields(args),
    includeParameters: args.includeParameters,
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

export function createAgentPersonalOpsTool(deps: AgentPersonalOpsToolDeps): Tool {
  const harnessTool = facadeHarness(deps);

  const tool: Tool = {
    definition: {
      name: 'personal_ops',
      activity: { doing: 'Checking', did: 'checked', object: 'your inbox & calendar' },
      description: 'Plan and run safe Personal Ops workflows.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['briefing', 'status', 'queue', 'intake', 'lane', 'read'],
            description: 'Discovery actions are read-only; live reads need current recorded admission.',
          },
          laneId: { type: 'string', enum: ['inbox', 'calendar', 'notes', 'tasks', 'reminders', 'routines', 'delivery'], description: 'Personal Ops lane id.' },
          recordId: { type: 'string', description: 'Selected inbox/calendar read operation record id.' },
          query: { type: 'string', description: 'Personal operations request or lane lookup text.' },
          target: { type: 'string', description: 'Alias for query or lookup target.' },
          fields: { type: 'object', additionalProperties: true, description: 'Connector input fields for action:read; the inbox-style-reply-draft record requires inbound and explicitly supplied sentMessages, plus optional context.' },
          saveReviewCards: { type: 'boolean', description: 'For action:read, save redacted review cards as a local artifact.' },
          saveReview: { type: 'boolean', description: 'Alias for saveReviewCards.' },
          artifactTitle: { type: 'string', description: 'Optional title for a saved read-review artifact.' },
          includeParameters: { type: 'boolean', description: 'Include bounded operation schema and route detail where supported.' },
          limit: { type: 'number', description: 'Maximum briefing or intake rows.' },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter('kept as audit context for the live read'),
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs, options) => {
      options?.signal?.throwIfAborted();
      const args = captureCatalogData(rawArgs);
      const action = readAction(args);
      if (!action) {
        return error(`Unknown Personal Ops action '${normalizePersonalOpsAction(args.action) ? readString(args.mode) : readString(args.action)}'. Use one of: ${PERSONAL_OPS_ACTIONS.join(', ')}. Nothing was read or changed.`);
      }

      if (action === 'briefing') return forwardHarnessCatalogCall(harnessTool(), rawArgs, briefingArgs(args), options);
      if (action === 'status') return forwardHarnessCatalogCall(harnessTool(), rawArgs, statusArgs(args), options);
      if (action === 'queue') return forwardHarnessCatalogCall(harnessTool(), rawArgs, queueArgs(args), options);
      if (action === 'intake') return forwardHarnessCatalogCall(harnessTool(), rawArgs, intakeArgs(args), options);
      if (action === 'lane') return forwardHarnessCatalogCall(harnessTool(), rawArgs, laneArgs(args), options);
      if (action === 'read') return forwardHarnessCatalogCall(harnessTool(), rawArgs, readArgs(args), options);

      return error(`Unknown Personal Ops action. Use one of: ${PERSONAL_OPS_ACTIONS.join(', ')}.`);
    },
  };
  return protectHarnessCatalogTool(tool, deps.toolRegistry, () => true, deps.commandContext);
}

export function registerAgentPersonalOpsTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('personal_ops')) registry.register(createAgentPersonalOpsTool({ commandRegistry, commandContext, toolRegistry: registry }), { inputProjection: createPersonalOpsInputProjector(registry, undefined, () => true) });
}
