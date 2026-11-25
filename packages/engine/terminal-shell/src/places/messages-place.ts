/**
 * messages-place.ts, the Mail, calendar and channels place: the daemon's one
 * mailbox, one calendar and one set of channels.
 *
 * Every list is read from the daemon and follows its changes: the inbox the
 * `mail` list (a message sent, a draft kept, the inbox mirror's labels), the
 * calendar the `calendar` list (an event added, changed or removed from here,
 * the web UI, a script or a scheduled run), the channels the `surfaces` domain
 * (a channel switched on or off, an account connected or degraded). Every
 * action is a capability of the group (platform capabilities/builtin/messages.ts),
 * on the item it acts on and only in the states where it applies: a test
 * message for a channel that works, the checks for one that does not.
 */
// The words' own module (channel-words.ts re-exports it): the web UI draws this declaration too (places/browser.ts).
import { CHANNEL_STATE_WORDS, channelReasonOf, channelStateOf, type ChannelState } from '@goodvibes/engine/platform/platform/channels/channel-state';
import { definePlace, type PlaceItem } from './place-types.js';

/** Text a stranger wrote (a sender, a subject, an event's notes) is shown, never obeyed by the terminal. */
const plain = (value: string): string => value.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f؜‎‏‪-‮⁦-⁩]/g, ' ');
const text = (value: unknown): string => typeof value === 'string' ? plain(value) : '';
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const records = (output: unknown, key: string): readonly Readonly<Record<string, unknown>>[] => {
  const list = isRecord(output) ? output[key] : undefined;
  return Array.isArray(list) ? list.filter(isRecord) : [];
};

interface MessageItem extends PlaceItem {
  readonly kind: 'message';
  readonly state: 'unread' | 'read';
  readonly from: string;
  readonly subject: string;
  readonly date: string;
  readonly preview: string;
  readonly label?: string | undefined;
  readonly notScreened?: string | undefined;
}

interface EventItem extends PlaceItem {
  readonly kind: 'event';
  readonly state: 'event';
  readonly title: string;
  readonly start: string;
  readonly end: string;
  readonly allDay: boolean;
  readonly location: string;
  readonly notes: string;
  readonly guests: readonly string[];
}

interface ChannelItem extends PlaceItem {
  readonly kind: 'channel';
  readonly state: ChannelState;
  readonly label: string;
  readonly reason?: string | undefined;
}

type Item = MessageItem | EventItem | ChannelItem;

function messages(output: unknown): readonly MessageItem[] {
  return records(output, 'messages').flatMap((message): MessageItem[] => {
    const uid = message['uid'];
    if (typeof uid !== 'number' || !Number.isFinite(uid)) return [];
    const label = text(message['triageLabel']);
    return [{
      id: String(uid), kind: 'message', state: message['unread'] === true ? 'unread' : 'read',
      from: text(message['from']) || 'an unknown sender', subject: text(message['subject']) || '(no subject)',
      date: text(message['date']), preview: text(message['bodyPreview']).replace(/\s+/g, ' ').trim(),
      ...(label === 'spam' || label === 'priority' ? { label } : {}),
      ...(message['screening'] === 'not-screened' ? { notScreened: text(message['screeningReason']) || 'checked by code only' } : {}),
    }];
  });
}

function events(output: unknown): readonly EventItem[] {
  return records(output, 'events').flatMap((event): EventItem[] => {
    const id = text(event['id']);
    if (!id) return [];
    return [{
      id, kind: 'event', state: 'event',
      title: text(event['title']) || 'Untitled event', start: text(event['start']), end: text(event['end']),
      allDay: event['allDay'] === true, location: text(event['location']), notes: text(event['description']),
      guests: Array.isArray(event['attendees']) ? event['attendees'].filter((entry): entry is string => typeof entry === 'string').map(plain) : [],
    }];
  });
}

function channels(output: unknown): readonly ChannelItem[] {
  return records(output, 'channels').flatMap((channel): ChannelItem[] => {
    const surface = text(channel['surface']);
    if (!surface) return [];
    const reason = channelReasonOf(channel);
    return [{ id: surface, kind: 'channel', state: channelStateOf(channel), label: text(channel['label']) || surface, ...(reason ? { reason } : {}) }];
  });
}

