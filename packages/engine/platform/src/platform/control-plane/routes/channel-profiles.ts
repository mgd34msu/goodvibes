/**
 * routes/channel-profiles.ts
 *
 * Handlers for the channels.profiles.* verbs over the ChannelProfileRegistry
 * (../../channel-profiles). Thin verb registration: read the invocation params,
 * call the registry, map a ChannelProfileError to an honest wire status
 * (INVALID_ARGUMENT -> 400, NOT_FOUND -> 404).
 */
import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../method-catalog-shared.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams, requireStringValue } from './invocation-params.js';
import { parseChannelPermissionMode, type SetChannelProfileInput } from '../../channel-profiles/registry.js';
import { attachHandler } from './attach-handler.js';
import {
  ChannelProfileError,
  ChannelProfileRegistry,
} from '../../channel-profiles/index.js';
import type { ApprovalBroker } from '../approval-broker.js';
import { putToOwner } from '../owner-act.js';
import { systemActor } from '@goodvibes/engine/daemon-api/http-policy';
import { admitEffects } from '../../security/effect-authority.js';
import { configKeyFacts } from '../../config/config-key-facts.js';
import { GATE_PRESETS, type GatePresetName } from '../../gate/presets.js';

export type ChannelProfilesGatewayService = Pick<
  ChannelProfileRegistry,
  'list' | 'get' | 'set' | 'delete' | 'explain'
>;

/**
 * What a binding's permission-mode change is judged against: the mode the
 * host gives a session no binding covers, and the approval path a looser mode
 * is put to the owner on (absent: a looser mode from anyone but the owner is
 * refused).
 */
export interface ChannelProfilesModeAuthority {
  /** The host's mode in force for a session with no channel binding (operator vocabulary). */
  readonly hostMode: () => GatePresetName;
  readonly ownerApprovals?: Pick<ApprovalBroker, 'raiseApproval' | 'onApproved'> | undefined;
}

/** The mode a channel key's sessions run under now, or would after `change` (a set's mode, or its removal). */
async function channelModeOf(service: ChannelProfilesGatewayService, authority: ChannelProfilesModeAuthority,
  surfaceKind: string, channelId: string | undefined, change?: { readonly mode: GatePresetName | undefined }): Promise<GatePresetName> {
  if (change === undefined) return (await service.explain(surfaceKind, channelId))?.profile.permissionMode ?? authority.hostMode();
  if (change.mode !== undefined) return change.mode;
  // The key's own mode is removed: the surface-wide binding's applies (to a channel key), else the host's.
  const wide = channelId !== undefined ? (await service.explain(surfaceKind))?.profile.permissionMode : undefined;
  return wide ?? authority.hostMode();
}

/**
 * A change that loosens the mode a channel's sessions run under is the
 * owner's own act (`settings.loosen`), as sessions.permissionMode.set and
 * config.set treat it: allowed, it returns null and the caller applies it; from
 * a caller who is not the owner it is put to the owner (202
 * OWNER_APPROVAL_PENDING) and applied when he approves it; refused (or with no
 * approval path) it is 403 OWNER_ONLY and nothing changes.
 */
async function ownerActForLoosening(invocation: GatewayMethodInvocation, authority: ChannelProfilesModeAuthority,
  service: ChannelProfilesGatewayService, target: { readonly surfaceKind: string; readonly channelId: string | undefined; readonly verb: string; readonly mode: GatePresetName | undefined },
  apply: () => Promise<unknown>): Promise<Response | null> {
  const current = await channelModeOf(service, authority, target.surfaceKind, target.channelId);
  const next = await channelModeOf(service, authority, target.surfaceKind, target.channelId, { mode: target.mode });
  if (configKeyFacts('permissions.mode').loosens?.(GATE_PRESETS[current].mode, GATE_PRESETS[next].mode) !== true) return null;
  const actor = invocation.context.actor ?? systemActor('in-process');
  const admission = admitEffects(actor, ['settings.loosen']);
  if (admission.kind === 'allowed') return null;
  const key = `${target.surfaceKind}${target.channelId ? `:${target.channelId}` : ''}`;
  if (admission.kind === 'refused' || !authority.ownerApprovals) {
    throw new GatewayVerbError(`This would loosen the permission mode the sessions from channel ${key} run under, from ${current} to ${next}, which only the owner does. Nothing was changed.`, 'OWNER_ONLY', 403, 'permissionMode');
  }
  const requestedBy = invocation.context.principalId ?? 'a caller who is not the owner';
  const { approvalId } = await putToOwner(authority.ownerApprovals, {
    summary: `${requestedBy} asks to run the sessions from channel ${key} in ${next}`,
    reasons: [`Changing the permission mode of channel ${key} from ${current} to ${next} loosens it.`],
    tool: target.verb,
    args: { surfaceKind: target.surfaceKind, ...(target.channelId ? { channelId: target.channelId } : {}), permissionMode: next },
    requestedBy,
    apply: async () => { await apply(); },
  });
  const binding = await service.get(target.surfaceKind, target.channelId).catch(() => null);
  return Response.json({
    code: 'OWNER_APPROVAL_PENDING',
    approvalId,
    // Whether this caller may read the approval (approvals.list) and so follow it to its outcome.
    followable: admitEffects(actor, ['approvals.read']).kind === 'allowed',
    binding,
    mode: current,
    requestedMode: next,
    state: `nothing was changed yet; this loosens the permission mode the sessions from channel ${key} run under, which only the owner does, so it was put to him and applies when he approves it`,
    next: [`Watch approval ${approvalId} (approvals.list with approvalId, or the approval-update event).`],
  }, { status: 202 });
}

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

function createSetHandler(service: ChannelProfilesGatewayService, authority: ChannelProfilesModeAuthority): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    try {
      const input: SetChannelProfileInput = {
        surfaceKind: requireStringValue(params.surfaceKind, 'surfaceKind'),
        channelId: optionalString(params.channelId),
        model: optionalString(params.model),
        provider: optionalString(params.provider),
        permissionMode: parseChannelPermissionMode(params.permissionMode),
        metadata: readMetadata(params.metadata),
      };
      // A set replaces the binding, so leaving permissionMode out removes the key's own mode too.
      const pending = await ownerActForLoosening(invocation, authority, service,
        { surfaceKind: input.surfaceKind, channelId: input.channelId, verb: 'channels.profiles.set', mode: input.permissionMode },
        () => service.set(input));
      if (pending) return pending;
      const binding = await service.set(input);
      return { binding };
    } catch (error) {
      rethrowAsVerbError(error);
    }
  };
}

function createDeleteHandler(service: ChannelProfilesGatewayService, authority: ChannelProfilesModeAuthority): GatewayMethodHandler {
  return async (invocation) => {
    const params = readInvocationParams(invocation);
    const surfaceKind = requireStringValue(params.surfaceKind, 'surfaceKind');
    const channelId = optionalString(params.channelId);
    try {
      // Removing a binding that held a tighter mode loosens the mode its channel's sessions run under.
      const pending = await ownerActForLoosening(invocation, authority, service,
        { surfaceKind, channelId, verb: 'channels.profiles.delete', mode: undefined },
        () => service.delete(surfaceKind, channelId));
      if (pending) return pending;
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
  authority: ChannelProfilesModeAuthority,
): void {
  const attach = (id: string, handler: GatewayMethodHandler): void => { attachHandler(catalog, id, handler); };
  attach('channels.profiles.list', createListHandler(service));
  attach('channels.profiles.get', createGetHandler(service));
  attach('channels.profiles.set', createSetHandler(service, authority));
  attach('channels.profiles.delete', createDeleteHandler(service, authority));
}
