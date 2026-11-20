import { actorFromChannelSender, type Actor } from '@goodvibes-jev/engine/daemon-api/http-policy';
import { randomUUID } from 'node:crypto';
import { PersistentStore } from '../state/persistent-store.js';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import type {
  ChannelConversationKind,
  ChannelGroupPolicyRecord,
  ChannelIngressPolicyInput,
  ChannelPolicyAuditRecord,
  ChannelPolicyDecision,
  ChannelPolicyRecord,
  ChannelSurface,
} from './types.js';
import { isRecord } from '../utils/record-coerce.js';
import { logger } from '../utils/logger.js';
import { judgmentInputProblem } from '../gate/judgment-input.js';
import type { OwnerInbox, OwnerItem } from '../control-plane/owner-inbox.js';
import { maskDigits } from '../security/batteries/card-talk.js';

/** The part of the owner inbox an owner claim uses. */
export type ChannelOwnerClaimInbox = Pick<OwnerInbox, 'postNow' | 'listNow' | 'subscribe' | 'withdraw'>;

/** Owner claims open at once on one surface; a further unknown sender waits without a new question. */
const MAX_OPEN_CLAIMS_PER_SURFACE = 3;
/** Declined claimants remembered per surface, so a stranger is not asked about again. */
const MAX_DECLINED_CLAIMANTS = 50;
const CLAIM_KEY_PREFIX = 'channel-owner:';
const DECLINED_CLAIMANTS_KEY = 'declinedOwnerClaims';

interface ChannelPolicySnapshot extends Record<string, unknown> {
  readonly policies: readonly ChannelPolicyRecord[];
  readonly audit: readonly ChannelPolicyAuditRecord[];
}

const MAX_AUDIT_RECORDS = 500;

/**
 * Audit writes are coalesced and flushed on this debounce interval instead of
 * synchronously on every inbound message. Policy mutations (upsertPolicy) remain
 * synchronously persisted; only the append-only audit telemetry is debounced, so
 * a busy ingress path is not blocked behind a full-snapshot disk write per message.
 */
const AUDIT_FLUSH_INTERVAL_MS = 1_000;

/** One frozen default per surface, so an unconfigured surface reads as the same record every time. */
const defaultPolicies = new Map<ChannelSurface, ChannelPolicyRecord>();

function defaultPolicy(surface: ChannelSurface): ChannelPolicyRecord {
  let policy = defaultPolicies.get(surface);
  if (!policy) {
    const fresh = newDefaultPolicy(surface);
    for (const value of Object.values(fresh)) if (value && typeof value === 'object') Object.freeze(value);
    policy = Object.freeze(fresh);
    defaultPolicies.set(surface, policy);
  }
  return policy;
}

function newDefaultPolicy(surface: ChannelSurface): ChannelPolicyRecord {
  return {
    surface,
    enabled: true,
    requireMention: false,
    allowDirectMessages: true,
    allowGroupMessages: true,
    allowThreadMessages: true,
    dmPolicy: 'inherit',
    groupPolicy: 'inherit',
    allowTextCommandsWithoutMention: false,
    allowlistUserIds: [],
    allowlistChannelIds: [],
    allowlistGroupIds: [],
    allowedCommands: [],
    groupPolicies: [],
    updatedAt: 0,
    metadata: {},
  };
}

function normalizeGroupPolicy(policy: ChannelGroupPolicyRecord): ChannelGroupPolicyRecord {
  return {
    ...policy,
    metadata: policy.metadata ?? {},
  };
}

function normalizeConversationKind(input: ChannelIngressPolicyInput): ChannelConversationKind {
  if (input.conversationKind) return input.conversationKind;
  if (input.threadId) return 'thread';
  if (input.groupId) return 'group';
  if (input.channelId) return 'channel';
  return 'service';
}

/**
 * The one owner test on a channel, read by control commands, purchase answers
 * and permission answers alike: the sender is the policy's explicit owner.
 * Being on an allowlist admits a person to talk to the assistant; it does not
 * let them approve spending or tool use, or cancel the owner's runs. A sender
 * with no identity is never the owner.
 */
export function isChannelOwner(decision: { readonly policy: Pick<ChannelPolicyRecord, 'ownerId'> }, userId: string | undefined): boolean {
  return userId !== undefined && decision.policy.ownerId !== undefined && decision.policy.ownerId === userId;
}

/**
 * The actor a sender on a channel is (actor.ts): the channel's owner, or a
 * guest. What either may cause is decided by the effect table
 * (`admitEffects`), never by testing the owner again at the call site. A
 * sender with no identity is admitted by the surface's own secret and acts as
 * the owner; a caller that needs to know who pressed or wrote refuses an
 * anonymous sender before it asks.
 */
export function channelSenderActor(decision: { readonly policy: Pick<ChannelPolicyRecord, 'ownerId'> }, surface: string, userId: string | undefined): Actor {
  return actorFromChannelSender({ surface, userId, isChannelOwner: isChannelOwner(decision, userId) });
}

/**
 * The owner a policy record carries. A policy saved before owners were
 * recorded, or an allowlist edited by hand, names its first allowlisted user,
 * which is how the surface was seeded; an owner who is no longer on a
 * non-empty allowlist hands over to its first entry, as before.
 */
function settledOwner(policy: Pick<ChannelPolicyRecord, 'ownerId' | 'allowlistUserIds' | 'groupPolicies'>): string | undefined {
  const first = policy.allowlistUserIds[0];
  if (policy.ownerId === undefined) return first ?? policy.groupPolicies.find(group => (group.allowlistUserIds?.length ?? 0) > 0)?.allowlistUserIds?.[0];
  return first === undefined || policy.allowlistUserIds.includes(policy.ownerId) ? policy.ownerId : first;
}

