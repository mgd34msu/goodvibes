/**
 * owner-alert.ts, reaching the owner when the thing that broke is a channel.
 *
 * An alert names internal failures, so it goes only to conversations that are
 * the owner's own: a direct conversation with the surface's owner, or a
 * surface that is private by nature (the owner's ntfy topic). A group, a
 * shared channel, a webhook route or a Home Assistant conversation (a voice
 * pipeline that names the device, never the speaker) is never a candidate,
 * however recently it was used.
 *
 * Among the owner's conversations, two facts decide the order:
 *
 * 1. Inbound and outbound fail independently. Telegram's sends worked all day
 *    while its receives were being dropped. So the failing surface's own
 *    conversation is still the FIRST choice, it is where the owner is already
 *    looking, and it usually still works.
 * 2. But it might not. So a refusal is not the end: the alert falls back to the
 *    owner's most recently used conversation on any OTHER surface.
 *
 * When no owner conversation exists or none accepted it, the alert is kept as
 * a daemon receipt, which the next attached terminal or web UI shows, and is
 * logged at error with every refusal reason.
 */

import type { AutomationRouteBinding } from '../automation/routes.js';
import type { RouteBindingManager } from '../channels/route-manager.js';
import type { ChannelSurface } from '../channels/types.js';
import type { DaemonSurfaceDeliveryHelper } from './surface-delivery.js';
import { logger } from '../utils/logger.js';

/** What an owner alert needs from the delivery helper. */
export type OwnerAlertDelivery = Pick<DaemonSurfaceDeliveryHelper, 'deliverSurfaceNotice' | 'channelOwner' | 'recordOwnerReceipt'>;

function metadataText(binding: AutomationRouteBinding, key: string): string | undefined {
  // A binding saved by an older build can lack metadata altogether.
  const value = (binding.metadata as Record<string, unknown> | undefined)?.[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

/**
 * True when the binding is one of the owner's own conversations. `owner` is
 * the surface's owner user id, or undefined when the surface names none.
 * Anything the binding does not prove to be private and the owner's is left
 * out, so an alert never reaches a shared place on a guess.
 */
export function isOwnerConversation(binding: AutomationRouteBinding, owner: string | undefined): boolean {
  if (binding.surfaceKind === 'ntfy') return true;
  // A webhook route describes itself: its user id and conversation kind are
  // whatever the caller sent, and its answer goes to a callback the caller
  // chose. Nothing on it can prove a private conversation with the owner.
  if (binding.surfaceKind === 'webhook') return false;
  // A Home Assistant conversation is a voice pipeline: it reports the device,
  // never the speaker, and its answer is spoken in a room anyone can be in.
  if (binding.surfaceKind === 'homeassistant') return false;
  if (owner === undefined) return false;
  const sender = metadataText(binding, 'userId') ?? metadataText(binding, 'fromId')
    ?? metadataText(binding, 'senderId') ?? metadataText(binding, 'from');
  if (sender !== owner) return false;
  const kind = metadataText(binding, 'conversationKind');
  const chatType = metadataText(binding, 'chatType');
  if (kind !== undefined || chatType !== undefined) return kind === 'direct' || chatType === 'private';
  if (metadataText(binding, 'groupId') !== undefined) return false;
  // A one-to-one chat on these surfaces is keyed by the person in it.
  return binding.externalId === owner || binding.channelId === owner;
}

/** Newest-first by last use, which is the best available proxy for "works". */
function byMostRecentlySeen(bindings: readonly AutomationRouteBinding[]): AutomationRouteBinding[] {
  return [...bindings].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
}

/**
 * The conversations to try, in order: the failing surface's own newest first,
 * then every other surface's, newest first.
 *
 * `preferred` is null when the alert is not ABOUT a channel, the daemon
 * failing to update itself, for instance. There is no surface to try first
 * then, so the order is simply newest-used first, which is the same
 * "best available proxy for works" the rest of this file runs on.
 */
export function orderOwnerAlertRoutes(
  bindings: readonly AutomationRouteBinding[],
  preferred: ChannelSurface | null,
): AutomationRouteBinding[] {
  const ordered = byMostRecentlySeen(bindings);
  if (preferred === null) return ordered;
  return [
    ...ordered.filter((binding) => binding.surfaceKind === preferred),
    ...ordered.filter((binding) => binding.surfaceKind !== preferred),
  ];
}

/**
 * Put one line in front of the owner, trying conversations until one accepts.
 *
 * Returns the binding it was delivered on, or null when nothing took it.
 */
export async function deliverOwnerAlert(
  routeBindings: RouteBindingManager,
  delivery: OwnerAlertDelivery,
  preferred: ChannelSurface | null,
  text: string,
  /** What the alert stands for in Waiting for you (`approval:<id>`): a kept line is retired once that is answered. */
  about?: string,
): Promise<AutomationRouteBinding | null> {
  let candidates: AutomationRouteBinding[];
  try {
    const owners = new Map<string, string | undefined>();
    const ownerOf = (surface: string) => {
      if (!owners.has(surface)) owners.set(surface, delivery.channelOwner(surface));
      return owners.get(surface);
    };
    candidates = orderOwnerAlertRoutes(
      routeBindings.listBindings().filter((binding) => isOwnerConversation(binding, ownerOf(binding.surfaceKind))),
      preferred,
    );
  } catch (error) {
    // Route binding can be switched off entirely, in which case listing throws
    // rather than returning nothing. There is no route to alert on, and it
    // must not take down the caller reporting a failure.
    logger.error('An alert for the owner could not be routed: route bindings are unavailable', {
      preferred,
      error: error instanceof Error ? error.message : String(error),
    });
    keepAsReceipt(delivery, text, about);
    return null;
  }
  const refusals: string[] = [];
  for (const binding of candidates) {
    try {
      const result = await delivery.deliverSurfaceNotice(binding, text);
      if (result.delivered) return binding;
      refusals.push(`${binding.surfaceKind}:${result.reason ?? 'unknown'}`);
    } catch (error) {
      // One malformed or unreachable route must not stop the next one from
      // being tried, and the fire-and-forget caller has no handler for a rejection.
      refusals.push(`${binding.surfaceKind}:threw ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  logger.error('An alert for the owner reached no channel at all', {
    preferred,
    text,
    triedRoutes: candidates.length,
    refusals,
  });
  keepAsReceipt(delivery, text, about);
  return null;
}

function keepAsReceipt(delivery: OwnerAlertDelivery, text: string, about?: string): void {
  try {
    delivery.recordOwnerReceipt(text, about);
  } catch (error) {
    logger.error('An alert for the owner could not be kept for the next surface', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
