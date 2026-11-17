import type { ToolDefinition } from '../../types/tools.js';
import type { ExecutionIntent } from '../../runtime/execution-intents.js';
import { REASONING_EFFORT_SEVERITY } from '../../providers/reasoning-effort.js';

/** The agent tool's definition as written; {@link AGENT_TOOL_SCHEMA} adds the per-field notes from the field rules. */
const AGENT_TOOL_DEFINITION: ToolDefinition = {
  name: 'agent',
  activity: {
    doing: 'Running', did: 'ran', object: 'an agent', objects: 'agents',
    byAction: {
      read: { doing: 'Checking', did: 'checked', object: 'agents' },
      send: { doing: 'Messaging', did: 'messaged', object: 'an agent', objects: 'agents' },
      delete: { doing: 'Stopping', did: 'stopped', object: 'an agent', objects: 'agents' },
    },
  },
  // Sent in full on every model request (see ToolDefinition.core).
  core: true,
  description:
    'Manages in-process subagents. Modes: spawn (create a new agent task), ' +
    'batch-spawn (hand several tasks over at once: the tasks without outsideContract become the proposed units of one contract, and tasks with outsideContract run as separate agents), ' +
    'status (check agent progress by ID), cancel (stop a running agent), ' +
    'list (show all agents and their status), ' +
    'templates (list available agent templates with default tool sets), ' +
    'get (detailed agent info including messages), ' +
    'budget (token usage for an agent), ' +
    'plan (execution plan: task + template + tools), ' +
    'wait (returns current status immediately if terminal, or waits up to timeoutMs, returning as soon as the agent ends; one wait is capped at contract.heartbeatTimeoutMs, default 10 minutes, and says so when it was), ' +
    'message (send a message to an agent), ' +
    'contracts (list the contracts of the current session with their status, goal, units and criteria met), ' +
    'contract-history (the decisions, checks and escalations of one contract, by contractId), ' +
    'cohort-status (JSON summary of all agents in a named cohort), ' +
    'cohort-report (markdown table report for all agents in a named cohort).' +
    ' A team is a cohort: spawn its members with one cohort name, each with its template as its role and its communicationLane, brief each with context and successCriteria, and track the work items in the work plan; cohort-status and cohort-report read the team back, and the fleet view shows the cohort on each agent.' +
    ' Discovery: use mode=list to see all agents and their status, mode=templates to see available agent templates. ' +
    'Work handed to this tool with mode=spawn or batch-spawn runs as a contract: a planner splits it into units, and each unit is checked against its acceptance criteria while it works and told what to fix until it passes. ' +
    'The result carries contractStarted, contractId and the owner agent id; the owner agent reports the contract\'s answer when it ends. ' +
    'Use contracts for requested deliverables and work with multiple functional parts: their criteria link each part to the original objective, and the host checks completed parts before integration. ' +
    'Set outsideContract only for a bounded helper whose complete result can be checked as one part. Standalone agents still require native Jev completion and output checks. ' +
    'Do not use outsideContract to avoid a rejected plan or move the same unfinished work past its required checks.',
  sideEffects: ['agent', 'workflow', 'state'],
  concurrency: 'serial',
  supportsProgress: true,
  parameters: {
    type: 'object',
    required: ['mode'],
    properties: {
      mode: {
        type: 'string',
        enum: ['spawn', 'batch-spawn', 'status', 'cancel', 'list', 'templates', 'get', 'budget', 'plan', 'wait', 'message', 'contracts', 'contract-history', 'cohort-status', 'cohort-report'],
        description: 'Operation mode.',
      },
      // mode: spawn
      task: {
        type: 'string',
        description: 'Task description (mode: spawn). Without outsideContract it becomes the proposed unit of a new contract; with outsideContract it is the agent\'s own task. Describe the deliverable itself.',
      },
      template: {
        type: 'string',
        enum: ['orchestrator', 'planner', 'engineer', 'reviewer', 'tester', 'researcher', 'integrator', 'general'],
        description:
          'Agent template to use (mode: spawn). Default: general. ' +
          'Each template includes a pre-selected tool set.',
      },
      model: {
        type: 'string',
        description: 'Model for the spawned agent (mode: spawn). A bare model id (e.g. "claude-fable-5") resolves automatically; use the provider:model form only when the id exists on more than one provider.',
      },
      provider: {
        type: 'string',
        description: 'Provider override for the spawned agent (mode: spawn).',
      },
      fallbackModels: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered models to try if the primary model fails (mode: spawn). Bare ids resolve automatically, same as model.',
      },
      executionIntent: {
        type: 'object',
        properties: {
          riskClass: {
            type: 'string',
            enum: ['safe', 'elevated', 'dangerous'],
            description: 'Execution risk classification hint for downstream policy/evaluation surfaces.',
          },
          requiresApproval: {
            type: 'boolean',
            description: 'Whether the spawned agent should be treated as requiring approval-sensitive execution.',
          },
          networkPolicy: {
            type: 'string',
            enum: ['inherit', 'allow', 'deny', 'scoped'],
            description: 'Requested network posture for downstream execution surfaces.',
          },
          filesystemPolicy: {
            type: 'string',
            enum: ['inherit', 'workspace-write', 'read-only', 'isolated'],
            description: 'Requested filesystem posture for downstream execution surfaces.',
          },
        },
        additionalProperties: false,
        description: 'Explicit execution-intent hints for policy-aware runtimes (mode: spawn).',
      },
      reasoningEffort: {
        type: 'string',
        enum: [...REASONING_EFFORT_SEVERITY],
        description: 'Reasoning effort override for providers/models that support it (mode: spawn). Which levels the spawned agent\'s model actually accepts is per-model.',
      },
      tools: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Explicit tool subset for the agent (mode: spawn). ' +
          'Defaults to template defaults. The "agent" tool is never included.',
      },
      context: {
        type: 'string',
        description: 'Additional context to provide to the spawned agent (mode: spawn). On a contract it is passed only as continuation evidence, not as a requirement.',
      },
      successCriteria: {
        type: 'array',
        items: { type: 'string' },
        description: 'Concrete success criteria the spawned agent must satisfy (mode: spawn).',
      },
      requiredEvidence: {
        type: 'array',
        items: { type: 'string' },
        description: 'Evidence the spawned agent must return before completion (mode: spawn).',
      },
      writeScope: {
        type: 'array',
        items: { type: 'string' },
        description: 'Expected file or path scope for writes owned by the spawned agent (mode: spawn).',
      },
      executionProtocol: {
        type: 'string',
        enum: ['direct', 'gather-plan-apply'],
        description: 'Execution discipline the spawned agent should follow (mode: spawn). Default: gather-plan-apply.',
      },
      reviewMode: {
        type: 'string',
        enum: ['none', 'contract'],
        description: 'Whether the agent uses contract unit checks (mode: spawn). Default: contract, or none when outsideContract is set. Mandatory Jev completion and output checks apply in either mode.',
      },
      communicationLane: {
        type: 'string',
        enum: ['parent-only', 'parent-and-children', 'cohort', 'direct'],
        description: 'Permitted communication lane for the spawned agent (mode: spawn). Default: parent-only for children, direct for root workers.',
      },
      parentAgentId: {
        type: 'string',
        description: 'Parent agent whose capability ceiling and communication lane this worker inherits (mode: spawn).',
      },
      orchestrationGraphId: {
        type: 'string',
        description: 'Explicit orchestration graph id to attach the spawned worker to (mode: spawn).',
      },
      orchestrationNodeId: {
        type: 'string',
        description: 'Explicit orchestration node id for the spawned worker (mode: spawn).',
      },
      parentNodeId: {
        type: 'string',
        description: 'Parent orchestration node id for the spawned worker (mode: spawn).',
      },
      restrictTools: {
        type: 'boolean',
        description:
          'If true, use ONLY the specified tools (override mode). ' +
          'If false or omitted, specified tools are merged with template defaults (additive mode). ' +
          'Only applies when tools is also provided (mode: spawn).',
        default: false,
      },
      outsideContract: {
        type: 'boolean',
        description: 'If true, run a bounded helper directly instead of using contract units (mode: spawn, batch-spawn). Native Jev completion and output checks remain mandatory. Use the default contract for requested deliverables or multi-part work. Default: false.',
        default: false,
      },
      // mode: batch-spawn
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          required: ['task'],
          properties: {
            task: { type: 'string', description: 'Task description for the agent.' },
            template: { type: 'string', enum: ['orchestrator', 'planner', 'engineer', 'reviewer', 'tester', 'researcher', 'integrator', 'general'], description: 'Agent template.' },
            model: { type: 'string', description: 'Model for this task. A bare model id resolves automatically; use provider:model only when the id exists on more than one provider.' },
            provider: { type: 'string', description: 'Provider override.' },
            fallbackModels: { type: 'array', items: { type: 'string' }, description: 'Ordered models to try if the primary model fails. Bare ids resolve automatically.' },
            executionIntent: {
              type: 'object',
              properties: {
                riskClass: { type: 'string', enum: ['safe', 'elevated', 'dangerous'], description: 'Execution risk classification hint.' },
                requiresApproval: { type: 'boolean', description: 'Whether approval-sensitive execution is required.' },
                networkPolicy: { type: 'string', enum: ['inherit', 'allow', 'deny', 'scoped'], description: 'Requested network posture.' },
                filesystemPolicy: { type: 'string', enum: ['inherit', 'workspace-write', 'read-only', 'isolated'], description: 'Requested filesystem posture.' },
              },
              additionalProperties: false,
              description: 'Explicit execution-intent hints for downstream runtimes.',
            },
            reasoningEffort: { type: 'string', enum: [...REASONING_EFFORT_SEVERITY], description: 'Reasoning effort override.' },
            tools: { type: 'array', items: { type: 'string' }, description: 'Tool subset.' },
            restrictTools: { type: 'boolean', description: 'If true, use ONLY the specified tools (override mode). Default: false.' },
            context: { type: 'string', description: 'Additional context.' },
            successCriteria: { type: 'array', items: { type: 'string' }, description: 'Concrete success criteria.' },
            requiredEvidence: { type: 'array', items: { type: 'string' }, description: 'Evidence the spawned agent must return.' },
            writeScope: { type: 'array', items: { type: 'string' }, description: 'Expected write ownership scope.' },
            executionProtocol: { type: 'string', enum: ['direct', 'gather-plan-apply'], description: 'Execution discipline.' },
            reviewMode: { type: 'string', enum: ['none', 'contract'], description: 'Whether the work is checked as a contract.' },
            communicationLane: { type: 'string', enum: ['parent-only', 'parent-and-children', 'cohort', 'direct'], description: 'Permitted communication lane.' },
            parentAgentId: { type: 'string', description: 'Parent agent to inherit capability ceiling from.' },
            orchestrationGraphId: { type: 'string', description: 'Graph id to attach the worker to.' },
            orchestrationNodeId: { type: 'string', description: 'Explicit node id for the worker.' },
            parentNodeId: { type: 'string', description: 'Parent node id for the worker.' },
            outsideContract: { type: 'boolean', description: 'Run a bounded helper as a standalone agent with mandatory Jev completion/output checks, instead of contract units. Default: the batch\'s outsideContract.' },
          },
        },
        description: 'Tasks to hand over at once (mode: batch-spawn). Max 20. The tasks without outsideContract become the proposed units of one contract, whose planner decides the units that run; tasks with outsideContract run as separate agents, up to the active-agent cap.',
      },
      // mode: spawn, batch-spawn, list, cohort-status, cohort-report
      cohort: {
        type: 'string',
        description: 'Cohort name to group agents together (mode: spawn, batch-spawn; applies to agents run with outsideContract=true, not to a contract\'s owner). Filter by cohort (mode: list, cohort-status, cohort-report).',
      },
      // mode: status / cancel / get / budget / plan / wait / message
      agentId: {
        type: 'string',
        description: 'Agent ID to query, cancel, get, budget, plan, wait, or message (mode: status, cancel, get, budget, plan, wait, message).',
      },
      detail: {
        type: 'string',
        enum: ['summary', 'contract', 'messages', 'full'],
        description: 'Detail level for inspection/reporting modes. Summary keeps the core execution state; contract adds capability/ownership data; messages adds recent bus traffic; full returns everything.',
      },
      // mode: wait
      timeoutMs: {
        type: 'number',
        description: 'Timeout in milliseconds for the wait action (mode: wait). Default: 0 (non-blocking, returns immediately). Returns as soon as the agent ends. One wait is capped at contract.heartbeatTimeoutMs (default 600000, 10 minutes; 30 minutes when that is 0); a reduced wait reports requestedMs and limitMs. If the agent is still running at the timeout, returns its current status with waitedMs and a hint to wait again.',
      },
      // mode: message
      message: {
        type: 'string',
        description: 'Message content to send to an agent (mode: message). Sent to the id a delegation returned (a contract), it goes to the agents working that contract\'s units now, and the result lists them.',
      },
      kind: {
        type: 'string',
        enum: ['directive', 'status', 'question', 'finding', 'review', 'handoff', 'escalation', 'completion'],
        description: 'Structured communication kind for the message (mode: message). Default: directive.',
      },
      // mode: contracts
      includeTerminal: {
        type: 'boolean',
        description: 'Include contracts that already ended (mode: contracts). Default: true.',
      },
      // mode: contract-history
      contractId: {
        type: 'string',
        description: 'The contract to read (mode: contract-history).',
      },
    },
  },
};

