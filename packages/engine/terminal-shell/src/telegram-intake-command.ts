/**
 * /telegram: delegated Telegram intake in a terminal, described once
 * (command-actions/) for both terminal apps.
 *
 * A chat selected for delegated intake stops being answered normally; each of
 * its messages waits for the owner. From here the owner selects a chat
 * (`configure`), sees what waits and what is in the review queue (`list`),
 * approves or denies a waiting message, reads an approved message's original
 * (which marks the review read), closes a review (`cancel`), ends a
 * configuration (`revoke`) and returns the chat to normal handling
 * (`release`). Every action is one `inbound.telegram.*` verb on the daemon;
 * nothing here decides a fact the daemon owns.
 *
 * The products supply how the daemon is reached and who is typing. A command
 * the model runs may list and look up; only the owner typing at this terminal
 * configures, decides, reads an original, cancels, revokes or releases.
 */
import type { DaemonVerbCaller } from '@goodvibes/engine/platform/platform/runtime/client';
import type { TerminalCommandRegistry } from './command-registry.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';
import { commandRefusal } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionValues, CommandActionContext, InputDescription } from './command-actions/types.js';
import { listInput, readAction, textInput } from './described-command-kit.js';

export type TelegramIntakeCommandContext = CommandActionContext;

export interface TelegramIntakeCommandPolicy<Context> {
  /** The daemon this terminal talks to, or the reason there is none right now. */
  readonly verbs: (context: Context) => Pick<DaemonVerbCaller, 'probe' | 'invoke'> | { readonly unavailable: string };
  /** True only when the owner typed `command` at this terminal. */
  readonly isOwner: (context: Context, command: string) => boolean;
}

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
  readonly outcome: 'listed';
  readonly records: readonly ReviewRecord[];
  readonly pending: readonly PendingMessage[];
}

interface Hold {
  readonly outcome: 'held';
  readonly reason: string;
  readonly message: string;
  readonly nextStep: string;
  readonly accountIdentity?: { readonly id: string; readonly username: string };
}

type Outcome = { readonly outcome: string } & Record<string, unknown>;

const REVIEW_ID_PREFIX = 'external-review-';
const SHORT_ID_CHARS = 8;
const MAX_DURATION_MS = 2_147_483_647;

