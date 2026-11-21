/**
 * group-transport.ts, one socket, two tenants.
 *
 * The group layer owns the datagram socket. Leader election is a TENANT on it:
 * every election datagram is wrapped in the group envelope, signed with the
 * current group key, and unwrapped on the far side before the election state
 * machine ever sees it. The election is not aware of any of this, which is
 * exactly the point, it means group membership, rotation and revocation are
 * enforced in ONE place, at the edge, and no state machine downstream has to
 * remember to check.
 *
 * Two consequences worth stating plainly:
 *
 *   - a datagram from a node that is not in this group never reaches the
 *     election. Two groups sharing one multicast address are mutually
 *     invisible, and it costs one string compare to keep them that way;
 *
 *   - a node whose group key was rotated out, because it was REMOVED, stops
 *     being heard on the same tick, without the election needing a concept of
 *     revocation at all.
 */
import { CONFIG_MESSAGE_TYPES } from './config-replication.js';
import { GROUP_MESSAGE_TYPES, isOutOfBandMessageType } from './group-membership.js';
import { MAX_DATAGRAM_SKEW_MS } from './protocol.js';
import { ClusterOwnedLifecycle } from './owned-lifecycle.js';
import {
  decodeEnvelope,
  encodeEnvelope,
  peekEnvelope,
  isWireSurfaceId,
  type ClusterEnvelope,
  type ClusterKeyring,
  type EnvelopeRejection,
} from './protocol-envelope.js';
import type { ClusterLogger, ClusterTransport, ClusterTransportDescription } from './types.js';

/** Envelope types the group layer handles itself rather than passing down, derived from the group and config message registries. */
const GROUP_OWNED_TYPES: ReadonlySet<string> = new Set<string>([
  GROUP_MESSAGE_TYPES.beacon, GROUP_MESSAGE_TYPES.roster, ...Object.values(CONFIG_MESSAGE_TYPES),
]);

/**
 * Fields lifted out of an election message onto the envelope, and put back on
 * arrival.
 *
 * These are exactly the fields the envelope has its own home for, and they mean
 * the same thing in both places. `v` and `sig` are deliberately NOT lifted:
 * `v` is the ELECTION protocol's version, which is a different number from the
 * envelope's own version, and `sig` is the election's optional signature under
 * `cluster.secret`, which is independent of the group key. Both ride in `body`,
 * where the envelope signature still covers them.
 */
const LIFTED_FIELDS = ['type', 'surfaceId', 'nodeId', 'nodeVersion', 'seq', 'ts'] as const;

/** Running totals, surfaced in `cluster status` so drops are visible rather than inferred. */
export interface GroupWireCounters {
  sent: number;
  received: number;
  droppedOtherGroup: number;
  droppedBadSignature: number;
  droppedMalformed: number;
  droppedOldGeneration: number;
  /** Outbound election datagrams not sent because this machine is in no group. */
  droppedNoGroup: number;
}

export interface GroupWireRouterOptions {
  readonly inner: ClusterTransport;
  readonly keyring: ClusterKeyring;
  readonly logger: ClusterLogger;
  readonly now: () => number;
  /** BEACON / ROSTER that verified against the group key. */
  readonly onGroupMessage: (envelope: ClusterEnvelope) => void;
  /** JOIN / REJOIN and their replies, authenticated by the membership layer, not here. */
  readonly onOutOfBandMessage: (raw: string, type: string) => void;
  /** A beacon from a DIFFERENT group. Advertisement only; never acted on. */
  readonly onForeignBeacon: (groupId: string, body: Record<string, unknown>, version: string) => void;
  /**
   * A datagram claimed a key generation this machine does not hold or does
   * not accept yet, or was signed under a generation it holds with a key that
   * did not verify (another minter's key for that generation won on the
   * group's record): the group moved on while this machine was not listening.
   * Unauthenticated (the signature could not be checked), so it may only
   * prompt a verified catch-up, never act on the datagram. `generation` and
   * `fromNodeId` are what the datagram claimed (hints, not facts).
   */
  readonly onGenerationNotHeld?: ((generation: number | null, fromNodeId: string | null, cause: 'generation' | 'signature') => void) | undefined;
  /**
   * Why this machine holds no group key, when it holds none: it is in no group,
   * or its stored membership could not be confirmed. Absent means "no group".
   */
  readonly membership?: (() => 'no-group' | 'member' | 'unreadable-key-material') | undefined;
}

