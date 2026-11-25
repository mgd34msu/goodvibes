/**
 * channel-words.ts, how a channel's state is said: one true state per channel,
 * the reason under any state that is not "working", and which of its stored
 * values are named as secrets. The `/channels` lines and the Mail, calendar and
 * channels place both read the daemon's answers through these, so the two
 * never say different things about one channel.
 */
import { SECRET_STORE_UNREADABLE } from '@goodvibes/engine/platform/platform/config';

export { CHANNEL_STATE_WORDS, channelReasonOf, channelStateOf, type ChannelState } from '@goodvibes/engine/platform/platform/channels/channel-state';

type JsonRecord = Readonly<Record<string, unknown>>;
function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function str(record: JsonRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/**
 * The stored values a channel names as secrets. ntfy's topics are its
 * settings (only on the public server is a topic name the one secret; it is
 * shown masked like any credential-bearing setting), so they are not listed
 * among its secrets.
 */
const NOT_SECRETS: Readonly<Record<string, ReadonlySet<string>>> = {
  ntfy: new Set(['topic', 'chatTopic', 'agentTopic', 'remoteTopic']),
};

export interface ChannelSecretShown {
  readonly field: string;
  readonly label: string;
  readonly source: string;
  readonly configured: boolean;
}

/** An account's secrets as they are named to a person. */
export function channelSecretsOf(account: JsonRecord): readonly ChannelSecretShown[] {
  const surface = str(account, 'surface');
  const list = Array.isArray(account['secrets']) ? account['secrets'].filter(isRecord) : [];
  return list
    .filter((secret) => !NOT_SECRETS[surface]?.has(str(secret, 'field')))
    .map((secret) => ({ field: str(secret, 'field') || 'secret', label: str(secret, 'label') || str(secret, 'field') || 'secret', source: str(secret, 'source'), configured: secret['configured'] === true }));
}

/** Whether a channel was ever set up: switched on, or a value declared for it. A never-set-up channel's store is not its problem. */
export function channelWasSetUp(account: JsonRecord): boolean {
  if (account['enabled'] === true) return true;
  const list = Array.isArray(account['secrets']) ? account['secrets'].filter(isRecord) : [];
  return list.some((secret) => secret['configured'] === true);
}

/**
 * What an account's line says about its secrets: for a channel that was set up
 * and whose secret store could not be read, that it could not be read (nothing
 * is asked for again); for a channel never set up, that it is not set up.
 */
export function channelAccountWords(account: JsonRecord): string {
  const secrets = channelSecretsOf(account);
  const unreadable = secrets.filter((secret) => secret.source === 'unreadable').map((secret) => secret.label);
  if (!channelWasSetUp(account)) return 'not set up';
  if (unreadable.length > 0) return `${SECRET_STORE_UNREADABLE}, so ${unreadable.join(', ')} could not be read; nothing already given there is asked for again`;
  const held = secrets.filter((secret) => secret.configured).map((secret) => secret.label);
  const signIn = str(account, 'authState');
  return [account['configured'] === true ? 'set up' : 'not set up', signIn ? `sign-in ${signIn}` : '', held.length > 0 ? `secrets held: ${held.join(', ')}` : '']
    .filter(Boolean).join('; ');
}
