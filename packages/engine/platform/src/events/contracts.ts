/**
 * The runtime event validator: `validateKnownEvent` checks an event payload
 * (the object with its `type`, not the envelope around it) against the rules
 * for its type.
 *
 * The event unions in this directory are the one description of each event.
 * The rules here are bound to them by the compiler: every rule table must name
 * every required field of its event and may name only fields the event has,
 * and an optional field is marked `optional: true` exactly when the event
 * declares it optional. Adding, removing or renaming a field of a registered
 * event therefore fails to compile until its rules say the same thing.
 */
export {
  type ContractResult,
  type FieldKind,
  type FieldSpec,
  validateEventFields,
  isString,
  isNumber,
  isBoolean,
  isObject,
} from './contracts/shared.js';

import { isObject, isString, validateEventFields, type ContractResult, type FieldKind, type FieldSpec } from './contracts/shared.js';
import type { AnyRuntimeEvent, RuntimeEventPayload } from './domain-map.js';
import { AUTOMATION_RUN_OUTCOMES, AUTOMATION_SCHEDULE_KINDS } from './automation.js';
import { ROUTE_SURFACE_KINDS, ROUTE_TARGET_KINDS } from './routes.js';
import { CONTROL_PLANE_CLIENT_KINDS, CONTROL_PLANE_PRINCIPAL_KINDS, CONTROL_PLANE_TRANSPORT_KINDS } from './control-plane.js';
import { DELIVERY_KINDS } from './deliveries.js';
import { WATCHER_SOURCE_KINDS } from './watchers.js';
import { SURFACE_KINDS } from './surfaces.js';
import { CONTRACT_EVENT_VALIDATORS } from './contracts/contract-runner.js';
import { GATE_EVENT_VALIDATORS } from './contracts/gate.js';

export { CONTRACT_EVENT_FIELD_SPECS, CONTRACT_EVENT_VALIDATORS } from './contracts/contract-runner.js';
export { GATE_EVENT_FIELD_SPECS, GATE_EVENT_VALIDATORS } from './contracts/gate.js';

type EventTypeName = AnyRuntimeEvent['type'];

/** The keys an event declares optional. */
type OptionalKey<E> = { [K in keyof E]-?: object extends Pick<E, K> ? K : never }[keyof E];

/** How one field is checked; `key` comes from the table it sits in. */
interface FieldRule {
  readonly kind: FieldKind;
  readonly values?: readonly string[] | undefined;
  readonly fields?: readonly FieldSpec[] | undefined;
}

/**
 * The rules for one event, keyed by field: every required field of the event
 * must appear, an optional one may, and nothing else can.
 */
type EventFieldRules<E> =
  & { readonly [K in Exclude<keyof E, 'type' | OptionalKey<E>>]-?: FieldRule & { readonly optional?: never } }
  & { readonly [K in Exclude<OptionalKey<E>, 'type'>]?: FieldRule & { readonly optional: true } };

/** One registered event: its type and the field specs its rules produce. */
function rules<T extends EventTypeName>(type: T, fields: EventFieldRules<RuntimeEventPayload<T>>): readonly [T, readonly FieldSpec[]] {
  return [type, Object.entries(fields as Record<string, FieldRule & { optional?: true }>).map(([key, rule]) => ({ key, ...rule }))];
}

const str = { kind: 'string' } as const;
const num = { kind: 'number' } as const;
const bool = { kind: 'boolean' } as const;
const strs = { kind: 'string[]' } as const;
const obj = { kind: 'object' } as const;
const optStr = { kind: 'string', optional: true } as const;
const optNum = { kind: 'number', optional: true } as const;
const optBool = { kind: 'boolean', optional: true } as const;
const optObj = { kind: 'object', optional: true } as const;
const oneOf = (values: readonly string[]) => ({ kind: 'enum', values }) as const;

const routeSurface = oneOf(ROUTE_SURFACE_KINDS);
const surfaceKind = oneOf(SURFACE_KINDS);
const watcherSource = oneOf(WATCHER_SOURCE_KINDS);

const delivery = { deliveryId: str, jobId: str, runId: str, surfaceKind: routeSurface, targetId: str } as const;

