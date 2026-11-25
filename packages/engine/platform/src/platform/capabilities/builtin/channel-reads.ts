/**
 * The channels' reads that each terminal program answered from its own copy
 * until now (the Agent's settings, router and receipts; the terminal app's
 * route and delivery snapshots in memory), answered from the daemon's own
 * methods instead: `channels.status` and `channels.setup.get` for readiness,
 * configuration and the setup guide, `deliveries.list` for what was sent and
 * how, `routes.bindings.list` and `routes.snapshot` for the routes, and
 * `control.messages.list` for what came in. Each runs in the daemon as the
 * caller (method-capability.ts).
 */
import type { ListName } from '../types.js';
import type { MethodCapabilityDefinition } from './method-capability.js';
import { CHANNEL_STATE_WORDS, channelReasonOf, channelStateOf, type ChannelState } from '../../channels/channel-state.js';

const READ = { done: '', touches: 'reads', lasts: 'not-a-change', risk: 'none' } as const;
const CHANNELS_LIST = 'channels' as ListName;
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const listOf = (answer: unknown, key: string): readonly Readonly<Record<string, unknown>>[] => {
  const list = isRecord(answer) ? answer[key] : undefined;
  return Array.isArray(list) ? list.filter(isRecord) : [];
};
/** Text the daemon reports from outside (a chat's title, a sender), without control characters. */
const word = (value: unknown): string => (typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/g, ' ').trim() : typeof value === 'number' ? String(value) : '');
const when = (value: unknown): string => (typeof value === 'number' && Number.isFinite(value) ? new Date(value).toISOString().replace('T', ' ').slice(0, 16) : '');

const CHANNEL = {
  id: 'channel', label: 'Channel', help: 'One of the daemon\'s channels', kind: 'choice' as const,
  choices: { list: CHANNELS_LIST, allowOther: { reason: 'a channel kind the daemon does not report yet (slack, telegram, discord, ntfy, webhook, ...)' } },
  required: true as const, typed: { position: 1 as const },
};

function channelLine(channel: Readonly<Record<string, unknown>>): { readonly state: ChannelState; readonly line: string } {
  const state = channelStateOf(channel);
  const reason = channelReasonOf(channel);
  return { state, line: `${word(channel['label']) || word(channel['surface'])}: ${CHANNEL_STATE_WORDS[state]}${reason ? ` (${reason})` : ''}` };
}

const SET_UP: readonly ChannelState[] = ['working', 'needs-attention', 'not-working', 'unknown', 'off'];

