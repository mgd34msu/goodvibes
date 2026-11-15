/**
 * The owner inbox for a surface outside the daemon: the same list and answer
 * the daemon's inbox offers, over the inbox.* verbs. A terminal app's
 * `/questions` and an agent leaving the owner a question both go through this.
 *
 * With no daemon reachable every call throws with the reason `probe()` gave,
 * before anything is sent. An answer the daemon refused (already answered,
 * withdrawn, expired) comes back as `applied: false` with its refusal.
 */
import { refusal } from '@goodvibes-jev/engine/errors';
import type {
  NewOwnerItem,
  OwnerAnswer,
  OwnerAnswerOutcome,
  OwnerInboxListFilter,
  OwnerInboxPort,
  OwnerItem,
  OwnerPostOutcome,
} from '../../control-plane/owner-inbox.js';
import { readOwnerItem } from '../../control-plane/owner-inbox.js';
import type { DaemonVerbCaller } from './daemon-verbs.js';

export interface OwnerInboxClient extends OwnerInboxPort {
  /** Leave the owner a question or a queued action; returns at once. */
  post(item: NewOwnerItem & { readonly kind: 'question' | 'queued-action' }): Promise<OwnerPostOutcome>;
  /** Take back an item this surface posted. */
  withdraw(id: string, reason?: string): Promise<OwnerAnswerOutcome>;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readItems(value: unknown): OwnerItem[] {
  const items = record(value)['items'];
  if (!Array.isArray(items)) throw new Error('The daemon answered inbox.list without an item list.');
  return items.map(readOwnerItem).filter((item): item is OwnerItem => item !== undefined);
}

function readOutcome(value: unknown): OwnerAnswerOutcome {
  const body = record(value);
  const item = readOwnerItem(body['item']);
  if (body['applied'] === true && item) return { applied: true, item };
  const carried = record(body['refusal']);
  return {
    applied: false,
    ...(item ? { item } : {}),
    refusal: refusal({
      code: typeof carried['code'] === 'string' ? carried['code'] : 'REFUSED',
      state: typeof carried['state'] === 'string' ? carried['state'] : 'unchanged',
      reason: typeof carried['reason'] === 'string' ? carried['reason'] : 'The daemon did not record the answer.',
      next: Array.isArray(carried['next']) ? carried['next'].filter((step): step is string => typeof step === 'string') : [],
      ...(typeof carried['retryable'] === 'boolean' ? { retryable: carried['retryable'] } : {}),
    }),
  };
}

export function createOwnerInboxClient(verbs: Pick<DaemonVerbCaller, 'probe' | 'invoke'>): OwnerInboxClient {
  const reachable = (): void => {
    const probe = verbs.probe();
    if (!probe.available) throw new Error(`The owner inbox lives in the daemon, which is not reachable: ${probe.reason}`);
  };
  return {
    async list(filter: OwnerInboxListFilter = {}) {
      reachable();
      return readItems(await verbs.invoke('inbox.list', {
        ...(filter.status !== undefined ? { status: filter.status } : {}),
        ...(filter.kinds !== undefined ? { kinds: [...filter.kinds] } : {}),
        ...(filter.sessionId !== undefined ? { sessionId: filter.sessionId } : {}),
        ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
      }));
    },
    async find(id: string) {
      reachable();
      return readItems(await verbs.invoke('inbox.list', { itemId: id }))[0];
    },
    async answer(id: string, answer: OwnerAnswer) {
      reachable();
      return readOutcome(await verbs.invoke('inbox.answer', {
        itemId: id,
        ...(answer.option !== undefined ? { option: answer.option } : {}),
        ...(answer.text !== undefined ? { text: answer.text } : {}),
      }));
    },
    async post(item) {
      reachable();
      const body = record(await verbs.invoke('inbox.post', { ...item, ...(item.options ? { options: [...item.options] } : {}) }));
      const posted = readOwnerItem(body['item']);
      if (!posted) throw new Error('The daemon answered inbox.post without the item it stored.');
      return { created: body['created'] === true, item: posted };
    },
    async withdraw(id: string, reason?: string) {
      reachable();
      return readOutcome(await verbs.invoke('inbox.withdraw', { itemId: id, ...(reason !== undefined ? { reason } : {}) }));
    },
  };
}
