/**
 * authority-sync.ts, the authority record carried between the machines of a
 * group.
 *
 * Every message is IDENTITY-CLASS: signed with the sender's long-lived ed25519
 * identity key and checked against that sender's key on the receiver's roster.
 * Identity keys never rotate, so a machine any number of group-key
 * generations behind can still check and take the record. Only a current
 * member's message is taken (the merge's rule 7: an entry enters the group
 * only through a machine that is in it). Private parts (a password hash) are
 * sealed to each current member's agreement key and never sent in clear.
 *
 * How a machine finds out it is behind, with no new datagram on the ordinary
 * path: the roster gossip it already sends carries the record's revision and
 * digest. A peer whose digest differs and is not behind gets one AUTH_PULL,
 * answered by that peer with the whole record sealed to the asker (in parts
 * when large). A change made here goes out at once as an AUTH_DELTA and is
 * sent again on each housekeeping pass until every member's gossiped head
 * covers it (at most ten times; after that the digest exchange heals it).
 *
 * The merge is order-free (authority-record.ts), so a delta, a pull and a
 * restart arriving in any order end on the same record on every machine.
 *
 * The group's key generations ride the same carriage. A key generation is a
 * record entry (its public facts); its SECRETS (the group key, and after a
 * revocation the new signing key and join key) go with it sealed to each
 * current member's agreement key: in the delta that announces it, and in every
 * answer to a record request. So a member that missed any number of rotations
 * takes the newest one from one answer, and a removed member, which is never
 * sealed anything, is told it was removed (AUTH_REMOVED) when it asks.
 * There is no separate rotation message.
 */
import { randomUUID } from 'node:crypto';
import {
  checkIdentityClassMessage,
  encodeIdentityClassMessage,
  GROUP_MESSAGE_TYPES,
  peekIdentityClassMessage,
} from './group-membership.js';
import { isWrappedKeyEnvelope, openSealedEnvelope, sealForMember, type NodeKeyMaterial } from './group-crypto.js';
import { findTombstone, isCurrentMember, isGroupEntry, type GroupStateDocument } from './group-state.js';
import { readGroupSigningMaterial, type GroupSigningMaterial } from './group-store.js';
import {
  keyOf,
  readAuthorityEntry,
  readAuthorityRecord,
  toAuthorityWire,
  type AnyAuthorityEntry,
  type AuthorityHead,
  type AuthorityKey,
  type AuthorityMergeOptions,
  type AuthorityRecord,
} from './authority-record.js';
import type { AuthorityChangeNotice, AuthorityRecordFile, AuthoritySyncStanding } from './authority-record-file.js';
import type { ClusterLogger } from './types.js';

const SEAL_CONTEXT = 'goodvibes-cluster-authority-v1';
const EPOCH_SEAL_CONTEXT = 'goodvibes-cluster-key-epoch-v1';
/** Most times one change is sent again before the digest exchange is left to heal it. */
const MAX_RESENDS = 10;
/** Least gap between two pulls to the same peer. */
const PULL_MIN_GAP_MS = 5_000;
/** Bytes of sealed record per AUTH_PART, leaving room for the envelope. */
const PART_BYTES = 12 * 1024;
/** A transfer larger than this is not a real household record. */
const MAX_TRANSFER_BYTES = 8 * 1024 * 1024;
const TRANSFER_TTL_MS = 30_000;
/** Entries per delta datagram; a larger change goes as several. */
const ENTRIES_PER_DELTA = 12;
/** Least gap between two catch-ups asked of the whole group. */
const CATCH_UP_MIN_GAP_MS = 5_000;

/** The secrets of one key generation, as they travel sealed to one member. */
export interface EpochSecrets {
  readonly epoch: number;
  readonly groupKey: string;
  /** The group signing key pair in force at this generation (a revocation replaced it). */
  readonly signing: GroupSigningMaterial | null;
  /** The join key in force at this generation (a revocation replaced it). */
  readonly joinKey: string | null;
}