// Arranged by event domain (turn/tool, agent, mcp, plugin, automation, route,
// control-plane, delivery, watcher, surface); the contracts and gate domains
// have their own exhaustive tables, which feed the generated docs.
const EVENT_RULES: ReadonlyArray<readonly [EventTypeName, readonly FieldSpec[]]> = [
  // turn / tool
  rules('TURN_SUBMITTED', { turnId: str, prompt: str, origin: optObj }),
  rules('STREAM_DELTA', { turnId: str, content: str, accumulated: str, reasoning: optStr }),
  rules('TURN_COMPLETED', { turnId: str, response: str, stopReason: str, metadata: optObj }),
  rules('TURN_ERROR', { turnId: str, error: str, stopReason: str, status: optNum, code: optStr }),
  rules('TURN_CANCEL', { turnId: str, stopReason: str, reason: optStr }),
  rules('TOOL_RECEIVED', { callId: str, turnId: str, tool: str, args: obj }),
  rules('TOOL_SUCCEEDED', { callId: str, turnId: str, tool: str, durationMs: num }),
  rules('TOOL_FAILED', { callId: str, turnId: str, tool: str, error: str, durationMs: num }),
  // agent
  rules('AGENT_SPAWNING', { agentId: str, task: str, contractRole: { kind: 'enum', values: ['owner', 'unit', 'planner'], optional: true } }),
  rules('AGENT_COMPLETED', { occurrenceId: optStr, agentId: str, durationMs: num }),
  rules('AGENT_FAILED', { occurrenceId: optStr, agentId: str, error: str, durationMs: num, taskId: optStr }),
  // mcp
  rules('MCP_CONNECTED', { serverId: str, toolCount: num, resourceCount: num }),
  rules('MCP_DISCONNECTED', { serverId: str, willRetry: bool }),
  rules('MCP_RECONNECTING', { serverId: str, attempt: num, maxAttempts: num }),
  // plugin
  rules('PLUGIN_LOADED', { pluginId: str, version: str, capabilities: strs }),
  rules('PLUGIN_ERROR', { pluginId: str, error: str, fatal: bool }),
  // automation
  rules('AUTOMATION_JOB_CREATED', { jobId: str, name: str, scheduleKind: oneOf(AUTOMATION_SCHEDULE_KINDS), enabled: bool }),
  rules('AUTOMATION_JOB_UPDATED', { jobId: str, changedFields: strs }),
  rules('AUTOMATION_JOB_ENABLED', { jobId: str }),
  rules('AUTOMATION_JOB_DISABLED', { jobId: str, reason: str }),
  rules('AUTOMATION_RUN_STARTED', { jobId: str, runId: str, startedAt: num, attempt: num }),
  rules('AUTOMATION_RUN_COMPLETED', {
    jobId: str, runId: str, startedAt: num, completedAt: num, durationMs: num,
    outcome: oneOf(AUTOMATION_RUN_OUTCOMES), error: optStr, retryable: optBool,
  }),
  rules('AUTOMATION_RUN_FAILED', { jobId: str, runId: str, startedAt: num, failedAt: num, error: str, retryable: bool }),
  rules('AUTOMATION_JOB_AUTO_DISABLED', { jobId: str, reason: str, consecutiveFailures: num }),
  // route
  rules('ROUTE_BINDING_CREATED', { bindingId: str, surfaceKind: routeSurface, externalId: str, targetKind: oneOf(ROUTE_TARGET_KINDS), targetId: str }),
  rules('ROUTE_BINDING_UPDATED', { bindingId: str, changedFields: strs }),
  rules('ROUTE_BINDING_REMOVED', { bindingId: str, surfaceKind: routeSurface, externalId: str }),
  rules('ROUTE_BINDING_RESOLVED', { bindingId: str, surfaceKind: routeSurface, externalId: str, targetKind: oneOf(ROUTE_TARGET_KINDS), targetId: str }),
  rules('ROUTE_REPLY_TARGET_CAPTURED', { bindingId: str, surfaceKind: routeSurface, externalId: str, replyTargetId: str, threadId: str }),
  rules('ROUTE_BINDING_FAILED', { surfaceKind: routeSurface, externalId: str, error: str }),
  // control-plane
  rules('CONTROL_PLANE_CLIENT_CONNECTED', { clientId: str, clientKind: oneOf(CONTROL_PLANE_CLIENT_KINDS), transport: oneOf(CONTROL_PLANE_TRANSPORT_KINDS) }),
  rules('CONTROL_PLANE_CLIENT_DISCONNECTED', { clientId: str, reason: str }),
  rules('CONTROL_PLANE_SUBSCRIPTION_CREATED', { clientId: str, subscriptionId: str, topics: strs }),
  rules('CONTROL_PLANE_SUBSCRIPTION_DROPPED', { clientId: str, subscriptionId: str, reason: str }),
  rules('CONTROL_PLANE_AUTH_GRANTED', { clientId: str, principalId: str, principalKind: oneOf(CONTROL_PLANE_PRINCIPAL_KINDS), scopes: strs }),
  // delivery
  rules('DELIVERY_QUEUED', { ...delivery, deliveryKind: oneOf(DELIVERY_KINDS) }),
  rules('DELIVERY_STARTED', { ...delivery, startedAt: num }),
  rules('DELIVERY_SUCCEEDED', { ...delivery, completedAt: num, durationMs: num }),
  rules('DELIVERY_FAILED', { ...delivery, failedAt: num, error: str, retryable: bool }),
  rules('DELIVERY_DEAD_LETTERED', { ...delivery, reason: str, attempts: num }),
  // watcher
  rules('WATCHER_STARTED', { watcherId: str, sourceKind: watcherSource, name: str }),
  rules('WATCHER_HEARTBEAT', { watcherId: str, sourceKind: watcherSource, seenAt: num, checkpoint: str }),
  rules('WATCHER_CHECKPOINT_ADVANCED', { watcherId: str, sourceKind: watcherSource, checkpoint: str }),
  rules('WATCHER_FAILED', { watcherId: str, sourceKind: watcherSource, error: str, retryable: bool }),
  rules('WATCHER_STOPPED', { watcherId: str, sourceKind: watcherSource, reason: str }),
  // surface
  rules('SURFACE_ENABLED', { surfaceKind, surfaceId: str, accountId: str }),
  rules('SURFACE_DISABLED', { surfaceKind, surfaceId: str, reason: str }),
  rules('SURFACE_ACCOUNT_CONNECTED', { surfaceKind, surfaceId: str, accountId: str, displayName: str }),
  rules('SURFACE_ACCOUNT_DEGRADED', { surfaceKind, surfaceId: str, accountId: str, error: str }),
  rules('SURFACE_CAPABILITY_CHANGED', { surfaceKind, surfaceId: str, capability: str, enabled: bool }),
];

