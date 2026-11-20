/**
 * effect-authority.ts, the one table of who may cause what.
 *
 * Whether an effect may happen is decided once, by the effect, from who is
 * causing it (daemon-api/src/actor.ts `Actor`). Every builtin operator method
 * declares the effects it causes (`methodDescriptor({ effects })`); its
 * published `access`, `scopes`, `ownerOnly`, `irreversible`,
 * `changesContract` and `effect` are computed from these rows, so what the
 * contract says is what is enforced. Paths that are not catalog methods (a
 * chat sender's button, a settings write that loosens security, the event
 * stream) call `admitEffects` with their own actor and the effect they cause.
 *
 * Ids are named for what happens. The rows under "one per scope" are the
 * mechanical first pass: one effect per scope a method needs, `read`/`write`
 * for anyone holding the scope, `inspect`/`administer` where an admin is
 * needed. The named rows above them say more than a scope can (the owner
 * himself, a question to the owner instead of a refusal, a subject the actor
 * must own); the flag rows mark what a method also does (cannot be undone,
 * sends outward, changes a contract, is the owner's own act).
 *
 * Cost: a table lookup and a set membership per effect; no I/O.
 */
import { actorHoldsScope, type Actor, type ActorClass } from '@goodvibes-jev/engine/daemon-api/http-policy';
import type { OwnerOnlyKind } from '../gate/classify.js';

/** The classes a rule's `least` and an ask's `floor` name. A peer reaches only rows whose `least` is `peer`. */
export type EffectClass = Exclude<ActorClass, 'system'>;

interface EffectRow {
  readonly id: string;
  /** Lowest class that causes it without asking. */
  readonly least: EffectClass;
  /** A member, device or guest must also hold this scope; the owner and an admin hold every scope. Empty: no scope. */
  readonly scope: string;
  /** `own`: below admin, only on a subject whose owners include the actor (the caller that holds the subject passes it). */
  readonly subject: 'any' | 'own';
  /** Below `least` but at or above `floor`: a question to the owner instead of a refusal. */
  readonly ask?: { readonly kind: OwnerOnlyKind; readonly floor: EffectClass } | undefined;
  /** A model never causes it, whoever it acts for. */
  readonly modelRefused?: true | undefined;
  /** It deletes or ends what nothing restores. */
  readonly irreversible?: true | undefined;
  /** It changes what a running contract requires. */
  readonly changesContract?: true | undefined;
  /** It sends something to a third party or a provider. */
  readonly outward?: true | undefined;
  /** Anyone may cause it, signed in or not (signing in itself). */
  readonly public?: true | undefined;
}

