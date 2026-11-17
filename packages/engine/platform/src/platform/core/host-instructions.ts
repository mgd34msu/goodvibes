/**
 * The per-request host channel: what the host tells the model, kept out of the
 * system prompt.
 *
 * The system prompt stays byte-identical for the life of a session so the
 * provider's cached prefix covers the whole history on every request. Anything
 * the host says for one request or for a stretch of requests (the active plan,
 * a breaker warning, a held-draft correction, replayed events, quoted
 * background results) is set here under a fixed key and sent as one trailing
 * host message after the conversation, for that request only. Nothing here is
 * saved with the session or shown to the person; a line the person should see
 * is a notice (`ConversationManager.addNotice`).
 */

/** The closed set of things the host tells the model. One entry per key; setting a key replaces it. */
export type HostKey = 'plan' | 'breaker' | 'delegation' | 'handoffs' | 'replay' | 'knowledge' | 'correction' | 'mode' | 'evidence';

/**
 * Render order. Standing context first, one-request corrections after it,
 * quoted evidence last so nothing after it can be read as part of it.
 */
export const HOST_KEYS: readonly HostKey[] = Object.freeze(['mode', 'plan', 'delegation', 'handoffs', 'knowledge', 'replay', 'correction', 'breaker', 'evidence']);

export interface HostInstructionOptions {
  /** Send with the next accepted request only, then drop (see `delivered`). Default: kept until cleared. */
  readonly once?: boolean | undefined;
  /** Add to the key's current text instead of replacing it; the entry becomes `once` only when both are. */
  readonly append?: boolean | undefined;
}

export interface HostInstructions {
  /** Set the key's text. Empty or whitespace-only text clears the key. */
  set(key: HostKey, text: string, options?: HostInstructionOptions): void;
  clear(key: HostKey): void;
  /** Drop every entry (a new or replaced session). */
  reset(): void;
  /** The text for the next request, or undefined when nothing is set. Pure apart from remembering what it rendered. */
  render(): string | undefined;
  /** The request carrying the last `render()` was accepted: drop the `once` entries it carried. An entry set again since then stays. */
  delivered(): void;
}

/** The first line of the host message, so the model can tell who wrote what follows. */
export const HOST_MESSAGE_HEADER = '[Host] Written by GoodVibes for this request only; not from the user.';

interface Entry { readonly text: string; readonly once: boolean }

export class HostInstructionChannel implements HostInstructions {
  readonly #entries = new Map<HostKey, Entry>();
  #rendered: ReadonlySet<Entry> = new Set();

  set(key: HostKey, text: string, options: HostInstructionOptions = {}): void {
    const previous = options.append ? this.#entries.get(key) : undefined;
    const trimmed = text.trim();
    if (trimmed.length === 0) {
      if (!previous) this.#entries.delete(key);
      return;
    }
    const once = options.once === true && (previous === undefined || previous.once);
    this.#entries.set(key, { text: previous ? `${previous.text}\n\n${trimmed}` : trimmed, once });
  }

  clear(key: HostKey): void {
    this.#entries.delete(key);
  }

  reset(): void {
    this.#entries.clear();
    this.#rendered = new Set();
  }

  render(): string | undefined {
    if (this.#entries.size === 0) {
      this.#rendered = new Set();
      return undefined;
    }
    const rendered = new Set<Entry>();
    const sections: string[] = [HOST_MESSAGE_HEADER];
    for (const key of HOST_KEYS) {
      const entry = this.#entries.get(key);
      if (!entry) continue;
      rendered.add(entry);
      sections.push(entry.text);
    }
    this.#rendered = rendered;
    return sections.join('\n\n');
  }

  delivered(): void {
    for (const [key, entry] of this.#entries) {
      if (entry.once && this.#rendered.has(entry)) this.#entries.delete(key);
    }
    this.#rendered = new Set();
  }
}