/** The three allowlists that apply to one message: the surface's, or a matching group policy's. */
export interface ChannelAllowlists {
  readonly allowlistUserIds: readonly string[];
  readonly allowlistGroupIds: readonly string[];
  readonly allowlistChannelIds: readonly string[];
  /** The surface's recorded owner, admitted to a direct conversation when only conversation lists are set. */
  readonly ownerId?: string | undefined;
}

/** The conversation a message (or a would-be sender) is in. */
export interface ChannelAllowlistSubject {
  /** `direct` for a one-to-one conversation; anything else is a shared conversation. */
  readonly conversationKind: ChannelConversationKind;
  readonly userId?: string | undefined;
  readonly groupId?: string | undefined;
  readonly channelId?: string | undefined;
}

/**
 * Who the allowlists admit. One rule, read by ingress, by actor checks and by
 * the allowlist edit's lock-out check:
 *
 * - Every list that is set must admit the message; an empty list restricts
 *   nobody. When every list that applies is empty the message is admitted;
 *   that also means the surface has no owner yet, which `decideIngress` turns
 *   into an owner claim unless the surface is `open`.
 * - A shared conversation (group, channel, thread) must be on the group list
 *   when one is set, on the channel list when one is set, and its sender on
 *   the user list when one is set. A listed group admits only the listed
 *   people in it when a user list is set, and a listed person is admitted only
 *   in the listed groups and channels.
 * - A direct conversation is judged by the user list when one is set; adapters
 *   pass a direct chat's id as its group id, and judging it against the group
 *   list would refuse the owner's own direct chat the moment any group was
 *   listed. When only group or channel lists are set the owner restricted the
 *   surface to those conversations: a direct message is admitted only from the
 *   recorded owner or when the chat itself is listed.
 */
export function admitByAllowlists(
  lists: ChannelAllowlists,
  subject: ChannelAllowlistSubject,
): { readonly allowed: true } | { readonly allowed: false; readonly reason: string } {
  const users = lists.allowlistUserIds;
  const groups = lists.allowlistGroupIds;
  const channels = lists.allowlistChannelIds;
  const userRefusal = users.length > 0 && !(subject.userId !== undefined && users.includes(subject.userId))
    ? (subject.userId ? 'user-not-allowlisted' : 'missing-user-identity')
    : undefined;
  const groupListed = subject.groupId !== undefined && groups.includes(subject.groupId);
  const channelListed = subject.channelId !== undefined && channels.includes(subject.channelId);
  if (subject.conversationKind === 'direct') {
    if (userRefusal !== undefined) return { allowed: false, reason: userRefusal };
    if (users.length > 0 || (groups.length === 0 && channels.length === 0)) return { allowed: true };
    if (groupListed || channelListed) return { allowed: true };
    if (subject.userId !== undefined && lists.ownerId !== undefined && subject.userId === lists.ownerId) return { allowed: true };
    return { allowed: false, reason: subject.userId ? 'direct-not-allowlisted' : 'missing-user-identity' };
  }
  if (groups.length > 0 && !groupListed) return { allowed: false, reason: subject.groupId ? 'group-not-allowlisted' : 'missing-group-identity' };
  if (channels.length > 0 && !channelListed) return { allowed: false, reason: subject.channelId ? 'channel-not-allowlisted' : 'missing-channel-identity' };
  if (userRefusal !== undefined) return { allowed: false, reason: userRefusal };
  return { allowed: true };
}

/**
 * Whether an actor (a sender writing to the surface directly) is admitted, and
 * why, in words a person or an agent can act on. The same rule ingress applies.
 */
export function describeActorAdmission(
  policy: ChannelAllowlists & { readonly open?: boolean | undefined },
  actorId: string | undefined,
): { readonly admitted: boolean; readonly reason: string } {
  const decision = admitByAllowlists(policy, { conversationKind: 'direct', userId: actorId });
  const unowned = policy.allowlistUserIds.length === 0 && policy.allowlistGroupIds.length === 0 && policy.allowlistChannelIds.length === 0;
  if (decision.allowed && unowned && !policy.open) {
    // Nobody is admitted on an unowned surface until the owner accepts a claim: speaking first does not make anyone the owner.
    return {
      admitted: false,
      reason: 'No owner is set on this surface yet. The first message from an unknown sender raises an owner claim (in /questions, or the web UI inbox); accept it to make that sender the owner, and add other senders with the allowlist edit.',
    };
  }
  if (decision.allowed) {
    return {
      admitted: true,
      reason: policy.allowlistUserIds.length > 0
        ? `Actor '${actorId}' is on the surface's user list.`
        : !unowned
          ? `Actor '${actorId}' is the surface's owner.`
          : policy.open ? 'The surface policy is open: any sender may write to it.' : 'The surface has no user list, so a direct sender is admitted.',
    };
  }
  if (decision.reason === 'direct-not-allowlisted') {
    return {
      admitted: false,
      reason: `The surface admits only its listed groups and channels and its owner, and actor '${actorId}' is neither; add them with the allowlist edit action (kind user) first.`,
    };
  }
  return {
    admitted: false,
    reason: actorId === undefined
      ? 'The surface admits only the senders on its user list and no actorId was given; name the actor to check.'
      : `Actor '${actorId}' is not on the surface's user list; add them with the allowlist edit action (kind user) first.`,
  };
}

function selectGroupPolicy(policy: ChannelPolicyRecord, input: ChannelIngressPolicyInput): ChannelGroupPolicyRecord | undefined {
  const selectors = ['groupId', 'channelId', 'workspaceId'] as const;
  const specificity = (entry: ChannelGroupPolicyRecord) => selectors.filter(key => Boolean(entry[key])).length;
  return policy.groupPolicies.filter(entry => specificity(entry) > 0
    && selectors.every(key => !entry[key] || entry[key] === input[key]))
    .sort((a, b) => specificity(b) - specificity(a))[0];
}

