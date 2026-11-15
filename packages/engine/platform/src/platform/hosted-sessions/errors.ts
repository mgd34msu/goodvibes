/**
 * errors.ts, the hosted-session engine's refusals. Each has its own class so
 * the routes can give each its own wire shape (routes/hosted-sessions.ts):
 * "no such session", "that session cannot serve this, and why", "a malformed
 * argument" and "at the configured cap" want four different reactions.
 */

/** A hosted session id nobody here knows. */
export class HostedSessionNotFoundError extends Error {
  readonly retryable = false;
  constructor(public readonly sessionId: string) {
    super(`This daemon hosts no session ${sessionId}.`);
    this.name = 'HostedSessionNotFoundError';
  }
}

/** A known hosted session that cannot serve this request, with the reason. A retry cannot change it. */
export class HostedSessionUnavailableError extends Error {
  readonly retryable = false;
  constructor(public readonly sessionId: string, reason: string) {
    super(`Hosted session ${sessionId} is unavailable: ${reason}.`);
    this.name = 'HostedSessionUnavailableError';
  }
}

/**
 * The session exists and has ended for good; nothing sent to it can run. A
 * caller that keeps a mapping to it creates a new session instead. Still an
 * unavailable session for every existing check; `code` is what a remote caller reads.
 */
export class HostedSessionTerminatedError extends HostedSessionUnavailableError {
  readonly code = 'HOSTED_SESSION_TERMINATED';
  constructor(sessionId: string, terminatedReason: string | undefined) {
    super(sessionId, `it is terminated (${terminatedReason ?? 'no reason recorded'})`);
    this.name = 'HostedSessionTerminatedError';
  }
}

/**
 * A live hosted session whose loop cannot be built yet: its workspace floor is
 * still being acquired or its provider registry is not ready. Nothing ran, so
 * the same request can be sent again shortly.
 */
export class HostedSessionNotReadyError extends Error {
  readonly retryable = true;
  constructor(public readonly sessionId: string, cause: unknown, detail: string) {
    super(`Hosted session ${sessionId} is not ready yet: ${detail}. Nothing was run; send the request again in a moment.`, { cause });
    this.name = 'HostedSessionNotReadyError';
  }
}

/** A client id that another principal attached under, so this caller may not renew or remove it. */
export class HostedSessionClientOwnerError extends Error {
  constructor(public readonly sessionId: string, public readonly clientId: string) {
    super(`Client ${clientId} is attached to hosted session ${sessionId} by a different principal, so it cannot be changed from this one. Use a clientId of your own.`);
    this.name = 'HostedSessionClientOwnerError';
  }
}

/** A malformed request argument. */
export class HostedSessionArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedSessionArgumentError';
  }
}

/** The configured hosted-session cap is reached. */
export class HostedSessionLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostedSessionLimitError';
  }
}