function readEpochSecrets(value: unknown): EpochSecrets[] {
  if (!Array.isArray(value)) return [];
  const out: EpochSecrets[] = [];
  for (const raw of value.slice(0, 4)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const candidate = raw as Record<string, unknown>;
    const epoch = candidate['epoch'], groupKey = candidate['groupKey'], joinKey = candidate['joinKey'];
    if (typeof epoch !== 'number' || !Number.isSafeInteger(epoch) || epoch < 0 || typeof groupKey !== 'string' || groupKey.length === 0) continue;
    out.push({
      epoch,
      groupKey,
      signing: candidate['signing'] === null || candidate['signing'] === undefined ? null : readGroupSigningMaterial(candidate['signing']),
      joinKey: typeof joinKey === 'string' && joinKey.length > 0 ? joinKey : null,
    });
  }
  return out;
}

export interface AuthoritySyncHost {
  /** This machine's cluster node id: who it is on the roster. */
  readonly nodeId: string;
  readonly version: string;
  readonly file: AuthorityRecordFile;
  readonly logger: ClusterLogger;
  now(): number;
  /** The group this machine is in and its key pairs, or null when it is in none. */
  membership(): { readonly groupId: string; readonly node: NodeKeyMaterial } | null;
  /** The roster: who is a member, with the identity and agreement keys to check and seal with. */
  roster(): GroupStateDocument | null;
  send(raw: string): Promise<void>;
  nextSeq(): number;
  /**
   * The secrets of these key generations this machine holds and may hand to a
   * current member; with null, the catch-up set (its current generation, and
   * the one before while it is still accepted).
   */
  epochSecrets(epochs: readonly number[] | null): readonly EpochSecrets[];
  /** Take key generations' secrets a current member sent; the host checks each against the record. */
  installEpochs(secrets: readonly EpochSecrets[]): Promise<void>;
  /** How a copy from the group is merged here: rule 7 per entry (group-state.ts `originAdmission`). */
  mergeOptions?(): AuthorityMergeOptions;
}

interface PendingDelta {
  readonly keys: readonly AuthorityKey[];
  readonly revision: number;
  resendsLeft: number;
}

interface Transfer {
  readonly from: string;
  readonly count: number;
  readonly parts: Map<number, string>;
  readonly startedAt: number;
}

export class AuthoritySync {
  /** Each member's last gossiped head, by cluster node id. */
  private readonly peerHeads = new Map<string, AuthorityHead>();
  private readonly lastPullAt = new Map<string, number>();
  private readonly lastRemovedAt = new Map<string, number>();
  private lastCatchUpAt = Number.NEGATIVE_INFINITY;
  private readonly pending: PendingDelta[] = [];
  private readonly transfers = new Map<string, Transfer>();
  private absorbing = 0;
  private readonly unsubscribe: () => void;

  constructor(private readonly host: AuthoritySyncHost) {
    // A change written on this machine (here, or by another process of this
    // home) goes to the group at once; a merge from the group does not echo.
    this.unsubscribe = host.file.onChange((notice) => { if (this.absorbing === 0) this.onLocalChange(notice); });
  }

  close(): void {
    this.unsubscribe();
  }

  /**
   * Where this machine stands with its group's record. A machine that has not
   * held the group's record within the retention window (`stale`), or never
   * has (`never`), may hold entries the group revoked and then dropped: until
   * it has taken a member's whole record as the truth (`adoptGroupTruth`) it
   * sends nothing of its own and answers no request for its record. Alone in
   * its group it is current by definition.
   */
  private standing(): AuthoritySyncStanding {
    const membership = this.host.membership();
    const roster = this.host.roster();
    if (!membership || !roster) return 'current';
    const others = roster.members.some((member) => member.nodeId !== this.host.nodeId && isCurrentMember(roster, member.nodeId));
    if (!others) {
      void this.host.file.noteSynced(membership.groupId).catch(() => {});
      return 'current';
    }
    return this.host.file.syncStanding(membership.groupId);
  }

  /** The head this machine gossips with the roster. */
  head(): AuthorityHead | null {
    return this.host.file.head();
  }

