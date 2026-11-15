/**
 * routes/stepup.ts
 *
 * Handlers for the relay step-up ceremony verbs over the shared StepUpService
 * (relay/step-up-service.ts). Thin verb registration: read+validate the
 * invocation params, call the service, return its result. The same service
 * instance backs the daemon's real StepUpAssertionVerifier, so a challenge
 * minted here is the object the relay gate later consumes.
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import {
  StepUpChallengeLimitError,
  StepUpValidationError,
  type StepUpService,
  type UserVerificationRequirement,
} from '../../relay/step-up-service.js';

export type StepUpGatewayService = Pick<StepUpService, 'registerCredential' | 'mintChallenge' | 'listCredentials' | 'removeCredential'>;

function requireString(params: Record<string, unknown>, key: string): string {
  const value = params[key];
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GatewayVerbError(`${key} is required`, 'INVALID_ARGUMENT', 400, key);
  }
  return value;
}

function optionalUserVerification(value: unknown): UserVerificationRequirement | undefined {
  if (value === undefined) return undefined;
  if (value === 'required' || value === 'preferred' || value === 'discouraged') return value;
  throw new GatewayVerbError('userVerification must be one of required|preferred|discouraged', 'INVALID_ARGUMENT', 400, 'userVerification');
}

function createRegisterHandler(service: StepUpGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const originValue = params['origin'];
    const origin = typeof originValue === 'string'
      ? originValue
      : Array.isArray(originValue) && originValue.every((o) => typeof o === 'string')
        ? (originValue as string[])
        : undefined;
    if (origin === undefined) throw new GatewayVerbError('origin is required (string or string[])', 'INVALID_ARGUMENT', 400, 'origin');
    const signCountRaw = params['signCount'];
    if (signCountRaw !== undefined && (typeof signCountRaw !== 'number' || !Number.isFinite(signCountRaw) || signCountRaw < 0)) {
      throw new GatewayVerbError('signCount must be a non-negative number', 'INVALID_ARGUMENT', 400, 'signCount');
    }
    try {
      const credential = await service.registerCredential({
        rpId: requireString(params, 'rpId'),
        origin,
        credentialId: requireString(params, 'credentialId'),
        publicKeyCose: requireString(params, 'publicKeyCose'),
        ...(typeof signCountRaw === 'number' ? { signCount: signCountRaw } : {}),
        ...(optionalUserVerification(params['userVerification']) ? { userVerification: optionalUserVerification(params['userVerification'])! } : {}),
        ...(typeof params['label'] === 'string' ? { label: params['label'] } : {}),
      });
      return { credential };
    } catch (error) {
      if (error instanceof GatewayVerbError) throw error;
      if (error instanceof StepUpValidationError) throw new GatewayVerbError(error.message, 'INVALID_ARGUMENT', 400);
      throw error;
    }
  };
}

function createMintHandler(service: StepUpGatewayService): GatewayMethodHandler {
  return (invocation) => {
    const params = readInvocationParams(invocation);
    const ttlRaw = params['ttlMs'];
    if (ttlRaw !== undefined && (typeof ttlRaw !== 'number' || !Number.isFinite(ttlRaw))) {
      throw new GatewayVerbError('ttlMs must be a number', 'INVALID_ARGUMENT', 400, 'ttlMs');
    }
    try {
      return service.mintChallenge({
        ...(typeof params['rendezvousId'] === 'string' ? { rendezvousId: params['rendezvousId'] } : {}),
        ...(typeof params['sessionId'] === 'string' ? { sessionId: params['sessionId'] } : {}),
        ...(typeof params['method'] === 'string' ? { method: params['method'] } : {}),
        ...(typeof params['path'] === 'string' ? { path: params['path'] } : {}),
        ...(typeof ttlRaw === 'number' ? { ttlMs: ttlRaw } : {}),
        ...(invocation.context.principalId ? { principalId: invocation.context.principalId } : {}),
      });
    } catch (error) {
      if (error instanceof StepUpChallengeLimitError) throw new GatewayVerbError(error.message, 'STEP_UP_CHALLENGES_FULL', 429);
      throw error;
    }
  };
}

function createListHandler(service: StepUpGatewayService): GatewayMethodHandler {
  return async () => ({ credentials: await service.listCredentials() });
}

function createRemoveHandler(service: StepUpGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const credentialId = requireString(readInvocationParams(invocation), 'credentialId');
    if (!(await service.removeCredential(credentialId))) {
      throw new GatewayVerbError(`No step-up credential with id "${credentialId}", see stepup.credentials.list`, 'NOT_FOUND', 404, 'credentialId');
    }
    return { credentialId, removed: true };
  };
}

export function registerStepUpGatewayMethods(catalog: GatewayMethodCatalog, service: StepUpGatewayService): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => {
    const descriptor = catalog.get(id);
    if (descriptor) catalog.register(descriptor, handler, { replace: true });
  };
  attach('stepup.credentials.register', createRegisterHandler(service));
  attach('stepup.credentials.list', createListHandler(service));
  attach('stepup.credentials.remove', createRemoveHandler(service));
  attach('stepup.challenge.mint', createMintHandler(service));
}
