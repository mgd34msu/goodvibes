/**
 * gmail-inbound-reader.ts, turning an adopted Google credential into the two
 * things `GmailMailSource` needs, or saying why there are none.
 *
 * This is the composition the inbound path did not have. `GmailMailSource` was
 * complete, tested and exported; `createInboundMailSourceFactory` took a
 * `GmailSourceBuilder`; and the field's comment said "Supplied by a composition
 * that has an adopted Google credential." No such composition existed. So
 * `deps.gmail` was `undefined` on every machine, the factory answered `null`
 * for `kind: 'gmail'`, and an owner who had connected Google and never set up
 * IMAP had no inbound mail at all, while `source-selection.ts` told them "no
 * Google credentials have been adopted on this machine".
 *
 * What a caller gets back is deliberately NOT a source
 * ───────────────────────────────────────────────────
 * `GmailMailSource` also needs a cursor store, an expectation predicate, a
 * clock and two poll intervals, and every one of those belongs to the inbound
 * composition rather than to Google. Splitting at the Google boundary is what
 * lets `composeInboundMail` build the source with the stores it already owns
 * while this file owns exactly the credential question.
 *
 * Why resolving makes one network call
 * ────────────────────────────────────
 * `collectHistoryDelta` gates on `GoogleTokenManager.scopes()`, and that list
 * is EMPTY for credentials read from the encrypted secret store until a refresh
 * has happened, the store records no scope list, and the real set arrives on
 * the refresh response. A source built over an unrefreshed store credential
 * would therefore refuse its first delta with `no-gmail-scope`, which is a
 * terminal verdict, and report a perfectly good mailbox as unreadable. So
 * resolving asks `users.getProfile` once. That call:
 *
 *   - forces the token refresh, so `scopes()` answers the real grant;
 *   - proves the credential actually works, rather than that a file exists;
 *   - returns `emailAddress`, which is the only trustworthy answer to "is the
 *     watched mailbox the one these credentials read" on a machine where no
 *     IMAP host has been configured to infer it from;
 *   - is authorized by every scope that authorizes `users.history.list`
 *     (including `gmail.metadata`), so it can never be the narrower gate.
 *
 * A failure is REPORTED, never rounded down to "not connected"
 * ───────────────────────────────────────────────────────────
 * The `unavailable` arm carries Google's own `problem` and `fix` wherever
 * Google produced them. That matters because the consumer of this answer is
 * source selection, and its previous message asserted a fact nobody had
 * checked. An owner whose grant was revoked must read "the credential is no
 * longer valid, re-authorize", not "no Google credentials have been adopted".
 *
 * The transient case is deliberately `unavailable` too, and that is a real
 * trade-off rather than an oversight: with Google unreachable there is no way
 * to learn the grant's scopes, and running a source that would refuse its first
 * delta with a terminal `no-gmail-scope` verdict is a worse answer than an
 * inactive supervisor whose reason says Google could not be reached and that
 * the next start tries again.
 */

import { openGoogleConnection, type GoogleConnectionSources } from './connection.js';
import type { GoogleConnectionOwner } from './connection-owner.js';
import type { GoogleConnectionRepair, GoogleConsentStart } from './connection-repair.js';
import type { GoogleApiFetchPort, GoogleApiResult, RecentMessageIds } from './api-client.js';
import type { GoogleFetchPort } from './oauth-loopback.js';
import type { HistoryDeltaDeps } from './history-delta.js';

/**
 * Everything `GmailMailSource` needs from Google, and nothing else.
 *
 * No client, no token manager and no credentials: a source handed those could
 * send mail, read the calendar or write the token store, none of which reading
 * a mailbox requires. The narrowness is the same idea `HistoryDeltaDeps`
 * already applies one layer down.
 */
