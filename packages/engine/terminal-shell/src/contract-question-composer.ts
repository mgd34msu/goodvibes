/**
 * contract-question-composer.ts, a contract's open question offered to the
 * composer of both terminal apps.
 *
 * When a contract of this session asks its owner something, a line above the
 * composer says so, and the next message typed in the composer is sent as the
 * answer (`answersContractQuestion`): the contract gets it at once, with no
 * model request to decide what the message was. Alt+X (a chord that is never
 * typed text) sends the next message as an ordinary one instead. A question
 * answered or dismissed is not offered again; a newer question is.
 *
 * Read from the session's cached contract list (rebuilt on a contract event),
 * so a frame costs one walk of the open contracts' escalations and no copy.
 */
import { openEscalation, type ContractView } from '@goodvibes-jev/engine/platform/platform/contract';

export const DISMISS_CONTRACT_QUESTION_CHORD_LABEL = 'Alt+X';
/** Characters of the question the line above the composer quotes; the transcript has it whole. */
const QUESTION_EXCERPT_CHARS = 80;
/** Questions remembered as answered or dismissed; the oldest leave first. */
const SETTLED_KEPT = 64;

/** Alt+X in both encodings a terminal sends: ESC-prefixed, or CSI-u with the Alt modifier. */
function isDismissChord(data: string): boolean {
  return data === '\x1bx' || data === `\x1b[${'x'.charCodeAt(0)};3u`;
}

export interface OpenContractQuestion {
  readonly contractId: string;
  readonly escalationId: string;
  readonly question: string;
}

export interface ContractQuestionComposer {
  /** The question the next typed message answers, or null. */
  current(): OpenContractQuestion | null;
  /** The line above the composer while a question is on offer; null when none is. */
  hint(): string | null;
  /** Consumes Alt+X while a question is on offer (the next message is ordinary); false for every other chunk. */
  handleChord(data: string): boolean;
  /**
   * The input options of a message typed now: the open question's id when one
   * is on offer. The question is then settled, so the message after it is
   * ordinary unless the contract asks again.
   */
  answerOptions(): { readonly answersContractQuestion?: string };
}

export function createContractQuestionComposer(contracts: () => readonly ContractView[]): ContractQuestionComposer {
  const settled = new Set<string>();
  const settle = (escalationId: string): void => {
    settled.add(escalationId);
    if (settled.size > SETTLED_KEPT) settled.delete(settled.values().next().value!);
  };
  const current = (): OpenContractQuestion | null => {
    const open = openEscalation(contracts());
    if (!open || settled.has(open.escalation.id)) return null;
    return { contractId: open.contract.id, escalationId: open.escalation.id, question: open.escalation.question };
  };
  return {
    current,
    hint() {
      const open = current();
      if (!open) return null;
      const question = open.question.replace(/\s+/g, ' ').trim();
      const excerpt = question.length > QUESTION_EXCERPT_CHARS ? `${question.slice(0, QUESTION_EXCERPT_CHARS - 1)}…` : question;
      return `[Contract question] ${excerpt} · your next message answers it · ${DISMISS_CONTRACT_QUESTION_CHORD_LABEL} send it as an ordinary message`;
    },
    handleChord(data) {
      if (!isDismissChord(data)) return false;
      const open = current();
      if (!open) return false;
      settle(open.escalationId);
      return true;
    },
    answerOptions() {
      const open = current();
      if (!open) return {};
      settle(open.escalationId);
      return { answersContractQuestion: open.escalationId };
    },
  };
}
