/**
 * companion-chat-route-types.ts
 *
 * Context interface injected into companion chat route handlers.
 */

import type { CompanionChatManager } from './companion-chat-manager.js';

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