/**
 * The command a message names. An adapter's explicit `controlCommand` wins; free
 * text counts only when its first word is written as a command (`/status`,
 * `!status`, `/status@bot`). Ordinary conversation names no command, so it is
 * neither held to `allowedCommands` nor allowed past `requireMention` as one.
 */
function firstCommand(text: string | undefined, explicit?: string): string {
  if (explicit && explicit.trim().length > 0) return explicit.trim().toLowerCase();
  if (!text) return '';
  const word = text.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? '';
  if (!/^[/!]\S/.test(word)) return '';
  return word.startsWith('/') ? word.replace(/@\S*$/, '') : word;
}

function commandAllowed(command: string, allowedCommands: readonly string[]): boolean {
  if (allowedCommands.length === 0 || !command) return true;
  return allowedCommands.map((entry) => entry.toLowerCase()).includes(command);
}

const CONVERSATION_POLICIES = new Set(['allow', 'deny', 'inherit']);
const CONVERSATION_KINDS = new Set<ChannelConversationKind>(['direct', 'group', 'channel', 'thread', 'service']);


function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function throwInvalidChannelPolicySnapshot(): never {
  throw new Error('Channel policy store snapshot is invalid.');
}

function validateOptionalString(value: unknown): void {
  if (value !== undefined && typeof value !== 'string') throwInvalidChannelPolicySnapshot();
}

function validateOptionalBoolean(value: unknown): void {
  if (value !== undefined && typeof value !== 'boolean') throwInvalidChannelPolicySnapshot();
}

function validateOptionalStringArray(value: unknown): void {
  if (value !== undefined && !isStringArray(value)) throwInvalidChannelPolicySnapshot();
}

function validateChannelGroupPolicyRecord(value: unknown): void {
  if (!isRecord(value) || typeof value['id'] !== 'string') throwInvalidChannelPolicySnapshot();
  validateOptionalString(value['label']);
  validateOptionalString(value['groupId']);
  validateOptionalString(value['channelId']);
  validateOptionalString(value['workspaceId']);
  validateOptionalBoolean(value['requireMention']);
  validateOptionalBoolean(value['allowGroupMessages']);
  validateOptionalBoolean(value['allowThreadMessages']);
  validateOptionalBoolean(value['allowTextCommandsWithoutMention']);
  validateOptionalStringArray(value['allowlistUserIds']);
  validateOptionalStringArray(value['allowlistChannelIds']);
  validateOptionalStringArray(value['allowlistGroupIds']);
  validateOptionalStringArray(value['allowedCommands']);
  if (value['metadata'] !== undefined && !isRecord(value['metadata'])) throwInvalidChannelPolicySnapshot();
}

function validateChannelPolicyRecord(value: unknown): void {
  if (!isRecord(value) || typeof value['surface'] !== 'string') throwInvalidChannelPolicySnapshot();
  validateOptionalBoolean(value['enabled']);
  validateOptionalBoolean(value['requireMention']);
  validateOptionalBoolean(value['allowDirectMessages']);
  validateOptionalBoolean(value['allowGroupMessages']);
  validateOptionalBoolean(value['allowThreadMessages']);
  validateOptionalBoolean(value['allowTextCommandsWithoutMention']);
  const dmPolicy = value['dmPolicy'];
  if (dmPolicy !== undefined && (typeof dmPolicy !== 'string' || !CONVERSATION_POLICIES.has(dmPolicy))) {
    throwInvalidChannelPolicySnapshot();
  }
  const groupPolicy = value['groupPolicy'];
  if (groupPolicy !== undefined && (typeof groupPolicy !== 'string' || !CONVERSATION_POLICIES.has(groupPolicy))) {
    throwInvalidChannelPolicySnapshot();
  }
  validateOptionalStringArray(value['allowlistUserIds']);
  validateOptionalStringArray(value['allowlistChannelIds']);
  validateOptionalStringArray(value['allowlistGroupIds']);
  validateOptionalStringArray(value['allowedCommands']);
  if (value['groupPolicies'] !== undefined) {
    if (!Array.isArray(value['groupPolicies'])) throwInvalidChannelPolicySnapshot();
    for (const groupPolicy of value['groupPolicies']) validateChannelGroupPolicyRecord(groupPolicy);
  }
  validateOptionalBoolean(value['open']);
  validateOptionalString(value['ownerId']);
  if (value['ownerSince'] !== undefined && !isFiniteNumber(value['ownerSince'])) throwInvalidChannelPolicySnapshot();
  if (value['updatedAt'] !== undefined && !isFiniteNumber(value['updatedAt'])) throwInvalidChannelPolicySnapshot();
  if (value['metadata'] !== undefined && !isRecord(value['metadata'])) throwInvalidChannelPolicySnapshot();
}

function validateChannelPolicyAuditRecord(value: unknown): void {
  if (
    !isRecord(value)
    || typeof value['id'] !== 'string'
    || typeof value['surface'] !== 'string'
    || !isFiniteNumber(value['createdAt'])
    || typeof value['allowed'] !== 'boolean'
    || typeof value['reason'] !== 'string'
    || !isRecord(value['metadata'])
  ) {
    throwInvalidChannelPolicySnapshot();
  }
  validateOptionalString(value['userId']);
  validateOptionalString(value['channelId']);
  validateOptionalString(value['groupId']);
  validateOptionalString(value['threadId']);
  validateOptionalString(value['matchedGroupPolicyId']);
  validateOptionalString(value['text']);
  const conversationKind = value['conversationKind'];
  if (
    conversationKind !== undefined
    && (typeof conversationKind !== 'string' || !CONVERSATION_KINDS.has(conversationKind as ChannelConversationKind))
  ) {
    throwInvalidChannelPolicySnapshot();
  }
}

