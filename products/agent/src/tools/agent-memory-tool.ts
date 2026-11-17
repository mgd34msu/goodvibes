import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { createAgentHarnessTool } from './agent-harness-tool.ts';
import { captureModelReadingInput } from './agent-harness-model-reading-source.ts';
import { createHarnessCatalogInputProjector, protectHarnessCatalogTool, forwardHarnessCatalogCall } from './agent-harness-catalog-ingress.ts';
import { confirmParameter, requestParameter } from '@goodvibes-jev/engine/terminal-shell/agent-turn/effect-admission';

type AgentMemoryAction =
  | 'status'
  | 'provider'
  | 'refinement'
  | 'run_refinement'
  | 'curator'
  | 'curate'
  | 'candidate'
  | 'list'
  | 'search'
  | 'get'
  | 'create'
  | 'update'
  | 'review'
  | 'stale'
  | 'delete';

interface AgentMemoryToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly recordId?: unknown;
  readonly providerId?: unknown;
  readonly candidateId?: unknown;
  readonly knowledgeSpaceId?: unknown;
  readonly sourceIds?: unknown;
  readonly gapIds?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
  readonly semantic?: unknown;
  readonly cls?: unknown;
  readonly scope?: unknown;
  readonly summary?: unknown;
  readonly detail?: unknown;
  readonly body?: unknown;
  readonly confidence?: unknown;
  readonly tags?: unknown;
  readonly reason?: unknown;
  readonly maxRunMs?: unknown;
  readonly force?: unknown;
  readonly confirm?: unknown;
  readonly explicitUserRequest?: unknown;
}

interface AgentMemoryToolDeps {
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

function normalizeMemoryAction(value: unknown): AgentMemoryAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (action === 'status' || action === 'summary' || action === 'posture' || action === 'memory_posture' || action === 'providers') return 'status';
  if (action === 'provider' || action === 'memory_provider' || action === 'embedding' || action === 'external' || action === 'external_provider') return 'provider';
  if (action === 'refinement' || action === 'refinement_tasks' || action === 'semantic_refinement' || action === 'self_improvement' || action === 'semantic_self_improvement' || action === 'learning_loop') return 'refinement';
  if (action === 'run_refinement' || action === 'refine' || action === 'run_semantic_refinement' || action === 'run_self_improvement' || action === 'self_improve') return 'run_refinement';
  if (action === 'curate' || action === 'curation' || action === 'curation_pass' || action === 'run_curator' || action === 'refresh_curator') return 'curate';
  if (action === 'curator' || action === 'learning' || action === 'learning_curator' || action === 'queue' || action === 'review_queue' || action === 'plan') return 'curator';
  if (action === 'candidate' || action === 'learning_candidate' || action === 'card' || action === 'inspect_candidate') return 'candidate';
  if (action === 'list' || action === 'records' || action === 'memories') return 'list';
  if (action === 'search' || action === 'find' || action === 'lookup' || action === 'recall') return 'search';
  if (action === 'get' || action === 'show' || action === 'inspect' || action === 'read') return 'get';
  if (action === 'create' || action === 'add' || action === 'remember') return 'create';
  if (action === 'update' || action === 'edit') return 'update';
  if (action === 'review' || action === 'approve') return 'review';
  if (action === 'stale' || action === 'mark_stale') return 'stale';
  if (action === 'delete' || action === 'remove' || action === 'forget') return 'delete';
  return null;
}

/** The action or mode text the caller gave when it names nothing this tool does. */
function unrecognisedAction(args: AgentMemoryToolArgs): string | null {
  for (const value of [args.action, args.mode]) {
    const text = readString(value);
    if (text && normalizeMemoryAction(value) === null) return text;
  }
  return null;
}

function readAction(args: AgentMemoryToolArgs): AgentMemoryAction {
  const explicit = normalizeMemoryAction(args.action) ?? normalizeMemoryAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.providerId)) return 'provider';
  if (readString(args.candidateId)) return 'candidate';
  if (readString(args.id) || readString(args.recordId)) return 'get';
  if (readString(args.query) || readString(args.target)) return 'search';
  return 'status';
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function lookupId(args: AgentMemoryToolArgs): string {
  return readString(args.id) || readString(args.recordId);
}

let recordCallSequence = 0;

function localMemoryArgs(action: AgentMemoryAction, args: AgentMemoryToolArgs): Record<string, unknown> {
  return compactArgs({
    domain: 'memory',
    action,
    id: lookupId(args),
    query: args.query ?? args.target,
    limit: args.limit,
    semantic: args.semantic,
    cls: args.cls,
    scope: args.scope,
    summary: args.summary,
    detail: args.detail,
    body: args.body,
    confidence: args.confidence,
    tags: args.tags,
    reason: args.reason,
    confirm: args.confirm,
    explicitUserRequest: args.explicitUserRequest,
  });
}

