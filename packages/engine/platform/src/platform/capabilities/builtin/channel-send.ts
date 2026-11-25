/**
 * Channels: a message sent to a channel, the messages sent, and Telegram's
 * saved reading position, each the daemon's.
 *
 *  - `channels.send`: the daemon sends through its own channel router (the
 *    one its scheduled runs and channel turns deliver through) and keeps a
 *    receipt of each send in its sends store, beside its deliveries
 *    (`~/.goodvibes/daemon/channels/delivery-receipts.json`). The Agent's own
 *    receipts (3.5.0, `~/.goodvibes/agent/channels/delivery-receipts.json`)
 *    are carried into that store once, at the daemon's start; the Agent's file
 *    is left as it was.
 *  - `channels.deliveries`: the daemon's deliveries (`deliveries.list`) and
 *    the sends it keeps receipts of, together.
 *  - `channels.telegram-cursor`: the saved Telegram reading position the
 *    daemon holds (`channels.actions.invoke`, the cursor migration), shown, and
 *    bound to the bot when the owner says it belongs to it.
 */
import { CapabilityRefusal, type CapabilityCaller, type CapabilityDefinition, type ListName } from '../types.js';
import { readTelegramCursorMigrationResult, readTelegramCursorPreview } from '../../channels/telegram/cursor-migration-data.js';

/** One send the daemon kept a receipt of (no address: a webhook's is its scheme and host only). */
export interface ChannelSendReceipt {
  readonly id: string;
  readonly createdAt: string;
  /** Who sent it: a person's press or line (`command`), or a model's tool. */
  readonly source: string;
  readonly target: string;
  readonly title: string;
  readonly messagePreview: string;
  readonly responseId?: string | undefined;
}

/** What a send names: the words, and one of a channel, a route, a webhook address or a link. */
export interface ChannelSendInput {
  readonly message: string;
  readonly title?: string | undefined;
  readonly channel?: string | undefined;
  readonly route?: string | undefined;
  readonly webhook?: string | undefined;
  readonly link?: string | undefined;
}

export interface ChannelSendCapabilityServices {
  readonly channelSends: {
    /** Send through the daemon's channel router; the receipt is kept before this answers. */
    send(input: ChannelSendInput): Promise<{ readonly target: string; readonly responseId?: string | undefined; readonly receiptId?: string | undefined; readonly receiptNote?: string | undefined }>;
    /** The sends kept, newest first; `unreadable` says why the store could not be read. */
    receipts(): { readonly receipts: readonly ChannelSendReceipt[]; readonly unreadable?: string | undefined };
  };
}