const EVENT_VALIDATORS: Readonly<Record<string, (v: unknown) => ContractResult>> = {
  ...Object.fromEntries(EVENT_RULES.map(([type, fields]) => [type, (v: unknown) => validateEventFields(type, v, fields)])),
  // contracts domain (every CONTRACT_* type; the table is exhaustive by type)
  ...CONTRACT_EVENT_VALIDATORS,
  // gate domain (every gate event type; the table is exhaustive by type)
  ...GATE_EVENT_VALIDATORS,
};

/**
 * Validate a runtime event against the rules for its type.
 *
 * Returns `{ valid: false }` for an event type with no registered rules
 * (`registeredEventTypes()` lists the ones that have them). Use
 * `isKnownEventType` to tell "unknown type" from "validation failed".
 */
export function validateKnownEvent(event: unknown): ContractResult {
  if (!isObject(event)) return { valid: false, violations: ['event must be an object'] };
  const type = event['type'];
  if (!isString(type)) return { valid: false, violations: ['event.type must be a string'] };
  const validator = Object.hasOwn(EVENT_VALIDATORS, type) ? EVENT_VALIDATORS[type] : undefined;
  if (!validator) return { valid: false, violations: [`unknown event type: '${type}'`] };
  return validator(event);
}

export function isKnownEventType(type: unknown): type is string {
  return isString(type) && Object.hasOwn(EVENT_VALIDATORS, type);
}

export function registeredEventTypes(): readonly string[] {
  return Object.keys(EVENT_VALIDATORS);
}