  /** Members whose last gossiped record differs from this machine's, and whether one is ahead. */
  divergence(): { readonly behindOn: readonly string[]; readonly behind: boolean } {
    const own = this.head();
    const roster = this.host.roster();
    if (!own || !roster) return { behindOn: [], behind: false };
    const behindOn: string[] = [];
    let behind = false;
    for (const [nodeId, head] of this.peerHeads) {
      if (!isCurrentMember(roster, nodeId) || head.digest === own.digest) continue;
      behindOn.push(nodeId);
      if (head.revision >= own.revision) behind = true;
    }
    return { behindOn: behindOn.sort(), behind };
  }

  /**
   * A member's roster gossip carried its record head. A different digest from
   * a peer that is not behind this machine means it holds something this one
   * does not: ask it for its record.
   */
  notePeerHead(nodeId: string, revision: unknown, digest: unknown): void {
    if (nodeId === this.host.nodeId || typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0
      || typeof digest !== 'string' || digest.length === 0 || digest.length > 64) return;
    this.peerHeads.set(nodeId, { revision, digest });
    const own = this.head();
    const standing = this.standing();
    const membership = this.host.membership();
    // The same record as a member: this machine is in sync with its group.
    if (own && own.digest === digest && standing === 'current' && membership) void this.host.file.noteSynced(membership.groupId).catch(() => {});
    // Too far behind (or new to the group): ask whatever its revision says.
    if (!own || (standing === 'current' && (own.digest === digest || revision < own.revision))) return;
    void this.pull(nodeId).catch((error: unknown) => this.host.logger.debug('cluster: an authority record request could not be sent', { error: String(error) }));
  }

  /**
   * Ask every other member for its record: a machine that has just started,
   * or just been re-keyed after missing changes, may have missed authority
   * changes too, and waiting for the next roster gossip would leave a revoked
   * credential working here until then. One small datagram per member; each
   * answers with its record, and the order-free merge takes them all.
   */
  async pullAll(): Promise<void> {
    const roster = this.host.roster();
    if (!roster || !this.host.membership()) return;
    for (const member of roster.members) {
      if (member.nodeId === this.host.nodeId) continue;
      await this.pull(member.nodeId);
    }
  }

  /**
   * A datagram showed this machine is behind the group (a key generation it
   * does not hold or does not accept, or a signature under a key it holds that
   * did not verify, which is another minter's key for the same generation).
   * The datagram is unauthenticated, so this only asks: the claimed sender
   * when the record lists it, else every member, at most once per 5 s each.
   */
  async catchUp(fromNodeId: string | null): Promise<void> {
    const roster = this.host.roster();
    if (!roster || !this.host.membership()) return;
    if (fromNodeId !== null && fromNodeId !== this.host.nodeId && isCurrentMember(roster, fromNodeId)) {
      await this.pull(fromNodeId);
      return;
    }
    const now = this.host.now();
    if (now - this.lastCatchUpAt < CATCH_UP_MIN_GAP_MS) return;
    this.lastCatchUpAt = now;
    await this.pullAll();
  }

  /** Housekeeping: send unconfirmed changes again; forget stale transfers and departed members. */
  async housekeeping(): Promise<void> {
    const now = this.host.now();
    // The record belongs to the group this machine is in (owner decision D2:
    // what it held before joining is merged in, nothing removed).
    const membership = this.host.membership();
    const view = this.host.file.view();
    if (membership && view && view.record.scope.groupId !== membership.groupId) await this.host.file.rescope({ groupId: membership.groupId });
    for (const [id, transfer] of this.transfers) if (now - transfer.startedAt > TRANSFER_TTL_MS) this.transfers.delete(id);
    const roster = this.host.roster();
    if (!roster) return;
    for (const nodeId of [...this.peerHeads.keys()]) if (!isCurrentMember(roster, nodeId)) this.peerHeads.delete(nodeId);
    if (this.standing() !== 'current') {
      // Nothing of this machine's goes out until it has the group's truth.
      await this.pullAll();
      return;
    }
    const others = roster.members.filter((member) => member.nodeId !== this.host.nodeId);
    for (const delta of [...this.pending]) {
      const covered = others.every((member) => (this.peerHeads.get(member.nodeId)?.revision ?? -1) >= delta.revision);
      if (covered || delta.resendsLeft <= 0) {
        this.pending.splice(this.pending.indexOf(delta), 1);
        continue;
      }
      delta.resendsLeft -= 1;
      await this.sendDelta(delta.keys);
    }
  }