const CHANNELS_LIST = 'channels' as ListName;
const READ = { done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none' } as const;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const word = (value: unknown): string => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, ' ').trim() : typeof value === 'number' ? String(value) : '');
const when = (value: unknown): string => (typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString().replace('T', ' ').slice(0, 16) : '');

function methodOf(caller: CapabilityCaller, what: string): NonNullable<CapabilityCaller['method']> {
  if (!caller.method) throw new CapabilityRefusal(`${what} is the daemon's, and this run did not come through it, so nothing was done.`);
  return caller.method;
}

export const CHANNELS_SEND: CapabilityDefinition<ChannelSendCapabilityServices> = {
  capability: { id: 'channels.send', group: 'messages', home: 'daemon', repeat: 'unsafe' },
  actionId: 'send', word: 'send', label: 'Send a message to a channel',
  inputs: [
    { id: 'message', label: 'Message', help: 'What to send', kind: 'long-text', freeTextReason: 'your own words', required: true, typed: { tail: true } },
    { id: 'channel', label: 'To', help: 'A channel (slack, telegram, discord, ntfy, ...), or channel:route', kind: 'choice',
      choices: { list: CHANNELS_LIST, allowOther: { reason: 'a channel and route, as channel:route' } },
      required: { default: '', defaultMeans: 'a route, webhook or link instead' }, typed: { flag: '--channel' } },
    { id: 'title', label: 'Title', help: 'A title above the message', kind: 'text', freeTextReason: 'your own words', required: { default: '', defaultMeans: 'no title' }, typed: { flag: '--title' } },
    { id: 'route', label: 'Route', help: 'A route the daemon keeps, by its id, in place of a channel', kind: 'text', freeTextReason: 'a route id', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--route' } },
    { id: 'webhook', label: 'Webhook address', help: 'An incoming webhook address in place of a channel; it carries its token, so it is never shown', kind: 'secret', required: { default: '', defaultMeans: 'none' }, typed: { flag: '--webhook' } },
    { id: 'link', label: 'Link', help: 'A link sent under the message', kind: 'text', freeTextReason: 'a web address', required: { default: '', defaultMeans: 'no link' }, typed: { flag: '--link' } },
  ],
  sentence: '"{message}" is sent to {channel} (a Slack, Telegram, Discord, ntfy or other chat channel) and cannot be recalled.', done: '',
  touches: 'another-machine', lasts: 'not-a-change', risk: 'sends-out',
  example: { message: 'Build is green', channel: 'slack' },
  async run(values, services) {
    const message = (values.message ?? '').trim();
    if (!message) throw new CapabilityRefusal('There is nothing to send: the message is empty.');
    const named = [values.channel, values.route, values.webhook].filter((value) => typeof value === 'string' && value.trim().length > 0);
    if (named.length === 0 && !values.link?.trim()) throw new CapabilityRefusal('No channel was named, so nothing was sent.', 'Choose the channel in "To"');
    if (named.length > 1) throw new CapabilityRefusal('More than one of a channel, a route and a webhook address was given, so who it is for is unclear; nothing was sent.', 'Give one');
    let sent: Awaited<ReturnType<ChannelSendCapabilityServices['channelSends']['send']>>;
    try {
      sent = await services.channelSends.send({
        message, ...(values.title?.trim() ? { title: values.title.trim() } : {}), ...(values.channel?.trim() ? { channel: values.channel.trim() } : {}),
        ...(values.route?.trim() ? { route: values.route.trim() } : {}), ...(values.webhook?.trim() ? { webhook: values.webhook.trim() } : {}),
        ...(values.link?.trim() ? { link: values.link.trim() } : {}),
      });
    } catch (error) {
      if (error instanceof CapabilityRefusal) throw error;
      throw new CapabilityRefusal(`Not sent: ${error instanceof Error ? error.message : String(error)}`);
    }
    return {
      text: [`Sent to ${sent.target}${sent.responseId ? ` (the channel answered ${sent.responseId})` : ''}.`, ...(sent.receiptNote ? [sent.receiptNote] : [])].join(' '),
      data: { target: sent.target, ...(sent.responseId ? { responseId: sent.responseId } : {}), ...(sent.receiptId ? { receiptId: sent.receiptId } : {}) },
    };
  },
};

function attemptLine(attempt: Readonly<Record<string, unknown>>): { readonly at: string; readonly line: string } {
  const target = isRecord(attempt['target']) ? attempt['target'] : {};
  const where = word(target['label']) || [word(target['surfaceKind']), word(target['address'])].filter(Boolean).join(' ') || word(target['kind']);
  const status = word(attempt['status']);
  const at = when(attempt['endedAt'] ?? attempt['startedAt']);
  return { at, line: `  ${at} ${where || 'a target'}: ${status}${attempt['error'] ? ` (${word(attempt['error'])})` : ''}` };
}

export const CHANNELS_DELIVERIES: CapabilityDefinition<ChannelSendCapabilityServices> = {
  capability: { id: 'channels.deliveries', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'deliveries', word: 'deliveries', label: 'See the messages the daemon sent to your channels', ...READ, inputs: [],
  sentence: 'Lists the newest messages sent to your chat channels and webhooks (the daemon\'s deliveries and the messages sent from here), and whether each arrived.', example: {},
  async run(_values, services, caller) {
    const answer = await methodOf(caller, 'What was sent')('deliveries.list', {});
    const attempts = Array.isArray(isRecord(answer) ? answer['attempts'] : undefined) ? (answer as { attempts: unknown[] }).attempts.filter(isRecord) : [];
    const kept = services.channelSends.receipts();
    const rows = [
      ...attempts.map(attemptLine),
      ...kept.receipts.map((receipt) => ({ at: receipt.createdAt.replace('T', ' ').slice(0, 16), line: `  ${receipt.createdAt.replace('T', ' ').slice(0, 16)} ${word(receipt.target)}: sent${receipt.source === 'model-tool' ? ' by the model' : ''}, "${word(receipt.messagePreview)}"` })),
    ].sort((left, right) => left.at.localeCompare(right.at));
    const unreadable = kept.unreadable ? [`The messages sent from here could not be read (${kept.unreadable}); they are not listed.`] : [];
    if (rows.length === 0) return { text: ['Nothing was sent to a channel yet.', ...unreadable].join('\n'), data: { attempts: [], sends: [] } };
    return {
      text: [`${rows.length} send${rows.length === 1 ? '' : 's'}, newest last:`, ...rows.slice(-20).map((row) => row.line), ...unreadable].join('\n'),
      data: { attempts, sends: kept.receipts },
    };
  },
};

export const CHANNELS_TELEGRAM_CURSOR: CapabilityDefinition<ChannelSendCapabilityServices> = {
  capability: { id: 'channels.telegram-cursor', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'telegram-cursor', word: 'telegram-cursor', label: 'Pick up Telegram where it left off',
  inputs: [{ id: 'bind', label: 'What to do', help: 'See the saved reading position, or say it belongs to this bot and start reading from it', kind: 'choice',
    choices: [{ value: 'no', label: 'Show the saved position' }, { value: 'yes', label: 'It belongs to this bot: read from it', risk: 'cannot-be-undone', riskDone: 'Telegram reads from the saved position now.' }],
    required: { default: 'no', defaultMeans: 'show the saved position' }, typed: { flag: '--bind', switchOn: 'yes' } }],
  sentence: 'Shows the Telegram reading position the daemon saved and which bot it was saved for, and, when you say it belongs to this bot, Telegram reads on from it.', done: '',
  touches: 'another-machine', lasts: 'kept', risk: 'none',
  example: {},
  async run(values, _services, caller) {
    const method = methodOf(caller, 'Telegram\'s reading position');
    let preview: ReturnType<typeof readTelegramCursorPreview>;
    try {
      const previewAnswer = await method('channels.actions.invoke', { surface: 'telegram', actionId: 'cursor-migration-preview' });
      preview = readTelegramCursorPreview(isRecord(previewAnswer) ? previewAnswer['result'] : undefined);
    } catch (error) {
      // Telegram not set up to read by polling here: there is no reading position to review.
      const status = (error as { readonly status?: unknown } | null)?.status;
      throw new CapabilityRefusal(typeof status === 'number' && status >= 500
        ? 'Telegram is not reading messages here (no bot is set up to poll), so there is no saved reading position to review.'
        : `Telegram's reading position could not be read: ${error instanceof Error ? error.message : String(error)}`, 'Set Telegram up under Channels first');
    }
    if (preview.state === 'not-needed') return { text: preview.message, data: { state: 'not-needed' } };
    const saved = `The saved position ${preview.offset} was kept for the bot @${preview.username} (${preview.accountId}) on ${preview.updatedAt.replace('T', ' ').slice(0, 16)}.`;
    if (values.bind !== 'yes') {
      return { text: `${saved} Telegram is not read until you say it belongs to this bot; choosing the wrong bot can skip its waiting messages.`, data: { state: 'unbound', offset: preview.offset, username: preview.username } };
    }
    const committed = await method('channels.actions.invoke', { surface: 'telegram', actionId: 'cursor-migration-commit', previewId: preview.previewId, confirm: true });
    const result = readTelegramCursorMigrationResult(isRecord(committed) ? committed['result'] : undefined);
    if (result.accountId !== preview.accountId || result.offset !== preview.offset) throw new CapabilityRefusal('The daemon bound another position than the one shown; read it again before going on.');
    return { text: result.message, data: { state: 'migrated', offset: result.offset, running: result.running } };
  },
};

/** The channels' handler capabilities of this file. */
export const CHANNEL_SEND_CAPABILITIES: readonly CapabilityDefinition<ChannelSendCapabilityServices>[] = [CHANNELS_SEND, CHANNELS_DELIVERIES, CHANNELS_TELEGRAM_CURSOR];