export interface GmailInboundReader {
  /**
   * The address these credentials actually read, from `users.getProfile`.
   *
   * Present because "is the watched mailbox a Gmail one" cannot otherwise be
   * answered on the machine this exists to serve. The existing test reads the
   * configured IMAP host and concludes from its domain, which answers `false`
   * for an owner who has Google connected and has never configured IMAP at all,
   * sending automatic selection to the source they do not have.
   */
  readonly address: string;
  /** The `collectHistoryDelta` I/O slice, over the same client that refreshed the token. */
  readonly history: HistoryDeltaDeps;
  /** `users.getProfile().historyId`, see `GoogleApiClient.currentHistoryId`. */
  readonly currentHistoryId: () => Promise<GoogleApiResult<string>>;
  /** The newest message ids of a label, for the first-run history window; see `GoogleApiClient.listRecentMessageIds`. */
  readonly listRecentMessageIds?: ((labelId: string, maxResults: number) => Promise<GoogleApiResult<RecentMessageIds>>) | undefined;
}

/** Why there is no Gmail reader, in words a selection can hand to the owner. */
export interface GmailInboundReaderUnavailable {
  readonly kind: 'unavailable';
  /** What is wrong. Google's own wording when Google produced it. */
  readonly detail: string;
  /** The one remedial step, or '' when there is nothing the owner can do but wait. */
  readonly fix: string;
  /**
   * Set when this resolution started (or joined) a consent: resolves true when
   * the person approved and the grant is stored, so the caller resolves again
   * on that completion instead of at its next start.
   */
  readonly repairing?: Promise<boolean> | undefined;
}

export type GmailInboundReaderResolution =
  | { readonly kind: 'ready'; readonly reader: GmailInboundReader }
  | GmailInboundReaderUnavailable;

/**
 * Asked once per supervisor start, so a credential adopted after boot is picked
 * up on the next start rather than at the next restart.
 */
export type GmailInboundReaderProvider = () => Promise<GmailInboundReaderResolution>;

const NOT_CONNECTED_DETAIL = 'No Google account is connected on this machine, so there is no Gmail mailbox to read.';

const NOT_CONNECTED: GmailInboundReaderUnavailable = {
  kind: 'unavailable',
  detail: NOT_CONNECTED_DETAIL,
  fix: 'Set surfaces.email.inbound.source to "gmail" to connect a Google account for it (the consent link is shown at once), or set '
    + 'surfaces.email.user to read a mailbox over IMAP instead.',
};

/** The unavailable arm for a consent this resolution started: what the person sees, and its completion. */
function consentStarted(detail: string, start: GoogleConsentStart): GmailInboundReaderUnavailable {
  if (!start.started) return { kind: 'unavailable', detail: `${detail} ${start.problem}`, fix: start.fix };
  return {
    kind: 'unavailable',
    detail,
    fix: `A consent asking for mail and calendar together is open${start.joined ? ' already' : ''}: approve ${start.consentUrl} in your browser, and the mailbox is read as soon as you do.`,
    repairing: start.completed.then((outcome) => outcome.ok),
  };
}

export interface GmailInboundReaderSources {
  readonly sources: GoogleConnectionSources;
  readonly fetch: GoogleFetchPort & GoogleApiFetchPort;
  readonly now?: (() => number) | undefined;
  /** The process's held connection; without it a connection is opened for this resolution. */
  readonly connectionOwner?: GoogleConnectionOwner | undefined;
  /** The process's connection repair: a broken or missing grant starts a consent from here. */
  readonly repair?: GoogleConnectionRepair | undefined;
  /** Whether the owner asked for Gmail inbound (`surfaces.email.inbound.source` is "gmail"); only then does a missing connection start one. */
  readonly wantsGmail?: (() => boolean) | undefined;
}

/**
 * Resolve the Gmail reader for this machine, or explain why there is not one.
 *
 * Never throws: every failure is an `unavailable` arm with a reason, because
 * this is called from the supervisor's start path and a rejection there is a
 * watcher that does not start with nothing in its status to say why.
 */
