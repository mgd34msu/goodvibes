/**
 * routes/ci.ts
 *
 * Handlers for the ci.* gateway verbs over the CiWatchService (../../ci-watch).
 * Thin verb registration: read params, call the service, map CiWatchError to an
 * honest wire status (INVALID_ARGUMENT -> 400, NOT_FOUND -> 404), a target gone
 * on GitHub to 404 CI_TARGET_GONE and a refusal of gh itself to 424
 * CI_SOURCE_REFUSED.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireString } from './invocation-params.js';
import { attachHandler } from './attach-handler.js';
import { CiWatchError, type CiWatchService } from '../../ci-watch/index.js';
import { CiSourceError, CiTargetGoneError } from '../../ci-watch/types.js';

export type CiWatchGatewayService = Pick<
  CiWatchService,
  'status' | 'listWatches' | 'createWatch' | 'deleteWatch' | 'checkWatch'
>;

const ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
};

function rethrow(error: unknown): never {
  if (error instanceof CiWatchError) {
    throw new GatewayVerbError(error.message, error.code, ERROR_STATUS[error.code] ?? 400);
  }
  // The repository, branch or pull request is gone on GitHub, or this login cannot read it: no verdict will come.
  if (error instanceof CiTargetGoneError) {
    throw new GatewayVerbError(error.message, 'CI_TARGET_GONE', 404, 'repo', { next: ['Check the repository, branch or pull request named, and that gh is signed in to an account that can read it.'] });
  }
  // gh refused or could not answer (not signed in, no network, not installed): a refusal from outside this daemon,
  // in gh's own words, never a daemon fault (a 500).
  if (error instanceof CiSourceError) {
    throw new GatewayVerbError(`GitHub could not be read: ${error.message}`, 'CI_SOURCE_REFUSED', 424, undefined, {
      state: 'nothing was read from GitHub and nothing was changed',
      next: ['Check that gh is installed and signed in (gh auth status, gh auth login) and that GitHub can be reached, then ask again.'],
    });
  }
  throw error;
}


function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

/**
 * A number from a body or from the query string, where it always arrives as
 * text. An absent value is absent; a present one that is not a finite number is
 * refused, because dropping it would silently widen the call (a watch for the
 * ref instead of the pull request).
 */
function optionalNumber(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'string' ? Number(value.trim()) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new GatewayVerbError(`${field} must be a number`, 'INVALID_ARGUMENT', 400, field);
  }
  return parsed;
}

/**
 * The repository, branch and pull request a call names. A repository written
 * the way a person says it, `owner/repo#123` (a pull request) or
 * `owner/repo@branch`, is read into its parts when the call does not give
 * them separately.
 */
function targetOf(params: Record<string, unknown>): { readonly repo: string; readonly ref?: string; readonly prNumber?: number } {
  const written = requireString(params, 'repo').trim();
  const prNumber = optionalNumber(params.prNumber, 'prNumber');
  const ref = optionalString(params.ref);
  const pr = prNumber === undefined && ref === undefined ? written.match(/^([^#@\s]+)#(\d+)$/) : null;
  if (pr) return { repo: pr[1]!, prNumber: Number(pr[2]) };
  const branch = prNumber === undefined && ref === undefined ? written.match(/^([^#@\s]+)@(\S+)$/) : null;
  if (branch) return { repo: branch[1]!, ref: branch[2]! };
  return { repo: written, ...(ref !== undefined ? { ref } : {}), ...(prNumber !== undefined ? { prNumber } : {}) };
}

function createStatusHandler(service: CiWatchGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const target = targetOf(params);
    try {
      const report = await service.status(target);
      return { report };
    } catch (error) {
      rethrow(error);
    }
  };
}

function createListHandler(service: CiWatchGatewayService): GatewayMethodHandler {
  return async () => ({ watches: await service.listWatches() });
}

function createCreateHandler(service: CiWatchGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const target = targetOf(params);
    try {
      const watch = await service.createWatch({
        ...target,
        deliveryChannel: requireString(params, 'deliveryChannel'),
        triggerFixSession: params.triggerFixSession === true,
      });
      return { watch };
    } catch (error) {
      rethrow(error);
    }
  };
}

function createDeleteHandler(service: CiWatchGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const watchId = requireString(params, 'watchId');
    try {
      return { watchId, deleted: await service.deleteWatch(watchId) };
    } catch (error) {
      rethrow(error);
    }
  };
}

function createRunHandler(service: CiWatchGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const watchId = requireString(params, 'watchId');
    try {
      const result = await service.checkWatch(watchId);
      return {
        report: result.report,
        notified: result.notified,
        ...(result.notificationId ? { notificationId: result.notificationId } : {}),
        fixSessionTriggered: result.fixSessionTriggered,
        ...(result.fixSessionId ? { fixSessionId: result.fixSessionId } : {}),
        ...(result.fixSessionError ? { fixSessionError: result.fixSessionError } : {}),
        ...(result.retired ? { retired: true } : {}),
        ...(result.endedReason ? { endedReason: result.endedReason } : {}),
      };
    } catch (error) {
      rethrow(error);
    }
  };
}

export function registerCiGatewayMethods(catalog: GatewayMethodCatalog, service: CiWatchGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => { attachHandler(catalog, id, handler); };
  attach('ci.status', createStatusHandler(service));
  attach('ci.watches.list', createListHandler(service));
  attach('ci.watches.create', createCreateHandler(service));
  attach('ci.watches.delete', createDeleteHandler(service));
  attach('ci.watches.run', createRunHandler(service));
}
