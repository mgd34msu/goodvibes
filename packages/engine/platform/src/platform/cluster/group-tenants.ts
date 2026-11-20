/**
 * group-tenants.ts, one place where a feature adds a family of messages to the
 * group's signed channel.
 *
 * The group key proves a datagram came from inside the group; it does not say
 * which member sent it, because every member holds that key. A tenant whose
 * messages act on another member's behalf (a relayed approval decision) needs
 * to know the sender, so every tenant message also carries the sender's
 * identity signature (`idSig`), made with the node identity key that never
 * rotates and checked against the key the group record holds for that member.
 * A message from a node that is not a current member, or whose identity
 * signature does not verify, never reaches the tenant.
 *
 * Messages go to every member (the transport is a broadcast); one meant for one
 * member names it in `to`, and the others drop it unread.
 *
 * Cost: one Ed25519 signature per message sent and one verification per
 * message received; nothing is written.
 */
import type { ClusterEnvelope } from './protocol-envelope.js';

/** A family of group messages handled by one feature. */
export interface GroupTenant {
  /** The envelope types it owns, e.g. `APPROVAL_STATE`. Never a type the group layer owns itself. */
  readonly types: readonly string[];
  /** A verified message from a current member (never this machine's own). */
  handle(envelope: ClusterEnvelope, from: { readonly nodeId: string }): Promise<void> | void;
}

/** What a tenant may do on the group's channel. */
export interface GroupTenantHost {
  /** This machine's node id. */
  readonly selfNode: string;
  /** Add a tenant; returns its removal. */
  register(tenant: GroupTenant): () => void;
  /** Send one tenant message, identity-signed; `to` limits it to one member. Nothing is sent outside a group. */
  send(type: string, body: Record<string, unknown>, to?: string): Promise<void>;
  /** Whether `nodeId` is a current member of this machine's group (removed and unknown nodes are not). */
  isCurrentMember(nodeId: string): boolean;
  /** When this machine last heard any signed datagram from `nodeId`, or null. */
  lastHeardFrom(nodeId: string): number | null;
  /** How long without a datagram before a member reads as unreachable. */
  readonly silenceMs: number;
  /** Called when a member is heard after silence (or for the first time): the moment to ask it for its state. */
  onMemberHeard(listener: (nodeId: string) => void): () => void;
}

/** Deterministic JSON, object keys sorted at every level: what an identity signature covers. */
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** The bytes a tenant message's identity signature covers: who sent which type, when, in which group, and the body. */
export function tenantSigningBytes(groupId: string, type: string, nodeId: string, ts: number, seq: number, body: Record<string, unknown>): string {
  const { idSig: _idSig, ...signed } = body;
  return `goodvibes-group-tenant\n${groupId}\n${type}\n${nodeId}\n${ts}\n${seq}\n${stableJson(signed)}`;
}