/**
 * How the agent tool treats an input field the model does not simply set:
 * - `host-stamped`: the host writes it after the model's call (the model's own value is replaced), so the model is not offered it;
 * - `host-only`: only the composition sets it; a model's value is removed;
 * - `contract-fence`: a limit on a worker's authority, refused unless `outsideContract` is set, because a contract's planner chooses it per unit;
 * - `standalone-only`: honoured only with `outsideContract`; on a contract it is reported back as not applied.
 * The one table: the schema, the stripping, the refusal and the not-applied report all read it.
 */
export type AgentInputFieldRule = 'host-stamped' | 'host-only' | 'contract-fence' | 'standalone-only';
export const AGENT_INPUT_FIELD_RULES = {
  authoritativeTask: 'host-stamped',
  captureAuthority: 'host-only', systemPromptAddendum: 'host-only', proposedUnits: 'host-only',
  replyStyle: 'host-only', workingDirectory: 'host-only', routing: 'host-only', sessionId: 'host-only',
  tools: 'contract-fence', restrictTools: 'contract-fence', writeScope: 'contract-fence', executionIntent: 'contract-fence',
  model: 'standalone-only', provider: 'standalone-only', fallbackModels: 'standalone-only', reasoningEffort: 'standalone-only',
  successCriteria: 'standalone-only', requiredEvidence: 'standalone-only', executionProtocol: 'standalone-only',
  reviewMode: 'standalone-only', communicationLane: 'standalone-only', orchestrationGraphId: 'standalone-only',
  orchestrationNodeId: 'standalone-only', parentNodeId: 'standalone-only', cohort: 'standalone-only',
} as const satisfies Partial<Record<keyof AgentInput, AgentInputFieldRule>>;