/**
 * Routes every inbound datagram to exactly one destination, and wraps every
 * outbound election datagram.
 */
export class GroupWireRouter {
  readonly counters: GroupWireCounters = {
    sent: 0,
    received: 0,
    droppedOtherGroup: 0,
    droppedBadSignature: 0,
    droppedMalformed: 0,
    droppedOldGeneration: 0,
    droppedNoGroup: 0,
  };

  private readonly lifecycle = new ClusterOwnedLifecycle(
    async () => { await this.options.inner.start((raw) => { if (typeof raw === 'string') this.receive(raw); }); },
    async () => {
      this.clearElectionListener();
      try { await this.options.inner.stop(); }
      finally { this.clearElectionListener(); }
    },
  );
  /** The reason for holding no key that was last said; null while a key is held. */
  private announcedNoGroup: 'no-group' | 'unreadable-key-material' | null = null;
  private electionListener: ((datagram: string | Readonly<Record<string, unknown>>) => void) | null = null;
  private electionListenerGeneration = 0;
  private seq = 0;
  /** Envelope types a group tenant registered (group-tenants.ts): handled by the group layer, never the election. */
  private readonly tenantTypes = new Set<string>();

  constructor(private readonly options: GroupWireRouterOptions) {}

  /** Start the underlying socket. Idempotent, both tenants may call it. */
  ensureStarted(): Promise<void> {
    return this.lifecycle.start();
  }

  stop(): Promise<void> {
    return this.lifecycle.stop();
  }

  describe(): ClusterTransportDescription {
    return this.options.inner.describe();
  }

  /** Hand `types` to the group layer instead of the election; returns the removal. */
  ownTypes(types: readonly string[]): () => void {
    for (const type of types) {
      if (GROUP_OWNED_TYPES.has(type)) throw new Error(`cluster: ${type} is a group message type already`);
      this.tenantTypes.add(type);
    }
    return () => { for (const type of types) this.tenantTypes.delete(type); };
  }

