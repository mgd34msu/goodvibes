/**
 * policy-audit-poster.ts, the calls this terminal program's permission gate decided, posted to the daemon's
 * permission audit (`permissions.audit.post`; routes/policy-audit.ts in the platform), where "See what the candidate
 * policy changes" decides every program's calls again, not only the daemon's own.
 *
 * Each call is posted as the gate records its decision. Calls the daemon did not take (it is down or still starting)
 * wait, the newest kept, and go with the next post or when the program's daemon connection is back. Nothing waits on
 * a clock.
 */
import { logger, summarizeError } from '@goodvibes/engine/platform/platform/utils';

/** One decided call as the gate's audit records it (policy-runtime.ts `PermissionAuditEntry`): posted as it is. */
interface PermissionAuditEntry { readonly callId: string; readonly autonomousDecision?: unknown; readonly persisted?: boolean | undefined }

/** The most calls kept waiting while the daemon does not answer; the oldest go first. */
const MAX_WAITING = 100;
/** The most calls in one post (the method's own bound). */
const MAX_PER_POST = 100;

export interface DecidedCallsSource {
  /** Told of each call the gate decides, as it is recorded; returns the stop. */
  onDecision(listener: (entry: PermissionAuditEntry) => void): () => void;
}

export interface PolicyAuditPosterOptions {
  readonly decisions: DecidedCallsSource;
  readonly invoke: (method: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  readonly onDaemonBack: (listener: () => void) => () => void;
  readonly program: 'tui' | 'agent';
}

/** Post this program's decided calls to the daemon's permission audit. Returns the stop. */
export function postDecidedCallsToDaemon(options: PolicyAuditPosterOptions): () => void {
  // A call id is this program's: the process and its start keep two runs of one program apart in the daemon's audit.
  const started = `${process.pid}:${Date.now().toString(36)}`;
  let waiting: PermissionAuditEntry[] = [];
  let sending = false;
  let stopped = false;

  const send = async (): Promise<void> => {
    if (sending || stopped || waiting.length === 0) return;
    sending = true;
    const batch = waiting.slice(0, MAX_PER_POST);
    try {
      const calls = batch.map(({ autonomousDecision: _receipt, persisted: _persisted, ...call }) => ({ ...call, callId: `${started}:${call.callId}` }));
      await options.invoke('permissions.audit.post', { program: options.program, calls });
      const sent = new Set(batch);
      waiting = waiting.filter((call) => !sent.has(call));
    } catch (error) {
      // Kept for the next post, or for when the daemon is back.
      logger.debug('decided calls not posted to the daemon yet', { waiting: waiting.length, error: summarizeError(error) });
      sending = false;
      return;
    }
    sending = false;
    if (waiting.length > 0) void send();
  };

  const stopDecisions = options.decisions.onDecision((entry) => {
    waiting.push(entry);
    if (waiting.length > MAX_WAITING) waiting = waiting.slice(-MAX_WAITING);
    void send();
  });
  const stopBack = options.onDaemonBack(() => { void send(); });
  return () => {
    stopped = true;
    stopDecisions();
    stopBack();
  };
}
