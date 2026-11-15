/**
 * group-admissions.ts, the JOIN and REJOIN exchange, both ends of it.
 *
 * Split out of the runtime because it is the part with the security property in
 * it: everything here either decides whether a machine may enter the group, or
 * hands the group's secrets to one that may. Keeping it in one file means the
 * whole of that decision fits on a screen or two and can be read as a unit.
 *
 * The runtime owns the socket and the key material; this service borrows both
 * through {@link AdmissionHost} and owns nothing persistent of its own except
 * the single in-flight request this node is waiting on.
 */
import { createHash } from 'node:crypto';
import { deriveJoinVerifier, generateNodeKeyMaterial, type NodeKeyMaterial } from './group-crypto.js';
import {
  checkIdentityClassMessage,
  checkJoinClassMessage,
  decideAdmission,
  describeRefusal,
  encodeIdentityClassMessage,
  encodeJoinClassMessage,
  GROUP_MESSAGE_TYPES,
  joinKeyFingerprint,
  openGrant,
  parseJoinRequestBody,
  parseRejoinRequestBody,
  peekIdentityClassMessage,
  sealGrant,
  type AdmissionGrant,
  type AdmissionRefusal,
} from './group-membership.js';
import {
  admitMember,
  findTombstone,
  MAX_GROUP_MEMBERS,
  readmitMember,
  type GroupMember,
  type GroupStateDocument,
} from './group-state.js';
import type { GroupKeyMaterial } from './group-store.js';
import { readUnverifiedEnvelope } from './protocol-envelope.js';
import type { ClusterClock, ClusterLogger } from './types.js';

/** Refusals one member will send in a window; past it, further ones are dropped. */
const MAX_REFUSALS_PER_WINDOW = 16;
const REFUSAL_WINDOW_MS = 10_000;
/**
 * How long a join keeps waiting after a reply it cannot verify (the sign of a
 * wrong join key) for a grant that would prove otherwise, before saying so.
 */
const MISMATCH_SETTLE_MS = 2_000;
const JOIN_KEY_MISMATCH = 'a machine in that group answered and the join key did not match';

/**
 * A digest of the whole datagram. The sig field alone can be copied from a
 * broadcast request onto an altered one, so a refusal is bound to the exact
 * bytes asked about: any change to the request changes the digest.
 */
function requestSignature(raw: string): string | null {
  return readUnverifiedEnvelope(raw) ? createHash('sha256').update(raw).digest('hex') : null;
}

/** What the admission service borrows from the runtime. */
export interface AdmissionHost {
  readonly nodeId: string;
  readonly version: string;
  readonly nodeDisplayName: string;
  readonly clock: ClusterClock;
  readonly logger: ClusterLogger;
  material(): GroupKeyMaterial | null;
  state(): GroupStateDocument | null;
  commitState(state: GroupStateDocument, gossip: boolean): Promise<void>;
  send(raw: string): Promise<void>;
  nextSeq(): number;
  /**
   * True when this member is the one that answers a JOIN from `joiner`. Every
   * member reaches the same answer from the roster, so a join gets one reply,
   * one roster write and one grant however many members hear it.
   */
  answersJoinFrom(joiner: string): boolean;
}

/**
 * Why an admission request failed, when the caller must act differently.
 *
 * - `unanswered`, nobody replied. The ordinary case for a machine that booted
 *   before its peers, and it resolves itself when they come up.
 *
 * - `refused`, a member said no AND proved it was a member when it said so.
 *   This is final: the machine is out, waiting changes nothing, and the
 *   operator has to put it back by hand. Only an AUTHENTICATED refusal reaches
 *   this, which is what stops anything on the network from talking a machine
 *   out of its own group by shouting at it.
 *
 * - `unverifiable-replies`, replies arrived and none of them could be
 *   authenticated. Deliberately NOT final, because this machine genuinely
 *   cannot tell the two possible causes apart: it may have been away across a
 *   removal and no longer recognise any current member, or a stranger may be
 *   sending it noise. It is worth telling the operator about and it is not
 *   worth asserting a removal over.
 *
 * - `not-sent`, the request never left this machine.
 *
 * - `abandoned`, this machine gave up before the deadline (the daemon shut
 *   down), so nothing is known about the group's answer.
 */
