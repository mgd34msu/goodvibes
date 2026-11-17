import type { PermissionCategory } from '@goodvibes-jev/engine/platform/platform/permissions';
import { analyzePermissionRequest } from '@goodvibes-jev/engine/platform/platform/permissions';
import type { ToolDefinition } from '@goodvibes-jev/engine/platform/platform/types';
import type { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { CommandContext } from '../input/command-registry.ts';
import { snapshotJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate/judgment-input';
import { explainAgentToolPolicyInvocation } from './agent-tool-policy-guard.ts';
import { computeApprovalPosture, readApprovalPostureFromConfig, type ApprovalPosture } from '../permissions/approval-posture.ts';
import { readString } from '@goodvibes-jev/engine/terminal-shell/agent-turn/tool-args';

/** `decided_at_call`: nothing settles it in advance; the decision model (or the owner) decides when the call is made. */
type PolicyExplanationStatus = 'allowed' | 'denied' | 'owner_decides' | 'decided_at_call' | 'not_evaluated';

export interface AgentPolicyExplainArgs {
  readonly toolName?: unknown;
  readonly tool?: unknown;
  readonly toolArgs?: unknown;
  readonly args?: unknown;
  readonly target?: unknown;
  readonly query?: unknown;
  readonly includeParameters?: unknown;
}

export type AgentPolicyExplanationResolution =
  | { readonly status: 'found'; readonly explanation: Record<string, unknown> }
  | { readonly status: 'ambiguous'; readonly input: string; readonly candidates: readonly Record<string, unknown>[] }
  | { readonly status: 'missing_lookup'; readonly usage: string };

const SECRET_KEY_RE = /(?:api[_-]?key|token|secret|password|authorization|auth|bearer|webhook)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readToolArgs(args: AgentPolicyExplainArgs): Record<string, unknown> {
  if (isRecord(args.toolArgs)) return args.toolArgs;
  if (isRecord(args.args)) return args.args;
  return {};
}

function redactValue(key: string, value: unknown, depth = 0): unknown {
  if (SECRET_KEY_RE.test(key)) return '<redacted>';
  if (depth > 2) return '<nested>';
  if (Array.isArray(value)) return value.slice(0, 8).map((entry) => redactValue(key, entry, depth + 1));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).slice(0, 20).map(([entryKey, entryValue]) => [entryKey, redactValue(entryKey, entryValue, depth + 1)]));
  }
  if (typeof value === 'string' && /(?:[?&](?:token|secret|password|api[_-]?key)=|bearer\s+)/i.test(value)) return '<redacted>';
  if (typeof value === 'string' && value.length > 240) return `${value.slice(0, 237)}...`;
  return value;
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).slice(0, 30).map(([key, value]) => [key, redactValue(key, value)]));
}

function sideEffects(definition: ToolDefinition | undefined): readonly string[] {
  return Array.isArray(definition?.sideEffects) ? definition.sideEffects.filter((entry): entry is string => typeof entry === 'string') : [];
}

function findToolDefinition(toolRegistry: ToolRegistry, name: string): ToolDefinition | undefined {
  return toolRegistry.getToolDefinitions().find((definition) => definition.name === name);
}

function toolSearchText(definition: ToolDefinition): string {
  return [definition.name, definition.description, ...(definition.sideEffects ?? [])].filter(Boolean).join('\n').toLowerCase();
}

