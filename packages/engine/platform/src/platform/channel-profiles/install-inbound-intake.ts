/**
 * channel-profiles/install-inbound-intake.ts
 *
 * Wires the inbound-intake enrichment substrate (buildInboundIntakeEnrichment)
 * into the live session origination path WITHOUT every channel adapter having to
 * call it by hand. The composition root (registerGatewayVerbGroups, which already
 * constructs the principal and channel-profile registries) installs this once; it
 * decorates the shared broker's `submitMessage`, the single transport intake
 * chokepoint every adapter funnels an inbound message through, so each inbound
 * message gets its sender attributed and its channel's profile applied at the
 * moment the session is originated.
 *
 * submitMessage's input carries the NARROW transport surface kind (a Slack/Signal/
 * etc. surface, never a product surface like webui/agent, those originate via
 * sessions.register, a different path), so decorating it is inherently scoped to
 * channel inbound. The enrichment only augments the session/message metadata (it
 * never drops or rewrites a caller field), so an unmapped sender is stamped with
 * the honest unknown principal (known:false) rather than a guess.
 */
import type { PrincipalRegistry } from '../principals/index.js';
import type { SubmitSharedSessionMessageInput, SharedSessionSubmission } from './../control-plane/session-types.js';
import { withExecutionModeOwner, type ExecutionModeOwner } from '../gate/execution-context.js';
import type { ChannelPermissionMode } from './types.js';
import { isSettableGatePresetName } from '../gate/presets.js';
import { buildInboundIntakeEnrichment } from './intake.js';
import {
  CHANNEL_PROFILE_MODEL_KEY,
  CHANNEL_PROFILE_PROVIDER_KEY,
  CHANNEL_PROFILE_PERMISSION_MODE_KEY,
} from './intake.js';
import type { ChannelProfileRegistry } from './registry.js';
import type { ChannelPolicyManager } from '../channels/policy-manager.js';

/** The broker surface this decorator needs: just the transport intake entry point. */
export interface InboundIntakeBroker {
  submitMessage(input: SubmitSharedSessionMessageInput): Promise<SharedSessionSubmission>;
  getSession?(sessionId: string): { readonly status: string; readonly channelPermissionMode?: ChannelPermissionMode | undefined;
    readonly channelPermissionModeRevision?: number | undefined } | null;
  bindChannelExecutionMode?(sessionId: string, mode: ChannelPermissionMode): Promise<void>;
  setChannelExecutionMode?(sessionId: string, mode: ChannelPermissionMode): Promise<void>;
}

// Selected from the host registry at origination, never reconstructed from metadata.
const channelModeOwners = new WeakMap<object, Map<string, ExecutionModeOwner>>();

export function channelExecutionModeOwner(broker: Pick<InboundIntakeBroker, 'getSession'>, sessionId: string): ExecutionModeOwner | undefined {
  let owners = channelModeOwners.get(broker);
  const retained = owners?.get(sessionId);
  if (retained) return retained;
  const mode = broker.getSession?.(sessionId)?.channelPermissionMode;
  if (mode === undefined) return undefined;
  if (!isSettableGatePresetName(mode)) throw new Error('Stored channel execution mode is invalid');
  owners ??= new Map();
  channelModeOwners.set(broker, owners);
  const owner = createChannelModeOwner(broker, sessionId, mode);
  owners.set(sessionId, owner);
  return owner;
}

function createChannelModeOwner(broker: Pick<InboundIntakeBroker, 'getSession'>, sessionId: string, mode: ChannelPermissionMode): ExecutionModeOwner {
  const current = () => {
    const session = broker.getSession?.(sessionId);
    if (broker.getSession && session?.status !== 'active') throw new Error('Channel execution session is no longer active');
    const selected = session?.channelPermissionMode ?? mode;
    if (!isSettableGatePresetName(selected)) throw new Error('Channel execution mode is invalid');
    return { mode: selected, revision: session?.channelPermissionModeRevision ?? 0 };
  };
  return Object.freeze({ getMode: () => current().mode, getRevision: () => current().revision });
}

/** Dispatch an actual broker-owned session under its configured channel default. */
export function withChannelExecutionMode<T>(broker: Pick<InboundIntakeBroker, 'getSession'>, sessionId: string | undefined, run: () => T): T {
  const owner = sessionId === undefined ? undefined : channelExecutionModeOwner(broker, sessionId);
  return owner ? withExecutionModeOwner(owner, run) : run();
}

