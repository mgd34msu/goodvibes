/**
 * routes/checkin.ts
 *
 * Handlers for the checkin.* gateway verbs over the CheckinService
 * (../../checkin). Thin verb registration: read the invocation params, call the
 * service, return its result.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import type { CheckinService } from '../../checkin/index.js';

export type CheckinGatewayService = Pick<CheckinService, 'getConfig' | 'setConfig' | 'listReceipts' | 'evaluate' | 'scheduleStatus'>;

function createConfigGetHandler(service: CheckinGatewayService): GatewayMethodHandler {
  return () => ({ config: service.getConfig() });
}

function createConfigSetHandler(service: CheckinGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const patch: { enabled?: boolean; cadence?: string; deliveryChannel?: string; quietHours?: string } = {};
    if (typeof params.enabled === 'boolean') patch.enabled = params.enabled;
    if (typeof params.cadence === 'string') patch.cadence = params.cadence;
    if (typeof params.deliveryChannel === 'string') patch.deliveryChannel = params.deliveryChannel;
    if (typeof params.quietHours === 'string') patch.quietHours = params.quietHours;
    if (params.enabled !== undefined && typeof params.enabled !== 'boolean') {
      throw new GatewayVerbError('enabled must be a boolean', 'INVALID_ARGUMENT', 400, 'enabled');
    }
    const config = await service.setConfig(patch);
    // The config is stored either way; `schedule` says whether the scheduler really holds the job.
    return { config, schedule: service.scheduleStatus() };
  };
}

function createReceiptsListHandler(service: CheckinGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    // On the GET binding the limit arrives as query text, so a numeric string is read as the number it names.
    const rawLimit = typeof params.limit === 'string' && params.limit.trim() !== '' ? Number(params.limit) : params.limit;
    const limit = typeof rawLimit === 'number' && Number.isFinite(rawLimit) ? rawLimit : undefined;
    return { receipts: await service.listReceipts(limit) };
  };
}

function createRunHandler(service: CheckinGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const assertAuthority = () => {
      if (invocation.isAuthorized && !invocation.isAuthorized(['write:checkin'])) {
        throw new GatewayVerbError('Check-in invocation authority was revoked', 'FORBIDDEN', 403);
      }
    };
    const outcome = await service.evaluate('manual', undefined, invocation.signal, assertAuthority);
    return {
      outcome: outcome.outcome,
      summary: outcome.summary,
      ...(outcome.deliveryId ? { deliveryId: outcome.deliveryId } : {}),
      ...(outcome.error ? { error: outcome.error } : {}),
    };
  };
}

export function registerCheckinGatewayMethods(catalog: GatewayMethodCatalog, service: CheckinGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('checkin.config.get', createConfigGetHandler(service));
  attach('checkin.config.set', createConfigSetHandler(service));
  attach('checkin.receipts.list', createReceiptsListHandler(service));
  attach('checkin.run', createRunHandler(service));
}
