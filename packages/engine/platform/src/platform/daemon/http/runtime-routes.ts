import { createDaemonRuntimeRouteHandlers as createDaemonApiRuntimeRouteHandlers } from '@goodvibes/engine/daemon-api';
import type { DaemonRuntimeRouteContext as PlatformDaemonRuntimeRouteContext } from '@goodvibes/engine/daemon-api';
import type { CreateAutomationJobInput, UpdateAutomationJobInput } from '../../automation/index.js';
import { GatewayVerbError } from '../../control-plane/routes/gateway-verb-error.js';
import {
  EXECUTION_FILESYSTEM_POLICIES,
  EXECUTION_NETWORK_POLICIES,
  EXECUTION_RISK_CLASSES,
  type ExecutionIntent,
} from '../../runtime/execution-intents.js';
import type { DaemonRuntimeRouteContext, DaemonRuntimeRouteHandlerMap } from './runtime-route-types.js';
import { isRecord } from '../../utils/record-coerce.js';
import { REASONING_EFFORT_SEVERITY } from '../../providers/reasoning-effort.js';

export type { DaemonRuntimeRouteContext } from './runtime-route-types.js';

type RuntimeRouteSpawnAgentInput = Parameters<PlatformDaemonRuntimeRouteContext['trySpawnAgent']>[0];
type PlatformSpawnAgentInput = Parameters<DaemonRuntimeRouteContext['trySpawnAgent']>[0];

const providerSelections = new Set(['inherit-current', 'concrete', 'synthetic']);
const providerFailurePolicies = new Set(['ordered-fallbacks', 'fail']);
const executionTargetKinds = new Set(['isolated', 'current', 'pinned', 'background', 'main', 'session', 'route']);
const surfaceKinds = new Set([
  'tui',
  'web',
  'slack',
  'discord',
  'ntfy',
  'webhook',
  'homeassistant',
  'telegram',
  'google-chat',
  'signal',
  'whatsapp',
  'imessage',
  'msteams',
  'bluebubbles',
  'mattermost',
  'matrix',
  'service',
]);
// Full severity ladder, not a fixed 4-value list, see providers/reasoning-effort.ts.
const reasoningEfforts = new Set(REASONING_EFFORT_SEVERITY);
const wakeModes = new Set(['next-heartbeat', 'now']);
const externalContentKinds = new Set([
  'gmail',
  'email',
  'webhook',
  'api',
  'browser',
  'channel_metadata',
  'web_search',
  'web_fetch',
  'slack',
  'discord',
  'ntfy',
  'unknown',
]);
const deliveryModes = new Set(['none', 'webhook', 'surface', 'integration', 'link']);
const failureActions = new Set(['retry', 'cooldown', 'disable', 'dead_letter']);
const retryStrategies = new Set(['fixed', 'linear', 'exponential']);
const executionProtocols = new Set(['direct', 'gather-plan-apply']);
const reviewModes = new Set(['none', 'contract']);
const communicationLanes = new Set(['parent-only', 'parent-and-children', 'cohort', 'direct']);
const executionRiskClasses = new Set(EXECUTION_RISK_CLASSES);
const executionNetworkPolicies = new Set(EXECUTION_NETWORK_POLICIES);
const executionFilesystemPolicies = new Set(EXECUTION_FILESYSTEM_POLICIES);


function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === 'string';
}

function isOptionalBoolean(value: unknown): value is boolean | undefined {
  return value === undefined || typeof value === 'boolean';
}