export async function resolveGmailInboundReader(
  input: GmailInboundReaderSources,
): Promise<GmailInboundReaderResolution> {
  let connection: Awaited<ReturnType<typeof openGoogleConnection>>;
  try {
    connection = input.connectionOwner !== undefined
      ? await input.connectionOwner.connection({ sources: input.sources })
      : await openGoogleConnection(
        input.sources,
        { fetch: input.fetch },
        input.now?.() ?? Date.now(),
      );
  } catch (error) {
    return {
      kind: 'unavailable',
      detail: `The Google credentials on this machine could not be read: ${errorText(error)}`,
      fix: 'Check that the credential store is readable, then restart the daemon.',
    };
  }
  if (connection === null) {
    // Only an owner who asked for Gmail inbound is connected from here; on an IMAP machine this is the ordinary answer.
    if (input.repair === undefined || input.wantsGmail?.() !== true) return NOT_CONNECTED;
    return consentStarted(NOT_CONNECTED_DETAIL, await input.repair.startConsent('not-connected'));
  }

  // One call that does four jobs, see the module header. Wrapped because a
  // transport that throws rather than answering must not reject out of start().
  let profile: GoogleApiResult<{ readonly emailAddress: string }>;
  try {
    // Without the repair: start-up never waits on a person. A refusal the repair can act on is handed to it below, not awaited.
    profile = await connection.client.withoutRepair().getProfile();
  } catch (error) {
    return {
      kind: 'unavailable',
      detail: `Google could not be reached to check the connected mailbox: ${errorText(error)}`,
      fix: 'This is retried on the next start; no action is needed if the network recovers.',
    };
  }
  if (!profile.ok) {
    const repairable = profile.reason === 'grant-invalid' || profile.reason === 'missing-scopes' || profile.reason === 'api-disabled';
    if (input.repair === undefined || !repairable) return { kind: 'unavailable', detail: profile.problem, fix: profile.fix };
    // The start completes without this mailbox; the consent (or the enable) runs in the background, the person gets
    // one notice with the link, and the selection is made again when it completes.
    const repairing = input.repair.repair(profile, connection.tokens, {
      notice: (link) => `Google needs you to approve access again: ${link}. Mail from this account resumes when you do.`,
    }).then((outcome) => outcome.repaired, () => false);
    return {
      kind: 'unavailable',
      detail: profile.problem,
      fix: profile.reason === 'api-disabled' ? 'Enabling the API is being decided; mail from this account resumes once it is enabled.'
        : 'A consent link was sent to you; mail from this account resumes when you approve it.',
      repairing,
    };
  }

  // After the profile call the token has been refreshed, so this is the grant's
  // real scope list. An empty one here means Google's token response carried no
  // `scope` field and the credential recorded none either, which is not the
  // same fact as "the grant has no Gmail scope", and letting
  // `collectHistoryDelta` read it as the second would announce a terminal
  // no-gmail-scope failure for a mailbox that may be perfectly readable.
  if (connection.tokens.scopes().length === 0) {
    const detail = 'The connected Google credential works, but its granted scope list could not be '
      + 'determined: neither the stored credential nor the token response named any scopes. '
      + 'Whether it may read message bodies is therefore unknown, and this refuses to guess '
      + 'rather than start a reader that would report a working mailbox as unreadable.';
    // A fresh consent returns a grant that records its scopes; the reader is resolved again when it completes.
    if (input.repair !== undefined) return consentStarted(detail, await input.repair.startConsent('missing-scopes'));
    return { kind: 'unavailable', detail, fix: 'A fresh consent records the scopes; this program has no consent owner running, so none was started.' };
  }

  const client = connection.client;
  return {
    kind: 'ready',
    reader: {
      address: profile.value.emailAddress,
      history: client.historyDeltaPort(),
      currentHistoryId: () => client.currentHistoryId(),
      listRecentMessageIds: (labelId, maxResults) => client.listRecentMessageIds(labelId, maxResults),
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