export function createAgentMemoryTool(deps: AgentMemoryToolDeps): Tool {
  const harnessTool = deps.harnessTool ?? createAgentHarnessTool({
    commandRegistry: deps.commandRegistry,
    commandContext: deps.commandContext,
    toolRegistry: deps.toolRegistry,
  });

  const tool: Tool = {
    definition: {
      name: 'memory',
      activity: {
        doing: 'Recalling', did: 'recalled', object: 'memory',
        byAction: {
          change: { doing: 'Saving to', did: 'saved to', object: 'memory' },
          run: { doing: 'Refining', did: 'refined', object: 'memory' },
          delete: { doing: 'Forgetting', did: 'forgot', object: 'a memory', objects: 'memories' },
        },
      },
      description: 'Inspect memory posture, providers, curator, and records.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'provider', 'refinement', 'run_refinement', 'curator', 'curate', 'candidate', 'list', 'search', 'get', 'create', 'update', 'review', 'stale', 'delete'],
            description: 'Read memory posture/providers/curator, run the curation pass (curate: reads new or changed records once), or operate records.',
          },
          id: { type: 'string', description: 'Agent-local memory record id.' },
          recordId: { type: 'string', description: 'Alias for id.' },
          providerId: { type: 'string', description: 'Embedding or external-memory provider id.' },
          candidateId: { type: 'string', description: 'Learning curator candidate id.' },
          knowledgeSpaceId: { type: 'string', description: 'Agent Knowledge space id for semantic refinement.' },
          sourceIds: { type: 'array', items: { type: 'string' }, description: 'Agent Knowledge source ids for scoped semantic refinement.' },
          gapIds: { type: 'array', items: { type: 'string' }, description: 'Agent Knowledge semantic gap ids for scoped refinement.' },
          target: { type: 'string', description: 'Lookup target or search text.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include provider setup contracts or candidate details.' },
          limit: { type: 'number', description: 'Maximum rows for posture, curator, list and search. Record search defaults to 10 and returns at most 50.' },
          semantic: { type: 'boolean', description: 'Record search: semantic by default; false forces literal matching.' },
          cls: { type: 'string', description: 'Memory class for create/update.' },
          scope: { type: 'string', description: 'Memory scope for create/update.' },
          summary: { type: 'string', description: 'Memory summary for create/update.' },
          detail: { type: 'string', description: 'Memory detail for create/update.' },
          body: { type: 'string', description: 'Alias for detail.' },
          confidence: { type: 'number', description: 'Review confidence, 0-100.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Memory tags.' },
          reason: { type: 'string', description: 'Reason for stale/delete decisions.' },
          maxRunMs: { type: 'number', description: 'Maximum semantic refinement run budget in milliseconds.' },
          force: { type: 'boolean', description: 'Force semantic refinement reprocessing where supported.' },
          confirm: confirmParameter(),
          explicitUserRequest: requestParameter('recorded with the effect'),
        },
        additionalProperties: false,
      },
      sideEffects: ['state'],
      concurrency: 'serial',
    },
    execute: async (rawArgs, options) => {
      const args = captureModelReadingInput(rawArgs);
      const forward = (translated: Record<string, unknown>) => forwardHarnessCatalogCall(harnessTool, rawArgs, translated, options);
      const unrecognised = unrecognisedAction(args);
      if (unrecognised) return error(`Unknown memory action "${unrecognised}". Valid actions: status, provider, refinement, run_refinement, curator, curate, candidate, list, search, get, create, update, review, stale, delete.`);
      const action = readAction(args);

      if (action === 'status') {
        return forward(compactArgs({
          mode: 'memory_posture',
          query: args.query ?? args.target,
          limit: args.limit,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'provider') {
        return forward(compactArgs({
          mode: 'memory_provider',
          providerId: args.providerId ?? args.id,
          target: args.providerId || args.id ? undefined : args.target,
          query: args.providerId || args.id ? undefined : args.query,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'refinement') {
        return forward(compactArgs({
          mode: 'memory_refinement',
          target: args.target,
          query: args.query,
          knowledgeSpaceId: args.knowledgeSpaceId,
          sourceIds: args.sourceIds,
          gapIds: args.gapIds,
          limit: args.limit,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'run_refinement') {
        return forward(compactArgs({
          mode: 'run_memory_refinement',
          knowledgeSpaceId: args.knowledgeSpaceId,
          sourceIds: args.sourceIds,
          gapIds: args.gapIds,
          limit: args.limit,
          maxRunMs: args.maxRunMs,
          force: args.force,
          confirm: args.confirm,
          explicitUserRequest: args.explicitUserRequest,
        }));
      }
      if (action === 'curator') {
        return forward(compactArgs({
          mode: 'learning_curator',
          query: args.query ?? args.target,
          limit: args.limit,
          includeParameters: args.includeParameters,
        }));
      }
      if (action === 'curate') return forward({ mode: 'learning_curation_pass' });
      if (action === 'candidate') {
        return forward(compactArgs({
          mode: 'learning_candidate',
          candidateId: args.candidateId ?? args.id,
          target: args.candidateId || args.id ? undefined : args.target,
          query: args.candidateId || args.id ? undefined : args.query,
          includeParameters: args.includeParameters,
        }));
      }

      // Records belong to agent_local_registry. The record call runs as that
      // tool's own nested call, so it is admitted for what it does (a read or a
      // write) instead of reusing this call's argument proof.
      if (!deps.toolRegistry.has('agent_local_registry')) {
        return error(`memory action:"${action}" was not run: this runtime has no agent_local_registry tool, which owns memory records. Use memory action:"status" for posture.`);
      }
      return deps.toolRegistry.executeNested(`memory-record-${action}-${++recordCallSequence}`, 'agent_local_registry', localMemoryArgs(action, args), options);
    },
  };
  return protectHarnessCatalogTool(tool, deps.toolRegistry, isMemoryCatalogCall, deps.commandContext);
}

function isMemoryCatalogCall(input: Record<string, unknown>): boolean {
  const args = captureModelReadingInput(input);
  const action = readAction(args);
  return action === 'status' || action === 'provider'
    || (action === 'curator' || action === 'candidate') && Boolean(readString(args.query) || readString(args.target));
}

export function registerAgentMemoryTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  if (!registry.has('memory')) registry.register(createAgentMemoryTool({ commandRegistry, commandContext, toolRegistry: registry }), { inputProjection: createHarnessCatalogInputProjector(registry, undefined, isMemoryCatalogCall, commandContext) });
}