function isOptionalFiniteNumber(value: unknown): value is number | undefined {
  return value === undefined || isFiniteNumber(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isOptionalStringArray(value: unknown): value is readonly string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isStringFrom(value: unknown, allowed: ReadonlySet<string>): value is string {
  return typeof value === 'string' && allowed.has(value);
}

function isOptionalStringFrom(value: unknown, allowed: ReadonlySet<string>): value is string | undefined {
  return value === undefined || isStringFrom(value, allowed);
}

/** The first field of a request body that does not have its documented shape. */
export interface InvalidField {
  readonly field: string;
  readonly expectation: string;
}

/** Checks one field of an object at `path`; null when it is acceptable. */
type FieldCheck = (record: Record<string, unknown>, path: string) => InvalidField | null;

const at = (path: string, field: string): string => (path ? `${path}.${field}` : field);
const choices = (allowed: ReadonlySet<string>): string => `one of ${[...allowed].join(', ')}`;

function field(name: string, ok: (value: unknown) => boolean, expectation: string): FieldCheck {
  return (record, path) => (ok(record[name]) ? null : { field: at(path, name), expectation });
}
const optionalString = (name: string) => field(name, isOptionalString, 'a string');
const optionalBoolean = (name: string) => field(name, isOptionalBoolean, 'true or false (a JSON boolean)');
const optionalNumber = (name: string) => field(name, isOptionalFiniteNumber, 'a finite number');
const optionalStrings = (name: string) => field(name, isOptionalStringArray, 'an array of strings');
const optionalOneOf = (name: string, allowed: ReadonlySet<string>) => field(name, (value) => isOptionalStringFrom(value, allowed), choices(allowed));
const requiredOneOf = (name: string, allowed: ReadonlySet<string>) => field(name, (value) => isStringFrom(value, allowed), choices(allowed));

function objectProblem(value: unknown, checks: readonly FieldCheck[], path: string): InvalidField | null {
  if (!isRecord(value)) return { field: path, expectation: 'an object' };
  for (const check of checks) {
    const problem = check(value, path);
    if (problem) return problem;
  }
  return null;
}

function optionalObject(name: string, checks: readonly FieldCheck[]): FieldCheck {
  return (record, path) => (record[name] === undefined ? null : objectProblem(record[name], checks, at(path, name)));
}

function optionalObjectList(name: string, checks: readonly FieldCheck[]): FieldCheck {
  return (record, path) => {
    const value = record[name];
    if (value === undefined) return null;
    if (!Array.isArray(value)) return { field: at(path, name), expectation: 'an array of objects' };
    for (const [index, entry] of value.entries()) {
      const problem = objectProblem(entry, checks, `${at(path, name)}[${index}]`);
      if (problem) return problem;
    }
    return null;
  };
}

const scheduleCheck = (required: boolean): FieldCheck => (record, path) => {
  const value = record['schedule'];
  const where = at(path, 'schedule');
  if (value === undefined && !required) return null;
  if (!isRecord(value)) return { field: where, expectation: 'an object with kind "at", "every" or "cron"' };
  if (value.kind === 'at') return objectProblem(value, [field('at', isFiniteNumber, 'a time in milliseconds')], where);
  if (value.kind === 'every') return objectProblem(value, [field('intervalMs', isFiniteNumber, 'a finite number of milliseconds'), optionalNumber('anchorAt')], where);
  if (value.kind === 'cron') return objectProblem(value, [field('expression', (entry) => typeof entry === 'string', 'a cron expression string'), optionalString('timezone'), optionalNumber('staggerMs')], where);
  return { field: at(where, 'kind'), expectation: 'one of at, every, cron' };
};

const EXECUTION_INTENT_CHECKS: readonly FieldCheck[] = [
  optionalOneOf('riskClass', executionRiskClasses),
  optionalBoolean('requiresApproval'),
  optionalOneOf('networkPolicy', executionNetworkPolicies),
  optionalOneOf('filesystemPolicy', executionFilesystemPolicies),
];

const DELIVERY_TARGET_CHECKS: readonly FieldCheck[] = [
  requiredOneOf('kind', deliveryModes),
  optionalOneOf('surfaceKind', surfaceKinds),
  optionalString('address'),
  optionalString('routeId'),
  optionalString('label'),
];

const externalContentSourceCheck: FieldCheck = (record, path) => {
  const value = record['externalContentSource'];
  if (value === undefined) return null;
  const where = at(path, 'externalContentSource');
  if (typeof value === 'string') return externalContentKinds.has(value) ? null : { field: where, expectation: choices(externalContentKinds) };
  return objectProblem(value, [
    field('kind', (entry) => typeof entry === 'string', 'a string'),
    optionalString('id'),
    optionalString('url'),
    optionalString('routeId'),
    optionalOneOf('surfaceKind', surfaceKinds),
    field('metadata', (entry) => entry === undefined || isRecord(entry), 'an object'),
  ], where);
};

const JOB_FIELD_CHECKS: readonly FieldCheck[] = [
  optionalString('description'),
  optionalString('model'),
  optionalString('provider'),
  optionalStrings('fallbackModels'),
  optionalObject('routing', [
    optionalOneOf('providerSelection', providerSelections),
    optionalOneOf('providerFailurePolicy', providerFailurePolicies),
    optionalStrings('fallbackModels'),
  ]),
  optionalObject('executionIntent', EXECUTION_INTENT_CHECKS),
  optionalObject('target', [
    requiredOneOf('kind', executionTargetKinds),
    optionalString('sessionId'),
    optionalString('routeId'),
    optionalString('threadId'),
    optionalString('channelId'),
    optionalOneOf('surfaceKind', surfaceKinds),
    optionalString('pinnedSessionId'),
    optionalBoolean('preserveThread'),
    optionalBoolean('createIfMissing'),
  ]),
  optionalString('template'),
  optionalOneOf('reasoningEffort', reasoningEfforts),
  optionalString('thinking'),
  optionalOneOf('wakeMode', wakeModes),
  optionalNumber('timeoutMs'),
  optionalStrings('toolAllowlist'),
  optionalBoolean('allowUnsafeExternalContent'),
  externalContentSourceCheck,
  optionalBoolean('lightContext'),
  optionalObject('delivery', [
    optionalOneOf('mode', deliveryModes),
    optionalObjectList('targets', DELIVERY_TARGET_CHECKS),
    optionalObjectList('fallbackTargets', DELIVERY_TARGET_CHECKS),
    optionalBoolean('includeSummary'),
    optionalBoolean('includeLinks'),
    optionalString('replyToRouteId'),
  ]),
  optionalObject('failure', [
    optionalOneOf('action', failureActions),
    optionalNumber('maxConsecutiveFailures'),
    optionalNumber('cooldownMs'),
    optionalObject('retryPolicy', [
      field('maxAttempts', isFiniteNumber, 'a finite number'),
      field('delayMs', isFiniteNumber, 'a finite number'),
      requiredOneOf('strategy', retryStrategies),
      optionalNumber('maxDelayMs'),
      optionalNumber('jitterMs'),
    ]),
    optionalString('deadLetterRouteId'),
    optionalBoolean('disableAfterFailures'),
    optionalString('notifyRouteId'),
  ]),
  optionalBoolean('enabled'),
  optionalBoolean('deleteAfterRun'),
];

const CREATE_JOB_CHECKS: readonly FieldCheck[] = [
  optionalString('id'),
  field('name', (value) => typeof value === 'string', 'a string'),
  field('prompt', (value) => typeof value === 'string', 'a string'),
  scheduleCheck(true),
  ...JOB_FIELD_CHECKS,
];

const UPDATE_JOB_CHECKS: readonly FieldCheck[] = [
  optionalString('expectedMutationRevision'),
  optionalString('name'),
  optionalString('prompt'),
  scheduleCheck(false),
  ...JOB_FIELD_CHECKS,
];

function refuseInvalidJob(problem: InvalidField): never {
  throw new GatewayVerbError(`${problem.field} must be ${problem.expectation}. Nothing was changed.`, 'INVALID_ARGUMENT', 400, problem.field);
}

/** A create body with every field in its documented shape; otherwise a 400 naming the first field that is not. */
export function parseCreateAutomationJobInput(input: Record<string, unknown>): CreateAutomationJobInput {
  const problem = objectProblem(input, CREATE_JOB_CHECKS, '');
  if (problem) refuseInvalidJob(problem);
  return input as unknown as CreateAutomationJobInput;
}

/** An update body with every present field in its documented shape; otherwise a 400 naming the first field that is not. */
export function parseUpdateAutomationJobInput(input: Record<string, unknown>): UpdateAutomationJobInput {
  const problem = objectProblem(input, UPDATE_JOB_CHECKS, '');
  if (problem) refuseInvalidJob(problem);
  return input as unknown as UpdateAutomationJobInput;
}

function isExecutionIntent(value: unknown): value is ExecutionIntent {
  return objectProblem(value, EXECUTION_INTENT_CHECKS, 'executionIntent') === null;
}

/**
 * The agent start a task route asked for, as the agent manager takes it: the
 * route's lists are copied, so nothing the route holds is shared with the
 * record the agent keeps.
 */
export function toAgentSpawnInput(input: RuntimeRouteSpawnAgentInput): PlatformSpawnAgentInput {
  if (input.mode !== 'spawn' || typeof input.task !== 'string'
    || (input.executionIntent !== undefined && !isExecutionIntent(input.executionIntent))
    || !isOptionalStringFrom(input.executionProtocol, executionProtocols)
    || !isOptionalStringFrom(input.reviewMode, reviewModes)
    || !isOptionalStringFrom(input.communicationLane, communicationLanes)) {
    throw new Error('Invalid agent spawn payload from runtime route parser.');
  }
  const { tools, fallbackModels, routing, successCriteria, requiredEvidence, writeScope, ...rest } = input;
  return {
    ...rest,
    ...(tools ? { tools: [...tools] } : {}),
    ...(fallbackModels ? { fallbackModels: [...fallbackModels] } : {}),
    ...(routing ? { routing: { ...routing, ...(routing.fallbackModels ? { fallbackModels: [...routing.fallbackModels] } : {}) } } : {}),
    ...(successCriteria ? { successCriteria: [...successCriteria] } : {}),
    ...(requiredEvidence ? { requiredEvidence: [...requiredEvidence] } : {}),
    ...(writeScope ? { writeScope: [...writeScope] } : {}),
  };
}

export function createDaemonRuntimeRouteHandlers(
  context: DaemonRuntimeRouteContext,
): DaemonRuntimeRouteHandlerMap {
  return createDaemonApiRuntimeRouteHandlers({
    ...context,
    automationManager: {
      ...context.automationManager,
      createJob: (input) => context.automationManager.createJob(parseCreateAutomationJobInput(input)),
      updateJob: (jobId, input) => context.automationManager.updateJob(jobId, parseUpdateAutomationJobInput(input)),
    },
    trySpawnAgent: (input, logLabel, sessionId) => context.trySpawnAgent(toAgentSpawnInput(input), logLabel, sessionId),
  });
}
