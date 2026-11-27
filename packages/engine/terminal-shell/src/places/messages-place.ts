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
import { OWN_MESSAGES_CHANNELS } from '@goodvibes/engine/platform/platform/channels/own-messages-proof';

/** The channels whose own keys are entered on their row ("enter its keys": the daemon's channels.connect). */
const KEYED_CHANNELS: readonly string[] = ['slack', 'discord', 'ntfy', 'webhook', 'homeassistant', 'telegram', 'google-chat', 'signal',
  'whatsapp', 'telephony', 'imessage', 'msteams', 'bluebubbles', 'mattermost', 'matrix'];
import { definePlace, type PlaceAction, type PlaceItem, type PlaceList } from './place-types.js';
// The Google tab: the daemon's one Gmail and Google Calendar connection and the steps of connecting it (its own item kinds).
import { MESSAGES_GOOGLE_ACTIONS, MESSAGES_GOOGLE_LISTS } from './messages-google-entries.js';

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
  /** `feed`: an event of a feed subscribed to, read-only here. */
  readonly state: 'event' | 'feed';
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
  /** The project its conversations work in, `none` when none is chosen ("Project for this channel" opens on it). */
  readonly project: string;
}

/** A webhook address notifications go to, by its number in the daemon's one list (only its site is shown). */
interface AddressItem extends PlaceItem {
  readonly kind: 'address';
  readonly state: 'set' | 'unreadable';
  readonly shown: string;
}

/** A notification the daemon could not deliver (a webhook, Slack or Discord). */
interface FailedItem extends PlaceItem {
  readonly kind: 'failed';
  readonly state: 'failed';
  readonly channel: string;
  readonly summary: string;
  readonly error: string;
  readonly at: string;
  readonly attempts: number;
}

/** A thing never set up (the mailbox): one item saying so, its setup action the control on it. */
interface NotSetUpItem extends PlaceItem {
  readonly kind: 'not-set-up';
  /** `mailbox`: no server and user name; `password`: those are set, the password is not stored. */
  readonly state: 'needs-mailbox' | 'needs-password';
  readonly title: string;
  readonly said: string;
  /** What is set already (`needs-password`): setting mail up then asks only for the password. */
  readonly server: string;
  readonly user: string;
}

/** A calendar account the daemon signs in to (Google, Outlook), whether or not it is signed in. */
interface AccountItem extends PlaceItem {
  readonly kind: 'account';
  /** connected, refresh-due, reconnect-needed, disconnected, unreadable (calendar/oauth-types.ts ConnectionState). */
  readonly state: string;
  readonly name: string;
  readonly account?: string | undefined;
  readonly lastTry?: string | undefined;
  /** Google signed in here for the calendar alone (its grant names no mail). */
  readonly calendarOnly?: true | undefined;
}

/** A calendar feed subscribed to. */
interface FeedItem extends PlaceItem {
  readonly kind: 'feed';
  /** ok, stale, unreachable, parse-error, never-fetched (calendar/types.ts SubscriptionHealth). */
  readonly state: string;
  readonly events: number;
  readonly site: string;
  readonly every: number;
  readonly detail?: string | undefined;
}

type Item = MessageItem | EventItem | ChannelItem | AddressItem | FailedItem | NotSetUpItem | AccountItem | FeedItem;

const ACCOUNT_WORDS: Readonly<Record<string, string>> = {
  connected: 'signed in', 'refresh-due': 'signed in', 'reconnect-needed': 'sign in again', disconnected: 'not signed in', unreadable: 'could not be read',
};
const FEED_WORDS: Readonly<Record<string, string>> = {
  ok: 'read', stale: 'not read lately', unreachable: 'not reached', 'parse-error': 'not a calendar', 'never-fetched': 'not read yet',
};

function accounts(output: unknown): readonly AccountItem[] {
  const data = isRecord(output) ? output['data'] : undefined;
  return records(data, 'accounts').flatMap((row): AccountItem[] => {
    const id = text(row['provider']);
    if (!id) return [];
    const state = text(row['state']) || 'disconnected';
    // An account never signed in is a line saying it can be, not counted in the tab's number.
    return [{ id, kind: 'account', state, name: text(row['name']) || id, ...(state === 'disconnected' ? { uncounted: true as const } : {}),
      ...(text(row['account']) ? { account: text(row['account']) } : {}), ...(text(row['lastTry']) ? { lastTry: text(row['lastTry']) } : {}),
      ...(row['calendarOnly'] === true ? { calendarOnly: true as const } : {}) }];
  });
}

