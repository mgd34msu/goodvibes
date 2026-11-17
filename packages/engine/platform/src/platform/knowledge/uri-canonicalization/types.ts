export type KnowledgeUriHoldReason = 'unconfigured' | 'unavailable' | 'uncertain' | 'malformed' | 'aborted' | 'budget' | 'stale';
export class KnowledgeUriCanonicalizationHeldError extends Error {
  override readonly name = 'KnowledgeUriCanonicalizationHeldError';
  constructor(readonly reason: KnowledgeUriHoldReason) {
    super(`Knowledge URI canonicalization held (${reason}); no source identity or link was authorized.`);
  }
}
export interface KnowledgeUriOptions {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
  readonly timeoutMs?: number | undefined;
}
export interface KnowledgeUriCanonicalizer {
  readonly assertCurrent: () => void;
  readonly canonicalize: (input: string) => Promise<string | null>;
  readonly canonicalizeAll: (inputs: readonly string[]) => Promise<readonly (string | null)[]>;
}
/**
 * `requests`: ref readings one canonicalizer (one ingest, import or repair)
 * makes in all; a ref occurrence past the cap is kept unread. `defaultTimeoutMs`:
 * how long one batch of readings may run; when it ends, the occurrences still
 * unread are kept. `timeoutMs` is the longest delay a timer honours.
 */
export const KNOWLEDGE_URI_LIMITS = Object.freeze({ requests: 64, concurrency: 4, defaultTimeoutMs: 60_000, timeoutMs: 2_147_483_647 });
