/**
 * Delegated Telegram intake: a chat whose messages wait for the owner instead
 * of being answered, and the review queue of the messages the owner accepted. Kept by
 * the daemon (the chat selection and the review records under its project
 * store; the originals in its memory until their deadline). Every capability
 * here is one `inbound.telegram.*` method, called as the same caller, so the
 * method's own paired-owner authority decides who may act; the capability
 * adds what a person gives in words: a message by the short id they were shown,
 * a chat by its id, a time as 90s, 30m, 2h or 7d.
 */
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type CapabilityResult, type InputDescription, type ListName } from '../types.js';

interface SourceRef {
  readonly sessionId: string;
  readonly inputId: string;
  readonly sourceId: string;
  readonly sourceRevision: string;
  readonly requestId: string;
}

interface ReviewRecord {
  readonly id: string;
  readonly ref: SourceRef;
  readonly approvalId: string;
  readonly configurationId: string;
  readonly acceptedAt: number;
  readonly sourceExpiresAt: number;
  readonly recordExpiresAt: number;
  readonly state: 'accepted-for-review' | 'reviewed' | 'cancelled';
}

interface PendingMessage {
  readonly ref: SourceRef;
  readonly approvalId: string;
  readonly sourceExpiresAt: number;
  readonly outcome: string;
}

interface ListResult {
  readonly records: readonly ReviewRecord[];
  readonly pending: readonly PendingMessage[];
}

type Outcome = { readonly outcome?: unknown } & Record<string, unknown>;

/** The live lists the inputs choose from (registered in terminal-shell's waiting-lists.ts). */
export const TELEGRAM_WAITING_LIST = 'telegram.waiting' as ListName;
export const TELEGRAM_MESSAGES_LIST = 'telegram.messages' as ListName;
export const TELEGRAM_CONFIGURATIONS_LIST = 'telegram.configurations' as ListName;

const REVIEW_ID_PREFIX = 'external-review-';
const APPROVAL_ID_PREFIX = 'approval-';
const SHORT_ID_CHARS = 8;
const MAX_DURATION_MS = 2_147_483_647;
const TIME_WHY = 'a time such as 90s, 30m, 2h or 7d (at most 24 days)';
const PLACE = 'Waiting for you';
const OWNER_DECIDES = { reason: 'it decides what happens to messages sent to the owner\'s Telegram chat', instead: `${PLACE} shows what waits, for the owner to decide` };

