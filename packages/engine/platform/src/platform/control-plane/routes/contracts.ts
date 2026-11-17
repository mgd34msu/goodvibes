/**
 * routes/contracts.ts, the handlers behind `contracts.*`.
 *
 * Thin on purpose: reading the arguments and mapping refusals. What a
 * contract is, and which runner holds it, lives in
 * contract/operator-service.ts, so the methods, their REST paths and the
 * external work adapters cannot drift into different ideas of start, cancel
 * and reply.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { DecisionModelsDisabledError, formatRefusal, RefusalError } from '@goodvibes-jev/engine/errors';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireString } from './invocation-params.js';
import { ContractOperatorError, projectContractOperatorView, type ContractOperatorService } from '../../contract/operator-service.js';
import { attachHandler } from './attach-handler.js';

/** The reason a cancel over the operator surface records when the caller gives none. */
export const OPERATOR_CANCEL_REASON = 'cancelled by an operator';

/** The longest retry key a caller may send (the Idempotency-Key header or `idempotencyKey`). */
const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

function optionalString(params: Record<string, unknown>, field: string): string | undefined {
  const value = params[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw new GatewayVerbError(`Invalid ${field}: expected a string`, 'INVALID_ARGUMENT', 400, field);
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** A REST query carries booleans as text; the invoke body carries them as booleans. */
function optionalBoolean(params: Record<string, unknown>, field: string): boolean | undefined {
  const value = params[field];
  if (value === undefined || value === null) return undefined;
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  throw new GatewayVerbError(`Invalid ${field}: expected true or false`, 'INVALID_ARGUMENT', 400, field);
}

function optionalIsolation(params: Record<string, unknown>): 'auto' | 'worktree' | 'shared' | undefined {
  const value = params['isolation'];
  if (value === undefined || value === null) return undefined;
  if (value === 'auto' || value === 'worktree' || value === 'shared') return value;
  throw new GatewayVerbError('Invalid isolation: expected auto, worktree or shared', 'INVALID_ARGUMENT', 400, 'isolation');
}

/** The caller every method applies the session-ownership rule to. */
const callerOf = (invocation: Parameters<GatewayMethodHandler>[0]) => ({ principalId: invocation.context.principalId || undefined });

/** Map the service's refusals onto the wire shape a client can act on. */
function toGatewayVerbError(error: unknown): never {
  if (error instanceof ContractOperatorError) {
    throw new GatewayVerbError(error.message, error.code, error.status, error.field);
  }
  if (error instanceof RefusalError && error.refusal.code === 'IDEMPOTENCY_KEY_REUSED') {
    throw new GatewayVerbError(formatRefusal(error.refusal), error.refusal.code, error.refusal.status ?? 409, 'idempotencyKey');
  }
  // Decision models are off (no decision model): a setting the owner chose, not a daemon fault.
  if (error instanceof DecisionModelsDisabledError) {
    throw new GatewayVerbError(`${error.message} Turn decision models on (judgment.policy) to plan and judge contracts, or delegate with an agent outside a contract.`, 'DECISION_MODELS_DISABLED', 409);
  }
  throw error;
}

export function createContractsListHandler(service: ContractOperatorService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = optionalString(params, 'sessionId');
    const includeTerminal = optionalBoolean(params, 'includeTerminal');
    return {
      contracts: service.list({
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(includeTerminal === undefined ? {} : { includeTerminal }),
      }, callerOf(invocation)).map(projectContractOperatorView),
    };
  };
}

export function createContractsGetHandler(service: ContractOperatorService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const contractId = requireString(params, 'contractId');
    const includeInputFiles = optionalBoolean(params, 'includeInputFiles');
    const contract = service.get(contractId, callerOf(invocation), includeInputFiles === undefined ? {} : { includeInputFiles });
    if (contract === null) throw new GatewayVerbError(`No contract ${contractId} on this daemon.`, 'CONTRACT_NOT_FOUND', 404);
    return projectContractOperatorView(contract);
  };
}

export function createContractsSummariesHandler(service: ContractOperatorService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const sessionId = optionalString(params, 'sessionId');
    const includeTerminal = optionalBoolean(params, 'includeTerminal');
    return {
      contracts: service.summaries({
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(includeTerminal === undefined ? {} : { includeTerminal }),
      }, callerOf(invocation)),
    };
  };
}

export function createContractsStatusHandler(service: ContractOperatorService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const contractId = requireString(params, 'contractId');
    const ifRevision = optionalString(params, 'ifRevision');
    const summary = service.status(contractId, callerOf(invocation));
    if (summary === null) throw new GatewayVerbError(`No contract ${contractId} on this daemon.`, 'CONTRACT_NOT_FOUND', 404);
    // An unchanged contract answers with its revision only.
    return ifRevision === summary.revision ? { id: summary.id, revision: summary.revision, notModified: true } : summary;
  };
}

