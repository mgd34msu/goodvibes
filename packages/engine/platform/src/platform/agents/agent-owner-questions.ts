/**
 * The owner inbox as a `query` tool sees it inside the process that owns the
 * inbox (the daemon): each question is tagged with who asked it, and the
 * owner's answer is handed to that asker when the owner gives it. The answer
 * goes onto the asker's next model request through its host channel; when the
 * asker has ended, the answer stays on the question and the owner is told, with
 * the answer, that it was not delivered and why. Nothing waits or polls.
 */
import {
  OWNER_ANSWER_TO_METADATA,
  type OwnerAnswerDelivery,
  type OwnerAnswerRecipient,
  type OwnerItem,
} from '../control-plane/owner-inbox.js';
import { questionClosedText } from '../runtime/client/owner-inbox-updates.js';
import type { QuestionInbox } from '../tools/query/index.js';
import type { AgentRecord } from '../tools/agent/index.js';
import { callingAgentId } from './calling-agent.js';
import { tellRunningAgent } from './agent-inlets.js';

/** An inbox in this process: questions are posted to it and their answers handed over by it. */
export type InProcessQuestionInbox = QuestionInbox & {
  deliverTo(id: string, recipient: OwnerAnswerRecipient): void;
};

/** Who receives the answer to a question being posted now. */
export interface QuestionAsker {
  /** Shown to the owner: "agent …", "session …". */
  readonly to: string;
  readonly receive: (item: OwnerItem) => OwnerAnswerDelivery;
}

const KEPT = 'The answer is kept on the question.';

/** Posts through `inbox` naming the asker; without one (`asker()` undefined) a post is left as it is. */
export function deliveringQuestions(inbox: InProcessQuestionInbox, asker: () => QuestionAsker | undefined): QuestionInbox {
  return {
    async post(item) {
      const who = asker();
      if (!who) return await inbox.post(item);
      const outcome = await inbox.post({
        ...item,
        askedBy: item.askedBy ?? who.to,
        metadata: { ...item.metadata, [OWNER_ANSWER_TO_METADATA]: who.to },
      });
      // A post under an open key returns the question someone already asked; its asker keeps it.
      if (outcome.created) inbox.deliverTo(outcome.item.id, who.receive);
      return outcome;
    },
    find: (id) => inbox.find(id),
    list: (filter) => inbox.list(filter),
    withdraw: (id, reason) => inbox.withdraw(id, reason),
  };
}

function notRunning(record: AgentRecord | null): string {
  if (!record) return `it is no longer known here (its record was cleared). ${KEPT}`;
  const at = record.completedAt !== undefined ? ` at ${new Date(record.completedAt).toISOString()}` : '';
  switch (record.status) {
    case 'completed': return `it had already finished its run${at}. ${KEPT}`;
    case 'failed': return `its run had ended in failure${at}${record.error ? ` (${record.error})` : ''}. ${KEPT}`;
    case 'cancelled': return `it was cancelled${at}. ${KEPT}`;
    default: return `it was ending its run when the answer came. ${KEPT}`;
  }
}

/**
 * The asker of a question a sub-agent's tool call posts: that agent, reached on
 * its next model request while its run is live. Undefined outside an agent's
 * tool call.
 */
export function callingAgentAsker(agents: { getStatus(id: string): AgentRecord | null } | undefined): QuestionAsker | undefined {
  const agentId = callingAgentId();
  if (agentId === undefined) return undefined;
  const to = `agent ${agentId}`;
  return {
    to,
    receive: (item) => tellRunningAgent(agentId, questionClosedText(item))
      ? { delivered: true, to }
      : { delivered: false, to, reason: notRunning(agents?.getStatus(agentId) ?? null) },
  };
}