  /** Route an AUTH_* datagram. */
  async handle(raw: string, type: string): Promise<void> {
    const membership = this.host.membership();
    const roster = this.host.roster();
    if (!membership || !roster) return;
    const peeked = peekIdentityClassMessage(raw);
    if (!peeked || peeked.groupId !== membership.groupId || peeked.type !== type || peeked.nodeId === this.host.nodeId) return;
    // Rule 7: only a current member's message is taken, checked against the
    // identity key this machine's roster holds for it, never one the datagram carries.
    const sender = roster.members.find((member) => member.nodeId === peeked.nodeId);
    if (!sender) {
      // A machine the record says was removed is asking for the record (it
      // slept through its removal). It gets nothing of the record, only its
      // own removal, so it stops signing with keys the group dropped.
      const removal = type === GROUP_MESSAGE_TYPES.authorityPull && peeked.body['forNodeId'] === this.host.nodeId
        ? findTombstone(roster, peeked.nodeId) : null;
      if (removal && checkIdentityClassMessage(raw, removal.identityKey)?.identityProved) await this.sendRemoved(peeked.nodeId);
      return;
    }
    if (!checkIdentityClassMessage(raw, sender.identityKey)?.identityProved) return;
    switch (type) {
      case GROUP_MESSAGE_TYPES.authorityDelta:
        await this.onDelta(peeked.body, membership.node);
        return;
      case GROUP_MESSAGE_TYPES.authorityPull:
        if (peeked.body['forNodeId'] === this.host.nodeId && this.answersPull(sender.nodeId, peeked.body)) await this.sendRecordTo(sender.nodeId, sender.agreementKey);
        return;
      case GROUP_MESSAGE_TYPES.authorityPart:
        if (peeked.body['forNodeId'] === this.host.nodeId) await this.onPart(sender.nodeId, peeked.body, membership.node);
        return;
      case GROUP_MESSAGE_TYPES.authorityRemoved:
        if (peeked.body['forNodeId'] === this.host.nodeId) await this.onRemoved(peeked.body, membership.groupId);
        return;
      default:
    }
  }

  // ── sending ───────────────────────────────────────────────────────────────

  /**
   * Whether this machine sends its record to a member that asked. A machine
   * behind its group does not, unless the asker is behind too: then the one
   * with the higher (revision, node id) answers, so a group whose members were
   * all away settles on one record instead of waiting on each other.
   */
  private answersPull(asker: string, body: Record<string, unknown>): boolean {
    if (this.standing() === 'current') return true;
    if (body['standing'] === 'current' || body['standing'] === undefined) return false;
    const own = this.head()?.revision ?? 0;
    const theirs = typeof body['revision'] === 'number' ? body['revision'] : 0;
    return own !== theirs ? own > theirs : this.host.nodeId > asker;
  }

  private onLocalChange(notice: AuthorityChangeNotice): void {
    if (notice.keys.length === 0 || !this.host.membership()) return;
    this.pending.push({ keys: notice.keys, revision: notice.rev, resendsLeft: MAX_RESENDS });
    // Kept for after this machine has the group's truth; housekeeping sends it then.
    if (this.standing() !== 'current') return;
    void this.sendDelta(notice.keys).catch((error: unknown) => this.host.logger.debug('cluster: an authority change could not be sent', { error: String(error) }));
  }

  private async pull(nodeId: string): Promise<void> {
    const now = this.host.now();
    if (now - (this.lastPullAt.get(nodeId) ?? Number.NEGATIVE_INFINITY) < PULL_MIN_GAP_MS) return;
    this.lastPullAt.set(nodeId, now);
    const own = this.head();
    await this.sendSigned(GROUP_MESSAGE_TYPES.authorityPull, { forNodeId: nodeId, revision: own?.revision ?? 0, digest: own?.digest ?? '', standing: this.standing() });
  }

