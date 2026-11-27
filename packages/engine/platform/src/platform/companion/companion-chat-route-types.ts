/**
 * companion-chat-route-types.ts
 *
 * Context interface injected into companion chat route handlers.
 */

import type { CompanionChatManager } from './companion-chat-manager.js';
import type { Actor } from '@goodvibes/engine/daemon-api/http-policy';

export interface CompanionChatRouteContext {
  /**
   * The chat session manager. Caller injects a real instance;
   * tests can inject an isolated instance with a deterministic provider.
   */
  readonly chatManager: CompanionChatManager;
  /** Parse JSON body from request. Returns Response on parse error. */
  readonly parseJsonBody: (req: Request) => Promise<{ [k: string]: unknown } | Response>;
  /** Parse optional JSON body. Returns null if body is absent. */
  readonly parseOptionalJsonBody: (req: Request) => Promise<{ [k: string]: unknown } | null | Response>;
  /** Resolve the current provider/model when session creation omits an explicit route. */
  readonly resolveDefaultProviderModel?: (() => { provider: string; model: string; reasoningEffort?: string | null | undefined } | null) | undefined;
  /**
   * Returns null when the request carries the daemon's own authority (shared
   * token, paired device, admin user) and the refusal Response otherwise. Only
   * such a caller may have its chat messages attested as typed by the owner.
   * Omitted: every authenticated caller is treated as the owner.
   */
  readonly requireAdmin?: ((req: Request) => Response | null) | undefined;
  /**
   * Returns null when the caller holds the scope (an admin holds every scope)
   * and the refusal Response, naming the missing scope, otherwise. Used to
   * require `read:artifacts` before a message may attach an artifact.
   * Omitted: no scope check here.
   */
  readonly requireScope?: ((req: Request, scope: string) => Response | null) | undefined;
  /**
   * True when the request's credential is the owner's own (security/turn-input-party.ts): a message from anyone else
   * (an admin or member who is not the owner, a device with a scope list) drives a turn on someone else's input, which
   * runs no command outside a real sandbox and writes no file. Omitted: every caller is the owner.
   */
  readonly isOwnerCaller?: ((req: Request) => boolean) | undefined;
  /**
   * The one check of the project the request names (workspace/caller-project.ts), for the request's credential: a chat
   * is made only in a project that passes it, and in the checked project. Omitted: the project is taken as given.
   */
  readonly checkProject?: ((req: Request, raw: string) => { readonly ok: true; readonly project: string } | { readonly ok: false; readonly reason: string }) | undefined;
  /**
   * The principal the request authenticated as: kept on a chat it makes as who made it, which with the chat's project
   * is who the chat belongs to (control-plane/caller-reach.ts). Omitted: no maker is kept (the owner's only).
   */
  readonly callerPrincipal?: ((req: Request) => string | undefined) | undefined;
  /**
   * The actor the request authenticated as (its class and scopes): kept on a chat it makes, so the chat's model acts for
   * that maker (security/turn-session.ts). Omitted: no maker kept.
   */
  readonly callerActor?: ((req: Request) => Actor | undefined) | undefined;
  /**
   * Stable identity of the authenticated caller for the per-client message cap
   * (a token id). Omitted: derived from the request's credential headers.
   */
  readonly resolveClientId?: ((req: Request) => string | undefined) | undefined;
  /**
   * Open an SSE event stream scoped to a session.
   * Callers must call chatManager.registerSubscriber(sessionId, clientId)
   * before returning the Response so that event routing is set up.
   *
   * The returned function accepts (event, payload, id?) and is how the
   * gateway fan-out will push events to this specific subscriber.
   */
  readonly openSessionEventStream: (
    req: Request,
    sessionId: string,
  ) => Response;
}
