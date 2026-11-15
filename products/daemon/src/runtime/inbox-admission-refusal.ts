import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';

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
  | 'storage-busy'
  | 'unavailable';

/**
 * The step of building an account inbox that failed, logged as a fixed token
 * beside the error name: identity (the account identity record), owner (the
 * provider account owner), lock (the store lease) or store (opening and
 * registering the store).
 */
export type InboxBuildStage = 'identity' | 'owner' | 'lock' | 'store';

/** What the operator is told to do for each reason; fixed text, no values. */
export const INBOX_ADMISSION_ACTIONS: Readonly<Record<InboxAdmissionReason, string>> = Object.freeze({
  'account-incomplete': 'set the provider\'s account identity settings, or turn the provider off',
  'consent-missing': 'grant hosted inbox screening consent (surfaces.hostedInboxScreening), or turn the provider off',
  'credential-unavailable': 'store the screening credentials, or turn the provider off',
  'settings-changing': 'wait for the settings or credential edit to finish; the source retries on its own',
  'storage-busy': 'another daemon process still holds this inbox store; stop it or let it exit, and the source retries on its own at most a minute apart',
  unavailable: 'read the daemon log line for the provider, which names the failed step and error; the source retries on its own at most a minute apart',
});

/**
 * Reasons that clear without anyone acting (an edit settles, another process
 * lets go of the store, a network or provider outage ends): the source keeps
 * retrying at its last backoff delay until it is admitted. The other reasons
 * wait for the settings or credential write that fixes them.
 */
export function inboxAdmissionClearsOnItsOwn(reason: InboxAdmissionReason): boolean {
  return reason === 'settings-changing' || reason === 'storage-busy' || reason === 'unavailable';
}

/**
 * An inbox account that cannot be admitted, in the one refusal shape: the
 * provider alone degrades (its reads say unavailable with the reason), the
 * other providers keep serving, and the next step is the fixed action above.
 */
export class InboxAdmissionRefusal extends RefusalError {
  readonly reason: InboxAdmissionReason;
  readonly stage: InboxBuildStage | undefined;
  constructor(reason: InboxAdmissionReason, message: string,
    options: { readonly stage?: InboxBuildStage | undefined; readonly cause?: unknown } = {}) {
    super(refusal({
      code: `INBOX_${reason.toUpperCase().replace(/-/g, '_')}`,
      state: 'the inbox account is not admitted',
      reason: message,
      next: [INBOX_ADMISSION_ACTIONS[reason]],
      retryable: reason === 'settings-changing' || reason === 'storage-busy',
    }), 'cause' in options ? { cause: options.cause } : {});
    this.name = 'InboxAdmissionRefusal';
    this.reason = reason;
    this.stage = options.stage;
  }
}

/** A build step failed with an error that is not an admission refusal; the stage says which. */
export class InboxBuildFailure extends Error {
  readonly stage: InboxBuildStage;
  constructor(provider: string, stage: InboxBuildStage, cause: unknown) {
    super(`The ${provider} inbox could not start: its ${stage} step failed`, { cause });
    this.name = 'InboxBuildFailure';
    this.stage = stage;
  }
}

/** The error and its causes, outermost first, bounded so a cyclic chain ends. */
function causeChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; depth < 6 && current !== null && current !== undefined; depth++) {
    chain.push(current);
    if (typeof current !== 'object') break;
    const cause = Object.getOwnPropertyDescriptor(current, 'cause');
    current = cause && 'value' in cause ? cause.value : undefined;
  }
  return chain;
}

/** The admission refusal anywhere in the cause chain, so a wrapped refusal keeps its reason. */
export function inboxAdmissionRefusalOf(error: unknown): InboxAdmissionRefusal | undefined {
  return causeChain(error).find((link): link is InboxAdmissionRefusal => link instanceof InboxAdmissionRefusal);
}

/** The fixed reason for any admission failure; anything untyped is just `unavailable`. */
export function inboxAdmissionReason(error: unknown): InboxAdmissionReason {
  return inboxAdmissionRefusalOf(error)?.reason ?? 'unavailable';
}

/** The outermost build stage recorded on the failure, if any. */
export function inboxBuildStage(error: unknown): InboxBuildStage | undefined {
  for (const link of causeChain(error)) {
    if (link instanceof InboxBuildFailure || link instanceof InboxAdmissionRefusal) {
      if (link.stage) return link.stage;
    }
  }
  return undefined;
}

// A held store lease and a busy SQLite file are the same fact for an operator:
// another owner has the store right now.
const BUSY_CODES: ReadonlySet<string> = new Set(['PROCESS_LOCK_BUSY', 'SQLITE_BUSY', 'SQLITE_LOCKED']);

function isStorageBusy(error: unknown): boolean {
  return causeChain(error).some(link => {
    if (typeof link !== 'object' || link === null) return false;
    const code = (link as { readonly code?: unknown }).code;
    return typeof code === 'string' && BUSY_CODES.has(code);
  });
}

/**
 * Classify a failure at one build step: a busy store becomes a `storage-busy`
 * refusal, a refusal keeps its reason, and anything else names the step. The
 * original error stays as the cause; it is never logged verbatim.
 */
export function atInboxBuildStage(provider: string, stage: InboxBuildStage, error: unknown): Error {
  if (inboxBuildStage(error) !== undefined && error instanceof Error) return error;
  if (!inboxAdmissionRefusalOf(error) && isStorageBusy(error)) {
    return new InboxAdmissionRefusal('storage-busy', `The ${provider} inbox store is held by another owner`, { stage, cause: error });
  }
  return new InboxBuildFailure(provider, stage, error);
}