export type AdmissionFailure = 'unanswered' | 'refused' | 'unverifiable-replies' | 'not-sent' | 'abandoned';

export type AdmissionOutcome =
  | { readonly ok: true; readonly grant: AdmissionGrant; readonly node: NodeKeyMaterial }
  | { readonly ok: false; readonly reason: string; readonly failure: AdmissionFailure };

interface PendingAdmission {
  readonly kind: 'join' | 'rejoin';
  readonly groupId: string;
  joinVerifier: string | null;
  readonly node: NodeKeyMaterial;
  deadline: number;
  readonly settle: (result: AdmissionOutcome) => void;
  cancelDeadline?: () => void;
  /**
   * The signature on the request this machine sent. A refusal must echo it, so a
   * refusal produced by someone else's forged request in this machine's name
   * cannot be mistaken for the group's answer to this one.
   */
  requestSig?: string | null;
  /**
   * Replies addressed to this machine that arrived and could not be
   * authenticated. Counted so the timeout can tell "the group is not there"
   * from "the group is there and no longer knows me".
   */
  unauthenticatedReplies: number;
}

export class GroupAdmissionService {
  private pending: PendingAdmission | null = null;
  private active = true;
  private revision = 0;
  private readonly work = new Set<Promise<void>>();
  private refusalWindowStart = 0;
  private refusalsInWindow = 0;

  constructor(private readonly host: AdmissionHost) {}

  /** Refusals are unauthenticated-triggered traffic; cap what one member emits. */
  private allowRefusal(): boolean {
    const now = this.host.clock.now();
    if (now - this.refusalWindowStart >= REFUSAL_WINDOW_MS || now < this.refusalWindowStart) {
      this.refusalWindowStart = now;
      this.refusalsInWindow = 0;
    }
    if (this.refusalsInWindow >= MAX_REFUSALS_PER_WINDOW) return false;
    this.refusalsInWindow += 1;
    return true;
  }

  /** Fail an in-flight request, on shutdown, or when its deadline passes. */
  expire(now: number, reason: string): void {
    if (this.pending && this.pending.deadline <= now) {
      const pending = this.pending;
      this.settle(pending.joinVerifier === null
        ? { ok: false, failure: 'not-sent', reason: 'the admission deadline elapsed while preparing the join proof' }
        : { ok: false, failure: 'unanswered', reason }, pending);
    }
  }

  /** Reopen only after the owning runtime has acquired its transport. */
  start(): void { if (!this.active) { this.active = true; this.revision += 1; } }

  /** Stop immediately, including requests still deriving their verifier. */
  stop(reason: string): void { this.active = false; this.abandon(reason); }

  abandon(reason: string): void {
    this.revision += 1;
    this.settle({ ok: false, failure: 'abandoned', reason });
  }

  /** Route a datagram the group layer could not authenticate with a group key. */
  handle(raw: string, type: string): Promise<void> {
    if (!this.active) return Promise.resolve();
    return this.own(this.handleOwned(raw, type));
  }

  /** Drain work retained before stop, including non-cancellable scrypt. */
  async join(): Promise<void> {
    while (this.work.size > 0) await Promise.allSettled([...this.work]);
  }

  private own(work: Promise<void>): Promise<void> {
    this.work.add(work);
    // Attach both outcomes even when a router has no request caller to await it.
    void work.then(() => { this.work.delete(work); }, () => { this.work.delete(work); });
    return work;
  }

  private async handleOwned(raw: string, type: string): Promise<void> {
    switch (type) {
      case GROUP_MESSAGE_TYPES.join:
        await this.onJoinRequest(raw);
        return;
      case GROUP_MESSAGE_TYPES.joinAccept:
      case GROUP_MESSAGE_TYPES.joinRefuse:
        this.onJoinReply(raw, type);
        return;
      case GROUP_MESSAGE_TYPES.rejoin:
        await this.onRejoinRequest(raw);
        return;
      case GROUP_MESSAGE_TYPES.rejoinAccept:
        this.onRejoinReply(raw);
        return;
      case GROUP_MESSAGE_TYPES.rejoinRefuse:
        this.onRejoinRefused(raw);
        return;
      default:
    }
  }