function validateChannelPolicySnapshot(snapshot: ChannelPolicySnapshot | null): ChannelPolicySnapshot | null {
  if (!snapshot) return null;
  if (!isRecord(snapshot) || !Array.isArray(snapshot.policies) || !Array.isArray(snapshot.audit)) throwInvalidChannelPolicySnapshot();
  for (const policy of snapshot.policies) validateChannelPolicyRecord(policy);
  for (const audit of snapshot.audit) validateChannelPolicyAuditRecord(audit);
  return snapshot;
}

export class ChannelPolicyManager {
  private readonly store: PersistentStore<ChannelPolicySnapshot>;
  private readonly policies = new Map<ChannelSurface, ChannelPolicyRecord>();
  private readonly audit: ChannelPolicyAuditRecord[] = [];
  private loaded = false;
  private starting: Promise<void> | undefined;
  private auditFlushTimer: ReturnType<typeof setTimeout> | null = null;
  /** Whole-store writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();
  /** Where owner claims are asked; absent, the first identified sender becomes the owner. */
  private ownerInbox: ChannelOwnerClaimInbox | null = null;
  private ownerInboxUnsubscribe: (() => void) | null = null;
  /** Owner claims answered while this process was not attached, settled once the policies are loaded. */
  private pendingClaimReplay: (() => void) | null = null;
  /** Per surface, moved by every change of its policy record; a decision carries the one it was made under. */
  readonly #revisions = new Map<ChannelSurface, number>();

  constructor(
    options: {
      readonly store?: PersistentStore<ChannelPolicySnapshot> | undefined;
      readonly storePath?: string | undefined;
    },
  ) {
    if (options.store) {
      this.store = options.store;
      return;
    }
    if (!options.storePath) {
      throw new Error('ChannelPolicyManager requires an explicit store or storePath');
    }
    this.store = new PersistentStore<ChannelPolicySnapshot>(options.storePath);
  }

  async start(): Promise<void> {
    if (this.loaded) return;
    this.starting ??= this.load();
    try { await this.starting; }
    finally { this.starting = undefined; }
    const replay = this.pendingClaimReplay;
    this.pendingClaimReplay = null;
    replay?.();
  }

  private async load(): Promise<void> {
    const snapshot = validateChannelPolicySnapshot(await this.store.load());
    for (const surface of this.policies.keys()) this.#moved(surface);
    this.policies.clear();
    this.audit.length = 0;
    for (const policy of snapshot?.policies ?? []) {
      this.policies.set(policy.surface, {
        ...defaultPolicy(policy.surface),
        ...policy,
        allowDirectMessages: policy.allowDirectMessages ?? true,
        allowGroupMessages: policy.allowGroupMessages ?? true,
        allowThreadMessages: policy.allowThreadMessages ?? true,
        dmPolicy: policy.dmPolicy ?? 'inherit',
        groupPolicy: policy.groupPolicy ?? 'inherit',
        allowTextCommandsWithoutMention: policy.allowTextCommandsWithoutMention ?? false,
        allowlistGroupIds: policy.allowlistGroupIds ?? [],
        groupPolicies: (policy.groupPolicies ?? []).map(normalizeGroupPolicy),
        metadata: policy.metadata ?? {},
        ownerId: settledOwner({ ownerId: policy.ownerId, allowlistUserIds: policy.allowlistUserIds ?? [], groupPolicies: policy.groupPolicies ?? [] }),
      });
      this.#moved(policy.surface);
    }
    this.audit.push(...(snapshot?.audit ?? []));
    this.loaded = true;
  }

  listPolicies(): ChannelPolicyRecord[] {
    return [...this.policies.values()].sort((a, b) => a.surface.localeCompare(b.surface));
  }

  listAudit(limit = 100): ChannelPolicyAuditRecord[] {
    return this.audit.slice(0, Math.max(1, limit));
  }

  getPolicy(surface: ChannelSurface): ChannelPolicyRecord {
    return this.policies.get(surface) ?? defaultPolicy(surface);
  }

  /**
   * The surface's policy revision. A decision carries the revision it was
   * made under, so "is that decision still current" is one integer compare.
   */
  revision(surface: ChannelSurface): number {
    return this.#revisions.get(surface) ?? 0;
  }