  /** Next per-node sequence number. Shared by both tenants so it never repeats. */
  nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }

  /** Send a datagram the group layer built itself (already a full envelope). */
  async sendRaw(raw: string): Promise<void> {
    this.counters.sent += 1;
    await this.options.inner.send(raw);
  }

  /**
   * The transport handed to `ClusterCoordinator`.
   *
   * Deliberately a plain object rather than a subclass: the coordinator only
   * ever calls these four methods, and keeping the seam this narrow is what
   * lets the election stay entirely unaware of the group layer.
   */
  electionTransport(nodeVersion: string): ClusterTransport {
    return {
      // The group key signs every election datagram and receive() checks its clock skew.
      groupKeyed: true,
      start: async (onMessage) => {
        const generation = ++this.electionListenerGeneration;
        await this.ensureStarted();
        // Publish only after acquisition succeeds. A stop or newer start can
        // invalidate this registration while the shared socket is opening.
        if (generation === this.electionListenerGeneration) this.electionListener = onMessage;
      },
      send: async (raw) => {
        const wrapped = this.wrapElectionMessage(raw, nodeVersion);
        if (!wrapped) return;
        await this.sendRaw(wrapped);
      },
      // The socket belongs to the group runtime, whose own lifecycle closes it.
      // A coordinator shutting down must not take the beacon down with it.
      stop: async () => {
        this.clearElectionListener();
      },
      describe: () => this.describe(),
    };
  }

  private clearElectionListener(): void {
    this.electionListenerGeneration += 1;
    this.electionListener = null;
  }

  // ── outbound ──────────────────────────────────────────────────────────────

  /**
   * Lift an election message into the group envelope.
   *
   * The merged wire format is ONE object carrying the group's fields and the
   * surface's together:
   *
   *   { v, groupId, keyGen, surfaceId, type, nodeId, nodeVersion, seq, ts, body, sig }
   *
   * so a datagram is answerable for which group it belongs to, which key
   * generation signed it, AND which surface it is about, all under one
   * signature. Whatever the election put on the message beyond those fields
   * rides in `body` untouched, so the message that comes out the far side is
   * the one that went in.
   */
  private wrapElectionMessage(raw: string, nodeVersion: string): string | null {
    // No group, nothing to sign with. This is the explicitly-handled state, not
    // a failure: the machine coordinates with nobody, consumes locally exactly
    // as it did before clustering existed, and `cluster status` says so and
    // names the two commands that fix it.
    //
    // Said once per change of reason. The election heartbeats every few
    // seconds, so warning per datagram would bury the machine's logs in a
    // message whose answer never changes.
    if (this.options.keyring.acceptedGenerations().length === 0) {
      this.counters.droppedNoGroup += 1;
      const reason = this.options.membership?.() === 'unreadable-key-material' ? 'unreadable-key-material' : 'no-group';
      if (this.announcedNoGroup !== reason) {
        this.announcedNoGroup = reason;
        if (reason === 'no-group') {
          this.options.logger.info(
            'cluster: this machine is not in a group, so it is coordinating with nobody and reading its own inbox',
            { action: 'create a group with `cluster create`, or join one with `cluster join`' },
          );
        } else {
          this.options.logger.warn(
            'cluster: this machine\'s group membership could not be confirmed, so it is coordinating with nobody and reading its own inbox',
            { action: 'the stored membership is read again every 30 seconds; see `cluster status`' },
          );
        }
      }
      return null;
    }
    this.announcedNoGroup = null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.options.logger.warn('cluster: an election datagram was not JSON and was not sent');
      return null;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const message = parsed as Record<string, unknown>;
    const type = message['type'];
    const nodeId = message['nodeId'];
    if (typeof type !== 'string' || typeof nodeId !== 'string') return null;

    const body: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(message)) {
      if (!(LIFTED_FIELDS as readonly string[]).includes(key)) body[key] = value;
    }
    // The election owns derivation from the original private consumer key.
    // Preserve that exact ID and its inner signature; a malformed caller must
    // not mint a different identity by hashing arbitrary text at this boundary.
    const surfaceId = message['surfaceId'] ?? null;
    if (surfaceId !== null && !isWireSurfaceId(surfaceId)) {
      this.counters.droppedMalformed += 1;
      return null;
    }

    try {
      return encodeEnvelope(
        {
          type,
          nodeId,
          nodeVersion: typeof message['nodeVersion'] === 'string' ? message['nodeVersion'] : nodeVersion,
          seq: typeof message['seq'] === 'number' ? message['seq'] : this.nextSeq(),
          // The election stamps its own send time, and the holder-timeout logic
          // on the far side reads it. Re-stamping here would replace the
          // sender's clock with the wrapper's.
          ts: typeof message['ts'] === 'number' ? message['ts'] : this.options.now(),
          surfaceId,
          body,
        },
        this.options.keyring,
      );
    } catch (error) {
      this.options.logger.warn('cluster: an election datagram could not be signed and was not sent', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Rebuild the election's own message from a verified envelope: every lifted
   * field goes back under the name the election gave it, with the body around
   * them. Handed over as fields, not re-serialised: the group key already
   * authenticated it, so the election only validates the shape.
   */
  private unwrapElectionMessage(envelope: ClusterEnvelope): Readonly<Record<string, unknown>> {
    return {
      ...envelope.body,
      type: envelope.type,
      surfaceId: envelope.surfaceId,
      nodeId: envelope.nodeId,
      nodeVersion: envelope.nodeVersion,
      seq: envelope.seq,
      ts: envelope.ts,
    };
  }

  // ── inbound ───────────────────────────────────────────────────────────────

  private receive(raw: string): void {
    this.counters.received += 1;

    // Join and rejoin traffic is authenticated by the membership layer against
    // the join verifier or a roster public key, this node may not even hold a
    // key the sender could have used. Hand it over unopened.
    const peeked = peekEnvelope(raw);
    if (peeked && isOutOfBandMessageType(peeked.type)) {
      this.options.onOutOfBandMessage(raw, peeked.type);
      return;
    }

    const decoded = decodeEnvelope(raw, this.options.keyring);
    if (!decoded.envelope) {
      this.countRejection(decoded.rejected);
      const claimed = this.claimedNewerGeneration(raw, decoded.rejected);
      if (claimed !== undefined) this.options.onGenerationNotHeld?.(claimed, peeked?.nodeId ?? null, 'generation');
      else if (decoded.rejected === 'signature-did-not-verify' && peeked?.nodeId) this.options.onGenerationNotHeld?.(null, peeked.nodeId, 'signature');
      if (
        decoded.rejected === 'other-group'
        && peeked?.type === 'BEACON'
        && decoded.claimedGroupId !== null
      ) {
        this.options.onForeignBeacon(decoded.claimedGroupId, peeked.body, readVersion(raw));
      }
      return;
    }

    // A signature proves who sent a datagram, not when: a captured one replayed
    // into a node that just restarted would otherwise be taken as live.
    const skew = Math.abs(this.options.now() - decoded.envelope.ts);
    if (skew > MAX_DATAGRAM_SKEW_MS) {
      this.counters.droppedMalformed += 1;
      this.options.logger.debug('cluster: dropped a datagram whose timestamp is too far from this machine\'s clock', {
        type: decoded.envelope.type,
        skewSeconds: Math.round(skew / 1_000),
      });
      return;
    }

    if (GROUP_OWNED_TYPES.has(decoded.envelope.type) || this.tenantTypes.has(decoded.envelope.type)) {
      this.options.onGroupMessage(decoded.envelope);
      return;
    }
    this.electionListener?.(this.unwrapElectionMessage(decoded.envelope));
  }

  /**
   * A generation we do not hold, or one ahead of ours (a rotation we missed):
   * the generation claimed, or null when it could not be read. Undefined when
   * the datagram claims nothing newer: a generation BEHIND ours is the sender
   * being stale, which is not our gap.
   */
  private claimedNewerGeneration(raw: string, rejection: EnvelopeRejection | null): number | null | undefined {
    if (rejection !== 'generation-not-held' && rejection !== 'generation-not-accepted') return undefined;
    let claimed: unknown;
    try {
      claimed = (JSON.parse(raw) as Record<string, unknown>)['keyGen'];
    } catch {
      claimed = undefined;
    }
    const generation = typeof claimed === 'number' && Number.isSafeInteger(claimed) && claimed >= 0 ? claimed : null;
    if (rejection === 'generation-not-held') return generation === null || generation > this.options.keyring.currentGeneration ? generation : undefined;
    return generation !== null && generation > this.options.keyring.currentGeneration ? generation : undefined;
  }

  private countRejection(rejection: EnvelopeRejection | null): void {
    switch (rejection) {
      case 'other-group':
        this.counters.droppedOtherGroup += 1;
        return;
      case 'signature-did-not-verify':
        this.counters.droppedBadSignature += 1;
        return;
      case 'generation-not-accepted':
      case 'generation-not-held':
        this.counters.droppedOldGeneration += 1;
        return;
      default:
        this.counters.droppedMalformed += 1;
    }
  }
}

/** Pull the advertised build version off a beacon this node cannot verify. */
function readVersion(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return 'unknown';
    const version = (parsed as Record<string, unknown>)['nodeVersion'];
    return typeof version === 'string' && version.length <= 64 ? version : 'unknown';
  } catch {
    return 'unknown';
  }
}
