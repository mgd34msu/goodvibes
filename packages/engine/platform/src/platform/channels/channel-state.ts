/**
 * channel-state.ts, a channel's one state and why, from the daemon's status
 * snapshot (`channels.status`). It imports nothing, so the daemon's channel
 * capabilities (capabilities/builtin/messages.ts), the terminal programs'
 * Mail, calendar and channels place and the web UI's Channels tab all read
 * one definition. Never "on" and "not ready" and "healthy" at once.
 */

type JsonRecord = Readonly<Record<string, unknown>>;
function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function str(record: JsonRecord, key: string): string {
  const value = record[key];
  return typeof value === 'string' ? value : '';
}

/** A channel's one state, as the place's items carry it. */
export type ChannelState = 'working' | 'needs-attention' | 'not-working' | 'not-set-up' | 'off' | 'unknown';

/** The words of each state, for a row and a sentence. */
export const CHANNEL_STATE_WORDS: Readonly<Record<ChannelState, string>> = {
  working: 'working',
  'needs-attention': 'needs a look',
  'not-working': 'not working',
  'not-set-up': 'not set up',
  off: 'switched off',
  unknown: 'not known',
};

/**
 * The one state of a channel from its health (`healthy`, `degraded`, `dead`,
 * `unresolved`, `unconfigured`, `disabled`, `unknown`) and whether it is
 * switched on.
 */
export function channelStateOf(snapshot: JsonRecord): ChannelState {
  const health = str(snapshot, 'state') || str(snapshot, 'status');
  const enabled = snapshot['enabled'] === true;
  if (health === 'unconfigured') return 'not-set-up';
  if (health === 'disabled' || !enabled) return snapshot['configured'] === true ? 'off' : 'not-set-up';
  if (health === 'healthy') return 'working';
  if (health === 'degraded' || health === 'unresolved') return 'needs-attention';
  if (health === 'dead') return 'not-working';
  return 'unknown';
}

/**
 * Why a channel is in its state, in the daemon's own words; undefined for a channel that works, and for one not set
 * up or switched off (its runtime's words then say only how it would receive, which is not why it is off).
 */
export function channelReasonOf(snapshot: JsonRecord): string | undefined {
  const state = channelStateOf(snapshot);
  if (state === 'working' || state === 'not-set-up' || state === 'off') return undefined;
  const runtime = isRecord(snapshot['runtime']) ? snapshot['runtime'] : {};
  const reason = str(runtime, 'reason').trim();
  const lastError = str(runtime, 'lastError').trim();
  const said = [reason, lastError && !reason.includes(lastError) ? `Last error: ${lastError}` : ''].filter(Boolean).join(' ');
  return said || undefined;
}
