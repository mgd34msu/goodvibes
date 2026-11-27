/**
 * actor.ts, who is causing an effect.
 *
 * One value, derived once from what the transport established (the
 * credential, the sign-in, the channel sender), carried to every decision
 * about what that caller may cause. The effect table
 * (platform/security/effect-authority.ts `admitEffects`) is the only reader
 * that turns an actor into an answer; nothing else compares credential kinds.
 */
import type { CredentialKind } from './http-policy.js';
import { scopeMatches } from './route-helpers.js';

/** Who is causing an effect, ordered from most to least authority among people. */
export type ActorClass =
  /** The person the daemon belongs to: the operator token, the local credential, the owner user, a channel's owner. */
  | 'owner'
  /** A user with the admin role who is not the owner, or any full pairing (the owner's own device too: `ownerDevice`). */
  | 'admin'
  /**
   * The operator token (or the Agent's credential) presented without a registration the daemon issued to one of the
   * owner's own programs it verified: a script on this machine (or a holder of the token elsewhere), whoever it is. It
   * holds every scope as an admin does and is never the owner: an act only the owner makes is refused it or put to him.
   * Given by the daemon once it knows whether the request carries a checked registration (`scriptActor`).
   */
  | 'script'
  /** A signed-in user without the admin role. */
  | 'member'
  /** A pairing token with a stored scope list. */
  | 'device'
  /** An admitted chat sender who is not the channel's owner. */
  | 'guest'
  /** Another daemon node; it reaches only the peer methods. */
  | 'peer'
  /** The program itself (a product default, a scheduled job, an in-process call no person made). */
  | 'system';

export interface Actor {
  readonly class: ActorClass;
  /**
   * Stable id, the one records name their owners by: the principal id for a
   * credential (a user name, `pairing:<id>`, `shared-token`, `local`),
   * `channel:<surface>:<userId>` for a chat sender, `peer:<nodeId>`,
   * `system:<purpose>`.
   */
  readonly id: string;
  /** The scopes held; `all` for the owner and an admin, who hold every scope. */
  readonly scopes: ReadonlySet<string> | 'all';
  readonly via: 'local' | 'http' | 'ws' | 'channel' | 'peer' | 'in-process';
  /** Set when a model is acting: the actor whose turn it is. The model never exceeds this actor. */
  readonly agentFor?: Actor | undefined;
  /**
   * A device the owner paired himself (his pairing flow, made by him). Its class is `admin`: it is never the owner
   * himself. This mark gives it one thing more: it answers a question some OTHER caller raised (never one it raised,
   * nor one of the credentials made from it, listed here) and does his native work (platform
   * daemon/method-owner-decision.ts `ownersDevice`).
   */
  readonly ownerDevice?: OwnerDeviceMark | undefined;
}

/** What marks an owner's device on its actor: the principal ids of the credentials made from it. */
export interface OwnerDeviceMark {
  readonly madeFromIt: readonly string[];
}

/** Who "owner" is, from the daemon's own records only (never from a request body). */
export interface OwnerIdentity {
  /**
   * The user the user store records as the owner (the account made at first start, or carried forward at an upgrade;
   * platform security/user-auth.ts `ownerUsername`), never the first in its order; null when there is none.
   */
  readonly ownerUser: string | null;
}

/** No sign-in user is the owner (a daemon without a user store). */
export const NO_OWNER_USER: OwnerIdentity = Object.freeze({ ownerUser: null });

/** The fields of an authenticated principal an actor is derived from. Every one is set only by the transport. */
export interface ActorPrincipal {
  readonly principalId?: string | null | undefined;
  readonly principalKind?: 'user' | 'bot' | 'service' | 'token' | 'remote-peer' | null | undefined;
  readonly credentialKind?: CredentialKind | null | undefined;
  /** A device token the owner paired himself through his pairing flow. */
  readonly ownerDevice?: boolean | undefined;
  /** For an owner's device: the principal ids of the credentials made from it. */
  readonly madeFromIt?: readonly string[] | undefined;
  /** The credential holds the admin role with no narrowing list. */
  readonly admin?: boolean | undefined;
  readonly scopes?: readonly string[] | undefined;
}

function scopesOf(principal: ActorPrincipal, full: boolean): ReadonlySet<string> | 'all' {
  if (full || principal.scopes?.includes('*') === true) return 'all';
  return new Set(principal.scopes ?? []);
}

function classOf(principal: ActorPrincipal, owner: OwnerIdentity): ActorClass {
  if (principal.principalKind === 'remote-peer') return 'peer';
  switch (principal.credentialKind) {
    case 'local':
    case 'shared-token':
      // The operator token's class. Every script and command line holds it, so nothing is granted by this class alone:
      // the owner himself, his program, is asked of platform daemon/method-owner-decision.ts (`ownerHimself`,
      // `ownersProgramCaller`: a checked registration of his program, his sign-in, his own device).
      return 'owner';
    case 'device-token':
      // A full pairing is an admin, the owner's own device included: a device is never the owner himself, whatever
      // its origin says (his device carries `ownerDevice`, which answers others' questions and nothing more); a
      // pairing with a stored list holds that list.
      if (principal.admin === true) return 'admin';
      return 'device';
    case 'agent':
      // The Agent's credential is made only for the owner himself (platform daemon/method-owner-decision.ts
      // `mintsAgentCredential`), so it is his model. The class is the credential's fact, read before the router checks
      // the program's registration: what that model may do as his program (a decided call, any file, any project,
      // native authority) is asked of `ownersAgentProgram`, never of this class; without its program it is a script.
      return 'owner';
    case 'user-session':
      if (principal.admin === true) return owner.ownerUser !== null && principal.principalId === owner.ownerUser ? 'owner' : 'admin';
      return 'member';
    default:
      // A principal the transport did not name a credential for (an in-process
      // caller built from a stored pairing): its admin flag is all it carries.
      if (principal.principalKind === 'user') return principal.admin === true ? 'admin' : 'member';
      return principal.admin === true ? 'admin' : 'device';
  }
}