const ROWS = [
  // ── Named effects ──────────────────────────────────────────────────────
  { id: 'auth.sign-in', least: 'guest', scope: '', subject: 'any', public: true },
  // A paired device (a phone that only chats) reads, joins and shares the sessions it owns, as a member does.
  { id: 'session.transcript.read', least: 'device', scope: 'read:transcripts', subject: 'own' },
  { id: 'session.attach', least: 'device', scope: 'write:sessions', subject: 'own' },
  /** Adding a principal to a session's owners; only an owner of the session (or an admin) shares it. */
  { id: 'session.share', least: 'device', scope: 'write:sessions', subject: 'own' },
  /** Live `turn`/`tools`/`gate`/`session` frames and approval and hosted-session notices of a session (the event stream reads it). */
  { id: 'session.watch', least: 'device', scope: 'read:own-sessions', subject: 'own' },
  { id: 'session.end', least: 'device', scope: 'write:sessions', subject: 'own', irreversible: true },
  /** A turn started in a conversation: a guest's becomes the owner's question for everything beyond a plain read. */
  { id: 'turn.start', least: 'member', scope: 'write:sessions', subject: 'own', ask: { kind: 'channel-request', floor: 'guest' } },
  { id: 'run.cancel', least: 'member', scope: 'write:automation', subject: 'own' },
  { id: 'run.retry', least: 'member', scope: 'write:automation', subject: 'own' },
  { id: 'approval.raise', least: 'device', scope: 'write:approvals', subject: 'own' },
  /** Reading an approval record the actor raised (a coalesced raise returns it only to its raiser). */
  { id: 'approval.read', least: 'device', scope: 'read:approvals', subject: 'own' },
  /** Answering an approval, a question or a purchase window put to the owner. */
  { id: 'approval.answer', least: 'owner', scope: 'write:approvals', subject: 'any', modelRefused: true },
  { id: 'owner-inbox.post', least: 'device', scope: 'write:approvals', subject: 'own' },
  { id: 'owner-inbox.read', least: 'owner', scope: 'read:approvals', subject: 'any' },
  { id: 'stepup.credential.register', least: 'admin', scope: 'write:relay', subject: 'any', modelRefused: true },
  { id: 'hook.fire', least: 'admin', scope: 'write:hooks', subject: 'any' },
  { id: 'settings.write', least: 'admin', scope: 'write:config', subject: 'any' },
  /** A settings change that loosens a security, permission, judgment or payment setting: an admin's is put to the owner. */
  { id: 'settings.loosen', least: 'owner', scope: 'write:config', subject: 'any', ask: { kind: 'loosen-security', floor: 'admin' } },
  { id: 'secret.write', least: 'admin', scope: 'write:config', subject: 'any', modelRefused: true },
  /** Entering a card or its security code. */
  { id: 'card.enter', least: 'owner', scope: 'write:payments', subject: 'any', modelRefused: true },
  { id: 'purchase.start', least: 'owner', scope: 'write:payments', subject: 'any', ask: { kind: 'spend-over-limit', floor: 'member' } },
  /** Answering a purchase window, a standing authorization or a reconciliation. */
  { id: 'purchase.approve', least: 'owner', scope: 'write:payments', subject: 'any', modelRefused: true },
  /** A call to a plugin's method, held to the access and scopes the plugin declared for it (declaredAccessRules). */
  { id: 'plugin.call', least: 'device', scope: '', subject: 'any' },
  // ── Live event domains (the event stream reads them; gateway-scope-enforcement.ts) ──
  { id: 'events.session', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.turn', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.providers', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.tools', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.tasks', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.agents', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.contracts', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.communication', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.planner', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.gate', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.plugins', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.mcp', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.transport', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.compaction', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.ui', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.ops', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.forensics', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.security', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.automation', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.routes', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.control-plane', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.deliveries', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.watchers', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.surfaces', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.knowledge', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.workspace', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'events.fleet', least: 'admin', scope: 'read:events', subject: 'any' },
  { id: 'events.config', least: 'admin', scope: 'read:events', subject: 'any' },
  // ── What a method also does ────────────────────────────────────────────
  /** The owner's own act (granting or withdrawing access, restoring what he keeps): a model never makes it. */
  { id: 'owner.act', least: 'guest', scope: '', subject: 'any', modelRefused: true },
  { id: 'record.destroy', least: 'guest', scope: '', subject: 'any', irreversible: true },
  { id: 'contract.change', least: 'guest', scope: '', subject: 'any', changesContract: true },
  { id: 'outward.send', least: 'guest', scope: '', subject: 'any', outward: true },
  // ── One per scope ──────────────────────────────────────────────────────
  { id: 'accounts.read', least: 'device', scope: 'read:accounts', subject: 'any' },
  { id: 'approvals.administer', least: 'admin', scope: 'write:approvals', subject: 'any' },
  { id: 'approvals.read', least: 'device', scope: 'read:approvals', subject: 'any' },
  { id: 'approvals.write', least: 'device', scope: 'write:approvals', subject: 'any' },
  { id: 'artifacts.administer', least: 'admin', scope: 'write:artifacts', subject: 'any' },
  { id: 'artifacts.inspect', least: 'admin', scope: 'read:artifacts', subject: 'any' },
  { id: 'auth.administer', least: 'admin', scope: 'write:auth', subject: 'any' },
  { id: 'auth.inspect', least: 'admin', scope: 'read:auth', subject: 'any' },
  { id: 'automation-content.read', least: 'device', scope: 'read:automation-content', subject: 'any' },
  { id: 'automation.administer', least: 'admin', scope: 'write:automation', subject: 'any' },
  { id: 'automation.inspect', least: 'admin', scope: 'read:automation', subject: 'any' },
  { id: 'automation.read', least: 'device', scope: 'read:automation', subject: 'any' },
  { id: 'batch.administer', least: 'admin', scope: 'write:batch', subject: 'any' },
  { id: 'batch.read', least: 'device', scope: 'read:batch', subject: 'any' },
  { id: 'browser-content.read', least: 'device', scope: 'read:browser-content', subject: 'any' },
  { id: 'browser.read', least: 'device', scope: 'read:browser', subject: 'any' },
  { id: 'browser.write', least: 'device', scope: 'write:browser', subject: 'any' },
  { id: 'calendar.administer', least: 'admin', scope: 'write:calendar', subject: 'any' },
  { id: 'calendar.read', least: 'device', scope: 'read:calendar', subject: 'any' },
  { id: 'channel-content.read', least: 'device', scope: 'read:channel-content', subject: 'any' },
  { id: 'channels.administer', least: 'admin', scope: 'write:channels', subject: 'any' },
  { id: 'channels.read', least: 'device', scope: 'read:channels', subject: 'any' },
  { id: 'channels.write', least: 'device', scope: 'write:channels', subject: 'any' },
  { id: 'checkin.administer', least: 'admin', scope: 'write:checkin', subject: 'any' },
  { id: 'checkin.read', least: 'device', scope: 'read:checkin', subject: 'any' },
  { id: 'checkin.write', least: 'device', scope: 'write:checkin', subject: 'any' },
  { id: 'checkpoints.read', least: 'device', scope: 'read:checkpoints', subject: 'any' },
  { id: 'checkpoints.write', least: 'device', scope: 'write:checkpoints', subject: 'any' },
  { id: 'ci.read', least: 'device', scope: 'read:ci', subject: 'any' },
  { id: 'ci.write', least: 'device', scope: 'write:ci', subject: 'any' },
  { id: 'cloudflare.administer', least: 'admin', scope: 'write:cloudflare', subject: 'any' },
  { id: 'cloudflare.inspect', least: 'admin', scope: 'read:cloudflare', subject: 'any' },
  { id: 'config.administer', least: 'admin', scope: 'write:config', subject: 'any' },
  { id: 'config.inspect', least: 'admin', scope: 'read:config', subject: 'any' },
  { id: 'config.read', least: 'device', scope: 'read:config', subject: 'any' },
  { id: 'config.write', least: 'device', scope: 'write:config', subject: 'any' },
  { id: 'continuity.read', least: 'device', scope: 'read:continuity', subject: 'any' },
  { id: 'control-plane.administer', least: 'admin', scope: 'write:control-plane', subject: 'any' },
  { id: 'control-plane.inspect', least: 'admin', scope: 'read:control-plane', subject: 'any' },
  { id: 'control-plane.read', least: 'device', scope: 'read:control-plane', subject: 'any' },
  { id: 'control-plane.write', least: 'device', scope: 'write:control-plane', subject: 'any' },
  { id: 'deliveries.read', least: 'device', scope: 'read:deliveries', subject: 'any' },
  { id: 'deliveries.write', least: 'device', scope: 'write:deliveries', subject: 'any' },
  { id: 'email.administer', least: 'admin', scope: 'write:email', subject: 'any' },
  { id: 'email.inspect', least: 'admin', scope: 'read:email', subject: 'any' },
  { id: 'email.read', least: 'device', scope: 'read:email', subject: 'any' },
  { id: 'events.read', least: 'device', scope: 'read:events', subject: 'any' },
  { id: 'fleet-content.read', least: 'device', scope: 'read:fleet-content', subject: 'any' },
  { id: 'fleet.administer', least: 'admin', scope: 'write:fleet', subject: 'any' },
  { id: 'fleet.read', least: 'device', scope: 'read:fleet', subject: 'any' },
  { id: 'fleet.write', least: 'device', scope: 'write:fleet', subject: 'any' },
  { id: 'health.inspect', least: 'admin', scope: 'read:health', subject: 'any' },
  { id: 'health.read', least: 'device', scope: 'read:health', subject: 'any' },
  { id: 'intelligence.read', least: 'device', scope: 'read:intelligence', subject: 'any' },
  { id: 'judgment.write', least: 'device', scope: 'write:judgment', subject: 'any' },
  { id: 'knowledge-content.read', least: 'device', scope: 'read:knowledge-content', subject: 'any' },
  { id: 'knowledge.administer', least: 'admin', scope: 'write:knowledge', subject: 'any' },
  { id: 'knowledge.inspect', least: 'admin', scope: 'read:knowledge', subject: 'any' },
  { id: 'knowledge.read', least: 'device', scope: 'read:knowledge', subject: 'any' },
  { id: 'mcp.administer', least: 'admin', scope: 'write:mcp', subject: 'any' },
  { id: 'mcp.inspect', least: 'admin', scope: 'read:mcp', subject: 'any' },
  { id: 'mcp.read', least: 'device', scope: 'read:mcp', subject: 'any' },
  { id: 'media.administer', least: 'admin', scope: 'write:media', subject: 'any' },
  { id: 'media.inspect', least: 'admin', scope: 'read:media', subject: 'any' },
  { id: 'media.read', least: 'device', scope: 'read:media', subject: 'any' },
  { id: 'memory.administer', least: 'admin', scope: 'write:memory', subject: 'any' },
  { id: 'memory.read', least: 'device', scope: 'read:memory', subject: 'any' },
  { id: 'occasions.administer', least: 'admin', scope: 'write:occasions', subject: 'any' },
  { id: 'occasions.read', least: 'device', scope: 'read:occasions', subject: 'any' },
  { id: 'occasions.write', least: 'device', scope: 'write:occasions', subject: 'any' },
  { id: 'pairing.read', least: 'device', scope: 'read:pairing', subject: 'any' },
  { id: 'panels.administer', least: 'admin', scope: 'write:panels', subject: 'any' },
  { id: 'panels.read', least: 'device', scope: 'read:panels', subject: 'any' },
  { id: 'payments.administer', least: 'admin', scope: 'write:payments', subject: 'any' },
  { id: 'payments.read', least: 'device', scope: 'read:payments', subject: 'any' },
  { id: 'principals.read', least: 'device', scope: 'read:principals', subject: 'any' },
  { id: 'principals.write', least: 'device', scope: 'write:principals', subject: 'any' },
  { id: 'profile-document.read', least: 'device', scope: 'read:profile-document', subject: 'any' },
  { id: 'profile.administer', least: 'admin', scope: 'write:profile', subject: 'any' },
  { id: 'profile.read', least: 'device', scope: 'read:profile', subject: 'any' },
  { id: 'providers.administer', least: 'admin', scope: 'write:providers', subject: 'any' },
  { id: 'providers.read', least: 'device', scope: 'read:providers', subject: 'any' },
  { id: 'push.read', least: 'device', scope: 'read:push', subject: 'any' },
  { id: 'push.write', least: 'device', scope: 'write:push', subject: 'any' },
  { id: 'relay.administer', least: 'admin', scope: 'write:relay', subject: 'any' },
  { id: 'relay.inspect', least: 'admin', scope: 'read:relay', subject: 'any' },
  { id: 'relay.read', least: 'device', scope: 'read:relay', subject: 'any' },
  { id: 'remote.administer', least: 'admin', scope: 'write:remote', subject: 'any' },
  { id: 'remote.inspect', least: 'admin', scope: 'read:remote', subject: 'any' },
  { id: 'remote.read', least: 'device', scope: 'read:remote', subject: 'any' },
  { id: 'remote.write', least: 'device', scope: 'write:remote', subject: 'any' },
  { id: 'routes.administer', least: 'admin', scope: 'write:routes', subject: 'any' },
  { id: 'routes.inspect', least: 'admin', scope: 'read:routes', subject: 'any' },
  { id: 'routes.read', least: 'device', scope: 'read:routes', subject: 'any' },
  { id: 'services.administer', least: 'admin', scope: 'write:services', subject: 'any' },
  { id: 'services.inspect', least: 'admin', scope: 'read:services', subject: 'any' },
  { id: 'sessions.administer', least: 'admin', scope: 'write:sessions', subject: 'any' },
  { id: 'sessions.inspect', least: 'admin', scope: 'read:sessions', subject: 'any' },
  { id: 'sessions.read', least: 'device', scope: 'read:sessions', subject: 'any' },
  { id: 'sessions.write', least: 'device', scope: 'write:sessions', subject: 'any' },
  { id: 'settings.inspect', least: 'admin', scope: 'read:settings', subject: 'any' },
  { id: 'skill-content.read', least: 'device', scope: 'read:skill-content', subject: 'any' },
  { id: 'skills.read', least: 'device', scope: 'read:skills', subject: 'any' },
  { id: 'skills.write', least: 'device', scope: 'write:skills', subject: 'any' },
  { id: 'tasks.administer', least: 'admin', scope: 'write:tasks', subject: 'any' },
  { id: 'tasks.read', least: 'device', scope: 'read:tasks', subject: 'any' },
  { id: 'telemetry.read', least: 'device', scope: 'read:telemetry', subject: 'any' },
  { id: 'transcripts.read', least: 'device', scope: 'read:transcripts', subject: 'any' },
  { id: 'voice.administer', least: 'admin', scope: 'write:voice', subject: 'any' },
  { id: 'voice.read', least: 'device', scope: 'read:voice', subject: 'any' },
  { id: 'watchers.administer', least: 'admin', scope: 'write:watchers', subject: 'any' },
  { id: 'watchers.inspect', least: 'admin', scope: 'read:watchers', subject: 'any' },
  { id: 'watchers.read', least: 'device', scope: 'read:watchers', subject: 'any' },
  { id: 'web-search.administer', least: 'admin', scope: 'write:web-search', subject: 'any' },
  { id: 'web-search.read', least: 'device', scope: 'read:web-search', subject: 'any' },
  { id: 'work-ledger-import.administer', least: 'admin', scope: 'write:work-ledger-import', subject: 'any' },
  { id: 'work-ledger.administer', least: 'admin', scope: 'write:work-ledger', subject: 'any' },
  { id: 'work-ledger.inspect', least: 'admin', scope: 'read:work-ledger', subject: 'any' },
  { id: 'workspaces.read', least: 'device', scope: 'read:workspaces', subject: 'any' },
  { id: 'workspaces.write', least: 'device', scope: 'write:workspaces', subject: 'any' },
  { id: 'worktrees.read', least: 'device', scope: 'read:worktrees', subject: 'any' },
  { id: 'worktrees.write', least: 'device', scope: 'write:worktrees', subject: 'any' },
] as const satisfies readonly EffectRow[];

export type EffectId = (typeof ROWS)[number]['id'];

export interface EffectRule extends EffectRow {
  readonly id: EffectId;
}

/** Every effect id, in table order. */
export const EFFECT_IDS: readonly EffectId[] = Object.freeze(ROWS.map((row) => row.id));

/** The table, by id. */
export const EFFECTS: { readonly [K in EffectId]: EffectRule } = Object.freeze(
  Object.fromEntries(ROWS.map((row) => [row.id, Object.freeze(row)])) as { [K in EffectId]: EffectRule },
);

export function isEffectId(value: unknown): value is EffectId {
  return typeof value === 'string' && Object.hasOwn(EFFECTS, value);
}

export type EffectAdmission =
  | { readonly kind: 'allowed' }
  | { readonly kind: 'ask-owner'; readonly effect: EffectId; readonly ownerOnly: OwnerOnlyKind; readonly reason: string }
  | {
    readonly kind: 'refused'; readonly effect: EffectId;
    readonly code: 'MISSING_RIGHT' | 'NOT_YOURS' | 'OWNER_ONLY';
    /** The right that is missing, as the scope or the class: `read:transcripts`, `admin`, `owner`, `peer`. */
    readonly missing: string;
    readonly reason: string;
    readonly next: string;
  };

const ALLOWED: EffectAdmission = Object.freeze({ kind: 'allowed' });

/** People, most authority first; a smaller rank holds more. */
const RANK: Readonly<Record<Exclude<EffectClass, 'peer'>, number>> = { owner: 0, admin: 1, member: 2, device: 3, guest: 4 };

const CLASS_WORDS: Readonly<Record<EffectClass, string>> = {
  owner: 'the owner', admin: 'an admin', member: 'a signed-in user', device: 'a paired device', guest: 'a channel guest', peer: 'a remote peer',
};

function refused(rule: EffectRule, code: 'MISSING_RIGHT' | 'NOT_YOURS' | 'OWNER_ONLY', missing: string, reason: string, next: string): EffectAdmission {
  return { kind: 'refused', effect: rule.id, code, missing, reason, next };
}

/** One rule against one actor. */
function admitOne(actor: Actor, rule: EffectRule, subject: { readonly owners: readonly string[] } | undefined): EffectAdmission {
  if (rule.public === true || actor.class === 'system') return ALLOWED;
  if (actor.class === 'peer' || rule.least === 'peer') {
    if (actor.class === 'peer' && rule.least === 'peer') return ALLOWED;
    return actor.class === 'peer'
      ? refused(rule, 'MISSING_RIGHT', 'a person\'s credential', `${rule.id} is not open to a remote peer`, 'Call it with an operator credential.')
      : refused(rule, 'MISSING_RIGHT', 'peer', `${rule.id} is open only to a remote peer`, 'Call it from the peer node with its peer token.');
  }
  if (rule.modelRefused === true && actor.agentFor !== undefined) {
    return refused(rule, 'OWNER_ONLY', 'owner', `${rule.id} is the owner's own act; a model acting for him never makes it`,
      'Tell the owner what is waiting; he does it from his own app.');
  }
  const rank = RANK[actor.class];
  if (rank <= RANK[rule.least]) {
    if (rank >= RANK.member && rule.scope !== '' && !actorHoldsScope(actor, rule.scope)) {
      return refused(rule, 'MISSING_RIGHT', rule.scope, `the credential does not hold ${rule.scope}`,
        `Use a credential that holds ${rule.scope}, or an admin session.`);
    }
    if (rule.subject === 'own' && rank >= RANK.member && subject !== undefined && !subject.owners.includes(actor.id)) {
      return refused(rule, 'NOT_YOURS', 'owner of the subject', `${rule.id} acts on something ${actor.id} does not own`,
        'Ask its owner to share it with you.');
    }
    return ALLOWED;
  }
  if (rule.ask !== undefined && rule.ask.floor !== 'peer' && rank <= RANK[rule.ask.floor]) {
    return { kind: 'ask-owner', effect: rule.id, ownerOnly: rule.ask.kind, reason: `${rule.id} by ${CLASS_WORDS[actor.class]} is the owner's to decide` };
  }
  return rule.least === 'owner'
    ? refused(rule, 'OWNER_ONLY', 'owner', `${rule.id} is the owner's own act; ${CLASS_WORDS[actor.class]} cannot make it`,
      'The owner does it from his own credential (the operator token, his sign-in or a device he paired).')
    : refused(rule, 'MISSING_RIGHT', rule.least, `${rule.id} needs ${CLASS_WORDS[rule.least]}; this credential is ${CLASS_WORDS[actor.class]}`,
      rule.least === 'admin' ? 'Sign in with an admin account or use the operator token.' : `Use ${CLASS_WORDS[rule.least]}'s credential.`);
}

/**
 * The strictest admission across every effect a call causes: a refusal over
 * a question to the owner over allowed. Pure, synchronous, no I/O. A rule
 * whose subject is `own` is checked against `subject` only when the caller
 * passes it (the route that has the subject in hand); without one, class and
 * scope decide.
 */
export function admitEffects(actor: Actor, effects: readonly EffectId[],
  subject?: { readonly owners: readonly string[] }): EffectAdmission {
  return admitRules(actor, effects.map((id) => EFFECTS[id]), subject);
}

/** `admitEffects` over rules already in hand (a plugin method's rule built from what it declares). */
export function admitRules(actor: Actor, rules: readonly EffectRule[],
  subject?: { readonly owners: readonly string[] }): EffectAdmission {
  let ask: EffectAdmission | undefined;
  for (const rule of rules) {
    const one = admitOne(actor, rule, subject);
    if (one.kind === 'refused') return one;
    if (one.kind === 'ask-owner' && ask === undefined) ask = one;
  }
  return ask ?? ALLOWED;
}

/** What a set of effects publishes on a method descriptor, computed from the rows. */
export interface EffectFacts {
  readonly access: 'public' | 'authenticated' | 'admin' | 'remote-peer';
  readonly scopes: readonly string[];
  readonly ownerOnly: boolean;
  readonly irreversible: boolean;
  readonly changesContract: boolean;
  readonly outward: boolean;
}

export function effectFacts(effects: readonly EffectId[]): EffectFacts {
  const rules = effects.map((id) => EFFECTS[id]);
  const scopes = [...new Set(rules.map((rule) => rule.scope).filter((scope) => scope !== ''))];
  const access = rules.every((rule) => rule.public === true) ? 'public'
    : rules.some((rule) => rule.least === 'peer') ? 'remote-peer'
      : rules.some((rule) => rule.least === 'owner' || rule.least === 'admin') ? 'admin' : 'authenticated';
  return {
    access,
    scopes,
    ownerOnly: rules.some((rule) => rule.modelRefused === true),
    irreversible: rules.some((rule) => rule.irreversible === true),
    changesContract: rules.some((rule) => rule.changesContract === true),
    outward: rules.some((rule) => rule.outward === true),
  };
}

/**
 * The rule a method that declares no effects is held to (a plugin's method,
 * registered with its own access and scopes): one row per scope at its access
 * level, the same as the mechanical rows of the table.
 */
export function declaredAccessRules(descriptor: { readonly id: string; readonly access: EffectFacts['access']; readonly scopes: readonly string[]; readonly ownerOnly?: boolean | undefined }): readonly EffectRule[] {
  const least: EffectClass = descriptor.access === 'admin' ? 'admin' : descriptor.access === 'remote-peer' ? 'peer' : 'device';
  const base = { id: 'plugin.call' as const, subject: 'any' as const };
  if (descriptor.access === 'public') return [{ ...base, least: 'guest', scope: '', public: true }];
  const rules: EffectRule[] = descriptor.scopes.map((scope) => ({ ...base, least, scope }));
  if (rules.length === 0) rules.push({ ...base, least, scope: '' });
  if (descriptor.ownerOnly === true) rules.push(EFFECTS['owner.act']);
  return rules;
}
