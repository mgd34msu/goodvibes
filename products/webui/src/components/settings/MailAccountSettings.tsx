/**
 * MailAccountSettings, the connection status for the mail and calendar surfaces,
 * mounted in AdminView alongside TailscaleSettings and PairingTokensSettings.
 *
 * WHAT THIS IS: a read-only status panel that probes each surface with its cheapest
 * real verb and reports what came back, `ready`, or a needs-setup state naming the
 * concrete next step. It reports on the daemon; it does not hold anything.
 *
 * WHAT THIS DELIBERATELY IS NOT: a credential form. There is no field here for a
 * client id, a client secret, a refresh token or an app password, and that is a
 * design decision rather than an omission:
 *
 *   - Anything the operator configures must keep working after this tab is closed,
 *     and must be the same account the agent and the terminal see. That means it has
 *     to live in daemon-owned config and the daemon secret tier, never in browser
 *     state. Every write this repo makes to such a key goes through
 *     `platform.operator.config.set`, and `surfaces.*` is already covered by
 *     DAEMON_OWNED_CONFIG_PREFIXES in config-ownership.ts, so SettingsModal's
 *     schema-driven editor writes those keys through the daemon and badges them
 *     "Daemon-owned" with no bespoke form needed here.
 *   - Secret-shaped keys never round-trip to the browser: config-redaction.ts masks
 *     every key in its declared SECRET_CONFIG_KEYS set (the mail/calendar passwords
 *     and secret references among them), plus a last-segment token/secret/password/
 *     apikey heuristic as an additional safety net, and SettingsField renders those
 *     write-only (an explicit "Replace" that posts a new value and never displays
 *     the stored one).
 *
 * So the honest division is: the schema-driven settings modal owns editing, because
 * it already writes through the daemon and masks correctly; this panel owns telling
 * the operator whether what they configured actually works, and pointing at that
 * editor when it does not. Duplicating the editor here would add a second write path
 * with weaker masking and no benefit.
 *
 * QUIET BY CONSTRUCTION, like TailscaleSettings: while the probes are in flight the
 * panel renders nothing rather than flashing a scary state it is about to correct.
 */
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, Mail } from 'lucide-react';
import { client as platformClient, invokeOwnerMethod } from '../../lib/goodvibes';
import { asRecord } from '../../lib/object';
import { queryKeys } from '../../lib/queries';
import { formatError } from '../../lib/errors';
import {
  isCalendarAuthFailedError,
  isCalendarUnconfiguredError,
  isMethodNotInvokableError,
  isMethodUnavailableError,
  isSecretStoreUnreadableError,
} from '../../lib/errors';
import { mailRefusalNote } from '../../lib/mail-refusal';
import { Chip } from '../ui/Chip';
import type { StatusTone } from '../ui/StatusDot';
import { SettingsBlock } from './dialog/parts';

const STATE_TONE: Record<SurfaceState, StatusTone> = {
  ready: 'ok',
  'needs-setup': 'warn',
  'not-set-up': 'idle',
  'not-available': 'idle',
  'auth-failed': 'bad',
  'store-unreadable': 'bad',
  error: 'warn',
};

type SurfaceState = 'ready' | 'needs-setup' | 'not-set-up' | 'not-available' | 'auth-failed' | 'store-unreadable' | 'error';

interface SurfaceStatus {
  readonly state: SurfaceState;
  readonly label: string;
  readonly detail: string;
}

const STATE_LABEL: Record<SurfaceState, string> = {
  ready: 'Ready',
  'needs-setup': 'Needs setup',
  'not-set-up': 'Not set up',
  'not-available': 'Not on this daemon',
  'auth-failed': 'Credentials rejected',
  'store-unreadable': 'Secret store could not be read',
  error: 'Status unavailable',
};

/**
 * Mail status from the same classifier the mail views render, so the pill here can
 * never disagree with the note there about the same daemon response.
 */
function mailStatus(error: unknown, ok: boolean): SurfaceStatus {
  if (ok) {
    return { state: 'ready', label: STATE_LABEL.ready, detail: 'The account answered a live inbox read.' };
  }
  const note = mailRefusalNote(error);
  // This panel is in Settings already: the fields that set mail up are named, never "in Settings".
  if (note?.kind === 'needs-setup') return { state: note.kind, label: STATE_LABEL[note.kind], detail: MAIL_SETUP_HERE };
  if (note?.kind === 'auth-failed') return { state: note.kind, label: STATE_LABEL[note.kind], detail: MAIL_PASSWORD_HERE };
  if (note) return { state: note.kind, label: STATE_LABEL[note.kind], detail: note.description };
  return { state: 'error', label: STATE_LABEL.error, detail: formatError(error) };
}

/** Where on this page mail is set up: the Surfaces settings of Devices and pairing. */
const MAIL_SETUP_HERE = 'No mail account is set up. Fill in Mail server, Mail account and Mail password in Surfaces, under Devices and pairing on this page, and your inbox shows up here.';
const MAIL_PASSWORD_HERE = 'The mail server refused the saved password: replace Mail password in Surfaces, under Devices and pairing on this page.';
const CALENDAR_SETUP_HERE = 'No calendar is set up, so new events are kept on this computer only. Fill in Calendar server, Calendar account and Calendar password in Surfaces, under Devices and pairing on this page, to use a CalDAV calendar.';

