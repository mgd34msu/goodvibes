/**
 * The answer an inbox HTTP owner (slack-http.ts, discord-http.ts) gives for one
 * request, and the fixed wording a person or agent is shown for each failure.
 * A failure names what happened and what to do; it never carries provider
 * text, message content or a credential.
 */

export type InboxHttpFailure =
  /** The provider asked us to wait; `retryAt` says until when. */
  | 'rate-limited'
  /** A proxy variable is set for this process; these inboxes connect directly only. */
  | 'proxy'
  | 'timed-out'
  /** The provider could not be reached or answered with a server error. */
  | 'unavailable'
  | 'too-large'
  /** The account, its settings or the inbox was retired while the request ran. */
  | 'not-current'
  | 'cancelled'
  /** The request was refused before it left (a bug in the caller, never provider data). */
  | 'not-allowed'
  /** The provider refused the credential or this account's access (401/403). */
  | 'denied'
  /** The provider says the addressed resource does not exist (404). */
  | 'not-found';

export type InboxHttpResult =
  | { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly reason: InboxHttpFailure; readonly retryAt?: number };

/** Local clock time a person can act on, e.g. 14:05. */
export function clockTime(at: number): string {
  const date = new Date(at);
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/**
 * One sentence with the reason and the next step. `subject` names what was
 * being read, e.g. "Slack" or "Discord channel 1234" (the owner's own setting,
 * never message content).
 */
export function describeInboxHttpFailure(provider: 'Slack' | 'Discord', reason: InboxHttpFailure, options: {
  readonly retryAt?: number | undefined; readonly subject?: string | undefined; readonly credentialKey: string; readonly settingsHint?: string | undefined;
}): string {
  const subject = options.subject ?? provider;
  switch (reason) {
    case 'rate-limited':
      return options.retryAt !== undefined && Number.isFinite(options.retryAt)
        ? `${provider} is rate limiting this inbox; the next attempt is at ${clockTime(options.retryAt)}`
        : `${provider} is rate limiting this inbox; the next poll tries again`;
    case 'proxy':
      return `A proxy is set for the daemon (HTTPS_PROXY, HTTP_PROXY or ALL_PROXY) and the ${provider} inbox connects to ${provider} directly only; unset it for the daemon to read this inbox`;
    case 'timed-out':
      return `${subject} did not answer in time; the next poll tries again`;
    case 'unavailable':
      return `${subject} could not be reached or answered with a server error; the next poll tries again`;
    case 'too-large':
      return `An answer from ${subject} was larger than the inbox reads; the next poll tries again`;
    case 'not-current':
      return `The ${provider} account or its settings changed while the inbox was reading; the next poll uses the current settings`;
    case 'cancelled':
      return `The ${provider} inbox poll was stopped before it finished`;
    case 'not-allowed':
      return `The ${provider} inbox built a request it does not send; this is a defect, report it`;
    case 'denied':
      return options.subject
        ? `${subject} refused this account's access; ${options.settingsHint ?? 'remove it from the inbox settings or restore the access'}`
        : `${provider} refused the credential in ${options.credentialKey}; replace it with a working token`;
    case 'not-found':
      return `${subject} no longer exists; ${options.settingsHint ?? 'remove it from the inbox settings'}`;
  }
}