export function createContractsStartHandler(service: ContractOperatorService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    requireString(params, 'ask');
    // The ask is the person's words verbatim, the authority every stated criterion traces to: passed as given.
    const ask = params['ask'] as string;
    const sessionId = optionalString(params, 'sessionId');
    const workspaceRoot = optionalString(params, 'workspaceRoot');
    const isolation = optionalIsolation(params);
    const idempotencyKey = optionalString(params, 'idempotencyKey');
    if (idempotencyKey !== undefined && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new GatewayVerbError(`idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`, 'INVALID_ARGUMENT', 400, 'idempotencyKey');
    }
    try {
      return await service.start({
        ask,
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(invocation.context.principalId ? { principalId: invocation.context.principalId } : {}),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        ...(isolation === undefined ? {} : { isolation }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createContractsDispatchHandler(service: ContractOperatorService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    requireString(params, 'ask');
    const ask = params['ask'] as string;
    const workspaceRoot = optionalString(params, 'workspaceRoot');
    const idempotencyKey = optionalString(params, 'idempotencyKey');
    if (idempotencyKey !== undefined && idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
      throw new GatewayVerbError(`idempotencyKey must be at most ${MAX_IDEMPOTENCY_KEY_LENGTH} characters`, 'INVALID_ARGUMENT', 400, 'idempotencyKey');
    }
    try {
      return await service.dispatch({
        ask,
        ...(invocation.context.principalId ? { principalId: invocation.context.principalId } : {}),
        ...(workspaceRoot === undefined ? {} : { workspaceRoot }),
        ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
      });
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createContractsCancelHandler(service: ContractOperatorService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const contractId = requireString(params, 'contractId');
    const reason = optionalString(params, 'reason') ?? OPERATOR_CANCEL_REASON;
    try {
      return { cancelled: service.cancel(contractId, reason, callerOf(invocation)) };
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createContractsReplyHandler(service: ContractOperatorService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const contractId = requireString(params, 'contractId');
    const escalationId = requireString(params, 'escalationId');
    const text = requireString(params, 'text');
    try {
      return await service.reply(contractId, escalationId, text, callerOf(invocation));
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createContractsRemoveHandler(service: ContractOperatorService): GatewayMethodHandler {
  return (invocation) => {
    const contractId = requireString(readInvocationParams(invocation), 'contractId');
    try {
      return service.remove(contractId, callerOf(invocation));
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

export function createContractsRetryUnitHandler(service: ContractOperatorService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const contractId = requireString(params, 'contractId');
    const unitId = requireString(params, 'unitId');
    try {
      return await service.retryUnit(contractId, unitId, callerOf(invocation));
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

/** A non-negative number, or undefined when absent. */
function optionalAmount(params: Record<string, unknown>, field: string): number | undefined {
  const value = params[field];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new GatewayVerbError(`Invalid ${field}: expected a number of 0 or more`, 'INVALID_ARGUMENT', 400, field);
  }
  return value;
}

export function createContractsBudgetHandler(service: ContractOperatorService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const contractId = requireString(params, 'contractId');
    const maxCostUsd = optionalAmount(params, 'maxCostUsd');
    const maxTokens = optionalAmount(params, 'maxTokens');
    try {
      return service.raiseBudget(contractId, {
        ...(maxCostUsd === undefined ? {} : { maxCostUsd }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
      }, callerOf(invocation));
    } catch (error) {
      return toGatewayVerbError(error);
    }
  };
}

/** Every method this module owns. */
export const CONTRACT_METHOD_IDS: readonly string[] = [
  'contracts.list',
  'contracts.summaries',
  'contracts.get',
  'contracts.status',
  'contracts.start',
  'contracts.dispatch',
  'contracts.cancel',
  'contracts.reply',
  'contracts.remove',
  'contracts.retryUnit',
  'contracts.budget',
];

/**
 * Attach the handlers to their descriptors. Called once with the daemon's own
 * runner when the runtime services are built, and again with the hosted
 * runners joined in when the daemon hosts sessions; the later call replaces
 * the earlier handlers. A missing descriptor is a silent no-op, as for every
 * other route group.
 */
export function registerContractGatewayMethods(catalog: GatewayMethodCatalog, service: ContractOperatorService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => { attachHandler(catalog, id, handler); };
  attach('contracts.list', createContractsListHandler(service));
  attach('contracts.summaries', createContractsSummariesHandler(service));
  attach('contracts.get', createContractsGetHandler(service));
  attach('contracts.status', createContractsStatusHandler(service));
  attach('contracts.start', createContractsStartHandler(service));
  attach('contracts.dispatch', createContractsDispatchHandler(service));
  attach('contracts.cancel', createContractsCancelHandler(service));
  attach('contracts.reply', createContractsReplyHandler(service));
  attach('contracts.remove', createContractsRemoveHandler(service));
  attach('contracts.retryUnit', createContractsRetryUnitHandler(service));
  attach('contracts.budget', createContractsBudgetHandler(service));
}