  private async sendDelta(keys: readonly AuthorityKey[]): Promise<void> {
    const view = this.host.file.view();
    const roster = this.host.roster();
    const membership = this.host.membership();
    if (!view || !roster || !membership) return;
    const entries = keys.map((key) => view.record.entries.get(key)).filter((entry): entry is AnyAuthorityEntry => entry !== undefined);
    // The roster read AFTER the write: a member this change removed is never
    // sealed anything, neither a private part nor a key generation.
    const others = roster.members.filter((member) => member.nodeId !== this.host.nodeId);
    for (let index = 0; index < entries.length; index += ENTRIES_PER_DELTA) {
      const batch = entries.slice(index, index + ENTRIES_PER_DELTA);
      const privates: Record<string, unknown> = {};
      for (const entry of batch) if (entry.private !== null) privates[keyOf(entry)] = entry.private;
      const sealed: Record<string, unknown> = {};
      if (Object.keys(privates).length > 0) {
        const plaintext = JSON.stringify(privates);
        for (const member of others) sealed[member.nodeId] = sealForMember(member.agreementKey, plaintext, SEAL_CONTEXT);
      }
      // A key generation this change carries goes with its secrets.
      const epochs: number[] = [];
      for (const entry of batch) if (entry.kind === 'key-epoch' && entry.revoked === null && isGroupEntry(entry, membership.groupId)) epochs.push(entry.public.epoch);
      const secrets = epochs.length > 0 ? this.host.epochSecrets(epochs) : [];
      const sealedEpochs: Record<string, unknown> = {};
      if (secrets.length > 0) {
        const plaintext = JSON.stringify(secrets);
        for (const member of others) sealedEpochs[member.nodeId] = sealForMember(member.agreementKey, plaintext, EPOCH_SEAL_CONTEXT);
      }
      await this.sendSigned(GROUP_MESSAGE_TYPES.authorityDelta, {
        revision: view.record.revision,
        revocationFloor: view.record.revocationFloor,
        entries: batch.map((entry) => ({ ...entry, private: null })),
        ...(Object.keys(sealed).length > 0 ? { sealed } : {}),
        ...(Object.keys(sealedEpochs).length > 0 ? { epochs: sealedEpochs } : {}),
      });
    }
  }

  /** Tell a removed machine, verifiably, that the group removed it: its own revocation and nothing else. */
  private async sendRemoved(nodeId: string): Promise<void> {
    const now = this.host.now();
    if (now - (this.lastRemovedAt.get(nodeId) ?? Number.NEGATIVE_INFINITY) < PULL_MIN_GAP_MS) return;
    this.lastRemovedAt.set(nodeId, now);
    const view = this.host.file.view();
    const membership = this.host.membership();
    if (!view || !membership) return;
    const entries = view.list('member').filter((entry) => entry.revoked !== null && entry.public.nodeId === nodeId && isGroupEntry(entry, membership.groupId));
    if (entries.length === 0) return;
    await this.sendSigned(GROUP_MESSAGE_TYPES.authorityRemoved, { forNodeId: nodeId, entries: entries.slice(0, ENTRIES_PER_DELTA).map((entry) => ({ ...entry, private: null })) });
  }

  /** The whole record, private parts included, and the current key generation's secrets, sealed to one asker and sent in parts. */
  private async sendRecordTo(nodeId: string, agreementKey: string): Promise<void> {
    const view = this.host.file.view();
    if (!view) return;
    // Whether this record is the group's truth: a sender behind its group too
    // (every member was away) offers a copy to merge, never one to drop by.
    const payload = { record: toAuthorityWire(view.record), epochs: this.host.epochSecrets(null), standing: this.standing() };
    const sealed = JSON.stringify(sealForMember(agreementKey, JSON.stringify(payload), SEAL_CONTEXT));
    const count = Math.ceil(sealed.length / PART_BYTES);
    if (sealed.length > MAX_TRANSFER_BYTES) {
      this.host.logger.warn('cluster: the authority record is too large to send', { bytes: sealed.length });
      return;
    }
    const transferId = randomUUID();
    for (let index = 0; index < count; index += 1) {
      await this.sendSigned(GROUP_MESSAGE_TYPES.authorityPart, {
        forNodeId: nodeId, transferId, index, count, data: sealed.slice(index * PART_BYTES, (index + 1) * PART_BYTES),
      });
    }
  }