  // ── admitting others ──────────────────────────────────────────────────────

  private async onJoinRequest(raw: string): Promise<void> {
    const revision = this.revision;
    const material = this.host.material();
    const state = this.host.state();
    if (!material || !state) return;
    const checked = checkJoinClassMessage(raw, material.joinVerifier);
    if (!checked || checked.envelope.groupId !== material.groupId || checked.envelope.type !== GROUP_MESSAGE_TYPES.join) return;
    if (checked.envelope.nodeId === this.host.nodeId || !this.host.answersJoinFrom(checked.envelope.nodeId)) return;
    const body = parseJoinRequestBody(checked.envelope.body);
    if (!body) return;
    const requestSig = requestSignature(raw);

    const decision = decideAdmission(
      state,
      {
        nodeId: checked.envelope.nodeId,
        ts: checked.envelope.ts,
        now: this.host.clock.now(),
        provedCurrentJoinKey: checked.joinKeyProved,
        joinKeyId: joinKeyFingerprint(material.joinVerifier),
        provedHistoricalKey: false,
      },
      MAX_GROUP_MEMBERS,
    );
    if (!decision.admit) {
      // `identity-did-not-match` on this path means the join-key signature did
      // not verify, say THAT, because a mistyped key is the likely cause. The
      // asker cannot verify this reply, but counts it (see `onJoinReply`).
      await this.refuse(
        checked.envelope.nodeId,
        decision.reason === 'identity-did-not-match' ? 'join-key-did-not-match' : decision.reason,
        requestSig,
      );
      return;
    }
    // A repeat from a machine already on the roster with the same keys (a
    // resend, or a copy from a second interface) is answered with the grant
    // again; the roster does not change.
    if (sameMember(state, checked.envelope.nodeId, body)) {
      await this.grant(checked.envelope.nodeId, body.agreementKey, 'join', state, material, revision);
      return;
    }
    // A machine that was previously REMOVED and is now presenting the current
    // join key is the operator putting it back on purpose. That clears the
    // tombstone; nothing else does.
    const admit = findTombstone(state, checked.envelope.nodeId) ? readmitMember : admitMember;
    const admitted = admit(state, {
      nodeId: checked.envelope.nodeId,
      displayName: body.displayName,
      identityKey: body.identityKey,
      agreementKey: body.agreementKey,
      now: this.host.clock.now(),
    });
    if (admitted.refused) {
      await this.refuse(
        checked.envelope.nodeId,
        admitted.refused === 'group-is-full' ? 'group-is-full' : 'removed-from-the-group',
        requestSig,
      );
      return;
    }
    await this.host.commitState(admitted.state, true);
    if (!await this.grant(checked.envelope.nodeId, body.agreementKey, 'join', admitted.state, material, revision)) return;
    this.host.logger.info('cluster: a machine joined the group', {
      nodeId: checked.envelope.nodeId,
      members: admitted.state.members.length,
    });
  }

