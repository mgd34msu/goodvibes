import { redactSensitiveData } from '../../utils/redaction.js';
import { withheldFieldKind } from '../../utils/field-kind-reading.js';
import type { AnyRuntimeEvent } from '../events/index.js';

/**
 * What the telemetry API's default (`safe`) view shows of a runtime event.
 *
 * Runtime event payloads are a fixed vocabulary (events/*.ts), so which of
 * their fields hold conversation or work content is declared here per field:
 * a prompt, a streamed chunk, a tool's arguments or output, a message body,
 * the owner's goal, a plan's titles. Those are withheld. Everything else
 * (tool, provider, model, ids, statuses, counts, durations, and error text) is
 * what an operator needs to see why something failed, so it is shown with
 * credential-shaped text masked and paths anonymised. Credential and
 * owner-profile fields are withheld whole. Local and deterministic: no model
 * request, one table lookup per field, and the same record reads the same on
 * every call.
 *
 * Every top-level event field that can carry free text or structure (a plain
 * string, an object or an array) must be classified, by name in
 * EVENT_FIELD_CLASS or for one event type in EVENT_FIELD_OVERRIDES: a field
 * added to an event without a classification is a compile error (see
 * `everyEventFieldClassified`). Literal unions, numbers and booleans never
 * carry content and need no entry.
 *
 * Nested values, span attributes and payloads that are not runtime events are
 * judged by name with CONTENT_FIELDS; a span attribute by the last segment of
 * its dotted name (`tool.args` is `args`).
 */
const CONTENT_FIELDS: ReadonlySet<string> = new Set([
  'prompt', 'content', 'accumulated', 'output', 'args', 'arguments', 'input', 'text', 'body', 'response',
  'reasoning', 'reasoningcontent', 'reasoningsummary', 'result', 'results', 'stdout', 'stderr', 'messages',
  'instructions', 'transcript', 'preview', 'snippet', 'diff', 'patch', 'excerpt', 'task', 'question', 'answer',
  'context', 'document', 'query', 'toolinput', 'tooloutput', 'completion', 'delta',
  'goal', 'taskdescription', 'notes', 'progress', 'quote', 'successcriteria', 'requiredevidence', 'title',
  'reasons', 'dispositionreason',
]);

/**
 * How the safe view treats one event field: shown (text masked), withheld
 * whole, or shown with the listed fields of the object (or of each element of
 * the array) withheld.
 */
type EventFieldClass = 'shown' | 'content' | { readonly withhold: readonly string[] };

type EventType = AnyRuntimeEvent['type'];
type EventOf<T extends EventType> = Extract<AnyRuntimeEvent, { type: T }>;
/** The fields of an event that can carry free text or structure. */
type FreeFields<E> = {
  [K in keyof E]-?: K extends 'type' ? never
    : string extends NonNullable<E[K]> ? K
      : NonNullable<E[K]> extends object ? K
        : never;
}[keyof E];