  private async sendSigned(type: string, body: Record<string, unknown>): Promise<void> {
    const membership = this.host.membership();
    if (!membership) return;
    await this.host.send(encodeIdentityClassMessage({
      type,
      nodeId: this.host.nodeId,
      nodeVersion: this.host.version,
      seq: this.host.nextSeq(),
      ts: this.host.now(),
      body,
    }, membership.groupId, membership.node.identity));
  }

  // ── receiving ─────────────────────────────────────────────────────────────

  private async onDelta(body: Record<string, unknown>, node: NodeKeyMaterial): Promise<void> {
    const rawEntries = Array.isArray(body['entries']) ? body['entries'] : [];
    let privates: Record<string, unknown> = {};
    const sealed = body['sealed'];
    if (typeof sealed === 'object' && sealed !== null) {
      const mine = (sealed as Record<string, unknown>)[this.host.nodeId];
      if (isWrappedKeyEnvelope(mine)) {
        const opened = openSealedEnvelope(node.agreement, mine, SEAL_CONTEXT);
        if (opened) {
          try { privates = JSON.parse(opened) as Record<string, unknown>; } catch { privates = {}; }
        }
      }
    }
    const entries = new Map<AuthorityKey, AnyAuthorityEntry>();
    for (const raw of rawEntries.slice(0, ENTRIES_PER_DELTA)) {
      const entry = readAuthorityEntry(typeof raw === 'object' && raw !== null
        ? { ...(raw as Record<string, unknown>), private: privates[keyOf(raw as { kind: never; id: string })] ?? null } : raw);
      if (entry) entries.set(keyOf(entry), entry);
    }
    if (entries.size === 0) return;
    const view = this.host.file.view();
    if (!view) return;
    const floor = typeof body['revocationFloor'] === 'number' && Number.isSafeInteger(body['revocationFloor']) ? body['revocationFloor'] : 0;
    await this.absorb({ ...view.record, revision: 0, revocationFloor: floor, compacted: {}, entries }, true);
    // The key generations this change carries, sealed to this machine. Taken
    // after the entries, which the host checks the secrets against.
    const sealedEpochs = body['epochs'];
    if (typeof sealedEpochs === 'object' && sealedEpochs !== null) {
      const mine = (sealedEpochs as Record<string, unknown>)[this.host.nodeId];
      const opened = isWrappedKeyEnvelope(mine) ? openSealedEnvelope(node.agreement, mine, EPOCH_SEAL_CONTEXT) : null;
      if (opened) {
        let secrets: EpochSecrets[] = [];
        try { secrets = readEpochSecrets(JSON.parse(opened) as unknown); } catch { secrets = []; }
        if (secrets.length > 0) await this.host.installEpochs(secrets);
      }
    }
  }

  /** A member says the record holds this machine's removal: take that revocation into the record. */
  private async onRemoved(body: Record<string, unknown>, groupId: string): Promise<void> {
    const view = this.host.file.view();
    if (!view) return;
    const entries = new Map<AuthorityKey, AnyAuthorityEntry>();
    for (const raw of (Array.isArray(body['entries']) ? body['entries'] : []).slice(0, ENTRIES_PER_DELTA)) {
      const entry = readAuthorityEntry(raw);
      if (entry && entry.kind === 'member' && entry.revoked !== null && entry.public.nodeId === this.host.nodeId && isGroupEntry(entry, groupId)) {
        entries.set(keyOf(entry), entry);
      }
    }
    if (entries.size === 0) return;
    await this.absorb({ ...view.record, revision: 0, compacted: {}, entries }, true);
  }

