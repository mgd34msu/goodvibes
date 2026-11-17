/**
 * /telegram: delegated Telegram intake in a terminal.
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
import type { DaemonVerbCaller } from '@goodvibes-jev/engine/platform/platform/runtime/client';
import type { TerminalSlashCommand } from './command-registry.js';
import { stripDangerousAnsi } from './ansi-sanitize.js';

export interface TelegramIntakeCommandContext {
  readonly print: (text: string) => void;
  readonly renderRequest: () => void;
}

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
const DEFAULT_PENDING_RETENTION_MS = 60 * 60_000;
const DEFAULT_CONFIGURATION_LIFETIME_MS = 7 * 24 * 60 * 60_000;
const DEFAULT_SOURCE_RETENTION_MS = 60 * 60_000;
const DEFAULT_RECORD_RETENTION_MS = 7 * 24 * 60 * 60_000;
const MAX_DURATION_MS = 2_147_483_647;

const USAGE = [
  'Usage:',
  '  /telegram [list]                                   — messages waiting for you and the review queue',
  '  /telegram configure <chatId>[/<threadId>] <bot> [--hold <time>] [--for <time>]',
  '                                                     — select a chat; each of its messages waits for you',
  '  /telegram approve <id> [--keep <time>] [--record <time>] — accept a waiting message for review',
  '  /telegram deny <id>                                — refuse a waiting message; its original is released',
  '  /telegram status <id>                              — where one message stands',
  '  /telegram read <id>                                — show an approved message\'s original and mark it read',
  '  /telegram cancel <id>                              — close a review or withdraw a waiting message',
  '  /telegram revoke <configurationId>                 — capture no new messages; the chat stays held',
  '  /telegram release <chatId>[/<threadId>|configurationId] — return the chat to normal handling',
  'Times: 90s, 30m, 2h, 7d. Defaults: --hold 1h, --for 7d, --keep 1h, --record 7d.',
].join('\n');

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

/** Reads `--name value` options; returns the words left over, or the first problem. */
function readOptions(words: readonly string[], names: readonly string[]): { options: Map<string, string>; rest: string[] } | { error: string } {
  const options = new Map<string, string>();
  const rest: string[] = [];
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index]!;
    if (!word.startsWith('--')) { rest.push(word); continue; }
    const name = word.slice(2);
    if (!names.includes(name)) return { error: `unknown option ${word}` };
    const value = words[index + 1];
    if (value === undefined || value.startsWith('--')) return { error: `${word} needs a time such as 30m, 2h or 7d` };
    options.set(name, value);
    index += 1;
  }
  return { options, rest };
}

