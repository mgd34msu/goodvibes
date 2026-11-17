/**
 * routes/channel-profiles.ts
 *
 * Handlers for the channels.profiles.* verbs over the ChannelProfileRegistry
 * (../../channel-profiles). Thin verb registration: read the invocation params,
 * call the registry, map a ChannelProfileError to an honest wire status
 * (INVALID_ARGUMENT -> 400, NOT_FOUND -> 404).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { parseChannelPermissionMode } from '../../channel-profiles/registry.js';
import { attachHandler } from './attach-handler.js';
import {
  ChannelProfileError,
  ChannelProfileRegistry,
} from '../../channel-profiles/index.js';

export type ChannelProfilesGatewayService = Pick<
  ChannelProfileRegistry,
  'list' | 'get' | 'set' | 'delete' | 'explain'
>;

const ERROR_STATUS: Readonly<Record<string, number>> = {
  INVALID_ARGUMENT: 400,
  NOT_FOUND: 404,
};

function rethrowAsVerbError(error: unknown): never {
  if (error instanceof ChannelProfileError) {
    throw new GatewayVerbError(error.message, error.code, ERROR_STATUS[error.code] ?? 400);
  }
  throw error;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readMetadata(value: unknown): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new GatewayVerbError('metadata must be an object', 'INVALID_ARGUMENT', 400, 'metadata');
  }
  return value as Record<string, unknown>;
}

function createListHandler(service: ChannelProfilesGatewayService): GatewayMethodHandler {
  return async () => ({ bindings: await service.list() });
}

function createGetHandler(service: ChannelProfilesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const surfaceKind = requireStringValue(params.surfaceKind, 'surfaceKind');
    const channelId = optionalString(params.channelId);
    try {
      const binding = await service.get(surfaceKind, channelId);
      // The binding exists, so a resolution exists; the fallback only guards a delete racing this read.
      const effective = await service.explain(surfaceKind, channelId) ?? { profile: {}, sources: {} };
      return { binding, effective };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createSetHandler(service: ChannelProfilesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      const binding = await service.set({
        surfaceKind: requireStringValue(params.surfaceKind, 'surfaceKind'),
        channelId: optionalString(params.channelId),
        model: optionalString(params.model),
        provider: optionalString(params.provider),
        permissionMode: parseChannelPermissionMode(params.permissionMode),
        metadata: readMetadata(params.metadata),
      });
      return { binding };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createDeleteHandler(service: ChannelProfilesGatewayService): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const surfaceKind = requireStringValue(params.surfaceKind, 'surfaceKind');
    const channelId = optionalString(params.channelId);
    try {
      const deleted = await service.delete(surfaceKind, channelId);
      return { surfaceKind, ...(channelId ? { channelId } : {}), deleted };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

export function registerChannelProfilesGatewayMethods(
  catalog: GatewayMethodCatalog,
  service: ChannelProfilesGatewayService,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => { attachHandler(catalog, id, handler); };
  attach('channels.profiles.list', createListHandler(service));
  attach('channels.profiles.get', createGetHandler(service));
  attach('channels.profiles.set', createSetHandler(service));
  attach('channels.profiles.delete', createDeleteHandler(service));
}