/** Display-only: strip terminal control sequences from text a sender or the daemon wrote. */
function text(value: string): string {
  return stripDangerousAnsi(value).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function when(ms: number): string {
  return new Date(ms).toLocaleString();
}

function reviewShortId(record: ReviewRecord): string {
  const id = record.id.startsWith(REVIEW_ID_PREFIX) ? record.id.slice(REVIEW_ID_PREFIX.length) : record.id;
  return id.slice(0, SHORT_ID_CHARS);
}

function pendingShortId(entry: PendingMessage): string {
  return entry.approvalId.slice(0, SHORT_ID_CHARS);
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

function isHold(result: Outcome): result is Outcome & Hold {
  return result.outcome === 'held';
}

function holdText(hold: Hold): string {
  const account = hold.accountIdentity ? ` The verified bot is @${text(hold.accountIdentity.username)} (${text(hold.accountIdentity.id)}).` : '';
  return `${text(hold.message)}${account} Next: ${text(hold.nextStep)}`;
}

function recordLine(record: ReviewRecord): string {
  const state = record.state === 'reviewed' ? 'read' : 'waiting to be read';
  const original = record.sourceExpiresAt > Date.now() ? `original kept until ${when(record.sourceExpiresAt)}` : 'original released';
  return `  ${reviewShortId(record)}  approved ${when(record.acceptedAt)}, ${state}; ${original}; review kept until ${when(record.recordExpiresAt)}`;
}

function pendingLine(entry: PendingMessage): string {
  const state = entry.outcome === 'awaiting-owner' ? 'waiting for your decision' : entry.outcome;
  return `  ${pendingShortId(entry)}  ${state}; original kept until ${when(entry.sourceExpiresAt)}`;
}

type Match = { readonly kind: 'review'; readonly record: ReviewRecord } | { readonly kind: 'pending'; readonly entry: PendingMessage };

/** The one review or waiting message `id` names: a shown short id, or a prefix of its review, approval or request id. */
function findMessage(list: ListResult, id: string): Match[] {
  const matches: Match[] = [];
  for (const record of list.records) {
    if (reviewShortId(record).startsWith(id) || record.id.startsWith(id) || record.approvalId.startsWith(id) || record.ref.requestId.startsWith(id)) {
      matches.push({ kind: 'review', record });
    }
  }
  for (const entry of list.pending) {
    if (matches.some(match => match.kind === 'review' && match.record.ref.requestId === entry.ref.requestId)) continue;
    if (entry.approvalId.startsWith(id) || entry.ref.requestId.startsWith(id)) matches.push({ kind: 'pending', entry });
  }
  return matches;
}


const TIME_WHY = 'a time such as 90s, 30m, 2h or 7d (at most 24 days)';
const OWNER_DECIDES = { reason: 'it decides what happens to messages sent to the owner\'s Telegram chat', instead: '/telegram list shows what waits, for the owner to decide' };

let policyOf: TelegramIntakeCommandPolicy<unknown> | undefined;
/** The daemon takes a message by its full reference and a chat with its retention choices, which the terminal reads from the list it shows. */
const BY_REFERENCE = { terminalOnly: 'the daemon takes the message\'s full reference, which the terminal reads from the list it shows' } as const;

type Verbs = Pick<DaemonVerbCaller, 'probe' | 'invoke'>;
function verbsOf(context: unknown): Verbs {
  if (!policyOf) throw commandRefusal('Delegated Telegram intake is not wired in this program.');
  const verbs = policyOf.verbs(context);
  if ('unavailable' in verbs) throw commandRefusal(verbs.unavailable);
  const reach = verbs.probe();
  if (!reach.available) throw commandRefusal(`Delegated intake runs in the daemon, which this terminal cannot reach: ${reach.reason}`);
  return verbs;
}
async function call<T extends Outcome>(context: unknown, operation: string, input: Record<string, unknown>): Promise<T> {
  try {
    return await verbsOf(context).invoke<T>(`inbound.telegram.${operation}`, input);
  } catch (error) {
    if (error instanceof Error && 'refusal' in error) throw error;
    throw commandRefusal(`The daemon could not ${operation} delegated intake: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function listed(context: unknown): Promise<ListResult & Outcome> {
  return await call<ListResult & Outcome>(context, 'list', {});
}

/** The owner typed it at this terminal; a model, a channel or a nested command did not. */
function requireOwner(context: unknown, word: string): void {
  if (!policyOf?.isOwner(context, 'telegram')) throw commandRefusal(`/telegram ${word} acts for the owner; type it yourself at this terminal. Nothing was done.`);
}

function durationOf(value: string | undefined, label: string): number {
  const ms = parseIntakeDuration(value ?? '');
  if (ms === null) throw commandRefusal(`${label}: "${value}" is not ${TIME_WHY}. Nothing was done.`);
  return ms;
}

async function lookup(context: unknown, id: string): Promise<Match> {
  const matches = findMessage(await listed(context), id);
  if (matches.length === 0) throw commandRefusal(`No review or waiting message matches ${text(id)}.`, '/telegram list shows the ids');
  if (matches.length > 1) throw commandRefusal(`${text(id)} matches ${matches.length} messages; type more of its id.`);
  return matches[0]!;
}

function holdOr(result: Outcome, otherwise: string): string {
  if (isHold(result)) throw commandRefusal(holdText(result));
  return otherwise;
}

const WAITING = defineList<unknown>({
  name: 'telegram.waiting',
  async read(context) {
    return (await listed(context)).pending.map((entry): ListRow => ({ value: pendingShortId(entry), label: pendingLine(entry).trim(), state: 'waiting' }));
  },
  operator: { method: 'inbound.telegram.list', input: {}, rows: { from: 'pending', value: 'approvalId', label: 'outcome' } },
});
const MESSAGES = defineList<unknown>({
  name: 'telegram.messages',
  async read(context) {
    const list = await listed(context);
    return [
      ...list.pending.map((entry): ListRow => ({ value: pendingShortId(entry), label: pendingLine(entry).trim(), state: 'waiting' })),
      ...list.records.map((record): ListRow => ({ value: reviewShortId(record), label: recordLine(record).trim(), state: record.state === 'reviewed' ? 'read' : 'in review' })),
    ];
  },
  operator: { method: 'inbound.telegram.list', input: {}, rows: { from: 'records', value: 'id', label: 'state' } },
});
const CONFIGURATIONS = defineList<unknown>({
  name: 'telegram.configurations',
  async read(context) {
    const ids = new Set((await listed(context)).records.map((record) => record.configurationId));
    return [...ids].map((id): ListRow => ({ value: id, label: id }));
  },
  operator: { method: 'inbound.telegram.list', input: {}, rows: { from: 'records', value: 'configurationId', label: 'configurationId' } },
});

const WAITING_MESSAGE: InputDescription = listInput({ id: 'message', label: 'Message', help: 'A message waiting for your decision', list: WAITING });
const ANY_MESSAGE: InputDescription = listInput({ id: 'message', label: 'Message', help: 'A waiting message or one in the review queue', list: MESSAGES });
const CHAT: InputDescription = textInput({ id: 'chat', label: 'Chat', help: 'The chat id, with /thread for one thread of it (-1001234/7)', why: 'a Telegram chat id', typed: { position: 1 } });

/** Register `/telegram` (the one description) with how this app reaches the daemon and who is typing. */
export function registerTelegramIntakeCommand<Ctx extends TelegramIntakeCommandContext>(
  registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>,
  policy: TelegramIntakeCommandPolicy<Ctx>,
): void {
  policyOf = policy as unknown as TelegramIntakeCommandPolicy<unknown>;
  registry.register(defineCommand<Ctx>({
    name: 'telegram',
    title: 'Telegram messages held for you',
    summary: 'Hold a Telegram chat\'s messages for your decision, decide each one, and read and close the reviews',
    group: 'Channels',
    report: 'list',
    actions: [
      readAction<Ctx>({
        id: 'list', label: 'See what waits for you', word: 'list',
        sentence: 'Lists the messages waiting for your decision and the review queue.',
        operator: { method: 'inbound.telegram.list', fields: {} },
        async run(_values, context) {
          const list = await listed(context);
          if (list.records.length === 0 && list.pending.length === 0) return 'Nothing waits for you and the review queue is empty. /telegram configure holds a chat\'s messages for you.';
          const lines: string[] = [];
          if (list.pending.length > 0) lines.push(`Waiting for your decision (${list.pending.length}):`, ...list.pending.map(pendingLine));
          if (list.records.length > 0) lines.push(`Review queue (${list.records.length}):`, ...list.records.map(recordLine));
          return lines.join('\n');
        },
      }),
      {
        id: 'configure', label: 'Hold a chat\'s messages for you', word: 'configure',
        inputs: [
          CHAT,
          textInput({ id: 'bot', label: 'Bot', help: 'The Telegram bot account that receives the chat', why: 'a bot account id', typed: { position: 2 } }),
          textInput({ id: 'hold', label: 'Each message waits', help: 'How long a message is kept in memory waiting for you', why: TIME_WHY, typed: { flag: '--hold' }, optional: { default: '1h', means: 'one hour' } }),
          textInput({ id: 'for', label: 'Hold the chat for', help: 'How long the chat is held before it goes back to normal', why: TIME_WHY, typed: { flag: '--for' }, optional: { default: '7d', means: 'seven days' } }),
        ],
        sentence: 'Every message in chat {chat} on {bot} waits for your decision instead of being answered, for {for} or until you change it.', done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'none', ownerOnly: OWNER_DECIDES, undoneBy: 'release',
        operator: BY_REFERENCE,
        example: { chat: '-1001234', bot: 'support-bot' },
        async run(values, context) {
          requireOwner(context, 'configure');
          const chat = parseChat(values.chat ?? '');
          if (!chat) throw commandRefusal(`"${values.chat}" is not a chat id (chatId or chatId/threadId). Nothing was configured.`);
          const pendingRetentionMs = durationOf(values.hold, 'Each message waits');
          // The hold as given (validated above); a bare number is milliseconds.
          const givenHold = (values.hold ?? '').trim();
          const heldFor = /^\d+$/.test(givenHold) ? `${givenHold}ms` : givenHold;
          const configurationLifetimeMs = durationOf(values.for, 'Hold the chat for');
          const result = await call(context, 'configure', {
            ...chat, accountId: values.bot!, pendingRetention: 'memory-only-until-deadline', pendingRetentionMs, configurationLifetimeMs, onExpiry: 'release-original-and-hold',
          });
          if (isHold(result)) throw commandRefusal(holdText(result));
          const identity = result.accountIdentity as { readonly username: string } | undefined;
          return [
            `Chat ${text(chat.chatId)}${chat.threadId ? `/${text(chat.threadId)}` : ''} is held for you${identity ? ` on @${text(identity.username)}` : ''}.`,
            `Configuration ${text(String(result.configurationId))} lasts until ${when(Number(result.expiresAt))}; each message is kept in memory for ${heldFor}.`,
            'The chat is not answered normally until /telegram release.',
          ].join('\n');
        },
      },
      {
        id: 'approve', label: 'Accept a waiting message for review', word: 'approve',
        inputs: [
          WAITING_MESSAGE,
          textInput({ id: 'keep', label: 'Keep the original', help: 'How long its original stays in memory for you to read', why: TIME_WHY, typed: { flag: '--keep' }, optional: { default: '1h', means: 'one hour' } }),
          textInput({ id: 'record', label: 'Keep the review', help: 'How long the review record is kept; at least as long as the original', why: TIME_WHY, typed: { flag: '--record' }, optional: { default: '7d', means: 'seven days' } }),
        ],
        sentence: '{message} goes into your review queue; nothing in it is run.', done: '',
        touches: 'another-machine', lasts: 'not-a-change', risk: 'none', ownerOnly: OWNER_DECIDES,
        operator: BY_REFERENCE,
        example: { message: '3f9a1c2e' },
        async run(values, context) {
          requireOwner(context, 'approve');
          const sourceRetentionMs = durationOf(values.keep, 'Keep the original');
          const derivedRecordRetentionMs = durationOf(values.record, 'Keep the review');
          if (derivedRecordRetentionMs < sourceRetentionMs) throw commandRefusal('Keep the review must be at least as long as Keep the original, so the review outlives its original. Nothing was decided.');
          return await decide(context, values, true, { sourceRetentionMs, derivedRecordRetentionMs });
        },
      },
      {
        id: 'deny', label: 'Refuse a waiting message', word: 'deny', inputs: [WAITING_MESSAGE],
        sentence: '{message} is refused; its original is released and nothing in it is run.', done: '',
        touches: 'another-machine', lasts: 'not-a-change', risk: 'none', ownerOnly: OWNER_DECIDES,
        operator: BY_REFERENCE,
        example: { message: '3f9a1c2e' },
        async run(values, context) {
          requireOwner(context, 'deny');
          return await decide(context, values, false, undefined);
        },
      },
      readAction<Ctx>({
        id: 'status', label: 'See where a message stands', word: 'status', inputs: [ANY_MESSAGE],
        sentence: 'Shows whether {message} waits, is in review or was read, and whether its original is still kept.', example: { message: '3f9a1c2e' },
        operator: BY_REFERENCE,
        async run(values, context) { return await showMessage(context, values, 'status'); },
      }),
      {
        id: 'read', label: 'Read an accepted message', word: 'read', inputs: [ANY_MESSAGE],
        sentence: 'Shows the original of {message} and marks its review read.', done: '',
        touches: 'another-machine', lasts: 'not-a-change', risk: 'none', ownerOnly: OWNER_DECIDES,
        operator: BY_REFERENCE,
        example: { message: '3f9a1c2e' },
        async run(values, context) {
          requireOwner(context, 'read');
          return await showMessage(context, values, 'read');
        },
      },
      {
        id: 'cancel', label: 'Close a review', word: 'cancel', inputs: [ANY_MESSAGE],
        sentence: '{message} leaves the queue and its original is released.', done: '',
        touches: 'another-machine', lasts: 'not-a-change', risk: 'cannot-be-undone', ownerOnly: OWNER_DECIDES,
        operator: BY_REFERENCE,
        example: { message: '3f9a1c2e' },
        async run(values, context) {
          requireOwner(context, 'cancel');
          const match = await lookup(context, values.message!);
          return holdOr(await call(context, 'cancel', { ref: match.kind === 'review' ? match.record.ref : match.entry.ref }), 'Closed; its place in the queue is free and its original was released.');
        },
      },
      {
        id: 'revoke', label: 'Stop holding new messages from a chat', word: 'revoke',
        inputs: [listInput({ id: 'configuration', label: 'Configuration', help: 'The configuration shown when you held the chat', list: CONFIGURATIONS, other: 'a configuration id shown when the chat was held' })],
        sentence: 'No new message is captured under {configuration}; the chat stays held until you hand it back.', done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'cannot-be-undone', ownerOnly: OWNER_DECIDES,
        operator: BY_REFERENCE,
        example: { configuration: 'telegram-config-1' },
        async run(values, context) {
          requireOwner(context, 'revoke');
          return holdOr(await call(context, 'revoke', { configurationId: values.configuration! }), 'No new message is captured. The chat stays held until /telegram release.');
        },
      },
      {
        id: 'release', label: 'Hand a chat back to normal handling', word: 'release',
        inputs: [{ ...CHAT, help: 'The chat id (chatId/threadId for a thread), or the configuration id shown when you held it', freeTextReason: 'a chat id or configuration id' }],
        sentence: 'Chat {chat} is answered normally again, until you change it.', done: '',
        touches: 'another-machine', lasts: 'kept', risk: 'none', ownerOnly: OWNER_DECIDES, undoneBy: 'configure',
        operator: BY_REFERENCE,
        example: { chat: '-1001234' },
        async run(values, context) {
          requireOwner(context, 'release');
          const target = values.chat!;
          const configuration = target.startsWith('telegram-config-');
          const chat = configuration ? null : parseChat(target);
          if (!configuration && !chat) throw commandRefusal(`"${target}" is not a chat id (chatId or chatId/threadId) or a configuration id. Nothing was released.`);
          return holdOr(await call(context, 'release', chat ?? { configurationId: target }), 'The chat is back to normal handling.');
        },
      },
    ],
  }));
}

async function decide(context: unknown, values: ActionValues, approved: boolean, keep: { sourceRetentionMs: number; derivedRecordRetentionMs: number } | undefined): Promise<string> {
  const match = await lookup(context, values.message!);
  if (match.kind !== 'pending') throw commandRefusal(`That message was already decided; it is in the review queue.`, `/telegram read ${reviewShortId(match.record)} shows it`);
  const result = await call(context, 'decide', {
    approvalId: match.entry.approvalId, ref: match.entry.ref, approved,
    ...(approved && keep ? { choices: {
      processingPurpose: 'accept-external-message-for-owner-review',
      sourceRetention: 'memory-only-until-review-close-or-deadline', sourceRetentionMs: keep.sourceRetentionMs,
      derivedRecord: 'external-source-reference-only-v1', derivedRecordRetentionMs: keep.derivedRecordRetentionMs,
      execution: 'none', ownerMayReadOriginal: true,
    } } : {}),
  });
  if (isHold(result)) throw commandRefusal(holdText(result));
  return result.outcome === 'denied'
    ? 'Refused; its original was released and nothing was run.'
    : `Accepted for review (${text(result.outcome)}); nothing was run. /telegram read ${pendingShortId(match.entry)} shows the original.`;
}

async function showMessage(context: unknown, values: ActionValues, operation: 'status' | 'read'): Promise<string> {
  const match = await lookup(context, values.message!);
  const ref = match.kind === 'review' ? match.record.ref : match.entry.ref;
  const result = await call(context, operation, { ref });
  if (isHold(result)) throw commandRefusal(holdText(result));
  if (result.outcome !== 'recorded') {
    return result.outcome === 'awaiting-owner' ? 'Waiting for your decision: /telegram approve or /telegram deny.' : `This message is ${text(result.outcome)}; its original is ${text(String(result.source))}.`;
  }
  const record = result.record as ReviewRecord;
  const lines = [recordLine(record).trim()];
  if (result.source !== 'available-in-memory') lines.push('Its original is no longer in memory; ask the sender to send it again if it still needs review.');
  const original = result.original as { readonly text: string; readonly unsupportedSources: readonly { readonly kind: string; readonly label: string }[] } | undefined;
  if (operation === 'read' && original) {
    lines.push('Original:', text(original.text));
    for (const entry of original.unsupportedSources) lines.push(`  (not shown: ${text(entry.kind)} ${text(entry.label)})`);
  }
  return lines.join('\n');
}