function durationOption(options: Map<string, string>, name: string, fallback: number): number | string {
  const raw = options.get(name);
  if (raw === undefined) return fallback;
  return parseIntakeDuration(raw) ?? `--${name} ${raw} is not a time such as 90s, 30m, 2h or 7d (at most 24 days)`;
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

const OWNER_ONLY = new Set(['configure', 'approve', 'deny', 'read', 'cancel', 'revoke', 'release']);

export function createTelegramIntakeCommand<Context extends TelegramIntakeCommandContext>(
  policy: TelegramIntakeCommandPolicy<Context>,
): TerminalSlashCommand<Context> {
  return {
    name: 'telegram',
    description: 'Delegated Telegram intake: select a chat, decide its waiting messages, read and close reviews',
    usage: '[list] | configure <chatId>[/<threadId>] <bot> | approve|deny|status|read|cancel <id> | revoke <configurationId> | release <chatId|configurationId>',
    argsHint: '[list|configure|approve|deny|status|read|cancel|revoke|release]',
    effect: 'mixed',
    readVerbs: ['list', 'status', 'help'],
    secretArgs: {},
    async handler(args, context) {
      // Read before the first await: a model running this command must not act for the owner.
      const owner = policy.isOwner(context, 'telegram');
      const say = (message: string) => { context.print(message); context.renderRequest(); };
      const sub = (args[0] ?? 'list').toLowerCase();
      if (sub === 'help') { say(USAGE); return; }
      if (OWNER_ONLY.has(sub) && !owner) {
        say(`[telegram] /telegram ${sub} acts for the owner; type it yourself at this terminal.`);
        return;
      }
      const verbs = policy.verbs(context);
      if ('unavailable' in verbs) { say(`[telegram] ${verbs.unavailable}`); return; }
      const reach = verbs.probe();
      if (!reach.available) { say(`[telegram] Delegated intake runs in the daemon, which this terminal cannot reach: ${reach.reason}`); return; }
      const call = async <T extends Outcome>(operation: string, input: Record<string, unknown>): Promise<T> =>
        await verbs.invoke<T>(`inbound.telegram.${operation}`, input);
      const failed = (what: string, error: unknown) => {
        say(`[telegram] Could not ${what}: ${error instanceof Error ? error.message : String(error)}`);
      };
      const lookup = async (id: string | undefined): Promise<Match | null> => {
        if (!id) { say(`[telegram] Name a message: /telegram ${sub} <id> (ids are shown by /telegram list).`); return null; }
        const list = await call<ListResult & Outcome>('list', {});
        const matches = findMessage(list, id);
        if (matches.length === 0) { say(`[telegram] No review or waiting message matches ${text(id)}. /telegram list shows the ids.`); return null; }
        if (matches.length > 1) { say(`[telegram] ${text(id)} matches ${matches.length} messages; type more of its id.`); return null; }
        return matches[0]!;
      };

      if (sub === 'list') {
        try {
          const list = await call<ListResult & Outcome>('list', {});
          if (list.records.length === 0 && list.pending.length === 0) {
            say('[telegram] Nothing waits for you and the review queue is empty. /telegram configure selects a chat.');
            return;
          }
          const lines: string[] = [];
          if (list.pending.length > 0) lines.push(`Waiting for your decision (${list.pending.length}):`, ...list.pending.map(pendingLine));
          if (list.records.length > 0) lines.push(`Review queue (${list.records.length}):`, ...list.records.map(recordLine));
          lines.push('/telegram approve|deny <id> decides a waiting message; /telegram read <id> shows an approved one.');
          say(lines.join('\n'));
        } catch (error) { failed('list delegated intake', error); }
        return;
      }

      if (sub === 'configure') {
        const parsed = readOptions(args.slice(1), ['hold', 'for']);
        if ('error' in parsed) { say(`[telegram] Nothing was configured: ${parsed.error}.\n${USAGE}`); return; }
        const chat = parsed.rest[0] ? parseChat(parsed.rest[0]) : null;
        const accountId = parsed.rest[1];
        if (!chat || !accountId || parsed.rest.length > 2) { say(`[telegram] Nothing was configured.\n${USAGE}`); return; }
        const pendingRetentionMs = durationOption(parsed.options, 'hold', DEFAULT_PENDING_RETENTION_MS);
        const configurationLifetimeMs = durationOption(parsed.options, 'for', DEFAULT_CONFIGURATION_LIFETIME_MS);
        if (typeof pendingRetentionMs === 'string' || typeof configurationLifetimeMs === 'string') {
          say(`[telegram] Nothing was configured: ${typeof pendingRetentionMs === 'string' ? pendingRetentionMs : configurationLifetimeMs}.`);
          return;
        }
        try {
          const result = await call('configure', {
            ...chat, accountId, pendingRetention: 'memory-only-until-deadline', pendingRetentionMs, configurationLifetimeMs, onExpiry: 'release-original-and-hold',
          });
          if (isHold(result)) { say(`[telegram] ${holdText(result)}`); return; }
          const identity = result.accountIdentity as { readonly username: string } | undefined;
          say([
            `[telegram] Chat ${text(chat.chatId)}${chat.threadId ? `/${text(chat.threadId)}` : ''} is selected for delegated intake${identity ? ` on @${text(identity.username)}` : ''}.`,
            `Configuration ${text(String(result.configurationId))} lasts until ${when(Number(result.expiresAt))}; each message waits for your decision and is kept in memory for ${Math.round(pendingRetentionMs / 60_000)} min.`,
            'The chat is not answered normally until /telegram release.',
          ].join('\n'));
        } catch (error) { failed('configure delegated intake', error); }
        return;
      }

      if (sub === 'approve' || sub === 'deny') {
        const parsed = readOptions(args.slice(1), sub === 'approve' ? ['keep', 'record'] : []);
        if ('error' in parsed) { say(`[telegram] Nothing was decided: ${parsed.error}.`); return; }
        const sourceRetentionMs = durationOption(parsed.options, 'keep', DEFAULT_SOURCE_RETENTION_MS);
        const derivedRecordRetentionMs = durationOption(parsed.options, 'record', DEFAULT_RECORD_RETENTION_MS);
        if (typeof sourceRetentionMs === 'string' || typeof derivedRecordRetentionMs === 'string') {
          say(`[telegram] Nothing was decided: ${typeof sourceRetentionMs === 'string' ? sourceRetentionMs : derivedRecordRetentionMs}.`);
          return;
        }
        if (sub === 'approve' && derivedRecordRetentionMs < sourceRetentionMs) {
          say('[telegram] Nothing was decided: --record must be at least as long as --keep, so the review outlives its original.');
          return;
        }
        try {
          const match = await lookup(parsed.rest[0]);
          if (!match) return;
          if (match.kind !== 'pending') { say(`[telegram] That message was already decided; it is in the review queue. /telegram read ${reviewShortId(match.record)} shows it.`); return; }
          const result = await call('decide', {
            approvalId: match.entry.approvalId, ref: match.entry.ref, approved: sub === 'approve',
            ...(sub === 'approve' ? { choices: {
              processingPurpose: 'accept-external-message-for-owner-review',
              sourceRetention: 'memory-only-until-review-close-or-deadline', sourceRetentionMs,
              derivedRecord: 'external-source-reference-only-v1', derivedRecordRetentionMs,
              execution: 'none', ownerMayReadOriginal: true,
            } } : {}),
          });
          if (isHold(result)) { say(`[telegram] ${holdText(result)}`); return; }
          say(result.outcome === 'denied'
            ? '[telegram] Denied; its original was released and nothing was run.'
            : `[telegram] Approved for review (${text(result.outcome)}); nothing was run. /telegram read ${pendingShortId(match.entry)} shows the original.`);
        } catch (error) { failed(`${sub} the message`, error); }
        return;
      }

      if (sub === 'status' || sub === 'read') {
        try {
          const match = await lookup(args[1]);
          if (!match) return;
          const ref = match.kind === 'review' ? match.record.ref : match.entry.ref;
          const result = await call(sub, { ref });
          if (isHold(result)) { say(`[telegram] ${holdText(result)}`); return; }
          if (result.outcome !== 'recorded') {
            say(`[telegram] ${result.outcome === 'awaiting-owner' ? 'Waiting for your decision: /telegram approve or /telegram deny.' : `This message is ${text(result.outcome)}; its original is ${text(String(result.source))}.`}`);
            return;
          }
          const record = result.record as ReviewRecord;
          const lines = [`[telegram] ${recordLine(record).trim()}`];
          if (result.source !== 'available-in-memory') lines.push('Its original is no longer in memory; ask the sender to send it again if it still needs review.');
          const original = result.original as { readonly text: string; readonly unsupportedSources: readonly { readonly kind: string; readonly label: string }[] } | undefined;
          if (sub === 'read' && original) {
            lines.push('Original:', text(original.text));
            for (const entry of original.unsupportedSources) lines.push(`  (not shown: ${text(entry.kind)} ${text(entry.label)})`);
          }
          say(lines.join('\n'));
        } catch (error) { failed(`${sub} the message`, error); }
        return;
      }

      if (sub === 'cancel') {
        try {
          const match = await lookup(args[1]);
          if (!match) return;
          const result = await call('cancel', { ref: match.kind === 'review' ? match.record.ref : match.entry.ref });
          say(isHold(result) ? `[telegram] ${holdText(result)}` : '[telegram] Closed; its place in the queue is free and its original was released.');
        } catch (error) { failed('cancel the review', error); }
        return;
      }

      if (sub === 'revoke') {
        const configurationId = args[1];
        if (!configurationId) { say('[telegram] Usage: /telegram revoke <configurationId> (shown when you configured the chat).'); return; }
        try {
          const result = await call('revoke', { configurationId });
          say(isHold(result) ? `[telegram] ${holdText(result)}` : '[telegram] No new message is captured. The chat stays held until /telegram release.');
        } catch (error) { failed('revoke the configuration', error); }
        return;
      }

      if (sub === 'release') {
        const target = args[1];
        const chat = target && !target.startsWith('telegram-config-') ? parseChat(target) : null;
        if (!target || (!chat && !target.startsWith('telegram-config-'))) { say('[telegram] Usage: /telegram release <chatId>[/<threadId>] or /telegram release <configurationId>.'); return; }
        try {
          const result = await call('release', chat ?? { configurationId: target });
          say(isHold(result) ? `[telegram] ${holdText(result)}` : '[telegram] The chat is back to normal handling.');
        } catch (error) { failed('release the chat', error); }
        return;
      }

      say(`[telegram] Unknown action ${text(sub)}.\n${USAGE}`);
    },
  };
}
