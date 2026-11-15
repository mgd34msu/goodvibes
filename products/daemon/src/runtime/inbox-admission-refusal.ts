/**
 * Why a configured inbox account could not be admitted, as a fixed token.
 *
 * Admission errors are never retained or logged verbatim because they can sit
 * next to credential and account material. The token is the part that is safe
 * to show an operator and an agent: it names the missing piece, not its value.
 */
export type InboxAdmissionReason =
  | 'account-incomplete'
  | 'consent-missing'
  | 'credential-unavailable'
  | 'settings-changing'
  | 'unavailable';

/** What the operator is told to do for each reason; fixed text, no values. */
export const INBOX_ADMISSION_ACTIONS: Readonly<Record<InboxAdmissionReason, string>> = Object.freeze({
  'account-incomplete': 'set the provider\'s account identity settings, or turn the provider off',
  'consent-missing': 'grant hosted inbox screening consent (surfaces.hostedInboxScreening), or turn the provider off',
  'credential-unavailable': 'store the screening credentials, or turn the provider off',
  'settings-changing': 'wait for the settings or credential edit to finish; the source retries on its own',
  unavailable: 'check the daemon log for the provider and retry by editing its settings',
});

export class InboxAdmissionRefusal extends Error {
  readonly reason: InboxAdmissionReason;
  constructor(reason: InboxAdmissionReason, message: string) {
    super(message);
    this.name = 'InboxAdmissionRefusal';
    this.reason = reason;
  }
}

/** The fixed reason for any admission failure; anything untyped is just `unavailable`. */
export function inboxAdmissionReason(error: unknown): InboxAdmissionReason {
  return error instanceof InboxAdmissionRefusal ? error.reason : 'unavailable';
}