/**
 * Calendar status from the calendar surface's own error helpers. Kept separate from
 * mailStatus rather than generalized: the two surfaces have genuinely different
 * refusal codes (CalDAV's CALENDAR_* set vs the email 412 backstop), and collapsing
 * them into one matcher would mean one surface silently inheriting the other's
 * assumptions the first time either changes.
 */
function calendarStatus(error: unknown, setUp: boolean | undefined): SurfaceStatus {
  if (!error && setUp === false) {
    return { state: 'not-set-up', label: STATE_LABEL['not-set-up'], detail: CALENDAR_SETUP_HERE };
  }
  if (!error) {
    return { state: 'ready', label: STATE_LABEL.ready, detail: 'The endpoint answered a live event query.' };
  }
  if (isMethodUnavailableError(error) || isMethodNotInvokableError(error)) {
    return {
      state: 'not-available',
      label: STATE_LABEL['not-available'],
      detail: 'This daemon has no calendar service yet, and updating the daemon turns it on.',
    };
  }
  // The password may well be stored: the daemon's secret store could not be read, so nothing is asked for again.
  if (isSecretStoreUnreadableError(error)) {
    return { state: 'store-unreadable', label: STATE_LABEL['store-unreadable'], detail: formatError(error) };
  }
  if (isCalendarUnconfiguredError(error)) {
    return {
      state: 'needs-setup',
      label: STATE_LABEL['needs-setup'],
      detail: 'Add the calendar address and account below, and the password goes to the daemon so the agent and terminal use it too.',
    };
  }
  if (isCalendarAuthFailedError(error)) {
    return {
      state: 'auth-failed',
      label: STATE_LABEL['auth-failed'],
      detail: 'The calendar server refused the saved password, so replace it below.',
    };
  }
  return { state: 'error', label: STATE_LABEL.error, detail: formatError(error) };
}

function SurfaceRow({
  icon,
  name,
  status,
  testId,
}: {
  icon: React.ReactNode;
  name: string;
  status: SurfaceStatus;
  testId: string;
}) {
  return (
    <li className="gv-row account-status" data-testid={testId} data-state={status.state}>
      <div className="gv-row__main">
        {icon}
        <span className="gv-row__text">
          <span className="gv-row__title">{name}</span>
          <span className="gv-row__meta account-status__detail">{status.detail}</span>
        </span>
      </div>
      <div className="gv-row__trailing">
        <Chip tone={STATE_TONE[status.state]}>{status.label}</Chip>
      </div>
    </li>
  );
}

export function MailAccountSettings() {
  // Mail: the capability mail.status, which answers either way (reachable, or why not by the refusal's own code), so
  // opening Settings with no mailbox set up draws no refused inbox read. The daemon reads one message summary to
  // answer it (read-only). Calendar: the lightest real read it publishes, limit:1 (EXAMINE), which cannot change state.
  const mailProbe = useQuery({
    queryKey: queryKeys.mailStatusDetail,
    queryFn: async () => {
      const data = asRecord(asRecord(await invokeOwnerMethod('capabilities.run', { id: 'mail.status', inputs: {} })).data);
      // Not reachable: the refusal the daemon met, shaped as the error the inbox read would have thrown.
      if (data.reachable !== true) {
        const failure = asRecord(data.failure);
        throw Object.assign(new Error(typeof failure.message === 'string' ? failure.message : 'The mailbox did not answer.'), failure);
      }
      return true;
    },
    retry: false,
  });
  // Calendar: the capability calendar.status first, which says whether any calendar is set up (a CalDAV server, a
  // signed-in Google or Outlook account, a subscribed feed); with none, the panel says so and reads no events (the
  // events list answers even with none, which is not "Ready"). With one, the lightest real event read.
  const calendarProbe = useQuery({
    queryKey: queryKeys.calendarSetUp,
    queryFn: async () => {
      const data = asRecord(asRecord(await invokeOwnerMethod('capabilities.run', { id: 'calendar.status', inputs: {} })).data);
      const accounts = Array.isArray(data.accounts) ? data.accounts.map(asRecord) : [];
      const signedIn = accounts.some((row) => row.state === 'connected' || row.state === 'refresh-due');
      const setUp = data.caldav === true || signedIn || (typeof data.feeds === 'number' && data.feeds > 0);
      if (!setUp) return { setUp: false };
      await platformClient.operator.calendar.events.list({ limit: 1 });
      return { setUp: true };
    },
    retry: false,
  });

  // Quiet while unknown, no flash of a state about to be corrected.
  if (mailProbe.isPending || calendarProbe.isPending) return null;

  const mail = mailStatus(mailProbe.error, !mailProbe.error);
  const calendar = calendarStatus(calendarProbe.error, calendarProbe.data?.setUp);

  return (
    <SettingsBlock
      testId="mail-account-settings"
      title="Mail & calendar accounts"
      description="Both are set up in the settings below. The daemon holds the account and its password, so it keeps working with this browser closed, and the terminal and the agent use the same one. Nothing secret is sent to or stored in this browser."
    >
      <ul className="gv-rows" aria-label="Account status">
        <SurfaceRow
          icon={<Mail size={16} aria-hidden="true" />}
          name="Mail"
          status={mail}
          testId="mail-surface-status"
        />
        <SurfaceRow
          icon={<CalendarDays size={16} aria-hidden="true" />}
          name="Calendar"
          status={calendar}
          testId="calendar-surface-status"
        />
      </ul>
    </SettingsBlock>
  );
}