  #moved(surface: ChannelSurface): void {
    this.#revisions.set(surface, this.revision(surface) + 1);
  }

  /**
   * Ask the owner, through the owner inbox, before an unknown sender becomes a
   * surface's owner. Once attached, the first message from an unknown sender on
   * a surface with no allowlist (and not `open`) is held as a claim the owner
   * accepts or declines from any surface that lists the inbox; the sender is
   * answered only after it is accepted. Returns the detach function.
   */
  attachOwnerInbox(inbox: ChannelOwnerClaimInbox): () => void {
    this.ownerInboxUnsubscribe?.();
    this.ownerInbox = inbox;
    const settle = (item: OwnerItem): void => {
      if (item.kind !== 'claim' || !item.key?.startsWith(CLAIM_KEY_PREFIX) || item.status !== 'answered') return;
      void this.settleOwnerClaim(item).catch((error: unknown) => {
        logger.error('An accepted channel owner claim could not be saved; the sender is not the owner yet', {
          claimId: item.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };
    this.ownerInboxUnsubscribe = inbox.subscribe(settle);
    // An answer given before this attach (a restart in between) still counts, once. An answer closed
    // no later than the surface policy's last change is already in it, or was overridden by the owner
    // since (a sender accepted and later removed stays removed), so it is not applied again. The
    // policy times are read before any answer is applied, since applying one moves its surface's time.
    // It is read when the policies are, not at attach, so attaching at start-up opens no log.
    const replay = (): void => {
      const answered: { readonly item: OwnerItem; readonly surface: string; readonly closedAt: number }[] = [];
      for (const item of inbox.listNow({ kinds: ['claim'], status: 'closed' })) {
        const surface = item.metadata?.['surface'];
        if (item.status === 'answered' && item.closedAt !== undefined && typeof surface === 'string') {
          answered.push({ item, surface, closedAt: item.closedAt });
        }
      }
      const changedAt = new Map<string, number>();
      for (const { surface } of answered) {
        if (!changedAt.has(surface)) changedAt.set(surface, this.getPolicy(surface as ChannelSurface).updatedAt);
      }
      // Oldest first, so the first accepted sender is the one recorded as owner.
      for (const { item, surface, closedAt } of answered.reverse()) {
        if (closedAt > (changedAt.get(surface) ?? 0)) settle(item);
      }
    };
    if (this.loaded) replay();
    else this.pendingClaimReplay = replay;
    return () => {
      this.ownerInboxUnsubscribe?.();
      this.ownerInboxUnsubscribe = null;
      if (this.pendingClaimReplay === replay) this.pendingClaimReplay = null;
      if (this.ownerInbox === inbox) this.ownerInbox = null;
    };
  }

  /** The owner answered a claim: accept makes the sender the owner, decline is remembered. */
  private async settleOwnerClaim(item: OwnerItem): Promise<void> {
    await this.start();
    const surface = item.metadata?.['surface'];
    const userId = item.metadata?.['userId'];
    const groupPolicyId = item.metadata?.['groupPolicyId'];
    if (typeof surface !== 'string' || typeof userId !== 'string') return;
    const policy = this.getPolicy(surface as ChannelSurface);
    if (item.answer?.option !== 'accept') {
      const declined = Array.isArray(policy.metadata[DECLINED_CLAIMANTS_KEY])
        ? (policy.metadata[DECLINED_CLAIMANTS_KEY] as unknown[]).filter((entry): entry is string => typeof entry === 'string')
        : [];
      if (declined.includes(userId)) return;
      await this.savePolicy(policy.surface, { metadata: { ...policy.metadata, [DECLINED_CLAIMANTS_KEY]: [...declined, userId].slice(-MAX_DECLINED_CLAIMANTS) } });
      return;
    }
    const group = typeof groupPolicyId === 'string' ? policy.groupPolicies.find((entry) => entry.id === groupPolicyId) : undefined;
    const owners = group ? group.allowlistUserIds ?? [] : policy.allowlistUserIds;
    if (!owners.includes(userId)) {
      const owner = policy.ownerId ? {} : { ownerId: userId, ownerSince: Date.now() };
      await this.savePolicy(policy.surface, group
        ? { groupPolicies: policy.groupPolicies.map((entry) => entry === group ? { ...entry, allowlistUserIds: [...owners, userId] } : entry), ...owner }
        : { allowlistUserIds: [...owners, userId], ...owner });
    }
    logger.info('Channel owner claim accepted', { surface: policy.surface, userId });
    // A sender admitted to a surface that already had an owner leaves the other held senders waiting.
    if (policy.ownerId) return;
    // The surface has an owner now; the other senders' claims are moot.
    for (const other of this.ownerInbox?.listNow({ kinds: ['claim'], status: 'open' }) ?? []) {
      if (other.key?.startsWith(`${CLAIM_KEY_PREFIX}${policy.surface}:`)) {
        // A claim closed in the meantime is refused, which leaves nothing to do.
        this.ownerInbox?.withdraw(other.id, `${policy.surface} now has an owner`);
      }
    }
  }

  /** Raise (or find) the owner claim for this sender, unless the cap or a decline says not to. */
  private raiseOwnerClaim(input: ChannelIngressPolicyInput, decision: ChannelPolicyDecision): void {
    const inbox = this.ownerInbox;
    const userId = input.userId;
    if (!inbox || !userId) return;
    const policy = decision.policy;
    const declined = policy.metadata[DECLINED_CLAIMANTS_KEY];
    if (Array.isArray(declined) && declined.includes(userId)) return;
    const prefix = `${CLAIM_KEY_PREFIX}${input.surface}:`;
    const key = `${prefix}${userId}`.slice(0, 200);
    const open = inbox.listNow({ kinds: ['claim'], status: 'open' }).filter((item) => item.key?.startsWith(prefix));
    if (!open.some((item) => item.key === key) && open.length >= MAX_OPEN_CLAIMS_PER_SURFACE) return;
    const name = typeof input.metadata?.['displayName'] === 'string' ? ` (${String(input.metadata['displayName']).slice(0, 60)})` : '';
    const shownId = userId.slice(0, 80);
    const where = input.conversationKind === 'direct' ? 'a direct message' : `a ${normalizeConversationKind(input)} message`;
    // A surface that already answers someone holds a new sender for the owner instead of ignoring them unseen.
    const hasOwner = decision.reason === 'user-not-allowlisted';
    try {
      inbox.postNow({
        kind: 'claim',
        key,
        title: hasOwner ? `Let ${shownId}${name} reach you on ${input.surface}?` : `Make ${shownId}${name} the owner of ${input.surface}?`,
        detail: hasOwner
          ? `${where} arrived on ${input.surface} from ${shownId}${name}, who is not on its allowlist, so it was not answered. `
            + 'Accept to add this sender to the allowlist: the surface answers their next message. Decline if you do not know them; they are not asked about again.'
          : `${where} arrived on ${input.surface} from ${shownId}${name}, and ${input.surface} has no owner yet, so it was not answered. `
            + 'Accept to make this sender the owner: the surface then answers them, and only them until you add others with the allowlist edit. '
            + 'Decline if this is not you.',
        options: ['accept', 'decline'],
        askedBy: `${input.surface} channel`,
        metadata: {
          surface: input.surface,
          userId,
          ...(decision.matchedGroupPolicy && decision.matchedGroupPolicy.allowlistUserIds !== undefined ? { groupPolicyId: decision.matchedGroupPolicy.id } : {}),
        },
      }, `${input.surface} channel`);
    } catch (error) {
      logger.warn('Channel owner claim could not be raised', { surface: input.surface, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async upsertPolicy(
    surface: ChannelSurface,
    patch: Partial<Omit<ChannelPolicyRecord, 'surface' | 'updatedAt'>>,
  ): Promise<ChannelPolicyRecord> {
    await this.start();
    return await this.savePolicy(surface, patch);
  }

  /**
   * Save, then publish: the patched record is written with the rest of the
   * store and only then becomes the live policy. A failed write publishes
   * nothing and throws, so the daemon never enforces a policy it would forget
   * at restart, and a caller is never told a change took that did not. The
   * record is computed inside the queued write, so two changes in flight
   * apply in order and neither loses the other's patch.
   */
  private async savePolicy(surface: ChannelSurface, patch: Partial<Omit<ChannelPolicyRecord, 'surface' | 'updatedAt'>>): Promise<ChannelPolicyRecord> {
    let saved: ChannelPolicyRecord | undefined;
    await this.writes.run(async () => {
      const next = this.nextPolicy(surface, patch);
      const policies = [...this.policies.values()].filter((entry) => entry.surface !== surface);
      policies.push(next);
      policies.sort((a, b) => a.surface.localeCompare(b.surface));
      await this.store.persist({ policies, audit: [...this.audit] });
      this.policies.set(surface, next);
      this.#moved(surface);
      saved = next;
    });
    return saved!;
  }

  private updatePolicy(surface: ChannelSurface, patch: Partial<Omit<ChannelPolicyRecord, 'surface' | 'updatedAt'>>): ChannelPolicyRecord {
    const owned = this.nextPolicy(surface, patch);
    this.policies.set(surface, owned);
    this.#moved(surface);
    return owned;
  }

  /** The record `patch` makes of the surface's current policy; publishes nothing. */
  private nextPolicy(surface: ChannelSurface, patch: Partial<Omit<ChannelPolicyRecord, 'surface' | 'updatedAt'>>): ChannelPolicyRecord {
    const existing = this.getPolicy(surface);
    const next: ChannelPolicyRecord = {
      ...existing,
      ...patch,
      surface,
      updatedAt: Date.now(),
      allowDirectMessages: patch.allowDirectMessages ?? existing.allowDirectMessages,
      allowGroupMessages: patch.allowGroupMessages ?? existing.allowGroupMessages,
      allowThreadMessages: patch.allowThreadMessages ?? existing.allowThreadMessages,
      dmPolicy: patch.dmPolicy ?? existing.dmPolicy,
      groupPolicy: patch.groupPolicy ?? existing.groupPolicy,
      allowTextCommandsWithoutMention: patch.allowTextCommandsWithoutMention ?? existing.allowTextCommandsWithoutMention,
      allowlistUserIds: patch.allowlistUserIds ?? existing.allowlistUserIds,
      allowlistChannelIds: patch.allowlistChannelIds ?? existing.allowlistChannelIds,
      allowlistGroupIds: patch.allowlistGroupIds ?? existing.allowlistGroupIds,
      allowedCommands: patch.allowedCommands ?? existing.allowedCommands,
      groupPolicies: (patch.groupPolicies ?? existing.groupPolicies).map(normalizeGroupPolicy),
      metadata: patch.metadata ?? existing.metadata,
    };
    const ownerId = settledOwner(next);
    return ownerId === next.ownerId ? next
      : { ...next, ownerId, ownerSince: ownerId === undefined ? undefined : Date.now() };
  }

  /** A decision the caller already made under the current revision, or a fresh one. */
  private decisionFor(input: ChannelIngressPolicyInput, decided: ChannelPolicyDecision | undefined): ChannelPolicyDecision {
    return decided !== undefined && decided.revision === this.revision(input.surface) && decided.policy.surface === input.surface
      ? decided : this.decideIngress(input);
  }

  private decideIngress(input: ChannelIngressPolicyInput): ChannelPolicyDecision {
    const revision = this.revision(input.surface);
    const policy = this.getPolicy(input.surface);
    const conversationKind = normalizeConversationKind(input);
    const parentKind = conversationKind === 'thread'
      ? input.parentConversationKind ?? (input.groupId ? 'group' : input.channelId ? 'channel' : 'service')
      : conversationKind;
    const matchedGroupPolicy = selectGroupPolicy(policy, input);
    const requireMention = matchedGroupPolicy?.requireMention ?? policy.requireMention;
    const allowTextCommandsWithoutMention = matchedGroupPolicy?.allowTextCommandsWithoutMention
      ?? policy.allowTextCommandsWithoutMention;
    const allowlistUserIds = matchedGroupPolicy?.allowlistUserIds ?? policy.allowlistUserIds;
    const allowlistChannelIds = matchedGroupPolicy?.allowlistChannelIds ?? policy.allowlistChannelIds;
    const allowlistGroupIds = matchedGroupPolicy?.allowlistGroupIds ?? policy.allowlistGroupIds;
    const allowedCommands = matchedGroupPolicy?.allowedCommands ?? policy.allowedCommands;
    const allowGroupMessages = matchedGroupPolicy?.allowGroupMessages ?? policy.allowGroupMessages;
    const allowThreadMessages = matchedGroupPolicy?.allowThreadMessages ?? policy.allowThreadMessages;
    const command = firstCommand(input.text, input.controlCommand);
    const isAuthorizedControlCommand = commandAllowed(command, allowedCommands);
    const bypassMention =
      (conversationKind === 'group' || conversationKind === 'channel' || conversationKind === 'thread')
      && requireMention
      && !input.mentioned
      && !input.hasAnyMention
      && allowTextCommandsWithoutMention
      && Boolean(command)
      && isAuthorizedControlCommand;
    const listed = admitByAllowlists(
      { allowlistUserIds, allowlistGroupIds, allowlistChannelIds, ownerId: policy.ownerId },
      { conversationKind: parentKind === 'direct' ? 'direct' : conversationKind, userId: input.userId, groupId: input.groupId, channelId: input.channelId },
    );
    let allowed = true;
    let reason = 'allowed';
    if (!policy.enabled) {
      allowed = false;
      reason = 'surface-disabled';
    } else if (parentKind === 'direct' && (policy.dmPolicy === 'deny' || !policy.allowDirectMessages)) {
      allowed = false;
      reason = 'direct-messages-disabled';
    } else if ((parentKind === 'group' || parentKind === 'channel') && (policy.groupPolicy === 'deny' || !allowGroupMessages)) {
      allowed = false;
      reason = 'group-messages-disabled';
    } else if (conversationKind === 'thread' && !allowThreadMessages) {
      allowed = false;
      reason = 'thread-messages-disabled';
    } else if (!listed.allowed) {
      allowed = false;
      reason = listed.reason;
    } else if (this.ownerInbox && !policy.open && input.userId && allowlistUserIds.length === 0
      && allowlistGroupIds.length === 0 && allowlistChannelIds.length === 0) {
      // No owner and not open: the sender waits for the owner's answer to a claim.
      allowed = false;
      reason = 'owner-claim-pending';
    } else if (requireMention && !input.mentioned && !bypassMention) {
      allowed = false;
      reason = 'mention-required';
    } else if (!commandAllowed(command, allowedCommands)) {
      allowed = false;
      reason = 'command-not-allowed';
    }

    return {
      allowed, reason, policy,
      ...(matchedGroupPolicy ? { matchedGroupPolicy } : {}),
      matchedScope: matchedGroupPolicy ? 'group' : 'surface',
      effectiveRequireMention: requireMention,
      effectiveAllowedCommands: allowedCommands,
      revision,
    };
  }

  /**
   * Decide a message under the surface policy. With `admit: false` this is
   * the decision alone (no audit, no owner seeding, no claim), for a caller
   * that must refuse a source before anything reads its text; it then passes
   * that decision back as `decided`, and it is reused while the surface's
   * revision has not moved, so a message is decided once.
   */
  async evaluateIngress(input: ChannelIngressPolicyInput, options: {
    readonly recordDenied?: boolean;
    readonly admit?: boolean;
    readonly decided?: ChannelPolicyDecision;
  } = {}): Promise<ChannelPolicyDecision> {
    await this.start();
    const decision = this.decisionFor(input, options.decided);
    if (options.admit === false) return decision;
    if (decision.reason === 'owner-claim-pending' || decision.reason === 'user-not-allowlisted') this.raiseOwnerClaim(input, decision);
    // Source-scoped callers may refuse fresh denials without retaining text.
    if (!decision.allowed && options.recordDenied === false) return decision;
    const { allowed, policy, matchedGroupPolicy } = decision;
    let reason = decision.reason;
    const allowlistUserIds = matchedGroupPolicy?.allowlistUserIds ?? policy.allowlistUserIds;
    const allowlistGroupIds = matchedGroupPolicy?.allowlistGroupIds ?? policy.allowlistGroupIds;
    const allowlistChannelIds = matchedGroupPolicy?.allowlistChannelIds ?? policy.allowlistChannelIds;
    // A host with no owner inbox (an embedder) cannot ask, so there the first
    // identified sender on a surface with no allowlist becomes its owner, and
    // status names who and since when. With the inbox attached, decideIngress
    // has already held that sender as a claim.
    let effectivePolicy = policy;
    if (allowed && !this.ownerInbox && !policy.open && allowlistUserIds.length === 0
      && allowlistGroupIds.length === 0 && allowlistChannelIds.length === 0 && input.userId) {
      // Publish ownership before awaiting disk so another ingress cannot also
      // seed the empty scope. An explicit group override owns its own seed.
      const before = this.policies.get(input.surface);
      effectivePolicy = this.updatePolicy(input.surface, matchedGroupPolicy?.allowlistUserIds !== undefined
        ? { groupPolicies: policy.groupPolicies.map(entry => entry === matchedGroupPolicy ? { ...entry, allowlistUserIds: [input.userId!] } : entry),
          ...(policy.ownerId ? {} : { ownerId: input.userId, ownerSince: Date.now() }) }
        : { allowlistUserIds: [input.userId], ownerId: input.userId, ownerSince: Date.now() });
      try {
        await this.persist();
      } catch (error) {
        // An owner that exists only in memory would be forgotten at restart, and
        // the next sender to speak would then become the owner instead. Leave the
        // scope unseeded so the next message retries the whole step.
        if (this.policies.get(input.surface) === effectivePolicy) {
          if (before) this.policies.set(input.surface, before);
          else this.policies.delete(input.surface);
          this.#moved(input.surface);
        }
        throw error;
      }
      reason = 'owner-allowlist-seeded';
      logger.info('Channel owner allowlist seeded from the first identified sender', {
        surface: input.surface,
        userId: input.userId,
      });
    }

    this.recordIngressAudit(input, { ...decision, reason, policy: effectivePolicy }, true);

    // Seeding the owner is a change of the record: the decision carries the revision it now stands under.
    return { ...decision, reason, policy: effectivePolicy, revision: this.revision(input.surface),
      ...(matchedGroupPolicy ? { matchedGroupPolicy: effectivePolicy.groupPolicies.find(entry => entry.id === matchedGroupPolicy.id) } : {}),
    };
  }

  /**
   * Preserve a denied source's bookkeeping without retaining its text or
   * arbitrary metadata. A sender waiting on an owner claim gets the claim
   * raised here too (it holds no message text), so the owner is asked
   * whichever path refused the message.
   */
  async recordDeniedIngress(input: ChannelIngressPolicyInput, decided?: ChannelPolicyDecision): Promise<ChannelPolicyDecision> {
    await this.start();
    const decision = this.decisionFor(input, decided);
    if (decision.reason === 'owner-claim-pending' || decision.reason === 'user-not-allowlisted') this.raiseOwnerClaim(input, decision);
    if (!decision.allowed) this.recordIngressAudit(input, decision, false);
    return decision;
  }

  private recordIngressAudit(input: ChannelIngressPolicyInput, decision: ChannelPolicyDecision, retainText: boolean): void {
    const { allowed, reason, matchedGroupPolicy } = decision;
    // Denied body identity fields are still untrusted prose. Preserve useful
    // safe identifiers, but never retain credentials smuggled in those fields.
    const safeIdentity = (value: string | undefined) => typeof value === 'string' && judgmentInputProblem(value) === undefined ? value : undefined;
    const identity = retainText ? input : {
      userId: safeIdentity(input.userId), channelId: safeIdentity(input.channelId),
      groupId: safeIdentity(input.groupId), threadId: safeIdentity(input.threadId),
    };
    const matchedGroupPolicyId = retainText ? matchedGroupPolicy?.id : safeIdentity(matchedGroupPolicy?.id);
    const conversationKind = normalizeConversationKind(input);
    if (!allowed && (reason === 'user-not-allowlisted' || reason === 'missing-user-identity')) {
      logger.info('Channel message from unknown sender ignored', {
        surface: input.surface,
        ...(identity.userId ? { userId: identity.userId } : {}),
        reason,
      });
    }

    this.audit.unshift({
      id: `policy-audit-${randomUUID().slice(0, 8)}`,
      surface: input.surface,
      createdAt: Date.now(),
      allowed,
      reason,
      ...(identity.userId ? { userId: identity.userId } : {}),
      ...(identity.channelId ? { channelId: identity.channelId } : {}),
      ...(identity.groupId ? { groupId: identity.groupId } : {}),
      ...(identity.threadId ? { threadId: identity.threadId } : {}),
      conversationKind,
      ...(matchedGroupPolicyId ? { matchedGroupPolicyId } : {}),
      // Digits are masked whatever the message says, so the audit trail never
      // holds a card number or code and does not wait on any reading of the text.
      ...(retainText && input.text ? { text: maskDigits(input.text.slice(0, 200)) } : {}),
      metadata: retainText ? input.metadata ?? {} : {},
    });
    if (this.audit.length > MAX_AUDIT_RECORDS) {
      this.audit.length = MAX_AUDIT_RECORDS;
    }
    // Audit telemetry is durability-decoupled from the per-message decision path:
    // schedule a coalesced flush rather than awaiting a full-snapshot disk write on
    // every inbound message. Call stop() to force a final flush on graceful shutdown.
    this.scheduleAuditFlush();
  }

  private scheduleAuditFlush(): void {
    if (this.auditFlushTimer) return;
    const timer = setTimeout(() => {
      this.auditFlushTimer = null;
      // The flush goes through the same write queue every other write uses.
      // It used to have a chain of its own, which ordered flushes against each
      // OTHER and against nothing else, the write it actually races is
      // `upsertPolicy`'s.
      void this.persist().catch((error: unknown) => {
        logger.warn('Channel policy audit flush failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      });
    }, AUDIT_FLUSH_INTERVAL_MS);
    timer.unref?.();
    this.auditFlushTimer = timer;
  }

  /**
   * Flush any pending debounced audit writes and stop the flush timer. Call on
   * graceful shutdown so the last batch of audit records is durably persisted.
   */
  async stop(): Promise<void> {
    if (this.auditFlushTimer) {
      clearTimeout(this.auditFlushTimer);
      this.auditFlushTimer = null;
    }
    // A flush already in flight settles first, so the final write below is the
    // last one to land rather than a race against it.
    await this.writes.drain();
    if (this.loaded) await this.persist();
  }

  /**
   * Write the policies and audit trail as they stand at THIS call, after every
   * write already queued has finished.
   *
   * Two paths write this file and they were ordered only against themselves:
   * `upsertPolicy` awaited its write, and the debounced audit flush ran on a
   * private chain. `evaluateIngress` schedules a flush on EVERY inbound message,
   * so a "disable this surface" ruling, or the owner-allowlist seeding that
   * decides which sender the surface answers at all, arriving while a flush was
   * in flight could be overwritten by that flush's older snapshot. The surface
   * comes back enabled, or the allowlist comes back empty and adopts the next
   * sender that speaks.
   */
  private async persist(): Promise<void> {
    const snapshot: ChannelPolicySnapshot = {
      policies: this.listPolicies(),
      audit: [...this.audit],
    };
    await this.writes.run(() => this.store.persist(snapshot));
  }
}
