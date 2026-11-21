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
  /** The person the daemon belongs to: the operator token, the local credential, the owner user, a device he paired himself, a channel's owner. */
  | 'owner'
  /** A user with the admin role who is not the owner, or a full pairing minted for automation. */
  | 'admin'
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
}

/** Who "owner" is, from the daemon's own records only (never from a request body). */
export interface OwnerIdentity {
  /** The first user the user store holds (the bootstrap user, created at first start); null when there is none. */
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
      return 'owner';
    case 'device-token':
      // A device the owner paired himself makes his own acts; a full pairing
      // minted through the API is automation with every right but his; a
      // pairing with a stored list holds that list.
      if (principal.admin === true) return principal.ownerDevice === true ? 'owner' : 'admin';
      return 'device';
    case 'agent':
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

/**
 * The actor an authenticated principal is. The operator token, the local
 * credential, the owner user and a device the owner paired himself are the
 * owner; an admin user and a full pairing minted for automation are `admin`;
 * a user without the admin role is `member`; a pairing with a stored scope
 * list is `device`; the Agent's credential is the model acting for the owner.
 */
export function actorFromPrincipal(principal: ActorPrincipal, owner: OwnerIdentity,
  via: Actor['via'] = 'http'): Actor {
  const actorClass = classOf(principal, owner);
  const base: Actor = Object.freeze({
    class: actorClass,
    id: actorClass === 'peer' ? `peer:${principal.principalId ?? 'unknown'}` : principal.principalId ?? principal.credentialKind ?? 'unknown',
    scopes: scopesOf(principal, actorClass === 'owner' || actorClass === 'admin'),
    via: actorClass === 'peer' ? 'peer' : principal.credentialKind === 'local' ? 'local' : via,
  });
  return principal.credentialKind === 'agent' ? agentActor(base) : base;
}

/**
 * The actor a chat sender is: the channel's owner (the identity its policy
 * names) is the owner; anyone else the channel admits is a guest. A sender
 * with no id is the owner: that holds only for a surface whose secret the
 * owner's own systems hold (the generic webhook, Home Assistant). Every chat
 * adapter must pass the sender it can identify (Telegram: the `sender_chat` of
 * a message posted as a chat, else `from`), never leave it out.
 */
export function actorFromChannelSender(input: { readonly surface: string; readonly userId?: string | undefined; readonly isChannelOwner: boolean }): Actor {
  const owner = input.isChannelOwner || input.userId === undefined;
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
