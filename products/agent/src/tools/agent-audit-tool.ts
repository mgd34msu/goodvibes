import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext, CommandRegistry } from '../input/command-registry.ts';
import { harnessCatalogExecutionGuard, retainHarnessCatalogCurrent } from './agent-harness-catalog-ingress.ts';
import { createHarnessFacade, registerHarnessFacade, type HarnessFacadeDeps } from './agent-harness-facade.ts';
import { selectHarnessCatalog } from './agent-harness-catalog-selection.ts';
import { agentResearchSourceOwner } from '../agent/protected-research-report.ts';

type AgentAuditAction = 'readiness' | 'item' | 'evidence' | 'artifact';

interface AgentAuditToolArgs {
  readonly action?: unknown;
  readonly mode?: unknown;
  readonly id?: unknown;
  readonly itemId?: unknown;
  readonly artifactId?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
  readonly limit?: unknown;
}

type AgentAuditToolDeps = HarnessFacadeDeps;

function error(message: string): { readonly success: false; readonly error: string } {
  return { success: false, error: message };
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeAuditAction(value: unknown): AgentAuditAction | null {
  const action = readString(value).toLowerCase().replace(/-/g, '_');
  if (!action) return null;
  if (['readiness', 'status', 'summary', 'inventory', 'gate', 'gates', 'release_readiness'].includes(action)) return 'readiness';
  if (['item', 'readiness_item', 'release_readiness_item'].includes(action)) return 'item';
  if (['evidence', 'artifacts', 'release_evidence', 'ledger', 'verification'].includes(action)) return 'evidence';
  if (['artifact', 'evidence_artifact', 'release_evidence_artifact'].includes(action)) return 'artifact';
  return null;
}

const AUDIT_ACTIONS: readonly { readonly id: AgentAuditAction; readonly description: string }[] = [
  { id: 'readiness', description: 'List release readiness status, gates, blockers and inventory; a mention of evidence alone does not request the evidence ledger.' },
  { id: 'item', description: 'Inspect one specific release readiness item or gate in detail.' },
  { id: 'evidence', description: 'List or search packaged release evidence, verification results, release notes and performance snapshots.' },
  { id: 'artifact', description: 'Inspect the contents of one specific release evidence artifact.' },
];

function readExplicitAction(args: AgentAuditToolArgs): AgentAuditAction | null {
  const explicit = normalizeAuditAction(args.action) ?? normalizeAuditAction(args.mode);
  if (explicit) return explicit;
  if (readString(args.action) || readString(args.mode)) return null;
  if (readString(args.artifactId)) return 'artifact';
  if (readString(args.itemId)) return 'item';
  return null;
}

function compactArgs(entries: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).filter(([, value]) => value !== undefined && value !== ''));
}

function readinessArgs(args: AgentAuditToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'release_readiness',
    query: args.query ?? args.target,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function itemArgs(args: AgentAuditToolArgs): Record<string, unknown> {
  const itemId = readString(args.itemId) || readString(args.id);
  return compactArgs({
    mode: 'release_readiness_item',
    itemId,
    target: itemId ? undefined : args.target,
    query: itemId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

function evidenceArgs(args: AgentAuditToolArgs): Record<string, unknown> {
  return compactArgs({
    mode: 'release_evidence',
    query: args.query ?? args.target,
    includeParameters: args.includeParameters,
    limit: args.limit,
  });
}

function artifactArgs(args: AgentAuditToolArgs): Record<string, unknown> {
  const artifactId = readString(args.artifactId) || readString(args.id);
  return compactArgs({
    mode: 'release_evidence_artifact',
    artifactId,
    target: artifactId ? undefined : args.target,
    query: artifactId ? undefined : args.query,
    includeParameters: args.includeParameters,
  });
}

export function createAgentAuditTool(deps: AgentAuditToolDeps): Tool {
  return createHarnessFacade<AgentAuditToolArgs>(deps, {
    definition: {
      name: 'audit',
      description: 'Read release readiness and packaged release evidence.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['readiness', 'item', 'evidence', 'artifact'],
            description: 'Read release inventory, one item, evidence list, or one artifact.',
          },
          mode: { type: 'string', description: 'Alias for action.' },
          id: { type: 'string', description: 'Alias for itemId or artifactId depending on action.' },
          itemId: { type: 'string', description: 'Release readiness item id.' },
          artifactId: { type: 'string', description: 'Release evidence artifact id.' },
          target: { type: 'string', description: 'Lookup target or search text.' },
          query: { type: 'string', description: 'Search text.' },
          includeParameters: { type: 'boolean', description: 'Include detailed release artifact or item content.' },
          limit: { type: 'number', description: 'Maximum rows returned.' },
        },
        additionalProperties: false,
      },
      sideEffects: [],
      concurrency: 'parallel',
    },
    async route({ args, rawArgs, options, forward: forwardCall }) {
      const executionCurrent = harnessCatalogExecutionGuard(rawArgs, options);
      const sourceOwner = agentResearchSourceOwner(deps.toolRegistry);
      const current = () => {
        executionCurrent();
        if (agentResearchSourceOwner(deps.toolRegistry) !== sourceOwner) throw new Error('Audit source owner changed.');
      };
      const forward = (translated: Record<string, unknown>) => forwardCall(translated, current);
      let action = readExplicitAction(args);
      if (!action && !readString(args.action) && !readString(args.mode)) {
        // A bare id names either a release item or an evidence artifact and there
        // is nothing to choose between them. Answering with the readiness list
        // would read as the answer for that id.
        if (readString(args.id)) {
          return error('audit got id without action, and an id alone cannot say whether it is a release readiness item or an evidence artifact. Re-send with action:"item" (or itemId) for a readiness item, or action:"artifact" (or artifactId) for an evidence artifact.');
        }
        const query = readString(args.query) || readString(args.target);
        if (!query) action = 'readiness';
        else {
          try {
            const selected = await selectHarnessCatalog(AUDIT_ACTIONS, query, entry => entry,
              { signal: options?.signal, sourceOwner, assertCurrent: current, retainCurrent: retainHarnessCatalogCurrent(rawArgs), requirePreservedSource: true },
              'agent.audit.intent', args);
            current();
            action = selected?.id ?? null;
          } catch { return error('Audit intent could not be established. Specify action:"readiness", "item", "evidence", or "artifact".'); }
        }
      }
      if (!action) return error('Unknown audit action. Use action:"readiness", "item", "evidence", or "artifact".');
      if (action === 'readiness') return forward(readinessArgs(args));
      if (action === 'item') return forward(itemArgs(args));
      if (action === 'evidence') return forward(evidenceArgs(args));
      if (action === 'artifact') return forward(artifactArgs(args));
      return error('Unknown audit action. Use action:"readiness", "item", "evidence", or "artifact".');
    },
  });
}

export function registerAgentAuditTool(
  registry: ToolRegistry,
  commandRegistry: CommandRegistry,
  commandContext: CommandContext,
): void {
  registerHarnessFacade(registry, createAgentAuditTool({ commandRegistry, commandContext, toolRegistry: registry }), commandContext);
}