/** The class of an event field, by its name: the meaning a name has across the vocabulary. */
const EVENT_FIELD_CLASS = {
  accountId: 'shown',
  accumulated: 'content',
  action: 'shown',
  added: 'shown',
  affectedCapabilities: 'shown',
  agentId: 'shown',
  allowedHosts: 'shown',
  allowedPaths: 'shown',
  allowedTools: 'shown',
  args: 'content',
  artifactId: 'shown',
  ask: 'content',
  asksForAttempts: 'shown',
  authType: 'shown',
  // Jev's decision record: ids and bindings are shown; its summary may restate the call.
  autonomousDecision: { withhold: ['summary'] },
  availableTools: 'shown',
  bindingId: 'shown',
  body: 'content',
  branch: 'shown',
  callId: 'shown',
  callIds: 'shown',
  candidateIds: 'shown',
  candidates: 'shown',
  capabilities: 'shown',
  capability: 'shown',
  category: 'shown',
  changedFields: 'shown',
  checkId: 'shown',
  checkpoint: 'shown',
  checkpointId: 'shown',
  chosen: 'shown',
  classification: 'shown',
  clearedBy: 'shown',
  clientId: 'shown',
  clientIp: 'shown',
  code: 'shown',
  cohort: 'shown',
  connectorId: 'shown',
  content: 'content',
  contentSummary: 'content',
  contractId: 'shown',
  contractUnitId: 'shown',
  criteria: { withhold: ['text', 'quote', 'dispositionReason'] },
  criterionId: 'shown',
  criterionIds: 'shown',
  decisionId: 'shown',
  decisionIds: 'shown',
  deliveryId: 'shown',
  deniedTools: 'shown',
  description: 'content',
  detail: 'content',
  displayName: 'shown',
  endpoint: 'shown',
  error: 'shown',
  errorCode: 'shown',
  errorMessage: 'shown',
  escalationId: 'shown',
  eventType: 'shown',
  excessScopes: 'shown',
  externalId: 'shown',
  extractionId: 'shown',
  files: 'shown',
  finishReason: 'shown',
  forbidsDelegation: 'shown',
  forbidsWriting: 'shown',
  format: 'shown',
  from: 'shown',
  fromId: 'shown',
  fromRole: 'shown',
  gate: 'shown',
  gateProblems: 'shown',
  gates: 'shown',
  goal: 'content',
  groupId: 'shown',
  groups: { withhold: ['title'] },
  hash: 'shown',
  hunkHeader: 'shown',
  inputs: { withhold: ['taskDescription'] },
  jobId: 'shown',
  key: 'shown',
  kinds: 'shown',
  knowledgeSpaceId: 'shown',
  label: 'shown',
  listenerId: 'shown',
  message: 'shown',
  messageId: 'shown',
  metAtCheckId: 'shown',
  metadata: 'shown',
  mode: 'shown',
  model: 'shown',
  modelId: 'shown',
  name: 'shown',
  nodeId: 'shown',
  note: 'shown',
  nudgeId: 'shown',
  occurrenceId: 'shown',
  operatorId: 'shown',
  orchestrationGraphId: 'shown',
  origin: { withhold: ['metadata'] },
  originCallId: 'shown',
  originHook: 'shown',
  originMcpServer: 'shown',
  originTool: 'shown',
  output: 'content',
  ownerAgentId: 'shown',
  panelId: 'shown',
  parentAgentId: 'shown',
  parentId: 'shown',
  parentNodeId: 'shown',
  path: 'shown',
  phase: 'shown',
  playbooks: 'shown',
  pluginId: 'shown',
  policyId: 'shown',
  preset: 'shown',
  previous: 'shown',
  previousMode: 'shown',
  previousPreset: 'shown',
  previousTask: { withhold: ['title', 'notes'] },
  principalId: 'shown',
  problems: { withhold: ['message'] },
  profileId: 'shown',
  progress: 'content',
  projectId: 'shown',
  prompt: 'content',
  promptSummary: 'content',
  protocol: 'shown',
  provider: 'shown',
  providerBatchId: 'shown',
  providerRequestId: 'shown',
  quality: 'shown',
  qualityGrade: 'shown',
  question: 'content',
  rateLimit: 'shown',
  // Which sign-in answered (subscription or API key) and the failure that moved it: provider status text, never content.
  signIn: 'shown',
  reason: 'shown',
  reasonCode: 'shown',
  reasoning: 'content',
  reasons: 'content',
  registryKey: 'shown',
  removed: 'shown',
  replyTargetId: 'shown',
  reportId: 'shown',
  requestedStrategy: 'shown',
  requestsParallelAgents: 'shown',
  response: 'content',
  result: { withhold: ['preview'] },
  riskLevel: 'shown',
  route: 'shown',
  ruleId: 'shown',
  runId: 'shown',
  safetyCheckpointId: 'shown',
  scopes: 'shown',
  sectionsIncluded: 'shown',
  serverId: 'shown',
  sessionId: 'shown',
  sleepEdgeNote: 'shown',
  source: 'shown',
  sourceId: 'shown',
  sourceLayer: 'shown',
  sourceType: 'shown',
  status: 'shown',
  strategy: 'shown',
  strategyFallbackReason: 'shown',
  streamId: 'shown',
  streamType: 'shown',
  subscriberId: 'shown',
  subscriptionId: 'shown',
  summary: 'content',
  surfaceId: 'shown',
  targetId: 'shown',
  task: 'content',
  taskContract: { withhold: ['successCriteria', 'requiredEvidence'] },
  taskId: 'shown',
  threadId: 'shown',
  title: 'content',
  to: 'shown',
  toId: 'shown',
  toRole: 'shown',
  tokenId: 'shown',
  tool: 'shown',
  toolCalls: { withhold: ['arguments'] },
  toolNames: 'shown',
  topics: 'shown',
  transport: 'shown',
  transportId: 'shown',
  tripwire: 'shown',
  turnId: 'shown',
  unitId: 'shown',
  unitIds: 'shown',
  units: { withhold: ['title'] },
  unmetCriterionIds: 'shown',
  updated: 'shown',
  uri: 'shown',
  url: 'shown',
  usage: 'shown',
  username: 'shown',
  usernameAttempted: 'shown',
  value: 'shown',
  version: 'shown',
  watcherId: 'shown',
  workPlanId: 'shown',
  workReasons: 'shown',
  workingDir: 'shown',
} as const satisfies Readonly<Record<string, EventFieldClass>>;