  /**
   * A machine that was already a member is coming back.
   *
   * Its identity key comes from THE ROSTER, never from the datagram. That is
   * the whole difference between "prove you are node X" and "assert you are
   * node X", and rule 2 of `decideAdmission` depends on it entirely: a node id
   * that is not on the roster has no key to check against, so there is nothing
   * an unknown machine can present here that gets it in.
   */
  private async onRejoinRequest(raw: string): Promise<void> {
    const revision = this.revision;
    const material = this.host.material();
    const state = this.host.state();
    if (!material || !state) return;
    const peeked = peekIdentityClassMessage(raw);
    if (!peeked || peeked.groupId !== material.groupId) return;
    if (peeked.type !== GROUP_MESSAGE_TYPES.rejoin || peeked.nodeId === this.host.nodeId) return;

    const member: GroupMember | undefined = state.members.find((entry) => entry.nodeId === peeked.nodeId);
    const proved = member
      ? (checkIdentityClassMessage(raw, member.identityKey)?.identityProved ?? false)
      : false;
    const decision = decideAdmission(
      state,
      {
        nodeId: peeked.nodeId,
        ts: peeked.ts,
        now: this.host.clock.now(),
        provedCurrentJoinKey: false,
        provedHistoricalKey: proved,
      },
      MAX_GROUP_MEMBERS,
    );
    if (!decision.admit || !member) {
      const reason = decision.admit ? 'not-on-the-roster' : decision.reason;
      this.host.logger.debug('cluster: refused a machine asking to come back', {
        nodeId: peeked.nodeId,
        reason,
      });
      // Say no OUT LOUD. Staying silent here is what left a removed machine
      // waiting out its full timeout and then reporting that nobody answered,
      // a healthy-looking daemon, permanently out of the group, with nothing
      // anywhere naming the reason or the fix.
      await this.refuseRejoin(peeked.nodeId, reason, requestSignature(raw));
      return;
    }
    const body = parseRejoinRequestBody(peeked.body);
    // The agreement key may legitimately have changed (a rebuilt machine that
    // kept its identity key). The IDENTITY key never rotates and is never taken
    // from the datagram, accepting a new one there would let anybody rewrite
    // the credential they are about to be checked against.
    const agreementKey = body?.agreementKey ?? member.agreementKey;
    // Nothing about the member changed: re-key it without a roster write, so a
    // copy of the request does not move its membership generation.
    if (agreementKey === member.agreementKey && (!body?.displayName || body.displayName === member.displayName)) {
      if (!await this.grant(member.nodeId, agreementKey, 'rejoin', state, material, revision)) return;
      this.host.logger.info('cluster: a machine already on the roster came back and was re-keyed to the current group key', { nodeId: member.nodeId });
      return;
    }
    const refreshed = admitMember(state, {
      nodeId: member.nodeId,
      displayName: body?.displayName || member.displayName,
      identityKey: member.identityKey,
      agreementKey,
      now: this.host.clock.now(),
    });
    if (refreshed.refused) return;
    await this.host.commitState(refreshed.state, true);
    if (!await this.grant(member.nodeId, agreementKey, 'rejoin', refreshed.state, material, revision)) return;
    this.host.logger.info('cluster: a machine already on the roster came back and was re-keyed to the current group key', {
      nodeId: member.nodeId,
    });
  }

  private async refuse(nodeId: string, reason: AdmissionRefusal, requestSig: string | null): Promise<void> {
    const material = this.host.material();
    // Without the request's signature the refusal could not be tied to it, and
    // an answer the asker cannot tie to its own request is only noise.
    if (!material || !requestSig || !this.allowRefusal()) return;
    await this.host.send(encodeJoinClassMessage(
      {
        type: GROUP_MESSAGE_TYPES.joinRefuse,
        nodeId: this.host.nodeId,
        nodeVersion: this.host.version,
        seq: this.host.nextSeq(),
        ts: this.host.clock.now(),
        body: { forNodeId: nodeId, forRequest: requestSig, reason, detail: describeRefusal(reason) },
      },
      material.groupId,
      material.joinVerifier,
    ));
  }