/** An event's time as a person reads it: the date and the time of day, no zone suffix when it is local. */
function when(value: string, allDay: boolean): string {
  if (!value) return 'not said';
  if (allDay || !value.includes('T')) return value.slice(0, 10);
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value.replace('T', ' ');
  return at.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

const MAIL_FOLLOWS = { domains: [], events: [], lists: ['mail'] } as const;
const CALENDAR_FOLLOWS = { domains: [], events: [], lists: ['calendar'] } as const;
const CHANNEL_FOLLOWS = { domains: ['surfaces'], events: [] } as const;

const CHANNEL_MARK: Readonly<Record<ChannelState, 'ok' | 'paused' | 'attention' | 'running' | 'waiting'>> = {
  working: 'ok', 'needs-attention': 'attention', 'not-working': 'attention', 'not-set-up': 'paused', off: 'paused', unknown: 'waiting',
};

/** The channel states whose checks are worth running; those the menu counts as wrong; those of a channel set up. */
const TROUBLED: readonly ChannelState[] = ['needs-attention', 'not-working', 'unknown'];
const WRONG: readonly ChannelState[] = ['needs-attention', 'not-working'];
const SET_UP: readonly ChannelState[] = ['working', 'needs-attention', 'not-working', 'unknown', 'off'];

export const MESSAGES_PLACE = definePlace<Item>({
  id: 'messages',
  group: 'messages',
  title: 'Mail, calendar and channels',
  lists: [
    {
      id: 'inbox',
      label: 'Inbox',
      noun: 'your inbox',
      source: { kind: 'daemon', method: 'email.inbox.list', input: { limit: 30 }, items: messages },
      follows: MAIL_FOLLOWS,
      empty: 'The inbox is empty.',
      row: (item) => {
        const message = item as MessageItem;
        // The subject is the row; the sender, as the message claims it, is the first line of the detail.
        return {
          title: message.subject,
          ...(message.label === 'spam' ? { right: 'spam' } : message.label === 'priority' ? { right: 'priority' } : message.state === 'unread' ? { right: 'unread' } : {}),
          ...(message.label === 'spam' ? { mark: 'attention' as const } : {}),
        };
      },
      detail: (item) => {
        const message = item as MessageItem;
        return [
          // The sender line is what the message's header claims; email carries no authority to direct anything.
          { label: 'From', text: `${message.from} (as the message says)` },
          { label: 'Subject', text: message.subject },
          ...(message.date ? [{ label: 'Date', text: message.date }] : []),
          ...(message.notScreened ? [{ label: 'Not screened', text: message.notScreened, tone: 'warning' as const }] : []),
          { text: '' },
          { text: message.preview || 'No preview; open it to read the message.', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'calendar',
      label: 'Calendar',
      noun: 'your calendar',
      source: { kind: 'daemon', method: 'calendar.events.list', input: {}, items: events },
      follows: CALENDAR_FOLLOWS,
      empty: 'Nothing on the calendar in the next 30 days.',
      row: (item) => {
        const event = item as EventItem;
        return { title: event.title, right: when(event.start, event.allDay), mark: 'ok' };
      },
      detail: (item) => {
        const event = item as EventItem;
        return [
          { label: 'Starts', text: when(event.start, event.allDay) },
          ...(event.end ? [{ label: 'Ends', text: when(event.end, event.allDay) }] : []),
          ...(event.location ? [{ label: 'Where', text: event.location }] : []),
          ...(event.guests.length > 0 ? [{ label: 'Guests', text: event.guests.join(', ') }] : []),
          ...(event.notes ? [{ text: '' }, { text: event.notes, tone: 'muted' as const }] : []),
        ];
      },
    },
    {
      id: 'channels',
      label: 'Channels',
      noun: 'your channels',
      source: { kind: 'daemon', method: 'channels.status', input: {}, items: channels },
      follows: CHANNEL_FOLLOWS,
      empty: 'The daemon reports no channels.',
      row: (item) => {
        const channel = item as ChannelItem;
        return { title: channel.label, right: CHANNEL_STATE_WORDS[channel.state], mark: CHANNEL_MARK[channel.state] };
      },
      detail: (item) => {
        const channel = item as ChannelItem;
        return [
          { label: 'State', text: CHANNEL_STATE_WORDS[channel.state] },
          // Why, under every state that is not "working": the daemon's own words.
          ...(channel.reason ? [{ label: 'Why', text: channel.reason, tone: channel.state === 'not-set-up' || channel.state === 'off' ? 'muted' as const : 'warning' as const }] : []),
        ];
      },
    },
  ],
  actions: [
    // The inbox: a message is opened, answered by a new message; drafts and the mailbox's own settings.
    { key: 'enter', list: 'inbox', capability: 'mail.read', label: 'read', fill: { message: 'id' } },
    { key: 'n', list: 'inbox', capability: 'mail.send', label: 'new message' },
    { key: 'd', list: 'inbox', capability: 'mail.draft', label: 'save a draft' },
    { key: 'm', list: 'inbox', capability: 'mail.settings', label: 'mailbox settings' },
    { key: 'e', list: 'inbox', capability: 'mail.set', label: 'change a setting' },
    { key: 'p', list: 'inbox', capability: 'mail.password', label: 'store the password' },
    { key: 'c', list: 'inbox', capability: 'mail.status', label: 'is it connected' },
    // The inbox list itself is mail.list (the newest 30); `l` reads a longer page.
    { key: 'l', list: 'inbox', capability: 'mail.list', label: 'more messages' },
    // The calendar: an event is opened, changed or removed; a new one is added.
    { key: 'enter', list: 'calendar', capability: 'calendar.get', label: 'open', fill: { event: 'id' } },
    { key: 'n', list: 'calendar', capability: 'calendar.add', label: 'new event' },
    { key: 'c', list: 'calendar', capability: 'calendar.change', label: 'change', fill: { event: 'id' } },
    { key: 'x', list: 'calendar', capability: 'calendar.delete', label: 'remove', fill: { event: 'id' } },
    // A channel: what it needs, a test message when it is set up, the checks when it is not working.
    { key: 'enter', list: 'channels', capability: 'channels.setup', label: 'what it needs', fill: { channel: 'id' } },
    { key: 't', list: 'channels', states: ['working'], capability: 'channels.test', label: 'send a test', fill: { channel: 'id' } },
    { key: 'k', list: 'channels', states: TROUBLED, capability: 'channels.doctor', label: 'check it', fill: { channel: 'id' } },
    { key: 'w', list: 'channels', states: SET_UP, capability: 'channels.rules', label: 'who may write', fill: { channel: 'id' } },
    { key: 'e', list: 'channels', states: SET_UP, capability: 'channels.set-rules', label: 'change who may write', fill: { channel: 'id' } },
    { key: 'p', list: 'channels', states: SET_UP, capability: 'channels.profile', label: 'what its sessions get', fill: { channel: 'id' } },
    { key: 'g', list: 'channels', states: SET_UP, capability: 'channels.set-profile', label: 'give it a model or mode', fill: { channel: 'id' } },
    { key: 'u', list: 'channels', states: SET_UP, capability: 'channels.remove-profile', label: 'use the defaults', fill: { channel: 'id' } },
    { key: 'a', list: 'channels', capability: 'channels.accounts', label: 'accounts' },
    { key: 'o', id: 'every-profile', list: 'channels', capability: 'channels.profiles', label: 'every channel\'s profile' },
    // The calendar list itself is calendar.upcoming's window (the next 30 days); `w` reads the days you name.
    { key: 'w', list: 'calendar', capability: 'calendar.upcoming', label: 'the days ahead' },
    // A channel not set up or switched off: the program's own form for connecting chat apps (/setup's chat-apps topic).
    { key: 's', list: 'channels', states: ['not-set-up', 'off'], capability: 'setup.chat-apps', label: 'set it up' },
  ],
  count: (lists) => {
    // A channel whose state nothing here can confirm (the web control plane) is not counted as wrong.
    const troubled = (lists.channels ?? []).filter((item) => WRONG.includes((item as ChannelItem).state)).length;
    if (troubled > 0) return { count: troubled, words: `${troubled} channel${troubled === 1 ? ' needs' : 's need'} a look`, tone: 'wrong' };
    const unread = (lists.inbox ?? []).filter((item) => item.state === 'unread').length;
    return unread > 0 ? { count: unread, words: `${unread} unread`, tone: 'waiting' } : undefined;
  },
});