/** The fields under one rule. */
export function agentInputFields(rule: AgentInputFieldRule): (keyof AgentInput)[] {
  return (Object.keys(AGENT_INPUT_FIELD_RULES) as (keyof typeof AGENT_INPUT_FIELD_RULES)[])
    .filter((key) => AGENT_INPUT_FIELD_RULES[key] === rule);
}

const FIELD_RULE_NOTES: Partial<Record<AgentInputFieldRule, string>> = {
  'contract-fence': ' Needs outsideContract=true: on a contract this is refused, because the contract planner chooses the tools and write scope of each unit.',
  'standalone-only': ' Applies only with outsideContract=true; without it the work runs as a contract and this is not carried.',
};

/** The model-facing schema: host fields left out, and each fenced or standalone-only field (top level and in `tasks`) carrying its note. */
function withFieldRuleNotes(definition: ToolDefinition): ToolDefinition {
  const annotate = (properties: Record<string, Record<string, unknown>>): Record<string, Record<string, unknown>> => Object.fromEntries(
    Object.entries(properties).flatMap(([key, property]) => {
      const rule = (AGENT_INPUT_FIELD_RULES as Partial<Record<string, AgentInputFieldRule>>)[key];
      if (rule === 'host-stamped' || rule === 'host-only') return [];
      const note = rule === undefined ? undefined : FIELD_RULE_NOTES[rule];
      return [[key, note && typeof property.description === 'string' && !property.description.includes('outsideContract') ? { ...property, description: property.description + note } : property]];
    }),
  );
  const parameters = definition.parameters as { properties: Record<string, Record<string, unknown>> } & Record<string, unknown>;
  const tasks = parameters.properties.tasks as { items: { properties: Record<string, Record<string, unknown>> } & Record<string, unknown> } & Record<string, unknown>;
  return {
    ...definition,
    hostArguments: [...agentInputFields('host-stamped'), ...agentInputFields('host-only')],
    parameters: {
      ...parameters,
      properties: {
        ...annotate(parameters.properties),
        tasks: { ...tasks, items: { ...tasks.items, properties: annotate(tasks.items.properties) } },
      },
    },
  };
}