  /**
   * Tell a returning machine, in a way it can actually verify, that it is out.
   *
   * Signed with THIS machine's identity key rather than the group key. The
   * recipient cannot check the group key, a removal rotated it and that is
   * precisely why it is being refused, but it can check this machine against
   * the roster it stored before it went away, and this machine was on it.
   *
   * It carries no secret and grants nothing. The worst a forged one can do is
   * make a machine give up early and tell its operator to run `cluster join`,
   * and a forgery cannot even do that: it is dropped unless it verifies.
   *
   * It also echoes the signature of the request it answers. A genuine member
   * will answer ANY datagram claiming to be this node, and the answer is
   * signed with its real key, so without the echo anything on the network
   * could make a healthy machine believe it had been removed by sending a
   * request in its name. The asker only obeys a refusal to the request it sent.
   */
  private async refuseRejoin(nodeId: string, reason: AdmissionRefusal | 'not-on-the-roster', requestSig: string | null): Promise<void> {
    const material = this.host.material();
    if (!material || !requestSig || !this.allowRefusal()) return;
    await this.host.send(encodeIdentityClassMessage(
      {
        type: GROUP_MESSAGE_TYPES.rejoinRefuse,
        nodeId: this.host.nodeId,
        nodeVersion: this.host.version,
        seq: this.host.nextSeq(),
        ts: this.host.clock.now(),
        body: {
          forNodeId: nodeId,
          forRequest: requestSig,
          reason,
          detail: reason === 'not-on-the-roster'
            ? 'this machine is not on the group roster'
            : describeRefusal(reason),
        },
      },
      material.groupId,
      material.node.identity,
    ));
  }

  /**
   * Hand the group over to a machine that has proved itself.
   *
   * Every secret in the grant is sealed to that one machine's agreement key, so
   * although the datagram goes to the whole network exactly one recipient can
   * read it.
   */
  private async grant(
    nodeId: string,
    agreementKey: string,
    path: 'join' | 'rejoin',
    state: GroupStateDocument,
    material: GroupKeyMaterial,
    revision: number,
  ): Promise<boolean> {
    // The roster is read again after the commit's wait: a heartbeat may have
    // replaced the document meanwhile, which changes nothing about membership.
    const current = this.grantRoster(nodeId, agreementKey, state, material, revision);
    if (!current) return false;
    const sealed = sealGrant(
      {
        joinKey: material.joinKey,
        joinSalt: material.joinSalt,
        joinVerifier: material.joinVerifier,
        keys: material.keys,
        currentGeneration: material.currentGeneration,
        state: current,
        groupSigning: material.groupSigning,
      },
      agreementKey,
      path,
    );
    const draft = {
      type: path === 'join' ? GROUP_MESSAGE_TYPES.joinAccept : GROUP_MESSAGE_TYPES.rejoinAccept,
      nodeId: this.host.nodeId,
      nodeVersion: this.host.version,
      seq: this.host.nextSeq(),
      ts: this.host.clock.now(),
      body: { forNodeId: nodeId, sealed },
    };
    await this.host.send(path === 'join'
      ? encodeJoinClassMessage(draft, material.groupId, material.joinVerifier)
      // Signed as the GROUP, not as this machine: the returning member's roster
      // is stale and may not contain this machine at all.
      : encodeIdentityClassMessage(draft, material.groupId, material.groupSigning));
    return true;
  }

  /**
   * The current roster, when a grant decided against `admitted` still holds:
   * same keys, same group, and the machine still on the roster with the
   * membership generation and agreement key it was admitted with.
   */
  private grantRoster(nodeId: string, agreementKey: string, admitted: GroupStateDocument, material: GroupKeyMaterial, revision: number): GroupStateDocument | null {
    if (!this.active || this.revision !== revision || this.host.material() !== material) return null;
    const current = this.host.state();
    if (!current || current.groupId !== material.groupId || admitted.groupId !== material.groupId) return null;
    const expected = admitted.members.find((entry) => entry.nodeId === nodeId);
    const member = current.members.find((entry) => entry.nodeId === nodeId);
    return expected && member && member.gen === expected.gen && member.agreementKey === agreementKey ? current : null;
  }

  // ── getting in ────────────────────────────────────────────────────────────