  private async onPart(from: string, body: Record<string, unknown>, node: NodeKeyMaterial): Promise<void> {
    const transferId = body['transferId'], index = body['index'], count = body['count'], data = body['data'];
    if (typeof transferId !== 'string' || transferId.length > 64 || typeof data !== 'string'
      || typeof index !== 'number' || typeof count !== 'number' || !Number.isSafeInteger(index) || !Number.isSafeInteger(count)
      || count < 1 || index < 0 || index >= count || count * PART_BYTES > MAX_TRANSFER_BYTES) return;
    let transfer = this.transfers.get(transferId);
    if (!transfer) {
      // One transfer per sender at a time: a newer one replaces an unfinished older one.
      for (const [id, other] of this.transfers) if (other.from === from) this.transfers.delete(id);
      transfer = { from, count, parts: new Map(), startedAt: this.host.now() };
      this.transfers.set(transferId, transfer);
    }
    if (transfer.from !== from || transfer.count !== count) return;
    transfer.parts.set(index, data);
    if (transfer.parts.size < count) return;
    this.transfers.delete(transferId);
    const joined = Array.from({ length: count }, (_, part) => transfer.parts.get(part) ?? '').join('');
    let envelope: unknown;
    try { envelope = JSON.parse(joined); } catch { return; }
    if (!isWrappedKeyEnvelope(envelope)) return;
    const opened = openSealedEnvelope(node.agreement, envelope, SEAL_CONTEXT);
    if (!opened) return;
    let record: AuthorityRecord | null;
    let secrets: EpochSecrets[] = [];
    let senderCurrent = false;
    try {
      const payload = JSON.parse(opened) as Record<string, unknown>;
      senderCurrent = payload['standing'] === 'current';
      record = readAuthorityRecord(payload['record']);
      secrets = readEpochSecrets(payload['epochs']);
    } catch { record = null; }
    if (!record) return;
    const membership = this.host.membership();
    if (membership && this.standing() !== 'current' && senderCurrent) {
      // Back after longer than the retention, or new to the group: the
      // group's record is the truth for what is live.
      this.absorbing += 1;
      try {
        const result = await this.host.file.adoptGroupTruth(record, membership.groupId, this.host.mergeOptions?.() ?? {});
        this.host.logger.info('cluster: took the group\'s authority record as the truth after being away', { dropped: result.dropped.length, revision: result.head.revision });
      } finally {
        this.absorbing -= 1;
      }
      // In step now: what this machine changed while it waited goes out at
      // once, not on the next housekeeping pass.
      for (const delta of [...this.pending]) await this.sendDelta(delta.keys);
    } else {
      await this.absorb(record);
      if (membership) await this.host.file.noteSynced(membership.groupId);
    }
    if (secrets.length > 0) await this.host.installEpochs(secrets);
    await this.sendWhatTheyLack(record);
  }

  /**
   * After taking a member's whole record, send the group what that member did
   * not hold (a change made here while it was apart, a key generation that won
   * on this side): the merge is symmetric only if both sides hear both copies.
   */
  private async sendWhatTheyLack(remote: AuthorityRecord): Promise<void> {
    const view = this.host.file.view();
    if (!view || !this.host.membership()) return;
    const lacking: AuthorityKey[] = [];
    for (const [key, entry] of view.record.entries) {
      const theirs = remote.entries.get(key);
      if (!theirs || theirs.rev !== entry.rev || theirs.origin !== entry.origin || (theirs.revoked === null) !== (entry.revoked === null)
        || (entry.kind === 'key-epoch' && theirs.kind === 'key-epoch' && theirs.public.mintedBy !== entry.public.mintedBy)) lacking.push(key);
    }
    if (lacking.length > 0) await this.sendDelta(lacking);
  }

  private async absorb(remote: AuthorityRecord, partial = false): Promise<void> {
    this.absorbing += 1;
    try {
      const result = await this.host.file.absorb(remote, { ...(this.host.mergeOptions?.() ?? {}), ...(partial ? { partial: true } : {}) });
      if (result.changed) this.host.logger.info('cluster: took authority record changes from the group', { entries: result.keys.length, revision: result.head.revision });
    } finally {
      this.absorbing -= 1;
    }
  }
}