export interface InboundIntakeEnrichmentDeps {
  readonly principals: Pick<PrincipalRegistry, 'resolveByIdentity'>;
  readonly channelProfiles: Pick<ChannelProfileRegistry, 'resolve'>;
  /**
   * Optional: the channel ingress-policy manager. When present, a sender who
   * is not a named principal but whom this surface's owner allowlist already
   * authorizes is attributed to the honest owner principal instead of the
   * unknown one, see {@link attributeInboundSession}. Absent (a narrower
   * composition, or every existing test) keeps the prior unknown-principal
   * behavior exactly.
   */
  readonly channelPolicy?: Pick<ChannelPolicyManager, 'getPolicy'> | undefined;
}

/**
 * Compute the metadata an inbound submit input should carry: the sender
 * attribution plus the applied channel profile (model/provider/permission mode),
 * merged over whatever metadata the caller already set. Exported for direct
 * testing of the enrichment mapping independent of the broker decoration.
 */
export async function enrichInboundSubmitMetadata(
  deps: InboundIntakeEnrichmentDeps,
  input: SubmitSharedSessionMessageInput,
): Promise<Record<string, unknown>> {
  return (await enrichInboundSubmit(deps, input)).metadata;
}

async function enrichInboundSubmit(
  deps: InboundIntakeEnrichmentDeps,
  input: SubmitSharedSessionMessageInput,
): Promise<{ readonly metadata: Record<string, unknown>; readonly permissionMode: ChannelPermissionMode | undefined }> {
  const enrichment = await buildInboundIntakeEnrichment(deps, {
    surfaceKind: input.surfaceKind,
    userId: input.userId,
    // Scope the profile to the originating channel when the input identifies one,
    // else fall back to the surface-level binding.
    channelId: input.externalId ?? input.surfaceId,
  });
  const metadata: Record<string, unknown> = {
    ...(input.metadata ?? {}),
    ...enrichment.sessionMetadata,
    ...(enrichment.spawnOverrides.model !== undefined ? { [CHANNEL_PROFILE_MODEL_KEY]: enrichment.spawnOverrides.model } : {}),
    ...(enrichment.spawnOverrides.provider !== undefined ? { [CHANNEL_PROFILE_PROVIDER_KEY]: enrichment.spawnOverrides.provider } : {}),
    ...(enrichment.permissionMode !== undefined ? { [CHANNEL_PROFILE_PERMISSION_MODE_KEY]: enrichment.permissionMode } : {}),
  };
  if (enrichment.permissionMode === undefined) delete metadata[CHANNEL_PROFILE_PERMISSION_MODE_KEY];
  return { metadata, permissionMode: enrichment.permissionMode };
}

/**
 * Decorate a broker's submitMessage so every inbound transport message is
 * enriched before origination. Idempotent guard: a broker already wrapped is left
 * as-is so a double install (defensive composition) never double-stamps.
 */
export function installInboundIntakeEnrichment(
  broker: InboundIntakeBroker,
  deps: InboundIntakeEnrichmentDeps,
): void {
  const marked = broker as InboundIntakeBroker & { __inboundIntakeEnriched?: boolean };
  if (marked.__inboundIntakeEnriched) return;
  const original = broker.submitMessage.bind(broker);
  const owners = new Map<string, ExecutionModeOwner>();
  channelModeOwners.set(broker, owners);
  broker.submitMessage = async (input: SubmitSharedSessionMessageInput) => {
    const { metadata, permissionMode } = await enrichInboundSubmit(deps, input);
    const result = await original({ ...input, metadata });
    if (result.created && permissionMode !== undefined) {
      const sessionId = result.session.id;
      await broker.bindChannelExecutionMode?.(sessionId, permissionMode);
      owners.set(sessionId, createChannelModeOwner(broker, sessionId, permissionMode));
    }
    if (broker.getSession) {
      for (const sessionId of owners.keys()) {
        if (broker.getSession(sessionId)?.status !== 'active') owners.delete(sessionId);
      }
    }
    return result;
  };
  marked.__inboundIntakeEnriched = true;
}