function resolveToolName(toolRegistry: ToolRegistry, args: AgentPolicyExplainArgs): {
  readonly status: 'found' | 'ambiguous' | 'missing_lookup';
  readonly toolName?: string;
  readonly input?: string;
  readonly candidates?: readonly Record<string, unknown>[];
  readonly explicit?: boolean;
} {
  const explicit = readString(args.toolName) || readString(args.tool);
  if (explicit) return { status: 'found', toolName: explicit, input: explicit, explicit: true };
  const input = readString(args.target) || readString(args.query);
  if (!input) return { status: 'missing_lookup' };

  const definitions = toolRegistry.getToolDefinitions();
  const exact = definitions.find((definition) => definition.name === input);
  if (exact) return { status: 'found', toolName: exact.name, input, explicit: false };
  const lowered = input.toLowerCase();
  const insensitive = definitions.find((definition) => definition.name.toLowerCase() === lowered);
  if (insensitive) return { status: 'found', toolName: insensitive.name, input, explicit: false };
  const matches = definitions.filter((definition) => toolSearchText(definition).includes(lowered)).slice(0, 8);
  if (matches.length === 1) return { status: 'found', toolName: matches[0]!.name, input, explicit: false };
  if (matches.length > 1) {
    return {
      status: 'ambiguous',
      input,
      candidates: matches.map((definition) => ({
        toolName: definition.name,
        description: definition.description,
        modelRoute: `security action:"explain" toolName:"${definition.name}" toolArgs:{...}`,
      })),
    };
  }
  return { status: 'found', toolName: input, input, explicit: false };
}

function readConfigValue(context: CommandContext, key: string): unknown {
  try {
    const manager = context.platform.configManager as unknown as { get?: (key: string) => unknown };
    return manager.get?.(key);
  } catch {
    return undefined;
  }
}

function readPermissionMode(context: CommandContext): string {
  const configured = readString(readConfigValue(context, 'permissions.mode'));
  if (configured) return configured;
  const mode = context.platform.config?.permissions?.mode;
  return typeof mode === 'string' && mode ? mode : 'prompt';
}

function readAutoApprove(context: CommandContext): boolean {
  const configured = readConfigValue(context, 'behavior.autoApprove');
  if (typeof configured === 'boolean') return configured;
  return context.platform.config?.behavior?.autoApprove === true;
}

/**
 * Reads the SAME effective approval posture that cli/status.ts, the doctor
 * surface, and the footer read (via computeApprovalPosture), the shared
 * single source of truth, so this tool's "explain" output never disagrees
 * with what those other surfaces say about auto-approve / permission mode.
 */
function readEffectivePosture(context: CommandContext): ApprovalPosture {
  return context.platform.configManager ? readApprovalPostureFromConfig(context.platform.configManager) : computeApprovalPosture({ autoApprove: readAutoApprove(context), mode: readPermissionMode(context) });
}

type GatePreview = NonNullable<Awaited<ReturnType<ToolRegistry['previewDecision']>>>;

/** The gate's answer for the exact call, in the words a live call would get. */
function gateOutcome(preview: GatePreview | undefined): {
  readonly status: PolicyExplanationStatus;
  readonly reason: string;
  readonly next: readonly string[];
  readonly decision?: Record<string, unknown>;
} {
  if (!preview) {
    return { status: 'not_evaluated', reason: 'This tool registry has no permission owner, so the gate decides only when the call is made.', next: ['make the call; the gate decides it then'] };
  }
  const decided = preview.decided;
  if (decided.kind === 'fact') {
    return {
      status: decided.allow ? 'allowed' : 'denied',
      reason: decided.decision.reason,
      next: decided.decision.next ?? (decided.allow ? ['make the call'] : []),
      decision: { ...decided.decision, basis: decided.basis },
    };
  }
  if (decided.kind === 'owner-only') {
    return {
      status: 'owner_decides',
      reason: `This is the owner's to decide (${decided.item}). ${preview.mode === 'just-vibes'
        ? 'In just-vibes mode the call is queued for the owner and the work carries on.'
        : 'The owner is asked once when the call is made; his answer is remembered.'}`,
      next: ['make the call and let the gate ask the owner', 'carry on with work that does not need it'],
    };
  }
  return {
    status: 'decided_at_call',
    reason: 'No rule, mode or declaration settles this call: the decision model decides it when it is made (the owner, when no decision model works).',
    next: ['make the call; the gate decides it then'],
  };
}

function userExplanation(status: PolicyExplanationStatus, category: PermissionCategory, reason: string): string {
  if (status === 'allowed') return `This ${category} call runs without asking: ${reason}`;
  if (status === 'denied') return `This ${category} call is refused: ${reason}`;
  return reason;
}

