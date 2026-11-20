import type { Tool } from '../../types/tools.js';
import type {
  NewOwnerItem,
  OwnerAnswerOutcome,
  OwnerInboxListFilter,
  OwnerItem,
  OwnerPostOutcome,
} from '../../control-plane/owner-inbox.js';
import { OWNER_ITEM_LIMITS } from '../../control-plane/owner-inbox.js';
import { summarizeError } from '../../utils/error-display.js';
import { QUERY_TOOL_SCHEMA, type QueryToolInput } from './schema.js';

/**
 * Where the `query` tool leaves its questions: the owner inbox, one store per
 * home that the daemon and every terminal app read and write at once, reached
 * in process inside the daemon, over the `inbox.*` verbs from a terminal while
 * a daemon is reachable, or directly otherwise. The inbox keeps the record,
 * shows it on every surface, pushes it to the owner's phone when push is on,
 * keeps the first answer, and says whether the answer reached the asker, waits
 * for it to be opened again, or cannot.
 */
export interface QuestionInbox {
  post(item: NewOwnerItem & { readonly kind: 'question' }): Promise<OwnerPostOutcome>;
  find(id: string): Promise<OwnerItem | undefined>;
  list(filter?: OwnerInboxListFilter): Promise<readonly OwnerItem[]>;
  withdraw(id: string, reason: string): OwnerAnswerOutcome | Promise<OwnerAnswerOutcome>;
}

export interface QueryToolOptions {
  readonly inbox: QuestionInbox | (() => QuestionInbox);
  /** The asking session, read per call; its questions are the ones list returns. */
  readonly resolveSessionId?: (() => string | undefined) | undefined;
  /** Who is asking, shown to the owner beside the question. */
  readonly askedBy?: string | undefined;
}

function view(item: OwnerItem) {
  return {
    questionId: item.id,
    status: item.status,
    question: item.title,
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.options.length > 0 ? { options: item.options } : {}),
    ...(item.answer ? { answer: item.answer } : {}),
    ...(item.answeredBy ? { answeredFrom: item.answeredBy.surface } : {}),
    ...(item.withdrawnReason ? { withdrawnReason: item.withdrawnReason } : {}),
    askedAt: new Date(item.createdAt).toISOString(),
    ...(item.closedAt !== undefined ? { closedAt: new Date(item.closedAt).toISOString() } : {}),
  };
}

function refusalText(outcome: Extract<OwnerAnswerOutcome, { applied: false }>): string {
  const next = outcome.refusal.next[0];
  return `${outcome.refusal.reason}${next ? ` ${next}` : ''}`;
}

export function createQueryTool(options: QueryToolOptions): Tool {
  const inbox = (): QuestionInbox => typeof options.inbox === 'function' ? options.inbox() : options.inbox;
  return {
    definition: {
      name: 'query',
      description: QUERY_TOOL_SCHEMA.description,
      parameters: QUERY_TOOL_SCHEMA.parameters,
      // Every mode reads or writes only the owner inbox, the app's own state: with the
      // tool's 'read' category (ENGINE_TOOL_CATEGORIES) the gate settles it without
      // asking anyone, in every mode. Asking the owner for permission to ask him a
      // question reached no one the question would not.
      sideEffects: ['state'],
      concurrency: 'serial',
    },

    async execute(args: Record<string, unknown>) {
      if (!args || typeof args !== 'object' || typeof args.mode !== 'string') {
        return { success: false, error: 'Invalid args: mode is required.' };
      }
      const input = args as unknown as QueryToolInput;
      const sessionId = options.resolveSessionId?.() || undefined;
      try {
        if (input.mode === 'ask') {
          const question = typeof input.question === 'string' ? input.question.trim() : '';
          if (!question) return { success: false, error: 'ask needs question: one line the owner can answer. Nothing was posted.' };
          // A long question keeps its full text in the detail the owner opens.
          const title = question.length > OWNER_ITEM_LIMITS.titleChars ? `${question.slice(0, OWNER_ITEM_LIMITS.titleChars - 1)}…` : question;
          const detail = [question.length > OWNER_ITEM_LIMITS.titleChars ? question : '', input.detail?.trim() ?? ''].filter(Boolean).join('\n\n');
          const { created, item } = await inbox().post({
            kind: 'question',
            title,
            ...(detail ? { detail } : {}),
            ...(input.options && input.options.length > 0 ? { options: input.options } : {}),
            ...(input.key ? { key: input.key } : {}),
            ...(sessionId ? { sessionId } : {}),
            ...(options.askedBy ? { askedBy: options.askedBy } : {}),
          });
          return { success: true, output: JSON.stringify({
            ...view(item),
            ...(created ? {} : { note: 'A question under this key was already open; this is that question, not a new one.' }),
            next: 'Carry on with what does not depend on the answer. It comes to you on a later request when the owner answers; query mode "show" reads it at any time.',
          }) };
        }

        if (input.mode === 'list') {
          const items = await inbox().list({ kinds: ['question'], status: input.status ?? 'all', ...(sessionId ? { sessionId } : {}) });
          const answered = items.filter((item) => item.status === 'answered').length;
          return { success: true, output: JSON.stringify({ count: items.length, answered, questions: items.map(view) }) };
        }

        const id = typeof input.questionId === 'string' ? input.questionId.trim() : '';
        if (!id) return { success: false, error: `${input.mode} needs questionId: the id ask returned (list shows them).` };

        if (input.mode === 'show') {
          const item = await inbox().find(id);
          if (!item || item.kind !== 'question') return { success: false, error: `No question has the id ${id}. List this session's questions with query mode "list".` };
          return { success: true, output: JSON.stringify(view(item)) };
        }

        if (input.mode === 'withdraw') {
          const outcome = await inbox().withdraw(id, input.reason?.trim() || 'no longer needed');
          if (!outcome.applied) return { success: false, error: refusalText(outcome) };
          return { success: true, output: JSON.stringify(view(outcome.item)) };
        }
      } catch (error) {
        return { success: false, error: `The owner inbox could not be reached: ${summarizeError(error)} Nothing was changed.` };
      }

      return { success: false, error: `Unknown mode: ${String(input.mode)}. Use ask, show, list or withdraw.` };
    },
  };
}
