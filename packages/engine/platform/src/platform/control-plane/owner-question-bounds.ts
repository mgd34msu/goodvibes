/**
 * owner-question-bounds.ts, how many questions one caller may have waiting for the owner, and one question for one call
 * sent again: the bound every held call (routes/capabilities.ts: a capability, a method the dispatch put to him) passes
 * before it is put to him.
 *
 * - The same call from the same caller (the same capability or method, the same values) while its question waits is
 *   that question again: the caller is answered with its id and the question counts one more ask (a counter on it,
 *   never a second question).
 * - A caller with `OPEN_QUESTIONS_PER_CALLER` questions waiting has every new call refused with the words below
 *   (429 `OWNER_QUESTIONS_FULL`), never held: the owner's Waiting for you cannot be flooded by one caller, and what he
 *   has not answered stays as it is.
 * The owner's own programs (his press, his sign-in) are never put to him and never pass here. In-process state only:
 * a question raised before a restart is counted from its record (`openOf`), never from memory.
 */
import { createHash } from 'node:crypto';

/** The questions one caller may have waiting for the owner at once. */
export const OPEN_QUESTIONS_PER_CALLER = 20;
export const OWNER_QUESTIONS_FULL = 'OWNER_QUESTIONS_FULL';

export function ownerQuestionsFullWords(open: number): string {
  return `Not asked, and nothing ran: ${open} questions from this caller are already waiting for the owner, the most one caller may have waiting. `
    + 'Wait until he answers some of them in Waiting for you, then send it again.';
}

interface Live {
  readonly requester: string;
  /** The approval its question has, once it is put to the owner (undefined: decided without asking him). */
  readonly asked: Promise<string | undefined>;
}

/** What to do with a call about to be put to the owner. */
export type QuestionAdmission =
  | { readonly kind: 'same'; readonly approvalId: string }
  | { readonly kind: 'full'; readonly open: number }
  | { readonly kind: 'new'; readonly asked: (approvalId: string | undefined) => void; readonly done: () => void };

export class OwnerQuestionBounds {
  readonly #live = new Map<string, Live>();
  readonly #waitingToAsk = new Map<string, number>();

  /**
   * `requester`: who asks (routes/capabilities.ts `callerKey`); `call`: the capability or method id and its values
   * (hashed here, never kept), and the project and session it was made in: the same call from another project or
   * session is a question of its own (every terminal program of the owner's is one requester); `openOf`: how many of
   * this caller's questions wait on the owner's record now.
   */
  async admit(requester: string, call: { readonly id: string; readonly values: unknown; readonly project?: string | undefined; readonly session?: string | undefined }, openOf: (requester: string) => number): Promise<QuestionAdmission> {
    const key = `${requester}\u0000${call.project ?? ''}\u0000${call.session ?? ''}\u0000${createHash('sha256').update(JSON.stringify([call.id, call.values])).digest('hex')}`;
    const live = this.#live.get(key);
    if (live) {
      const approvalId = await live.asked;
      if (approvalId !== undefined && this.#live.get(key) === live) return { kind: 'same', approvalId };
    }
    const open = openOf(requester) + (this.#waitingToAsk.get(requester) ?? 0);
    if (open >= OPEN_QUESTIONS_PER_CALLER) return { kind: 'full', open };
    let settle: (approvalId: string | undefined) => void = () => {};
    const asked = new Promise<string | undefined>((resolve) => { settle = resolve; });
    const entry: Live = { requester, asked };
    this.#live.set(key, entry);
    this.#waitingToAsk.set(requester, (this.#waitingToAsk.get(requester) ?? 0) + 1);
    let counted = true;
    const uncount = (): void => {
      if (!counted) return;
      counted = false;
      const left = (this.#waitingToAsk.get(requester) ?? 1) - 1;
      if (left > 0) this.#waitingToAsk.set(requester, left); else this.#waitingToAsk.delete(requester);
    };
    return {
      kind: 'new',
      // Once on the record, it is counted there (`openOf`), not here.
      asked: (approvalId) => { uncount(); settle(approvalId); },
      done: () => { uncount(); settle(undefined); if (this.#live.get(key) === entry) this.#live.delete(key); },
    };
  }
}