/** Ids another credential authenticates as (pairing/principal-ids.ts RESERVED_PRINCIPAL_IDS and _PREFIXES). */
const OTHER_CREDENTIAL_IDS: readonly string[] = ['shared-token', 'local', 'unknown'];
const OTHER_CREDENTIAL_PREFIXES: readonly string[] = ['pairing:', 'channel:', 'peer:', 'system:'];

/**
 * A sign-in user whose name is another credential's id (`shared-token`, `pairing:<id>`; one made before such names were
 * refused) as `user:<name>`: told apart by the kind of credential first, so no record owned by this machine's token or
 * a device (a session's owners, an ask's raiser) is ever taken as that user's. Undefined for any other principal.
 */
function signInIdApart(principal: ActorPrincipal): string | undefined {
  if (principal.credentialKind !== 'user-session' && principal.principalKind !== 'user') return undefined;
  const id = principal.principalId;
  if (typeof id !== 'string') return undefined;
  const lowered = id.toLowerCase();
  const collides = OTHER_CREDENTIAL_IDS.includes(lowered) || OTHER_CREDENTIAL_PREFIXES.some((prefix) => lowered.startsWith(prefix));
  return collides ? `user:${id}` : undefined;
}

/**
 * The actor an authenticated principal is. The operator token, the local
 * credential and the owner user are of the owner's class (who is the owner
 * himself is asked of platform daemon/method-owner-decision.ts); an admin
 * user and every full pairing, the owner's own device included, are `admin`
 * (his device marked `ownerDevice`); a user without the admin role is
 * `member`; a pairing with a stored scope list is `device`; the Agent's
 * credential is the model acting for the owner.
 */
export function actorFromPrincipal(principal: ActorPrincipal, owner: OwnerIdentity,
  via: Actor['via'] = 'http'): Actor {
  const actorClass = classOf(principal, owner);
  const ownerDevice = principal.credentialKind === 'device-token' && principal.ownerDevice === true && actorClass === 'admin';
  const base: Actor = Object.freeze({
    class: actorClass,
    id: actorClass === 'peer' ? `peer:${principal.principalId ?? 'unknown'}` : signInIdApart(principal) ?? principal.principalId ?? principal.credentialKind ?? 'unknown',
    scopes: scopesOf(principal, actorClass === 'owner' || actorClass === 'admin'),
    via: actorClass === 'peer' ? 'peer' : principal.credentialKind === 'local' ? 'local' : via,
    ...(ownerDevice ? { ownerDevice: Object.freeze({ madeFromIt: Object.freeze([...(principal.madeFromIt ?? [])]) }) } : {}),
  });
  return principal.credentialKind === 'agent' ? agentActor(base) : base;
}

/**
 * The actor a chat sender is: the channel's owner (the identity its policy
 * names, which the channel itself puts on the message) is the owner; anyone
 * else the channel admits is a guest. A sender with no id (the generic
 * webhook, Home Assistant naming no user, any other) is a guest, never the
 * owner: a surface's secret says the message came through that surface, not
 * who wrote it. Every chat adapter must pass the sender it can identify
 * (Telegram: the `sender_chat` of a message posted as a chat, else `from`),
 * never leave it out.
 */
export function actorFromChannelSender(input: { readonly surface: string; readonly userId?: string | undefined; readonly isChannelOwner: boolean }): Actor {
  const owner = input.isChannelOwner && input.userId !== undefined;
  return Object.freeze({
    class: owner ? 'owner' : 'guest',
    id: `channel:${input.surface}:${input.userId ?? 'owner'}`,
    scopes: owner ? 'all' : new Set<string>(),
    via: 'channel',
  });
}

/** A model acting inside `turn`'s session: it holds no more than `turn` does, and never the owner's own acts. */
export function agentActor(turn: Actor): Actor {
  const acting = turn.agentFor ?? turn;
  return Object.freeze({ class: acting.class, id: acting.id, scopes: acting.scopes, via: acting.via, agentFor: acting });
}

/**
 * The owner at a command surface of his own machine: a settings screen, a
 * terminal command, a daemon CLI command run by the person who owns it. The
 * `local` credential's actor, built the same way.
 */
export function localOwnerActor(): Actor {
  return actorFromPrincipal({ principalId: 'local', credentialKind: 'local' }, NO_OWNER_USER, 'local');
}

/**
 * The actor a credential of the owner's program's kind is when its request carries no registration of his verified
 * program: a script (see `ActorClass`). Same id and channel as the credential's own actor; every scope; never the
 * owner, never a model's turn.
 */
export function scriptActor(of: Actor): Actor {
  const base = of.agentFor ?? of;
  return Object.freeze({ class: 'script', id: base.id, scopes: 'all', via: base.via });
}

/** The program itself, for a purpose named in records (`system:<purpose>`). */
export function systemActor(purpose: string): Actor {
  return Object.freeze({ class: 'system', id: `system:${purpose}`, scopes: 'all', via: 'in-process' });
}

/** Whether the actor holds `scope`: the owner, an admin and the program hold every scope. */
export function actorHoldsScope(actor: Actor, scope: string): boolean {
  if (actor.scopes === 'all') return true;
  if (actor.scopes.has(scope)) return true;
  for (const granted of actor.scopes) if (scopeMatches(granted, scope)) return true;
  return false;
}