function feeds(output: unknown): readonly FeedItem[] {
  const data = isRecord(output) ? output['data'] : undefined;
  return records(data, 'feeds').flatMap((row): FeedItem[] => {
    const id = text(row['name']);
    if (!id) return [];
    return [{ id, kind: 'feed', state: text(row['health']) || 'never-fetched', events: typeof row['eventCount'] === 'number' ? row['eventCount'] : 0,
      site: text(row['site']), every: typeof row['everyMinutes'] === 'number' ? row['everyMinutes'] : 60, ...(text(row['detail']) ? { detail: text(row['detail']) } : {}) }];
  });
}

/** The inbox as `mail.list` answers it: its messages, or the one item saying mail is not set up. */
function inbox(output: unknown): readonly (MessageItem | NotSetUpItem)[] {
  const data = isRecord(output) ? output['data'] : undefined;
  if (isRecord(data) && data['setUp'] === false) {
    const password = data['missing'] === 'password';
    return [{
      id: 'mail-not-set-up', kind: 'not-set-up', state: password ? 'needs-password' : 'needs-mailbox', title: 'Mail is not set up', uncounted: true,
      said: password ? 'The mail server and user name are set; the password is not stored yet.' : 'No mail server and user name are set yet.',
      server: password ? text(data['server']) : '', user: password ? text(data['user']) : '',
    }];
  }
  return messages(data);
}

function addresses(output: unknown): readonly AddressItem[] {
  const data = isRecord(output) ? output['data'] : undefined;
  return records(data, 'addresses').flatMap((entry): AddressItem[] => {
    const number = entry['number'];
    if (typeof number !== 'number') return [];
    return [{ id: String(number), kind: 'address', state: entry['readable'] === false ? 'unreadable' : 'set', shown: text(entry['shown']) || 'an address' }];
  });
}