/**
 * JSON Schema for the agent tool's input.
 * Manages in-process subagents: spawn, status, cancel, list, templates.
 */
export const AGENT_TOOL_SCHEMA: ToolDefinition = withFieldRuleNotes(AGENT_TOOL_DEFINITION);

export interface AgentProviderRoutingPolicy {
  providerSelection?: 'inherit-current' | 'concrete' | 'synthetic' | undefined;
  providerFailurePolicy?: 'ordered-fallbacks' | 'fail' | undefined;
  fallbackModels?: readonly string[] | undefined;
}

/** A unit proposed for a contract: a task and the template it asked for. The contract's planner weighs it. */
export interface ProposedUnit {
  readonly task: string;
  readonly template?: string | undefined;
}

/** Input shape for the agent tool. */
export interface AgentInput {
  mode: 'spawn' | 'batch-spawn' | 'status' | 'cancel' | 'list' | 'templates' | 'get' | 'budget' | 'plan' | 'wait' | 'message' | 'contracts' | 'contract-history' | 'cohort-status' | 'cohort-report';
  // spawn
  task?: string | undefined;
  authoritativeTask?: string | undefined;
  template?: string | undefined;
  model?: string | undefined;
  provider?: string | undefined;
  fallbackModels?: string[] | undefined;
  routing?: AgentProviderRoutingPolicy | undefined;
  executionIntent?: ExecutionIntent | undefined;
  reasoningEffort?: string | undefined;
  tools?: string[] | undefined;
  restrictTools?: boolean | undefined;
  context?: string | undefined;
  /**
   * Internal: the write authority to bind this run's `profile` capture tool to.
   * Set by the composition root from the turn's channel, never by model output,
   * see personal-capture/authority.ts. Deliberately absent from the tool's own
   * JSON schema so a model cannot ask for it.
   */
  captureAuthority?: import('../../personal-capture/index.js').CaptureAuthorityDecision | undefined;
  /** Internal: text appended verbatim to the spawned agent's system prompt. */
  systemPromptAddendum?: string | undefined;
  /** Internal: units proposed for the contract this spawn starts, carried to its owner and weighed by the planner. */
  proposedUnits?: readonly ProposedUnit[] | undefined;
  /**
   * Internal: the conversation session that started this agent, stamped by the
   * host (the agent tool from its own session, a contract from its session).
   * What a session's model and transcript are told about agents is scoped to it.
   */
  sessionId?: string | undefined;
  successCriteria?: string[] | undefined;
  requiredEvidence?: string[] | undefined;
  writeScope?: string[] | undefined;
  executionProtocol?: 'direct' | 'gather-plan-apply' | undefined;
  reviewMode?: 'none' | 'contract' | undefined;
  communicationLane?: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct' | undefined;
  parentAgentId?: string | undefined;
  orchestrationGraphId?: string | undefined;
  orchestrationNodeId?: string | undefined;
  parentNodeId?: string | undefined;
  outsideContract?: boolean | undefined;
  /**
   * What the caller wants the agent's final message to LOOK like.
   *
   * - 'report'         (default) The structured completion report, plus its
   *                    prose Summary/Changes/Decisions/Issues/Uncertainties
   *                    sections.
   * - 'conversational' A reply to a person. No completion report, no section
   *                    headings, no template, just the answer.
   *
   * Set by the conversation-first gate, which already knows an inbound channel
   * message is conversation rather than work. Deliberately NOT in the agent
   * tool's JSON schema: it is a decision the platform makes about a spawn, not
   * a knob a model may turn to opt out of reporting on real work.
   */
  replyStyle?: 'report' | 'conversational' | undefined;
  /**
   * Overrides this spawn's tool working directory (absolute path), e.g. an
   * orchestration-engine item's dedicated git worktree in `worktree`
   * isolation mode (see platform/orchestration/worktree-isolation.ts).
   * Omitted ⇒ the orchestrator's default working directory, exactly as
   * before this field existed. Internal, not part of any user-facing agent
   * template surface.
   */
  workingDirectory?: string | undefined;
  // cohort grouping
  cohort?: string | undefined;
  // batch-spawn
  tasks?: Array<{
    task: string;
    template?: string | undefined;
    model?: string | undefined;
    provider?: string | undefined;
    fallbackModels?: string[] | undefined;
    routing?: AgentProviderRoutingPolicy | undefined;
    executionIntent?: ExecutionIntent | undefined;
    reasoningEffort?: string | undefined;
    tools?: string[] | undefined;
    restrictTools?: boolean | undefined;
    context?: string | undefined;
    successCriteria?: string[] | undefined;
    requiredEvidence?: string[] | undefined;
    writeScope?: string[] | undefined;
    executionProtocol?: 'direct' | 'gather-plan-apply' | undefined;
    reviewMode?: 'none' | 'contract' | undefined;
    communicationLane?: 'parent-only' | 'parent-and-children' | 'cohort' | 'direct' | undefined;
    parentAgentId?: string | undefined;
    orchestrationGraphId?: string | undefined;
    orchestrationNodeId?: string | undefined;
    parentNodeId?: string | undefined;
    outsideContract?: boolean | undefined;
  }>;
  // status / cancel / get / budget / plan / wait / message
  agentId?: string | undefined;
  detail?: 'summary' | 'contract' | 'messages' | 'full' | undefined;
  // wait
  timeoutMs?: number | undefined;
  // message
  message?: string | undefined;
  kind?: 'directive' | 'status' | 'question' | 'finding' | 'review' | 'handoff' | 'escalation' | 'completion' | undefined;
  // contracts: whether ended contracts are listed
  includeTerminal?: boolean | undefined;
  // contract-history: the contract to read
  contractId?: string | undefined;
}