  /** Broadcast a JOIN and wait for the group to answer. */
  requestJoin(input: {
    readonly groupId: string;
    readonly joinKey: string;
    readonly joinSalt: string;
    readonly timeoutMs: number;
  }): Promise<AdmissionOutcome> {
    // Capture request values once; a caller cannot change the group while the
    // expensive scrypt operation is pending. Reserve ownership before starting it.
    const { groupId, joinKey, joinSalt, timeoutMs } = input;
    if (!this.active || this.pending) return Promise.resolve(this.unavailable());
    const material = this.host.material();
    const node = material?.node ?? generateNodeKeyMaterial();
    return this.await('join', groupId, null, node, timeoutMs, async (pending) => {
      let joinVerifier: string;
      try { joinVerifier = await deriveJoinVerifier(joinKey, joinSalt); }
      catch {
        this.settle({ ok: false, failure: 'not-sent', reason: 'that group advertised a join salt this build cannot read' }, pending);
        return;
      }
      if (this.pending !== pending || !this.active) return;
      pending.joinVerifier = joinVerifier;
      const raw = encodeJoinClassMessage({
        type: GROUP_MESSAGE_TYPES.join,
        nodeId: this.host.nodeId,
        nodeVersion: this.host.version,
        seq: this.host.nextSeq(),
        ts: this.host.clock.now(),
        body: { displayName: this.host.nodeDisplayName, identityKey: node.identity.publicKey, agreementKey: node.agreement.publicKey },
      }, groupId, joinVerifier);
      pending.requestSig = requestSignature(raw);
      await this.host.send(raw);
    });
  }

  /**
   * Broadcast a REJOIN, the zero-touch return.
   *
   * A machine that has been switched off long enough to have missed every group
   * key rotation, and a join-key change on top, sends this when it starts and
   * is back in the group without the operator doing anything. It proves only
   * that it is itself; the group decides whether that is enough, and it is
   * enough only because the node id is already on the roster.
   */
  requestRejoin(timeoutMs: number): Promise<AdmissionOutcome> {
    if (!this.active || this.pending) return Promise.resolve(this.unavailable());
    const material = this.host.material();
    if (!material) return Promise.resolve({ ok: false, failure: 'not-sent', reason: 'this machine is not in a group' });
    return this.await('rejoin', material.groupId, material.joinVerifier, material.node, timeoutMs, (pending) => {
      const raw = encodeIdentityClassMessage(
        {
          type: GROUP_MESSAGE_TYPES.rejoin,
          nodeId: this.host.nodeId,
          nodeVersion: this.host.version,
          seq: this.host.nextSeq(),
          ts: this.host.clock.now(),
          body: {
            displayName: this.host.nodeDisplayName,
            identityKey: material.node.identity.publicKey,
            agreementKey: material.node.agreement.publicKey,
            heldGenerations: material.keys.map((entry) => entry.generation),
          },
        },
        material.groupId,
        material.node.identity,
      );
      pending.requestSig = requestSignature(raw);
      return this.host.send(raw);
    });
  }

  private onJoinReply(raw: string, type: string): void {
    const pending = this.pending;
    if (!pending || pending.kind !== 'join' || pending.joinVerifier === null) return;
    const checked = checkJoinClassMessage(raw, pending.joinVerifier);
    if (!checked || checked.envelope.groupId !== pending.groupId || checked.envelope.type !== type) return;
    if (checked.envelope.body['forNodeId'] !== this.host.nodeId) return;
    if (!checked.joinKeyProved) {
      // A refusal of this exact request that this machine cannot verify: a
      // member heard it and the key it was signed with is not the group's.
      // Not obeyed (anything on the network can send one), but it is reported
      // after a short wait for a grant instead of the full timeout's silence.
      if (type === GROUP_MESSAGE_TYPES.joinRefuse && pending.requestSig && checked.envelope.body['forRequest'] === pending.requestSig) {
        pending.unauthenticatedReplies += 1;
        this.settleSoon(pending, MISMATCH_SETTLE_MS);
      }
      return;
    }

    if (type === GROUP_MESSAGE_TYPES.joinRefuse) {
      // A refusal to some other request in this machine's name is not the
      // group's answer to this one.
      if (!pending.requestSig || checked.envelope.body['forRequest'] !== pending.requestSig) return;
      const detail = checked.envelope.body['detail'];
      // An explicit refusal from the group: it heard us and said no.
      this.settle({
        ok: false,
        failure: 'refused',
        reason: typeof detail === 'string' ? detail : 'the group refused the request',
      });
      return;
    }
    const grant = openGrant(pending.node, checked.envelope.body['sealed'], 'join');
    if (!grant || grant.state.groupId !== pending.groupId) return;
    this.settle({ ok: true, grant, node: pending.node }, pending);
  }