function failedNotifications(output: unknown): readonly FailedItem[] {
  return records(output, 'entries').flatMap((entry): FailedItem[] => {
    const id = text(entry['id']);
    if (!id) return [];
    const deadAt = entry['deadAt'];
    return [{
      id, kind: 'failed', state: 'failed', channel: text(entry['channel']) || 'a channel',
      summary: (text(entry['summary']).split('\n').map((line) => line.trim()).filter(Boolean).join(': ')) || text(entry['event']) || 'a notification',
      error: text(entry['finalError']) + (typeof entry['status'] === 'number' ? ` (HTTP ${entry['status']})` : ''),
      at: typeof deadAt === 'number' ? new Date(deadAt).toLocaleString() : '',
      attempts: typeof entry['attempts'] === 'number' ? entry['attempts'] : 0,
    }];
  });
}

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
  // Every occurrence of a repeating event carries its series (`seriesId`, every calendar backend): the tab counts the
  // event once, at its first occurrence. An answer without it (an older daemon): the `<event>@<start>` id's series.
  const seen = new Set<string>();
  return records(output, 'events').flatMap((event): EventItem[] => {
    const id = text(event['id']);
    if (!id) return [];
    const at = id.lastIndexOf('@');
    const series = text(event['seriesId']) || (at > 0 ? id.slice(0, at) : id);
    const again = seen.has(series);
    seen.add(series);
    return [{
      id, kind: 'event', state: id.startsWith('feed:') ? 'feed' : 'event', ...(again ? { uncounted: true as const } : {}),
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
    const state = channelStateOf(channel);
    // Its project (the daemon puts it in the channel's metadata), or `none` (the channels.projects row "None").
    const metadata = channel['metadata'];
    const project = (metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? text((metadata as Readonly<Record<string, unknown>>)['project']) : '') || 'none';
    // A channel never set up is a line saying so, not counted in the tab's number.
    return [{ id: surface, kind: 'channel', state, label: text(channel['label']) || surface, ...(reason ? { reason } : {}), project, ...(state === 'not-set-up' ? { uncounted: true as const } : {}) }];
  });
}

/** An event's time as a person reads it: the date and the time of day, no zone suffix when it is local. */
function when(value: string, allDay: boolean): string {
  if (!value) return 'not said';
  if (allDay || !value.includes('T')) return value.slice(0, 10);
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value.replace('T', ' ');
  return at.toLocaleString(undefined, { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** The same, short enough for a row beside the title: "Nov 26 09:30", "Nov 26" for a whole day. */
function whenShort(value: string, allDay: boolean): string {
  if (!value) return '';
  const at = new Date(allDay || !value.includes('T') ? `${value.slice(0, 10)}T00:00:00` : value);
  if (Number.isNaN(at.getTime())) return value.slice(0, 10);
  const day = at.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return allDay || !value.includes('T') ? day : `${day} ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}`;
}

const MAIL_FOLLOWS = { domains: [], events: [], lists: ['mail'] } as const;
const CALENDAR_FOLLOWS = { domains: [], events: [], lists: ['calendar'] } as const;
const CHANNEL_FOLLOWS = { domains: ['surfaces'], events: [] } as const;
const NOTIFY_FOLLOWS = { domains: [], events: [], lists: ['notifications'] } as const;

const CHANNEL_MARK: Readonly<Record<ChannelState, 'ok' | 'paused' | 'attention' | 'running' | 'waiting'>> = {
  working: 'ok', 'needs-attention': 'attention', 'not-working': 'attention', 'not-set-up': 'paused', off: 'paused', unknown: 'waiting',
};

/** The channel states whose checks are worth running; those the menu counts as wrong; those of a channel set up. */
const TROUBLED: readonly ChannelState[] = ['needs-attention', 'not-working', 'unknown'];
const WRONG: readonly ChannelState[] = ['needs-attention', 'not-working'];
const SET_UP: readonly ChannelState[] = ['working', 'needs-attention', 'not-working', 'unknown', 'off'];
/** The states of a message in the inbox (not the one item of a mailbox never set up). */
const MESSAGE_STATES = ['unread', 'read'] as const;

export const MESSAGES_PLACE = definePlace<Item>({
  id: 'messages',
  group: 'messages',
  title: 'Mail, calendar and channels',
  lists: [
    {
      id: 'inbox',
      label: 'Inbox',
      noun: 'your inbox',
      // mail.list (capabilities/builtin/messages.ts) over the daemon's inbox: a mailbox never set up is one item saying so.
      source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'mail.list', inputs: { count: '30' } }, items: inbox },
      follows: MAIL_FOLLOWS,
      empty: 'The inbox is empty.',
      row: (item) => {
        // Its title says it is not set up; the row repeats nothing beside it.
        if (item.kind === 'not-set-up') return { title: (item as NotSetUpItem).title, mark: 'paused' };
        const message = item as MessageItem;
        // The subject is the row; the sender, as the message claims it, is the first line of the detail.
        return {
          title: message.subject,
          ...(message.label === 'spam' ? { right: 'spam' } : message.label === 'priority' ? { right: 'priority' } : message.state === 'unread' ? { right: 'unread' } : {}),
          ...(message.label === 'spam' ? { mark: 'attention' as const } : {}),
        };
      },
      detail: (item) => {
        if (item.kind === 'not-set-up') return [{ text: (item as NotSetUpItem).said }];
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
        return { title: event.title, right: whenShort(event.start, event.allDay), mark: 'ok' };
      },
      detail: (item) => {
        const event = item as EventItem;
        return [
          { label: 'Starts', text: when(event.start, event.allDay) },
          ...(event.end && event.end !== event.start ? [{ label: 'Ends', text: when(event.end, event.allDay) }] : []),
          ...(event.location ? [{ label: 'Where', text: event.location }] : []),
          ...(event.guests.length > 0 ? [{ label: 'Guests', text: event.guests.join(', ') }] : []),
          ...(event.notes ? [{ text: '' }, { text: event.notes, tone: 'muted' as const }] : []),
        ];
      },
    },
    {
      id: 'calendar-accounts',
      label: 'Calendar accounts',
      noun: 'your calendar accounts',
      // The Google and Outlook accounts the daemon signs in to (capabilities/builtin/calendar.ts calendar.accounts).
      source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'calendar.accounts' }, items: accounts },
      follows: CALENDAR_FOLLOWS,
      empty: 'No calendar account can be signed in to here.',
      row: (item) => {
        const account = item as AccountItem;
        return { title: account.account ? `${account.name}: ${account.account}` : account.name, right: ACCOUNT_WORDS[account.state] ?? account.state,
          mark: account.state === 'connected' || account.state === 'refresh-due' ? 'ok' : account.state === 'disconnected' ? 'paused' : 'attention' };
      },
      detail: (item) => {
        const account = item as AccountItem;
        return [
          ...(account.account ? [{ label: 'Account', text: account.account }] : []),
          { label: 'State', text: ACCOUNT_WORDS[account.state] ?? account.state },
          ...(account.lastTry ? [{ label: 'Last try', text: account.lastTry, tone: 'warning' as const }] : []),
          // Google is one connection for mail and calendar: the Google tab's.
          ...(account.id === 'google' ? [{ text: account.state === 'disconnected'
            ? 'Connecting Google on the Google tab signs the calendar in too, with one consent for mail and calendar. Signing in here asks for the calendar alone.'
            : account.calendarOnly
              ? 'Signed in for the calendar alone: this grant does not include mail. "ask for consent again" on the Google tab asks for mail and calendar together.'
              : 'This is the Google connection of the Google tab: mail and calendar share it.', tone: 'muted' as const }] : []),
          { text: 'Its events show on the Calendar tab beside the ones kept on this computer.', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'calendar-feeds',
      label: 'Calendar feeds',
      noun: 'the calendar feeds you subscribe to',
      source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'calendar.subscriptions' }, items: feeds },
      follows: CALENDAR_FOLLOWS,
      empty: 'No calendar feed is subscribed to.',
      row: (item) => {
        const feed = item as FeedItem;
        return { title: feed.id, right: FEED_WORDS[feed.state] ?? feed.state, mark: feed.state === 'ok' ? 'ok' : feed.state === 'never-fetched' ? 'waiting' : 'attention' };
      },
      detail: (item) => {
        const feed = item as FeedItem;
        return [
          { label: 'Site', text: feed.site || 'its address is in the secret store' },
          { label: 'Events', text: String(feed.events) },
          { label: 'Read', text: `every ${feed.every} minutes, when the calendar is read` },
          ...(feed.detail ? [{ label: 'Why', text: feed.detail, tone: feed.state === 'ok' ? 'muted' as const : 'warning' as const }] : []),
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
    {
      id: 'notifications',
      label: 'Notifications',
      noun: 'where notifications go',
      // The daemon's one list of webhook addresses (capabilities/builtin/notify.ts notify.list), only each site shown.
      source: { kind: 'daemon', method: 'capabilities.run', input: { id: 'notify.list' }, items: addresses },
      follows: NOTIFY_FOLLOWS,
      empty: 'No webhook address is set: notifications go nowhere yet.',
      row: (item) => {
        const address = item as AddressItem;
        return { title: `${address.id}. ${address.shown}`, ...(address.state === 'unreadable' ? { right: 'could not be read', mark: 'attention' as const } : { mark: 'ok' as const }) };
      },
      detail: (item) => {
        const address = item as AddressItem;
        return [
          { label: 'Address', text: address.shown },
          { text: address.state === 'unreadable'
            ? 'Its stored address could not be read from the secret store; nothing is sent to it until it can be.'
            : 'The address carries its key, so only its site is shown. Notifications of turns that end, approvals waiting and budget alerts go here.', tone: 'muted' as const },
        ];
      },
    },
    {
      id: 'failed-notifications',
      label: 'Failed notifications',
      noun: 'the notifications that failed',
      source: { kind: 'daemon', method: 'notifications.deadLetters.list', input: {}, items: failedNotifications },
      follows: NOTIFY_FOLLOWS,
      empty: 'No notification failed.',
      row: (item) => {
        const failed = item as FailedItem;
        return { title: failed.summary, right: failed.channel, mark: 'attention' };
      },
      detail: (item) => {
        const failed = item as FailedItem;
        return [
          { label: 'Channel', text: failed.channel },
          ...(failed.at ? [{ label: 'Failed', text: failed.at }] : []),
          { label: 'Attempts', text: String(failed.attempts) },
          { label: 'Why', text: failed.error || 'not said', tone: 'warning' as const },
        ];
      },
    },
    // Google (messages-google-entries.ts): the one connection, and the steps of connecting it as they go.
    ...(MESSAGES_GOOGLE_LISTS as unknown as readonly PlaceList<Item>[]),
  ],
  actions: [
    // Google (messages-google-entries.ts): connect, check, ask for consent again, disconnect, the other routes.
    ...(MESSAGES_GOOGLE_ACTIONS as unknown as readonly PlaceAction<Item>[]),
    // The inbox: a message is opened, answered by a new message; drafts and the mailbox's own settings.
    { key: 'enter', list: 'inbox', states: MESSAGE_STATES, capability: 'mail.read', label: 'read', fill: { message: 'id' } },
    // Mail not set up: Enter is its one set-up form (server, user name and password together, the mailbox checked once);
    // with the server and user name set already, it asks only for the password.
    { key: 'enter', id: 'set-up-mailbox', list: 'inbox', states: ['needs-mailbox'], capability: 'mail.setup', label: 'set up mail' },
    { key: 'enter', id: 'set-up-password', list: 'inbox', states: ['needs-password'], capability: 'mail.setup', label: 'set up mail', fill: { server: 'server', user: 'user' } },
    // A new message and a draft act on the inbox, not on the message selected: there even when it is empty.
    // An empty inbox names writing a message first.
    { key: 'n', list: 'inbox', whole: true, capability: 'mail.send', label: 'new message', firstOnEmpty: true },
    { key: 'd', list: 'inbox', whole: true, capability: 'mail.draft', label: 'save a draft' },
    { key: 'm', list: 'inbox', capability: 'mail.settings', label: 'mailbox settings' },
    { key: 'e', list: 'inbox', capability: 'mail.set', label: 'change a setting' },
    { key: 'p', list: 'inbox', states: ['unread', 'read', 'needs-mailbox'], capability: 'mail.password', label: 'store the password' },
    { key: 'c', list: 'inbox', whole: true, capability: 'mail.status', label: 'is it connected' },
    // The inbox list itself is mail.list (the newest 30); `l` reads a longer page.
    { key: 'l', list: 'inbox', whole: true, capability: 'mail.list', label: 'more messages' },
    // The calendar: an event is opened, changed or removed; a new one is added.
    { key: 'enter', list: 'calendar', capability: 'calendar.get', label: 'open', fill: { event: 'id' } },
    { key: 'n', list: 'calendar', whole: true, capability: 'calendar.add', label: 'new event' },
    { key: 'c', list: 'calendar', states: ['event'], capability: 'calendar.change', label: 'change', fill: { event: 'id' } },
    { key: 'x', list: 'calendar', states: ['event'], capability: 'calendar.delete', label: 'remove', fill: { event: 'id' } },
    // A channel: what it needs, a test message when it is set up, the checks when it is not working.
    { key: 'enter', list: 'channels', capability: 'channels.setup', label: 'what it needs', fill: { channel: 'id' } },
    // A channel not set up or switched off: the program's own form for connecting chat apps (/setup's chat-apps
    // topic), declared next so it is the second key shown beside it.
    { key: 's', list: 'channels', states: ['not-set-up', 'off'], capability: 'setup.chat-apps', label: 'set it up' },
    // A chat channel's own keys, in its form on its row (secrets masked there), stored in the daemon and switched on
    // once everything it needs is set; "Pair something, A chat channel" in Devices and network opens this row.
    { key: 'l', id: 'enter-keys', list: 'channels', offeredWhen: { field: 'id', isOneOf: KEYED_CHANNELS }, capability: 'channels.connect', label: 'enter its keys', fill: { channel: 'id' }, form: true },
    { key: 't', list: 'channels', states: ['working'], capability: 'channels.test', label: 'send a test', fill: { channel: 'id' } },
    { key: 'k', list: 'channels', states: TROUBLED, capability: 'channels.doctor', label: 'check it', fill: { channel: 'id' } },
    { key: 'w', list: 'channels', states: SET_UP, capability: 'channels.rules', label: 'who may write', fill: { channel: 'id' } },
    { key: 'e', list: 'channels', states: SET_UP, capability: 'channels.set-rules', label: 'change who may write', fill: { channel: 'id' } },
    // Off by default: a message here is someone else's input, also from your own account (security/turn-input-party.ts).
    // Offered only on a channel whose kind proves its sender and a one-to-one conversation (own-messages-proof.ts).
    { key: 'm', list: 'channels', states: SET_UP, offeredWhen: { field: 'id', isOneOf: OWN_MESSAGES_CHANNELS }, capability: 'channels.own-messages', label: 'treat my own messages here as me', fill: { channel: 'id' } },
    // Where a conversation here may change things: a registered project, or none (then it writes no file and runs no
    // command; channels/channel-project.ts).
    // Always its form: choosing the project is the whole point (its default, none, would otherwise run at once).
    { key: 'j', list: 'channels', states: SET_UP, capability: 'channels.project', label: 'project for this channel', fill: { channel: 'id' }, startWith: { project: 'project' }, form: true },
    { key: 'p', list: 'channels', states: SET_UP, capability: 'channels.profile', label: 'what its sessions get', fill: { channel: 'id' } },
    { key: 'g', list: 'channels', states: SET_UP, capability: 'channels.set-profile', label: 'give it a model or mode', fill: { channel: 'id' } },
    { key: 'u', list: 'channels', states: SET_UP, capability: 'channels.remove-profile', label: 'use the defaults', fill: { channel: 'id' } },
    { key: 'a', list: 'channels', capability: 'channels.accounts', label: 'accounts' },
    { key: 'o', id: 'every-profile', list: 'channels', capability: 'channels.profiles', label: 'every channel\'s profile' },
    // The calendar list itself is calendar.upcoming's window (the next 30 days); `w` reads the days you name.
    { key: 'w', list: 'calendar', capability: 'calendar.upcoming', label: 'the days ahead' },
    // The calendar as a whole: what it reads, every event kept here, a file in and out (capabilities/builtin/calendar.ts).
    { key: 's', id: 'calendar-connected', list: 'calendar', whole: true, capability: 'calendar.status', label: 'what it reads' },
    { key: 'a', id: 'every-event', list: 'calendar', whole: true, capability: 'calendar.all', label: 'every event' },
    { key: 'i', id: 'import-events', list: 'calendar', whole: true, capability: 'calendar.import', label: 'import a file' },
    { key: 'e', id: 'export-events', list: 'calendar', whole: true, capability: 'calendar.export', label: 'export to a file', form: true },
    // A calendar account: signed in from a browser, a code on another device, or the address the browser landed on.
    { key: 'enter', id: 'sign-in', list: 'calendar-accounts', states: ['disconnected', 'reconnect-needed'], capability: 'calendar.connect', label: 'sign in', fill: { provider: 'id' }, form: true },
    { key: 'o', id: 'sign-out', list: 'calendar-accounts', states: ['connected', 'refresh-due', 'reconnect-needed'], capability: 'calendar.disconnect', label: 'sign out', fill: { provider: 'id' } },
    { key: 'u', id: 'own-app', list: 'calendar-accounts', capability: 'calendar.use-app', label: 'use your own app', fill: { provider: 'id' } },
    { key: 'l', id: 'accounts-in-words', list: 'calendar-accounts', whole: true, capability: 'calendar.accounts', label: 'list them in words' },
    // A feed: read again, removed; a new one subscribed to.
    { key: 'n', id: 'subscribe', list: 'calendar-feeds', whole: true, capability: 'calendar.subscribe', label: 'subscribe to a feed' },
    { key: 'g', id: 'read-feed-again', list: 'calendar-feeds', capability: 'calendar.refresh', label: 'read it again now', fill: { name: 'id' } },
    { key: 'a', id: 'read-every-feed', list: 'calendar-feeds', whole: true, capability: 'calendar.refresh', label: 'read every feed now', fill: { name: () => '' } },
    { key: 'x', id: 'unsubscribe', list: 'calendar-feeds', capability: 'calendar.unsubscribe', label: 'stop subscribing', fill: { name: 'id' } },
    { key: 'l', id: 'feeds-in-words', list: 'calendar-feeds', whole: true, capability: 'calendar.subscriptions', label: 'list them in words' },
    // The channels as a whole, from the daemon's own records (capabilities/builtin/channel-reads.ts).
    { key: 'f', list: 'channels', capability: 'channels.configured', label: 'how it is configured', fill: { channel: 'id' } },
    { key: 'y', list: 'channels', whole: true, capability: 'channels.readiness', label: 'which are set up' },
    { key: 'h', list: 'channels', whole: true, capability: 'channels.guide', label: 'what to set up next' },
    { key: 'i', list: 'channels', whole: true, capability: 'channels.triage', label: 'what came in' },
    { key: 'd', list: 'channels', whole: true, capability: 'channels.deliveries', label: 'what was sent' },
    { key: 'v', list: 'channels', whole: true, capability: 'channels.delivery', label: 'how sends went' },
    { key: 'b', list: 'channels', whole: true, capability: 'channels.routes', label: 'routes' },
    { key: 'O', list: 'channels', whole: true, capability: 'channels.overview', label: 'what the channels carry' },
    // A message to the selected channel, sent by the daemon (capabilities/builtin/channel-send.ts); Telegram's saved reading position.
    // A send names its channel (or a route, a webhook address, a link) in its form: one of the channels, or another.
    { key: 'n', id: 'send-to-channel', list: 'channels', whole: true, capability: 'channels.send', label: 'send a message' },
    { key: 'c', id: 'telegram-position', list: 'channels', whole: true, capability: 'channels.telegram-cursor', label: 'Telegram\'s reading position', form: true },
    // Where notifications go: the daemon's one list of webhook addresses (capabilities/builtin/notify.ts).
    { key: 'n', id: 'add-address', list: 'notifications', whole: true, capability: 'notify.add', label: 'add an address' },
    { key: 'x', id: 'remove-address', list: 'notifications', capability: 'notify.remove', label: 'stop sending here', fill: { address: 'id' } },
    { key: 'D', id: 'remove-every-address', list: 'notifications', whole: true, capability: 'notify.clear', label: 'remove every address' },
    { key: 't', id: 'test-notification', list: 'notifications', whole: true, capability: 'notify.test', label: 'send a test' },
    { key: 's', id: 'send-notification', list: 'notifications', whole: true, capability: 'notify.send', label: 'send a notification' },
    { key: 'v', id: 'show-addresses', list: 'notifications', capability: 'notify.list', label: 'show the full addresses', fill: { show: () => 'yes' } },
    // The notifications that failed: sent again, one or all; `l` says them all in words.
    { key: 'enter', list: 'failed-notifications', capability: 'notify.resend', label: 'send it again', fill: { which: 'id', where: () => 'same' } },
    { key: 'a', id: 'resend-all', list: 'failed-notifications', capability: 'notify.resend', label: 'send them all again', fill: { which: () => 'all', where: () => 'same' } },
    { key: 'c', id: 'resend-to-current', list: 'failed-notifications', capability: 'notify.resend', label: 'send it where the channel posts now', fill: { which: 'id', where: () => 'current' } },
    { key: 'l', id: 'failed-in-words', list: 'failed-notifications', whole: true, capability: 'notify.failed', label: 'list them in words' },
  ],
  count: (lists) => {
    // A channel whose state nothing here can confirm (the web control plane) is not counted as wrong.
    const troubled = (lists.channels ?? []).filter((item) => WRONG.includes((item as ChannelItem).state)).length;
    if (troubled > 0) return { count: troubled, words: `${troubled} channel${troubled === 1 ? ' needs' : 's need'} a look`, tone: 'wrong' };
    const failed = (lists['failed-notifications'] ?? []).length;
    if (failed > 0) return { count: failed, words: `${failed} notification${failed === 1 ? '' : 's'} failed`, tone: 'wrong' };
    const unread = (lists.inbox ?? []).filter((item) => item.state === 'unread').length;
    return unread > 0 ? { count: unread, words: `${unread} unread`, tone: 'waiting' } : undefined;
  },
  // The count reads these three only: a Google step or a calendar change reads nothing for the menu (google-b).
  countFrom: ['channels', 'failed-notifications', 'inbox'],
});
