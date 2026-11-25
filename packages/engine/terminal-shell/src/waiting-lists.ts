/**
 * waiting-lists.ts, the live lists the Waiting for you capabilities choose
 * from (platform capabilities/builtin/waiting.ts and telegram.ts name them):
 * what waits on you, everything ever asked, the requests you raised, the
 * calls Jev decided, the calls held in this session, and the Telegram
 * messages held for you. Each reads the daemon, through the binding the
 * program's places are wired with; the held calls are this program's own.
 * The web UI reads the same lists through each one's method.
 */
import {
  ALL_INBOX_LIST, HELD_CALLS_LIST, MY_REQUESTS_LIST, OPEN_DECISIONS_LIST, OPEN_INBOX_LIST,
  TELEGRAM_CONFIGURATIONS_LIST, TELEGRAM_MESSAGES_LIST, TELEGRAM_WAITING_LIST, shortInboxId, telegramPendingShortId, telegramReviewShortId,
} from '@goodvibes/engine/platform/platform/capabilities';
import { processHeldForOwner } from '@goodvibes/engine/platform/platform/permissions';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { CommandActionContext } from './command-actions/types.js';
import type { DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';

let binding: DaemonCapabilityBinding<never> | undefined;

/** Register these lists with the program's way to its daemon (its `capability-binding.ts`); once, at start. */
export function registerWaitingLists<Ctx>(next: DaemonCapabilityBinding<Ctx>): void {
  binding = next as unknown as DaemonCapabilityBinding<never>;
}

function text(value: unknown): string {
  return typeof value === 'string' ? stripDangerousAnsi(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ' ') : '';
}

function record(value: unknown): Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function entries(value: unknown): ReadonlyArray<Readonly<Record<string, unknown>>> {
  return Array.isArray(value) ? value.map(record) : [];
}

/** One daemon method, as this program reaches the daemon. */
async function invoke(ctx: CommandActionContext, method: string, input: Record<string, unknown>): Promise<unknown> {
  if (!binding) throw new Error('this program has no way to its daemon wired for these lists');
  return await binding.daemon(ctx as never).invoke(method, input);
}

async function inboxItems(ctx: CommandActionContext, input: Record<string, unknown>) {
  return entries(record(await invoke(ctx, 'inbox.list', { limit: 500, ...input })).items);
}

defineList<CommandActionContext>({
  name: OPEN_INBOX_LIST,
  async read(ctx) {
    return (await inboxItems(ctx, { status: 'open' })).map((item): ListRow => {
      const options = Array.isArray(item.options) ? item.options.filter((option): option is string => typeof option === 'string') : [];
      return { value: shortInboxId(text(item.id)), label: text(item.title), state: text(item.kind), detail: options.length > 0 ? `answers: ${options.join(', ')}` : 'a written answer' };
    });
  },
  operator: { method: 'inbox.list', input: { status: 'open' }, rows: { from: 'items', value: 'id', label: 'title', state: 'kind' } },
});

defineList<CommandActionContext>({
  name: ALL_INBOX_LIST,
  async read(ctx) {
    return (await inboxItems(ctx, { status: 'all' })).map((item): ListRow => ({ value: shortInboxId(text(item.id)), label: text(item.title), state: text(item.status) }));
  },
  operator: { method: 'inbox.list', input: { status: 'all' }, rows: { from: 'items', value: 'id', label: 'title', state: 'status' } },
});

defineList<CommandActionContext>({
  name: MY_REQUESTS_LIST,
  async read(ctx) {
    // The reading is this caller's: the requests it raised and may still withdraw.
    return (await inboxItems(ctx, { status: 'open', kinds: ['approval'] }))
      .filter((item) => {
        const reading = record(item.reading);
        return record(reading.requester).mine === true && Array.isArray(reading.allowedActions) && reading.allowedActions.includes('cancel');
      })
      .map((item): ListRow => ({ value: shortInboxId(text(item.id)), label: text(item.title), detail: typeof item.createdAt === 'number' ? new Date(item.createdAt).toLocaleString() : '' }));
  },
  operator: { method: 'inbox.list', input: { status: 'open', kinds: ['approval'] }, rows: { from: 'items', value: 'id', label: 'title' } },
});

defineList<CommandActionContext>({
  name: OPEN_DECISIONS_LIST,
  async read(ctx) {
    return (await inboxItems(ctx, { status: 'open', kinds: ['decision'] }))
      .map((item): ListRow => ({ value: shortInboxId(text(item.id)), label: text(item.title), detail: typeof item.createdAt === 'number' ? new Date(item.createdAt).toLocaleString() : '' }));
  },
  operator: { method: 'inbox.list', input: { status: 'open', kinds: ['decision'] }, rows: { from: 'items', value: 'id', label: 'title' } },
});

defineList<CommandActionContext>({
  name: HELD_CALLS_LIST,
  async read() {
    return processHeldForOwner().list().map((call): ListRow => ({ value: call.id, label: `${text(call.toolName)}: ${text(call.summary)}`, detail: text(call.reason) }));
  },
  operator: { terminalOnly: 'Held calls belong to the terminal session that held them.' },
});

async function telegramList(ctx: CommandActionContext) {
  const list = record(await invoke(ctx, 'inbound.telegram.list', {}));
  return { pending: entries(list.pending), records: entries(list.records) };
}

function pendingRow(entry: Readonly<Record<string, unknown>>): ListRow {
  const deadline = typeof entry.sourceExpiresAt === 'number' ? `; original kept until ${new Date(entry.sourceExpiresAt).toLocaleString()}` : '';
  return { value: telegramPendingShortId({ approvalId: text(entry.approvalId) }), label: `${entry.outcome === 'awaiting-owner' ? 'waiting for your decision' : text(entry.outcome)}${deadline}`, state: 'waiting' };
}

function reviewRow(entry: Readonly<Record<string, unknown>>): ListRow {
  const accepted = typeof entry.acceptedAt === 'number' ? `accepted ${new Date(entry.acceptedAt).toLocaleString()}` : 'accepted';
  return { value: telegramReviewShortId({ id: text(entry.id) }), label: accepted, state: entry.state === 'reviewed' ? 'read' : 'in review' };
}

defineList<CommandActionContext>({
  name: TELEGRAM_WAITING_LIST,
  async read(ctx) {
    return (await telegramList(ctx)).pending.map(pendingRow);
  },
  operator: { method: 'inbound.telegram.list', input: {}, rows: { from: 'pending', value: 'approvalId', label: 'outcome' } },
});

defineList<CommandActionContext>({
  name: TELEGRAM_MESSAGES_LIST,
  async read(ctx) {
    const list = await telegramList(ctx);
    return [...list.pending.map(pendingRow), ...list.records.map(reviewRow)];
  },
  operator: { method: 'inbound.telegram.list', input: {}, rows: { from: 'records', value: 'id', label: 'state' } },
});

defineList<CommandActionContext>({
  name: TELEGRAM_CONFIGURATIONS_LIST,
  async read(ctx) {
    const ids = new Set((await telegramList(ctx)).records.map((entry) => text(entry.configurationId)).filter(Boolean));
    return [...ids].map((id): ListRow => ({ value: id, label: id }));
  },
  operator: { method: 'inbound.telegram.list', input: {}, rows: { from: 'records', value: 'configurationId', label: 'configurationId' } },
});