function text(value: string): string {
  return value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function when(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function telegramReviewShortId(record: Pick<ReviewRecord, 'id'>): string {
  const id = record.id.startsWith(REVIEW_ID_PREFIX) ? record.id.slice(REVIEW_ID_PREFIX.length) : record.id;
  return id.slice(0, SHORT_ID_CHARS);
}

/** An approval's id after its `approval-` prefix, which every one shares: two held messages never show the same id. */
export function telegramPendingShortId(entry: Pick<PendingMessage, 'approvalId'>): string {
  const id = entry.approvalId.startsWith(APPROVAL_ID_PREFIX) ? entry.approvalId.slice(APPROVAL_ID_PREFIX.length) : entry.approvalId;
  return id.slice(0, SHORT_ID_CHARS);
}

/** `90s`, `30m`, `2h`, `7d`, or a whole number of milliseconds. */
export function parseIntakeDuration(value: string): number | null {
  const match = /^(\d+)(ms|s|m|h|d)?$/i.exec(value.trim());
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'ms').toLowerCase();
  const factor = unit === 'd' ? 86_400_000 : unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : unit === 's' ? 1_000 : 1;
  const ms = amount * factor;
  return Number.isSafeInteger(ms) && ms >= 1 && ms <= MAX_DURATION_MS ? ms : null;
}

/** The chat and optional thread of `<chatId>[/<threadId>]`. */
function parseChat(value: string): { chatId: string; threadId?: string } | null {
  const [chatId, threadId, extra] = value.split('/');
  if (!chatId || extra !== undefined || threadId === '') return null;
  return threadId === undefined ? { chatId } : { chatId, threadId };
}

function isHold(result: Outcome): boolean {
  return result.outcome === 'held';
}

const TOKEN_PLACE = 'the bot\'s token in Mail, calendar and channels, under Telegram';
const NOT_HELD = { said: 'This chat is not held for you right now, so the message was not captured.', next: 'Press h (hold a chat) for it, then ask the sender to send the message again.' };
const RELEASED = { said: 'This message was refused, closed or expired; its text was let go.', next: 'Ask the sender to send it again if it still needs your review.' };
/**
 * What a held answer of the intake means and what to do next, per reason, in the words of Waiting for you's Telegram
 * list and its keys (h hold a chat, y accept, n refuse, i where it stands, o read, c close, x stop holding, b hand
 * back, r read again). The intake's own next step names its methods, for a script calling them; it is never shown here.
 */
const HOLD_WORDS: Readonly<Record<string, { readonly said: string; readonly next: string }>> = {
  'account-proof-required': { said: 'The Telegram bot could not be verified, so nothing was held or captured.', next: `Check ${TOKEN_PLACE}, then press h (hold a chat) again.` },
  'account-not-chosen': { said: 'The bot you named is not the bot this daemon verified.', next: 'Press h (hold a chat) again and give the verified bot.' },
  'account-proof-unavailable': { said: 'The Telegram bot could not be verified just now, so nothing was decided.', next: `Check ${TOKEN_PLACE}, then press the key again.` },
  'account-proof-changed': { said: 'The Telegram bot changed while the message arrived, so it was not captured.', next: 'Press h (hold a chat) again for the bot in use now.' },
  'workspace-changed': { said: 'The project changed, so a held chat has to be held again.', next: 'Start the daemon again, then press h (hold a chat).' },
  'lifecycle-changed': { said: 'Holding chats was stopped or started again, so nothing was captured or decided.', next: 'Press h (hold a chat) again for this chat.' },
  'owner-changed': { said: 'The paired owner changed while this ran, so nothing was done.', next: 'Press the key again from the device paired as the owner.' },
  'not-owner': { said: 'This chat was held from another paired owner\'s device.', next: 'Do it from the device that held the chat.' },
  'message-identity-missing': { said: 'Telegram sent the message without its id, so it was not captured.', next: 'Ask the sender to send it again.' },
  'tracking-full': { said: '500 messages already wait, so this one was not captured.', next: 'Accept (y), refuse (n) or close (c) waiting messages, or let older ones expire.' },
  'message-edited': { said: 'The sender edited the message, so the earlier copy was released.', next: 'Decide on the edited message when it shows in this list.' },
  'no-configuration': NOT_HELD,
  'configuration-not-current': NOT_HELD,
  'source-unavailable': { said: 'The original message or its chat is no longer there, so nothing was done.', next: 'Press r (read again) to see what still waits.' },
  'missing-source-proof': { said: 'This daemon holds no such message.', next: 'Press r (read again) to see the messages it holds.' },
  'configuration-unavailable': { said: 'That chat is no longer held: it was handed back, or its time ran out.', next: 'Press h (hold a chat) to hold it again.' },
  'chat-not-selected': { said: 'That chat is not held, so there is nothing to hand back.', next: 'Press h (hold a chat) to hold one.' },
  'already-decided': { said: 'This message was already decided.', next: 'Press i (where it stands) to see how it came out.' },
  'lifetime-exceeds-configuration': { said: 'The original would be kept longer than the chat is held.', next: 'Give a shorter Keep the original, or hold the chat again for longer with h (hold a chat).' },
  'not-durably-resolved': { said: 'Your answer was not recorded exactly as given, so the original was released.', next: 'Press i (where it stands).' },
  'review-queue-refused': { said: 'The review queue did not take the message.', next: 'Close a review with c (close), or let one expire.' },
  'review-held': RELEASED,
  'review-closed': RELEASED,
  'handoff-held': { said: 'The accepted message could not be put in the review queue.', next: 'Press i (where it stands).' },
};

function holdText(hold: Outcome): string {
  const identity = hold.accountIdentity as { readonly id?: unknown; readonly username?: unknown } | undefined;
  const account = identity && typeof identity.username === 'string' ? ` The verified bot is @${text(identity.username)}.` : '';
  const words = HOLD_WORDS[String(hold.reason ?? '')] ?? { said: 'Telegram held this, so nothing was done.', next: 'Press r (read again) to see where things stand.' };
  return `${words.said}${account} Next: ${words.next}`;
}

function recordLine(record: ReviewRecord): string {
  const state = record.state === 'reviewed' ? 'read' : 'waiting to be read';
  const original = record.sourceExpiresAt > Date.now() ? `original kept until ${when(record.sourceExpiresAt)}` : 'original released';
  return `${telegramReviewShortId(record)}  accepted ${when(record.acceptedAt)}, ${state}; ${original}; review kept until ${when(record.recordExpiresAt)}`;
}

function pendingLine(entry: PendingMessage): string {
  const state = entry.outcome === 'awaiting-owner' ? 'waiting for your decision' : entry.outcome;
  return `${telegramPendingShortId(entry)}  ${state}; original kept until ${when(entry.sourceExpiresAt)}`;
}

type Match = { readonly kind: 'review'; readonly record: ReviewRecord } | { readonly kind: 'pending'; readonly entry: PendingMessage };

/** The one review or waiting message `id` names: a shown short id, or a prefix of its review, approval or request id. */
function findMessage(list: ListResult, id: string): Match[] {
  const matches: Match[] = [];
  for (const record of list.records) {
    if (telegramReviewShortId(record).startsWith(id) || record.id.startsWith(id) || record.approvalId.startsWith(id) || record.ref.requestId.startsWith(id)) {
      matches.push({ kind: 'review', record });
    }
  }
  for (const entry of list.pending) {
    if (matches.some((match) => match.kind === 'review' && match.record.ref.requestId === entry.ref.requestId)) continue;
    if (telegramPendingShortId(entry).startsWith(id) || entry.approvalId.startsWith(id) || entry.ref.requestId.startsWith(id)) matches.push({ kind: 'pending', entry });
  }
  return matches;
}

async function call<T extends Outcome>(caller: CapabilityCaller, operation: string, input: Record<string, unknown>): Promise<T> {
  if (!caller.method) throw new CapabilityRefusal('Delegated Telegram intake runs in the daemon, through capabilities.run; nothing was done.');
  const answer = await caller.method(`inbound.telegram.${operation}`, input);
  return (answer && typeof answer === 'object' ? answer : {}) as T;
}

async function listed(caller: CapabilityCaller): Promise<ListResult> {
  const answer = await call<Outcome>(caller, 'list', {});
  return {
    records: Array.isArray(answer.records) ? answer.records as ReviewRecord[] : [],
    pending: Array.isArray(answer.pending) ? answer.pending as PendingMessage[] : [],
  };
}

function durationOf(value: string | undefined, label: string): number {
  const ms = parseIntakeDuration(value ?? '');
  if (ms === null) throw new CapabilityRefusal(`${label}: "${value}" is not ${TIME_WHY}. Nothing was done.`, undefined, 'INVALID_ARGUMENT');
  return ms;
}

async function lookup(caller: CapabilityCaller, id: string): Promise<Match> {
  const matches = findMessage(await listed(caller), id.trim());
  if (matches.length === 0) throw new CapabilityRefusal(`No review or waiting message matches ${text(id)}.`, `${PLACE} shows them under Telegram.`, 'NOT_FOUND');
  if (matches.length > 1) throw new CapabilityRefusal(`${text(id)} matches ${matches.length} messages; give more of its id.`, undefined, 'AMBIGUOUS');
  return matches[0]!;
}

function holdOr(result: Outcome, otherwise: string): CapabilityResult {
  if (isHold(result)) throw new CapabilityRefusal(holdText(result), undefined, 'HELD');
  return { text: otherwise, data: { outcome: result.outcome } };
}

/** The facts of the list, for a screen or a script. */
function listData(list: ListResult): Readonly<Record<string, unknown>> {
  return {
    pending: list.pending.map((entry) => ({
      id: telegramPendingShortId(entry), approvalId: entry.approvalId, state: entry.outcome === 'awaiting-owner' ? 'waiting' : entry.outcome,
      sourceExpiresAt: entry.sourceExpiresAt,
    })),
    records: list.records.map((record) => ({
      id: telegramReviewShortId(record), reviewId: record.id, configurationId: record.configurationId,
      state: record.state === 'reviewed' ? 'read' : record.state === 'cancelled' ? 'closed' : 'in review',
      acceptedAt: record.acceptedAt, sourceExpiresAt: record.sourceExpiresAt, recordExpiresAt: record.recordExpiresAt,
    })),
  };
}

const WAITING_MESSAGE: InputDescription = {
  id: 'message', label: 'Message', help: 'A message waiting for your decision', kind: 'choice', choices: { list: TELEGRAM_WAITING_LIST }, required: true, typed: { position: 1 },
};
const ANY_MESSAGE: InputDescription = {
  id: 'message', label: 'Message', help: 'A waiting message or one in the review queue', kind: 'choice', choices: { list: TELEGRAM_MESSAGES_LIST }, required: true, typed: { position: 1 },
};
const CHAT: InputDescription = {
  id: 'chat', label: 'Chat', help: 'The chat id, with /thread for one thread of it (-1001234/7)', kind: 'text', freeTextReason: 'a Telegram chat id', required: true, typed: { position: 1 },
};
const time = (id: string, label: string, help: string, flag: `--${string}`, fallback: string, means: string): InputDescription => ({
  id, label, help, kind: 'text', freeTextReason: TIME_WHY, required: { default: fallback, defaultMeans: means }, typed: { flag },
});

export const TELEGRAM_LIST: CapabilityDefinition<unknown> = {
  capability: { id: 'telegram.list', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'list', label: 'See what waits for you', word: 'list', inputs: [],
  sentence: 'Lists the messages waiting for your decision and the review queue.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: {},
  async run(_values, _services, caller) {
    const all = await listed(caller);
    // What waits is what still waits for the owner: one accepted is in the review queue, one refused is gone.
    const list = { ...all, pending: all.pending.filter((entry) => entry.outcome === 'awaiting-owner') };
    const data = listData(list);
    if (list.records.length === 0 && list.pending.length === 0) return { text: 'No Telegram message waits for you and the review queue is empty. To hold a chat\'s messages for you: h (hold a chat).', data };
    const lines: string[] = [];
    if (list.pending.length > 0) lines.push(`Waiting for your decision (${list.pending.length}):`, ...list.pending.map((entry) => `  ${pendingLine(entry)}`));
    if (list.records.length > 0) lines.push(`Review queue (${list.records.length}):`, ...list.records.map((record) => `  ${recordLine(record)}`));
    return { text: lines.join('\n'), data };
  },
};

export const TELEGRAM_CONFIGURE: CapabilityDefinition<unknown> = {
  capability: { id: 'telegram.configure', group: 'waiting', home: 'daemon', repeat: 'unsafe' },
  actionId: 'configure', label: 'Hold a chat\'s messages for you', word: 'configure',
  inputs: [
    CHAT,
    { id: 'bot', label: 'Bot', help: 'The Telegram bot account that receives the chat', kind: 'text', freeTextReason: 'a bot account id', required: true, typed: { position: 2 } },
    time('hold', 'Each message waits', 'How long a message is kept in memory waiting for you', '--hold', '1h', 'one hour'),
    time('for', 'Hold the chat for', 'How long the chat is held before it goes back to normal', '--for', '7d', 'seven days'),
  ],
  sentence: 'Every message in chat {chat} on {bot} waits for your decision instead of being answered, for {for} or until you change it.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', ownerOnly: OWNER_DECIDES, undoneBy: 'release',
  example: { chat: '-1001234', bot: 'support-bot' },
  async run(values, _services, caller) {
    const chat = parseChat((values.chat ?? '').trim());
    if (!chat) throw new CapabilityRefusal(`"${values.chat}" is not a chat id (chatId or chatId/threadId). Nothing was configured.`, undefined, 'INVALID_ARGUMENT');
    const pendingRetentionMs = durationOf(values.hold, 'Each message waits');
    const givenHold = (values.hold ?? '').trim();
    const heldFor = /^\d+$/.test(givenHold) ? `${givenHold}ms` : givenHold;
    const configurationLifetimeMs = durationOf(values.for, 'Hold the chat for');
    const result = await call(caller, 'configure', {
      ...chat, accountId: (values.bot ?? '').trim(), pendingRetention: 'memory-only-until-deadline', pendingRetentionMs, configurationLifetimeMs, onExpiry: 'release-original-and-hold',
    });
    if (isHold(result)) throw new CapabilityRefusal(holdText(result), undefined, 'HELD');
    const identity = result.accountIdentity as { readonly username?: unknown } | undefined;
    const name = `${text(chat.chatId)}${chat.threadId ? `/${text(chat.threadId)}` : ''}`;
    return {
      text: [
        `Chat ${name} is held for you${identity && typeof identity.username === 'string' ? ` on @${text(identity.username)}` : ''}.`,
        `It is held until ${when(Number(result.expiresAt))}; each message is kept in memory for ${heldFor}.`,
        'The chat is not answered normally until you hand it back.',
      ].join('\n'),
      data: { chat: name, configurationId: result.configurationId, expiresAt: result.expiresAt },
    };
  },
};

async function decide(caller: CapabilityCaller, message: string, approved: boolean, keep: { sourceRetentionMs: number; derivedRecordRetentionMs: number } | undefined): Promise<CapabilityResult> {
  const match = await lookup(caller, message);
  if (match.kind !== 'pending') throw new CapabilityRefusal('That message was already decided; it is in the review queue.', undefined, 'NOT_OPEN');
  const result = await call(caller, 'decide', {
    approvalId: match.entry.approvalId, ref: match.entry.ref, approved,
    ...(approved && keep ? { choices: {
      processingPurpose: 'accept-external-message-for-owner-review',
      sourceRetention: 'memory-only-until-review-close-or-deadline', sourceRetentionMs: keep.sourceRetentionMs,
      derivedRecord: 'external-source-reference-only-v1', derivedRecordRetentionMs: keep.derivedRecordRetentionMs,
      execution: 'none', ownerMayReadOriginal: true,
    } } : {}),
  });
  if (isHold(result)) throw new CapabilityRefusal(holdText(result), undefined, 'HELD');
  return result.outcome === 'denied'
    ? { text: 'Refused; its text was let go unread and nothing was run.', data: { outcome: 'denied' } }
    : { text: 'Accepted for review; nothing was run. Press o (read it) on it to read its text.', data: { outcome: result.outcome } };
}

export const TELEGRAM_APPROVE: CapabilityDefinition<unknown> = {
  capability: { id: 'telegram.approve', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'approve', label: 'Accept a waiting message for review', word: 'approve',
  inputs: [
    WAITING_MESSAGE,
    time('keep', 'Keep the original', 'How long its original stays in memory for you to read', '--keep', '1h', 'one hour'),
    time('record', 'Keep the review', 'How long the review record is kept; at least as long as the original', '--record', '7d', 'seven days'),
  ],
  sentence: '{message} goes into your review queue; nothing in it is run.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'none', ownerOnly: OWNER_DECIDES,
  example: { message: '3f9a1c2e' },
  async run(values, _services, caller) {
    const sourceRetentionMs = durationOf(values.keep, 'Keep the original');
    const derivedRecordRetentionMs = durationOf(values.record, 'Keep the review');
    if (derivedRecordRetentionMs < sourceRetentionMs) throw new CapabilityRefusal('Keep the review must be at least as long as Keep the original, so the review outlives its original. Nothing was decided.', undefined, 'INVALID_ARGUMENT');
    return await decide(caller, values.message!, true, { sourceRetentionMs, derivedRecordRetentionMs });
  },
};

export const TELEGRAM_DENY: CapabilityDefinition<unknown> = {
  capability: { id: 'telegram.deny', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'deny', label: 'Refuse a waiting message', word: 'deny', inputs: [WAITING_MESSAGE],
  sentence: '{message} is refused; its text is let go unread and nothing in it is run.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'none', ownerOnly: OWNER_DECIDES,
  example: { message: '3f9a1c2e' },
  run: async (values, _services, caller) => await decide(caller, values.message!, false, undefined),
};

function capitalizeFirst(line: string): string {
  return line.charAt(0).toUpperCase() + line.slice(1);
}

async function showMessage(caller: CapabilityCaller, message: string, operation: 'status' | 'read'): Promise<CapabilityResult> {
  const match = await lookup(caller, message);
  const ref = match.kind === 'review' ? match.record.ref : match.entry.ref;
  const result = await call(caller, operation, { ref });
  if (isHold(result)) throw new CapabilityRefusal(holdText(result), undefined, 'HELD');
  if (result.outcome !== 'recorded') {
    return result.outcome === 'awaiting-owner'
      ? { text: 'Waiting for your decision: accept it for review or refuse it.', data: { state: 'waiting' } }
      : { text: `This message is ${text(String(result.outcome))}; its original is ${text(String(result.source))}.`, data: { state: result.outcome, source: result.source } };
  }
  const record = result.record as ReviewRecord;
  // Read in the place's pane, the message is the one selected: its short id (for a typed reference) is left out.
  const lines = [operation === 'read' ? capitalizeFirst(recordLine(record).replace(/^\S+\s+/, '')) : recordLine(record)];
  if (result.source !== 'available-in-memory') lines.push('Its original is no longer in memory; ask the sender to send it again if it still needs review.');
  const original = result.original as { readonly text: string; readonly unsupportedSources: readonly { readonly kind: string; readonly label: string }[] } | undefined;
  if (operation === 'read' && original) {
    lines.push('', 'The message:', text(original.text));
    for (const entry of original.unsupportedSources) lines.push(`  (not shown: ${text(entry.kind)} ${text(entry.label)})`);
  }
  return { text: lines.join('\n'), data: { state: record.state === 'reviewed' ? 'read' : 'in review', source: result.source } };
}

export const TELEGRAM_STATUS: CapabilityDefinition<unknown> = {
  capability: { id: 'telegram.status', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'status', label: 'See where a message stands', word: 'status', inputs: [ANY_MESSAGE],
  sentence: 'Shows whether {message} waits, is in review or was read, and whether its original is still kept.', done: '',
  touches: 'reads', lasts: 'not-a-change', risk: 'none', example: { message: '3f9a1c2e' },
  run: async (values, _services, caller) => await showMessage(caller, values.message!, 'status'),
};

export const TELEGRAM_READ: CapabilityDefinition<unknown> = {
  capability: { id: 'telegram.read', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'read', label: 'Read an accepted message', word: 'read', inputs: [ANY_MESSAGE],
  sentence: 'Shows the original of {message} and marks its review read.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'none', ownerOnly: OWNER_DECIDES,
  example: { message: '3f9a1c2e' },
  run: async (values, _services, caller) => await showMessage(caller, values.message!, 'read'),
};

export const TELEGRAM_CANCEL: CapabilityDefinition<unknown> = {
  capability: { id: 'telegram.cancel', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'cancel', label: 'Close a review', word: 'cancel', inputs: [ANY_MESSAGE],
  sentence: '{message} leaves the review queue and its text is let go; you cannot read it here again.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'cannot-be-undone', ownerOnly: OWNER_DECIDES,
  example: { message: '3f9a1c2e' },
  async run(values, _services, caller) {
    const match = await lookup(caller, values.message!);
    return holdOr(await call(caller, 'cancel', { ref: match.kind === 'review' ? match.record.ref : match.entry.ref }), 'Closed: it left the review queue and its text was let go.');
  },
};

export const TELEGRAM_REVOKE: CapabilityDefinition<unknown> = {
  capability: { id: 'telegram.revoke', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'revoke', label: 'Keep no new messages from a chat', word: 'revoke',
  inputs: [{
    id: 'configuration', label: 'Configuration', help: 'The configuration shown when you held the chat', kind: 'choice',
    choices: { list: TELEGRAM_CONFIGURATIONS_LIST, allowOther: { reason: 'a configuration id shown when the chat was held' } }, required: true, typed: { position: 1 },
  }],
  sentence: 'New messages in the chat you held are no longer kept for your review, and they are still not answered until you hand the chat back.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', ownerOnly: OWNER_DECIDES,
  example: { configuration: 'telegram-config-1' },
  run: async (values, _services, caller) => holdOr(await call(caller, 'revoke', { configurationId: (values.configuration ?? '').trim() }), 'New messages are no longer kept for your review; the chat is still not answered until you hand it back.'),
};

export const TELEGRAM_RELEASE: CapabilityDefinition<unknown> = {
  capability: { id: 'telegram.release', group: 'waiting', home: 'daemon', repeat: 'safe' },
  actionId: 'release', label: 'Hand a chat back to normal handling', word: 'release',
  inputs: [{ ...CHAT, help: 'The chat id (chatId/threadId for a thread), or the configuration id shown when you held it', freeTextReason: 'a chat id or configuration id' }],
  sentence: 'Chat {chat} is answered normally again, until you change it.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none', ownerOnly: OWNER_DECIDES, undoneBy: 'configure',
  example: { chat: '-1001234' },
  async run(values, _services, caller) {
    const target = (values.chat ?? '').trim();
    const configuration = target.startsWith('telegram-config-');
    const chat = configuration ? null : parseChat(target);
    if (!configuration && !chat) throw new CapabilityRefusal(`"${target}" is not a chat id (chatId or chatId/threadId) or a configuration id. Nothing was released.`, undefined, 'INVALID_ARGUMENT');
    return holdOr(await call(caller, 'release', chat ?? { configurationId: target }), 'The chat is back to normal handling.');
  },
};