  /**
   * The reply to a REJOIN.
   *
   * There is NO path here that accepts a reply on the strength of the seal
   * alone. The seal gives confidentiality, only this machine can read the
   * grant, and says nothing whatever about who sent it, so accepting on it
   * would let anything on the network hand a returning machine a group key
   * nobody accepts and keep it out of its own group indefinitely.
   *
   * Two authenticators are accepted, and both are things this machine held
   * BEFORE it went away:
   *
   *   - the GROUP's signing key, which any current member can sign with. This
   *     is the normal path and it works no matter who answers, including a
   *     machine admitted while this one was switched off;
   *
   *   - failing that, the identity key of a responder that is still on the
   *     roster this machine stored. This covers the one case the group signing
   *     key cannot: a REMOVAL happened while this machine was away, so the
   *     group signing key rotated and the copy here is a generation behind.
   *
   * When neither matches, the reply is dropped and the request times out with a
   * message naming `cluster join`. That is the honest residual: a machine that
   * was away across a removal AND no longer recognises any current member has
   * nothing left to trust, and being told to re-join with the current key is
   * the correct answer rather than trusting an unauthenticated reply.
   */
  private onRejoinReply(raw: string): void {
    const pending = this.pending;
    if (!pending || pending.kind !== 'rejoin') return;
    const peeked = peekIdentityClassMessage(raw);
    if (!peeked || peeked.body['forNodeId'] !== this.host.nodeId || peeked.groupId !== pending.groupId
      || peeked.type !== GROUP_MESSAGE_TYPES.rejoinAccept) return;
    if (!this.rejoinReplyIsAuthentic(raw, peeked.nodeId, pending.groupId)) {
      // Counted, not just dropped: a reply arriving at all proves the group is
      // on this network and heard us. Without that count the timeout below
      // reports "nobody answered", which is the opposite of what happened and
      // sends the operator looking for a network problem that does not exist.
      pending.unauthenticatedReplies += 1;
      this.host.logger.debug('cluster: dropped a reply to this machine\'s return that it could not authenticate', {
        from: peeked.nodeId,
      });
      return;
    }
    const grant = openGrant(pending.node, peeked.body['sealed'], 'rejoin');
    if (!grant || grant.state.groupId !== pending.groupId) return;
    this.settle({ ok: true, grant, node: pending.node }, pending);
  }

  /**
   * A member said no, and proved it was a member when it said so.
   *
   * Settled immediately and marked terminal rather than waiting out the
   * timeout: the answer is not going to change, and the difference between
   * "wait, someone may still come up" and "you are out, run `cluster join`" is
   * the entire point of telling the operator anything at all.
   *
   * Authenticated through the same two-key check the acceptance path uses. An
   * unverifiable refusal is counted, not obeyed, so a stranger cannot talk a
   * machine out of its own group.
   */
  private onRejoinRefused(raw: string): void {
    const pending = this.pending;
    if (!pending || pending.kind !== 'rejoin') return;
    const peeked = peekIdentityClassMessage(raw);
    if (!peeked || peeked.body['forNodeId'] !== this.host.nodeId || peeked.groupId !== pending.groupId
      || peeked.type !== GROUP_MESSAGE_TYPES.rejoinRefuse) return;
    if (!this.rejoinReplyIsAuthentic(raw, peeked.nodeId, pending.groupId)
      || !pending.requestSig || peeked.body['forRequest'] !== pending.requestSig) {
      pending.unauthenticatedReplies += 1;
      return;
    }
    const detail = peeked.body['detail'];
    this.settle({
      ok: false,
      failure: 'refused',
      reason: typeof detail === 'string' && detail.length > 0
        ? detail
        : 'the group refused this machine\'s return',
    }, pending);
  }