export const CHANNELS_READINESS: MethodCapabilityDefinition = {
  capability: { id: 'channels.readiness', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'readiness', word: 'readiness', label: 'See which channels are set up', inputs: [], ...READ,
  sentence: 'Lists which chat channels (Slack, Telegram, Discord, ntfy, ...) are set up and ready to send to, and what each one that is not still needs.', example: {},
  method: { id: 'channels.status', fields: {} },
  said: (answer) => {
    const lines = listOf(answer, 'channels').map(channelLine);
    const ready = lines.filter((entry) => entry.state === 'working');
    const setUp = lines.filter((entry) => SET_UP.includes(entry.state) && entry.state !== 'working');
    const notSetUp = lines.filter((entry) => entry.state === 'not-set-up');
    if (lines.length === 0) return 'The daemon reports no channels.';
    return [
      `${ready.length} of ${lines.length} channels work.`,
      ...(ready.length > 0 ? ['Working:', ...ready.map((entry) => `  ${entry.line}`)] : []),
      ...(setUp.length > 0 ? ['Set up, not working now:', ...setUp.map((entry) => `  ${entry.line}`)] : []),
      ...(notSetUp.length > 0 ? [`Not set up: ${notSetUp.map((entry) => entry.line.split(':')[0]).join(', ')}.`] : []),
    ].join('\n');
  },
};

function setupLines(answer: Readonly<Record<string, unknown>>): string[] {
  const settings = listOf(answer, 'settings').concat(listOf(answer, 'fields'), listOf(answer, 'requirements'));
  const lines = settings.map((entry) => {
    const name = word(entry['label']) || word(entry['key']) || word(entry['id']);
    const set = entry['configured'] === true || entry['present'] === true || entry['set'] === true;
    return `  ${set ? 'set' : 'missing'}: ${name}${entry['secret'] === true ? ' (a secret; never shown)' : ''}`;
  });
  return lines;
}

export const CHANNELS_CONFIGURED: MethodCapabilityDefinition = {
  capability: { id: 'channels.configured', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'configured', word: 'configured', label: 'See how one channel is configured', ...READ, inputs: [CHANNEL],
  sentence: 'Shows which settings {channel} has and which it still lacks, and what to do next; no secret value is shown.', example: { channel: 'slack' },
  method: { id: 'channels.setup.get', fields: { surface: 'channel' } },
  said: (answer, values) => {
    const lines = setupLines(answer);
    const next = word(answer['nextStep']) || word(answer['next']) || word(answer['summary']);
    return [`${values.channel}:`, ...(lines.length > 0 ? lines : ['  the daemon names no setting for it.']), ...(next ? [`Next: ${next}`] : [])].join('\n');
  },
};

export const CHANNELS_GUIDE: MethodCapabilityDefinition = {
  capability: { id: 'channels.guide', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'guide', word: 'guide', label: 'Walk through setting up chat channels',
  ...READ, inputs: [],
  sentence: 'Shows the chat channels in the order to set them up: what works, what needs a look, and the next one to set up.', example: {},
  method: { id: 'channels.status', fields: {} },
  said: (answer) => {
    const lines = listOf(answer, 'channels').map(channelLine);
    const troubled = lines.filter((entry) => entry.state === 'needs-attention' || entry.state === 'not-working');
    const notSetUp = lines.filter((entry) => entry.state === 'not-set-up');
    const done = lines.filter((entry) => entry.state === 'working');
    return [
      `${done.length} of ${lines.length} channels work.`,
      ...troubled.map((entry) => `  First look at ${entry.line}: select it under Channels and press "check it".`),
      ...(notSetUp[0] ? [`  Next to set up: ${notSetUp[0].line.split(':')[0]}: select it under Channels and press "what it needs", then "set it up".`] : []),
      ...(troubled.length === 0 && notSetUp.length === 0 ? ['  Every channel the daemon has is set up.'] : []),
    ].join('\n');
  },
};

// What was sent (`channels.deliveries`) reads the daemon's deliveries and the sends it keeps receipts of: channel-send.ts.

export const CHANNELS_DELIVERY: MethodCapabilityDefinition = {
  capability: { id: 'channels.delivery', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'delivery', word: 'delivery', label: 'See how outbound messages are delivered', ...READ, inputs: [],
  sentence: 'Shows, for each chat channel, how many messages the daemon sent, delivered, failed or gave up on.', example: {},
  method: { id: 'deliveries.list', fields: {} },
  said: (answer) => {
    const totals = isRecord(answer['totals']) ? answer['totals'] : {};
    const by = new Map<string, { sent: number; failed: number }>();
    for (const attempt of listOf(answer, 'attempts')) {
      const target = isRecord(attempt['target']) ? attempt['target'] : {};
      const key = word(target['surfaceKind']) || word(target['kind']) || 'other';
      const row = by.get(key) ?? { sent: 0, failed: 0 };
      if (word(attempt['status']) === 'failed' || word(attempt['status']) === 'dead_letter') row.failed += 1; else row.sent += 1;
      by.set(key, row);
    }
    return [
      `In all: ${word(totals['succeeded']) || '0'} delivered, ${word(totals['failed']) || '0'} failed, ${word(totals['deadLettered']) || '0'} given up, ${word(totals['queued']) || '0'} waiting.`,
      ...[...by].map(([kind, row]) => `  ${kind}: ${row.sent} sent, ${row.failed} failed`),
    ].join('\n');
  },
};

function bindingLine(binding: Readonly<Record<string, unknown>>): string {
  const title = word(binding['title']) || word(binding['externalId']) || word(binding['id']);
  return `  ${word(binding['surfaceKind'])}: ${title}${binding['sessionId'] ? ` (conversation ${word(binding['sessionId'])})` : ''}`;
}

export const CHANNELS_ROUTES: MethodCapabilityDefinition = {
  capability: { id: 'channels.routes', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'routes', word: 'routes', label: 'See the active channel routes', ...READ, inputs: [],
  sentence: 'Lists each chat or thread a channel is routed to, and the conversation behind it.', example: {},
  method: { id: 'routes.bindings.list', fields: {} },
  said: (answer) => {
    const bindings = listOf(answer, 'bindings');
    return bindings.length === 0 ? 'No chat is routed to a conversation yet.' : [`${bindings.length} route${bindings.length === 1 ? '' : 's'}:`, ...bindings.map(bindingLine)].join('\n');
  },
};

export const CHANNELS_OVERVIEW: MethodCapabilityDefinition = {
  capability: { id: 'channels.overview', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'overview', word: 'overview', label: 'See what the channels carry', ...READ, inputs: [],
  sentence: 'Shows how many chats the channels route, how many were active lately, and each route.', example: {},
  method: { id: 'routes.snapshot', fields: {} },
  said: (answer) => {
    const bindings = listOf(answer, 'bindings');
    return [`${word(answer['totalBindings']) || '0'} routes, ${word(answer['activeBindings']) || '0'} active, ${word(answer['recentBindings']) || '0'} used lately.`,
      ...bindings.slice(0, 20).map(bindingLine)].join('\n');
  },
};

export const CHANNELS_TRIAGE: MethodCapabilityDefinition = {
  capability: { id: 'channels.triage', group: 'messages', home: 'daemon', repeat: 'safe' },
  actionId: 'triage', word: 'triage', label: 'See what came in on your channels', ...READ, inputs: [],
  sentence: 'Lists the newest messages that came in on your chat channels (Slack, Telegram, Discord, ...), who wrote and where.', example: {},
  method: { id: 'control.messages.list', fields: {} },
  said: (answer) => {
    const messages = listOf(answer, 'messages');
    if (messages.length === 0) return 'Nothing came in on a channel yet.';
    return [`${messages.length} message${messages.length === 1 ? '' : 's'}, newest last (as each sender says):`,
      ...messages.slice(-20).map((message) => `  ${when(message['createdAt'] ?? message['receivedAt'])} ${word(message['surface']) || word(message['surfaceKind'])} ${word(message['author']) || word(message['from']) || word(message['userId'])}: ${(word(message['text']) || word(message['body'])).slice(0, 120)}`)].join('\n');
  },
};

/** The channels' reads that run through the daemon's own methods. */
export const CHANNEL_READ_CAPABILITIES: readonly MethodCapabilityDefinition[] = [
  CHANNELS_READINESS, CHANNELS_CONFIGURED, CHANNELS_GUIDE, CHANNELS_DELIVERY, CHANNELS_ROUTES, CHANNELS_OVERVIEW, CHANNELS_TRIAGE,
];
