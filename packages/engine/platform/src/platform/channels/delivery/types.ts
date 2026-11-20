import type { DeliveryLifetime } from '../../utils/delivery-lifetime.js';
import type { ArtifactReference } from '../../artifacts/index.js';
import type { ConfigManager } from '../../config/manager.js';
import type { SecretsManager } from '../../config/secrets.js';
import type { ServiceRegistry } from '../../config/service-registry.js';
import type { ArtifactStore } from '../../artifacts/index.js';
import type { ControlPlaneGateway } from '../../control-plane/gateway.js';
import { ROUTE_SURFACE_KINDS, type RouteSurfaceKind } from '../../../events/routes.js';

/**
 * Surfaces a delivery may be ADDRESSED to: the bindable transport routes. The
 * Agent is not one: it is another process and reads what is waiting for it
 * (occasion reminders through `occasions.pending`) instead of being sent to.
 */
export const CHANNEL_DELIVERY_SURFACE_KINDS = ROUTE_SURFACE_KINDS;

export type ChannelDeliverySurfaceKind = (typeof CHANNEL_DELIVERY_SURFACE_KINDS)[number];
export type ChannelDeliveryTargetKind = 'none' | 'webhook' | 'surface' | 'integration' | 'link';

export interface ChannelDeliveryTarget {
  readonly kind: ChannelDeliveryTargetKind;
  readonly surfaceKind?: ChannelDeliverySurfaceKind | undefined;
  readonly address?: string | undefined;
  readonly routeId?: string | undefined;
  readonly label?: string | undefined;
}

export interface ChannelDeliveryRouteBinding {
  readonly id: string;
  readonly surfaceKind: RouteSurfaceKind;
  readonly surfaceId: string;
  readonly externalId: string;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly title?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

export interface ChannelDeliveryRequest extends DeliveryLifetime {
  readonly target: ChannelDeliveryTarget;
  readonly body: string;
  readonly title: string;
  readonly jobId: string;
  readonly runId: string;
  readonly agentId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly status?: string | undefined;
  readonly includeLinks: boolean;
  /** Explicit repeated sends bypass notification deduplication; absent preserves existing behavior. */
  readonly allowDuplicate?: boolean | undefined;
  /**
   * The identity of what this message announces (`automation:<runId>:result`,
   * `approval:<id>:pending`, `agent:<id>:final:1`). A surface that suppresses
   * repeats does so on this identity, so two different announcements with the
   * same words are both sent. Absent: the surface compares the text.
   */
  readonly announces?: string | undefined;
  readonly attachments?: readonly ArtifactReference[] | undefined;
  readonly binding?: ChannelDeliveryRouteBinding | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

/** Native provider acknowledgement. No credentials or configuration aliases:
 * recipient identity is what the provider actually acknowledged. */
export interface ChannelDeliveryReceipt {
  readonly surfaceKind: ChannelDeliverySurfaceKind;
  readonly conversationId: string;
  readonly messageId: string;
  readonly threadId?: string | undefined;
  /** Public sender account acknowledged by the provider, never a token. */
  readonly accountId?: string | undefined;
}

export interface ChannelDeliveryResult {
  readonly responseId?: string | undefined;
  readonly receipt?: ChannelDeliveryReceipt | undefined;
  /** True when the message was shortened to fit the surface; what went out is not the whole text. */
  readonly truncated?: boolean | undefined;
  /** How many characters of the body did not go out, when `truncated`. */
  readonly omittedChars?: number | undefined;
  /** How many messages the body went out as, when it was longer than one message on the surface. */
  readonly parts?: number | undefined;
  /**
   * True when nothing new was sent: the same announcement (`announces`) went
   * to this target moments ago, so the recipient already has it.
   */
  readonly suppressed?: boolean | undefined;
}

export interface ChannelDeliveryStrategy {
  readonly id: string;
  /** Enforces lifetime restrictions, including publication, at the send boundary after preparation. */
  readonly supportsGuardedDelivery?: boolean | undefined;
  /** Invokes withPublication only around the final dispatch, after preparation. */
  readonly supportsPublication?: boolean | undefined;
  /**
   * Sends `request.attachments` with the message: as the file where the surface
   * takes files, otherwise as a named download link. Absent: attachments are dropped.
   */
  readonly supportsAttachments?: boolean | undefined;
  canHandle(request: ChannelDeliveryRequest): boolean;
  deliver(request: ChannelDeliveryRequest): Promise<ChannelDeliveryResult>;
}

export interface ChannelDeliveryRouterConfig {
  readonly configManager?: ConfigManager | undefined;
  readonly secretsManager?: Pick<SecretsManager, 'get' | 'getGlobalHome'> | undefined;
  readonly serviceRegistry?: ServiceRegistry | undefined;
  readonly artifactStore?: ArtifactStore | undefined;
  readonly controlPlaneGateway?: ControlPlaneGateway | null | undefined;
  readonly strategies?: readonly ChannelDeliveryStrategy[] | undefined;
  /**
   * The bound routes, so a target that names only a route id is sent on that
   * route's surface. Absent: such a target is taken by no strategy.
   */
  readonly routeBindings?: ChannelDeliveryRouteLookup | undefined;
}

/** Finds a bound route by its id. */
export interface ChannelDeliveryRouteLookup {
  getBinding(routeId: string): ChannelDeliveryRouteBinding | undefined;
}

/**
 * Parse a `surfaceKind` or `surfaceKind:address` channel string into a target.
 *
 * The one-line form is how a channel is written in configuration, a check-in
 * delivery channel, a CI watch notifier, so this is the seam between "what the
 * operator typed" and the structured target the router takes. It lives beside
 * the type it produces because it was previously written out twice inside one
 * registrar, once as a helper and once inline, which is exactly how the two
 * copies would have drifted.
 */
export function parseChannelDeliveryTarget(channel: string): ChannelDeliveryTarget {
  const separator = channel.indexOf(':');
  const surfaceKind = (separator === -1 ? channel : channel.slice(0, separator)).trim();
  const address = separator === -1 ? '' : channel.slice(separator + 1).trim();
  return {
    kind: 'surface',
    surfaceKind: surfaceKind as ChannelDeliveryTarget['surfaceKind'],
    ...(address ? { address } : {}),
  };
}

/** Why a channel string names no surface a message can be delivered to; undefined when it does. */
export function deliveryChannelProblem(channel: string): string | undefined {
  const { surfaceKind } = parseChannelDeliveryTarget(channel);
  if ((CHANNEL_DELIVERY_SURFACE_KINDS as readonly string[]).includes(surfaceKind ?? '')) return undefined;
  return `"${channel}" names no delivery surface ("${surfaceKind ?? ''}" is not one of ${CHANNEL_DELIVERY_SURFACE_KINDS.join(', ')})`;
}