  /** Group signing key first, then a remembered member's identity key. Never neither. */
  private rejoinReplyIsAuthentic(raw: string, responderNodeId: string, groupId: string): boolean {
    const material = this.host.material();
    const state = this.host.state();
    if (!material || material.groupId !== groupId || !state || state.groupId !== groupId) return false;
    if (checkIdentityClassMessage(raw, material.groupSigning.publicKey)?.identityProved) return true;
    const responder = state.members.find((entry) => entry.nodeId === responderNodeId);
    return responder ? checkIdentityClassMessage(raw, responder.identityKey)?.identityProved ?? false : false;
  }

  private unavailable(): AdmissionOutcome {
    return { ok: false, failure: 'not-sent', reason: this.active
      ? 'another group admission request is already in progress'
      : 'the group runtime is not accepting admission requests' };
  }

  private await(
    kind: 'join' | 'rejoin',
    groupId: string,
    joinVerifier: string | null,
    node: NodeKeyMaterial,
    timeoutMs: number,
    send: (pending: PendingAdmission) => Promise<void>,
  ): Promise<AdmissionOutcome> {
    if (!this.active || this.pending) return Promise.resolve(this.unavailable());
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
      return Promise.resolve({ ok: false, failure: 'not-sent', reason: 'the admission deadline must be a finite positive timeout' });
    }
    return new Promise((resolve) => {
      const pending: PendingAdmission = {
        kind,
        groupId,
        joinVerifier,
        node,
        deadline: this.host.clock.now() + timeoutMs,
        settle: resolve,
        unauthenticatedReplies: 0,
      };
      this.pending = pending;
      // Identity-scoped so a timer left over from an earlier attempt cannot
      // settle a later one with a deadline that never applied to it.
      pending.cancelDeadline = this.host.clock.setTimer(() => this.settle(this.timeoutOutcome(pending), pending), timeoutMs);
      if (this.pending !== pending) { pending.cancelDeadline(); return; }
      this.own(Promise.resolve().then(async () => {
        if (this.pending !== pending || !this.active) return;
        try { await send(pending); }
        catch (error) {
          this.settle({ ok: false, failure: 'not-sent',
            reason: error instanceof Error ? error.message : 'the request could not be sent' }, pending);
        }
      }));
    });
  }

  private timeoutOutcome(pending: PendingAdmission): AdmissionOutcome {
    if (pending.joinVerifier === null) return { ok: false, failure: 'not-sent', reason: 'the admission deadline elapsed while preparing the join proof' };
    if (pending.unauthenticatedReplies === 0) return { ok: false, failure: 'unanswered', reason: 'no machine in that group answered in time' };
    return {
      ok: false,
      failure: 'unverifiable-replies',
      reason: pending.kind === 'join'
        ? JOIN_KEY_MISMATCH
        : 'replies arrived and none of them could be authenticated:'
          + ' either this machine was away across a removal and no longer recognises any current member,'
          + ' or something on this network is answering that is not in the group',
    };
  }

  /** Bring a pending request's deadline forward to `delayMs` from now. */
  private settleSoon(pending: PendingAdmission, delayMs: number): void {
    if (this.pending !== pending || pending.deadline <= this.host.clock.now() + delayMs) return;
    pending.deadline = this.host.clock.now() + delayMs;
    pending.cancelDeadline?.();
    pending.cancelDeadline = this.host.clock.setTimer(() => this.settle(this.timeoutOutcome(pending), pending), delayMs);
  }

  private settle(result: AdmissionOutcome, only?: PendingAdmission): void {
    const pending = this.pending;
    if (!pending || (only && pending !== only)) return;
    this.pending = null;
    pending.cancelDeadline?.();
    pending.settle(result);
  }
}

/** True when `nodeId` is on the roster with exactly these keys and name. */
function sameMember(state: GroupStateDocument, nodeId: string, body: { readonly displayName: string; readonly identityKey: string; readonly agreementKey: string }): boolean {
  const member = state.members.find((entry) => entry.nodeId === nodeId);
  return !!member && member.identityKey === body.identityKey && member.agreementKey === body.agreementKey
    && (body.displayName === '' || body.displayName === member.displayName);
}