/** Where a field name means something else on one event type. */
const EVENT_FIELD_OVERRIDES = {
  // Fleet node labels are unit titles, agent tasks and command lines.
  FLEET_NODE_STARTED: { label: 'content' },
  FLEET_NODE_STATE_CHANGED: { label: 'content' },
  FLEET_NODE_FINISHED: { label: 'content' },
  FLEET_NODE_BLOCKED_ON_USER: { label: 'content' },
  FLEET_NODE_UNBLOCKED: { label: 'content' },
  // A companion message's metadata comes from the sender.
  COMPANION_MESSAGE_RECEIVED: { metadata: 'content' },
  // The quarantine detail names the schema problem, not content.
  MCP_SCHEMA_QUARANTINED: { detail: 'shown' },
  // Work-plan task records: ids and status are shown, the owner's words are not.
  WORK_PLAN_TASK_CREATED: { task: { withhold: ['title', 'notes'] } },
  WORK_PLAN_TASK_UPDATED: { task: { withhold: ['title', 'notes'] } },
  WORK_PLAN_TASK_STATUS_CHANGED: { task: { withhold: ['title', 'notes'] } },
  WORK_PLAN_TASK_DELETED: { task: { withhold: ['title', 'notes'] } },
  // Authority record changes name entries by kind and id, never a value.
  AUTHORITY_CHANGED: { ids: 'shown', cascade: 'shown', origin: 'shown' },
} as const satisfies { readonly [T in EventType]?: { readonly [K in FreeFields<EventOf<T>>]?: EventFieldClass } };

type ClassifiedFields<T extends EventType> = keyof typeof EVENT_FIELD_CLASS
  | (T extends keyof typeof EVENT_FIELD_OVERRIDES ? keyof (typeof EVENT_FIELD_OVERRIDES)[T] : never);
/** `EVENT_TYPE.field` for every free-text or structured field nothing classifies. */
type UnclassifiedEventFields = {
  [T in EventType]: Exclude<FreeFields<EventOf<T>>, ClassifiedFields<T>> extends infer K
    ? K extends string ? `${T}.${K}` : never
    : never;
}[EventType];
/** A compile error naming each unclassified field: classify it above. */
const everyEventFieldClassified: [UnclassifiedEventFields] extends [never] ? true : UnclassifiedEventFields = true;
void everyEventFieldClassified;

const FIELD_CLASS_BY_NAME: Readonly<Record<string, EventFieldClass>> = EVENT_FIELD_CLASS;
const FIELD_CLASS_OVERRIDES: Readonly<Record<string, Readonly<Record<string, EventFieldClass>>>> = EVENT_FIELD_OVERRIDES;

function eventFieldClass(eventType: string, key: string): EventFieldClass | undefined {
  const overrides = Object.hasOwn(FIELD_CLASS_OVERRIDES, eventType) ? FIELD_CLASS_OVERRIDES[eventType] : undefined;
  if (overrides && Object.hasOwn(overrides, key)) return overrides[key];
  return Object.hasOwn(FIELD_CLASS_BY_NAME, key) ? FIELD_CLASS_BY_NAME[key] : undefined;
}

const WITHHELD_TEXT = '[REDACTED_TEXT]';

function fieldName(key: string): string {
  const lastSegment = key.slice(key.lastIndexOf('.') + 1);
  return lastSegment.replace(/[_-]/g, '').toLowerCase();
}

/** Whether a payload or span attribute field carries content the safe view withholds. */
export function isTelemetryContentField(key: string): boolean {
  return CONTENT_FIELDS.has(fieldName(key));
}

/** Free text an operator reads (an error, a reason, a status), with credential-shaped spans masked. */
export function safeTelemetryText(text: string): string {
  return text.length === 0 ? text : redactSensitiveData(text);
}

function withheldValue(child: unknown): unknown {
  return child === null || child === undefined || child === '' || typeof child === 'number' || typeof child === 'boolean'
    ? child
    : WITHHELD_TEXT;
}

/**
 * `withhold` names fields of this object (or of each element of this array)
 * that an event's classification withholds; `eventType` is set only for the
 * top level of a runtime event payload.
 */
function safeValue(value: unknown, seen: WeakSet<object>, withhold?: readonly string[], eventType?: string): unknown {
  if (typeof value === 'string') return safeTelemetryText(value);
  if (value === null || typeof value !== 'object') return typeof value === 'function' || typeof value === 'symbol' ? undefined : value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => safeValue(item, seen, withhold));
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const withheld = withheldFieldKind(fieldName(key));
      const declared = eventType !== undefined ? eventFieldClass(eventType, key) : undefined;
      if (withheld === 'secret') {
        result[key] = child === null || child === undefined || typeof child === 'boolean' || child === '' ? child : '[REDACTED]';
      } else if (withheld === 'owner_profile') {
        result[key] = '[REDACTED_PROFILE]';
      } else if (withhold?.includes(key) || declared === 'content' || (declared === undefined && isTelemetryContentField(key))) {
        result[key] = withheldValue(child);
      } else if (declared !== undefined && declared !== 'shown') {
        result[key] = safeValue(child, seen, declared.withhold);
      } else {
        result[key] = safeValue(child, seen);
      }
    }
    return result;
  } finally {
    seen.delete(value);
  }
}

/** The safe view of a span's attributes or a payload that is not a runtime event. */
export function projectSafeTelemetryValue(value: unknown): unknown {
  return safeValue(value, new WeakSet());
}

/** The safe view of a runtime event payload, read with its event type's field classes. */
export function projectSafeTelemetryEventPayload(eventType: string, payload: unknown): unknown {
  return safeValue(payload, new WeakSet(), undefined, eventType);
}