export async function explainAgentPolicyDecision(
  context: CommandContext,
  toolRegistry: ToolRegistry,
  args: AgentPolicyExplainArgs,
  signal?: AbortSignal,
): Promise<AgentPolicyExplanationResolution> {
  const input = snapshotJudgmentInput(args) as AgentPolicyExplainArgs;
  const resolved = resolveToolName(toolRegistry, input);
  if (resolved.status === 'missing_lookup') {
    return {
      status: 'missing_lookup',
      usage: 'policy_explain requires toolName or a target/query matching one model tool.',
    };
  }
  if (resolved.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      input: resolved.input ?? '',
      candidates: resolved.candidates ?? [],
    };
  }

  const toolName = resolved.toolName!;
  const toolArgs = readToolArgs(input);
  const definition = findToolDefinition(toolRegistry, toolName);
  // The Agent's own route guard runs first on a live call; a denial there is final.
  const guard = explainAgentToolPolicyInvocation(toolName, toolArgs);
  // The gate's own classification of this exact call: mode, category, session answers, saved rules,
  // owner-only list and surface. Code only: no hook, prompt or model request.
  const preview = guard.status === 'denied' ? undefined : await toolRegistry.previewDecision(toolName, toolArgs, signal);
  const category: PermissionCategory = preview?.category ?? definition?.category ?? 'delegate';
  const gate = guard.status === 'denied'
    ? { status: 'denied' as const, reason: guard.reason, next: guard.allowedModes ? [`use one of these modes: ${guard.allowedModes.join(', ')}`] : [] }
    : gateOutcome(preview);
  const analysis = analyzePermissionRequest(toolName, toolArgs, category);
  // The overall approval posture, computed by the SAME shared helper that
  // cli/status.ts, the doctor surface, and the footer use, so this tool's
  // own displayed posture text can never disagree with theirs.
  const posture = readEffectivePosture(context);

  return {
    status: 'found',
    explanation: {
      status: gate.status,
      toolName,
      registered: definition !== undefined,
      category,
      userExplanation: userExplanation(gate.status, category, gate.reason),
      ...('decision' in gate && gate.decision ? { decision: gate.decision } : {}),
      next: gate.next,
      posture: {
        label: posture.label,
        autoApprove: posture.autoApprove,
        mode: preview?.mode ?? posture.mode,
        automaticApprovals: posture.automaticApprovals,
        bypassesPrompts: posture.bypassesPrompts,
        detail: posture.detail,
      },
      policyLayers: [
        {
          layer: 'Agent route guard',
          outcome: guard.status,
          reason: guard.reason,
          ...(guard.allowedModes ? { allowedModes: guard.allowedModes } : {}),
        },
        ...(preview ? [{
          layer: 'Permission gate',
          outcome: preview.decided.kind === 'fact' ? (preview.decided.allow ? 'allow' : 'deny') : preview.decided.kind,
          mode: preview.mode,
          reason: gate.reason,
        }] : []),
      ],
      analysis,
      preflight: {
        permissionEvaluated: preview !== undefined,
        outcome: gate.status,
      },
      toolArgs: redactArgs(toolArgs),
      routes: {
        explain: `security action:"explain" toolName:"${toolName}" toolArgs:{...}`,
        inspectTool: `agent_harness mode:"tool" toolName:"${toolName}" includeParameters:true`,
        permissions: 'workspace action:"actions" categoryId:"tools-permissions"',
        securityPosture: 'security action:"status" includeParameters:true',
      },
      notes: [
        'Nothing was run and nobody was asked: this is how the gate would decide this exact call now. A rule or mode change before the call changes the answer.',
        'confirm and explicitUserRequest grant nothing on any Agent tool; the gate decides every call.',
        'Secret-looking argument values are redacted in this explanation.',
      ],
      ...(input.includeParameters === true && definition ? {
        toolDefinition: {
          name: definition.name,
          description: definition.description,
          sideEffects: sideEffects(definition),
        },
      } : {}),
      ...(resolved.input ? { lookup: { input: resolved.input, explicit: resolved.explicit === true } } : {}),
    },
  };
}
