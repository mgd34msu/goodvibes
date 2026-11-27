/**
 * companion-chat-rate-limiter.ts
 *
 * How many messages may wait to be answered, for CompanionChatManager. No clock: a message counts from the moment it is
 * accepted until its turn ends (answered, failed, stopped, or removed from the queue), so a person who sends and waits
 * for each answer is never refused, however fast the answers come; only a sender that keeps adding messages faster
 * than they are answered meets the bound.
 *
 * Two independent bounds:
 *   - per chat: at most M messages waiting in one chat (default 10), whoever sent them;
 *   - per client: at most N messages waiting across every chat for one clientId (default 30).
 *
 * The counts are the manager's own (its queue, its running turn, the sends being prepared); this file holds the bounds
 * and the refusal words. When a bound is met the send is refused with a GoodVibesError of category 'rate_limit' that
 * says how many wait and that it can be sent once one is answered.
 */

import { GoodVibesError } from '@goodvibes/engine/errors';
import type { ConfigManager } from '../config/manager.js';

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/** Messages one client may have waiting to be answered across every chat. */
export const DEFAULT_MESSAGES_WAITING_PER_CLIENT = 30;
/** Messages one chat may have waiting to be answered. */
export const DEFAULT_MESSAGES_WAITING_PER_SESSION = 10;

/**
 * Read the per-chat bound from the environment.
 * GOODVIBES_CHAT_LIMITER_THRESHOLD=<int> overrides the per-chat bound.
 * Returns undefined when unset or not a positive integer.
 */
export function readThresholdFromEnv(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env['GOODVIBES_CHAT_LIMITER_THRESHOLD'];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

// ---------------------------------------------------------------------------
// CompanionChatRateLimiter
// ---------------------------------------------------------------------------

export interface CompanionChatRateLimiterOptions {
  /** Messages one clientId may have waiting across every chat. Default: 30. */
  readonly perClientLimit?: number | undefined;
  /**
   * Messages one chat may have waiting. Default: 10.
   *
   * **Startup-time env var**: `GOODVIBES_CHAT_LIMITER_THRESHOLD` is read **once** at constructor time and used when
   * this option is not provided.
   *
   * **Runtime config key**: `runtime.companionChatLimiter.perSessionLimit` is read on every `check()` call (when a
   * `configManager` is provided) and takes precedence over the env-var-captured default.
   */
  readonly perSessionLimit?: number | undefined;
  /** Optional ConfigManager for runtime lookup of `runtime.companionChatLimiter.perSessionLimit`. */
  readonly configManager?: Pick<ConfigManager, 'get'> | null | undefined;
}

/** What waits now, counted by the manager: in the chat the message is for, and from the client that sends it. */
export interface CompanionChatWaiting {
  readonly session: number;
  readonly client: number;
}

export class CompanionChatRateLimiter {
  private readonly perClientLimit: number;
  /** Base per-chat bound: explicit option, else the env var read at construction, else 10. */
  private readonly perSessionLimitBase: number;
  private readonly configManager: Pick<ConfigManager, 'get'> | null;

  constructor(options: CompanionChatRateLimiterOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    const envThreshold = readThresholdFromEnv(env);
    this.perClientLimit = options.perClientLimit ?? DEFAULT_MESSAGES_WAITING_PER_CLIENT;
    this.perSessionLimitBase = options.perSessionLimit ?? envThreshold ?? DEFAULT_MESSAGES_WAITING_PER_SESSION;
    this.configManager = options.configManager ?? null;
  }

  /** The per-chat bound now: the setting when it is a positive integer (0 means unset), else the base. */
  private resolvePerSessionLimit(): number {
    if (this.configManager) {
      const raw = this.configManager.get('runtime.companionChatLimiter.perSessionLimit');
      if (typeof raw === 'number' && Number.isInteger(raw) && raw > 0) return raw;
    }
    return this.perSessionLimitBase;
  }

  /**
   * Refuses one more message when the chat, or the client (`clientId` '' skips the client bound), already has its
   * bound of messages waiting to be answered. `waiting` is counted by the caller before this message is added.
   */
  check(clientId: string, waiting: CompanionChatWaiting): void {
    const perSessionLimit = this.resolvePerSessionLimit();
    if (waiting.session >= perSessionLimit) {
      throw new GoodVibesError(
        `Not sent: this chat already has ${waiting.session} message${waiting.session === 1 ? '' : 's'} waiting to be answered, the most one chat holds (${perSessionLimit}). `
          + 'Send it again once one of them is answered, or stop the chat\'s turn.',
        { category: 'rate_limit', source: 'runtime', recoverable: true, code: 'COMPANION_CHAT_SESSION_RATE_LIMIT' },
      );
    }
    if (clientId && waiting.client >= this.perClientLimit) {
      throw new GoodVibesError(
        `Not sent: client '${clientId}' already has ${waiting.client} messages waiting to be answered across its chats, the most one client holds (${this.perClientLimit}). `
          + 'Send it again once one of them is answered.',
        { category: 'rate_limit', source: 'runtime', recoverable: true, code: 'COMPANION_CHAT_CLIENT_RATE_LIMIT' },
      );
    }
  }
}
