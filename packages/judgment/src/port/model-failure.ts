import { JudgmentContextLimitError, JudgmentError, type JudgmentErrorKind, type JudgmentFailureReason } from './errors.ts';

/** A set decision model's failure, said the way the user sees it. */
export interface DecisionModelFailure {
  /** The model that failed, as the request named it. */
  readonly model: string;
  /** What failed, in plain words, without the model's name. */
  readonly what: string;
  /** What the user can do about it. */
  readonly nextStep: string;
  readonly kind: JudgmentErrorKind;
  readonly reason?: JudgmentFailureReason;
}

/** One line naming the model, what failed and the next step. */
export function decisionModelFailureMessage(failure: DecisionModelFailure): string {
  return `Decision model ${failure.model} failed: ${failure.what}. ${failure.nextStep}`;
}

const CHOOSE = 'or choose another one in Settings (Decision model, Decision model server).';

/**
 * The one rule for a decision the decision model did not make: whether the
 * error means no usable answer came back, so the decision takes its declared
 * fallback and the work goes on. Every judgment failure but a cancellation
 * is one: a request too large even after the transport split it, an HTTP
 * error of any status, a refused or missing credential, a malformed,
 * mismatched or abstaining answer, a closed connection, an attempt that had
 * no answer within `judgment.timeoutMs`, a target it cannot serve, a request
 * that broke a documented limit, a decision log that could not record. Only
 * the caller's own cancellation (`aborted`) is not: that stops the work it
 * belongs to.
 */
export function isDecisionModelFailure(error: unknown): error is JudgmentError {
  return error instanceof JudgmentError && error.kind !== 'aborted';
}

function whatAndNext(error: JudgmentError): { readonly what: string; readonly nextStep: string } {
  if (error instanceof JudgmentContextLimitError) {
    return { what: 'it refused the request as larger than its token limit', nextStep: `Check the token limit of the decision model server, ${CHOOSE}` };
  }
  if (error.kind === 'unrecorded') return { what: 'the decision log could not record its answer, so the answer was not used', nextStep: 'Check free disk space and that no other program holds the decision log.' };
  switch (error.reason) {
    case 'abstained': return { what: 'it abstained from answering', nextStep: `Check the decision model server, ${CHOOSE}` };
    case 'no-credential': return { what: 'it has no API key', nextStep: `Give it a key in Settings (Where the decision model key comes from, Decision model key name), ${CHOOSE}` };
    case 'unreachable': return { what: 'its endpoint could not be reached', nextStep: `Check that the decision model server is running and its address (Decision model server in Settings) is right, ${CHOOSE}` };
    case 'endpoint-timeout': return { what: 'its endpoint did not answer in time', nextStep: `Check the decision model server's load, raise "Give up on the decision model after" in Settings, ${CHOOSE}` };
    case 'deadline-missed': return { what: 'it did not answer within the time allowed', nextStep: `Check the decision model server's load, ${CHOOSE}` };
    case 'targets-slow': return { what: 'it kept not answering in time and is skipped for a minute', nextStep: `Check the decision model server's load, ${CHOOSE}` };
    case 'rate-limited': return { what: 'it is rate limited', nextStep: `Wait for the limit to clear, add one under Backup decision models in Settings, ${CHOOSE}` };
    case 'endpoint-status': return { what: `its endpoint answered${error.status === undefined ? ' with an error' : ` HTTP ${error.status}`}`, nextStep: `Retry later; if it persists, check the decision service, ${CHOOSE}` };
    case 'malformed-response': return { what: 'it sent an answer this client cannot read', nextStep: `Check that the Decision model server setting points at a supported decision server, ${CHOOSE}` };
    case 'model-mismatch': return { what: 'a different model answered than the one configured', nextStep: `Check the model name set for this target, ${CHOOSE}` };
    case 'target-configuration': return { what: 'its target is configured in a way it cannot serve', nextStep: `Check its endpoint address, model and server mode, ${CHOOSE}` };
    case 'invalid-model': return { what: 'its name is not a valid model identifier', nextStep: `Correct the Decision model setting in Settings, ${CHOOSE}` };
    default: break;
  }
  if (error.kind === 'rejected' && (error.status === 401 || error.status === 403)) {
    return { what: `its endpoint refused the credential (HTTP ${error.status})`, nextStep: `Check its key in Settings (Where the decision model key comes from, Decision model key name), ${CHOOSE}` };
  }
  if (error.kind === 'rejected') return { what: `its endpoint refused the request${error.status === undefined ? '' : ` (HTTP ${error.status})`}`, nextStep: `Check the decision service and its settings, ${CHOOSE}` };
  if (error.kind === 'invalid-response') return { what: 'it sent an answer that does not match the questions', nextStep: `Check that the Decision model server setting points at a supported decision server, ${CHOOSE}` };
  if (error.kind === 'internal') return { what: 'the decision client failed internally', nextStep: 'Restart the app; if it repeats, report it.' };
  if (error.kind === 'invalid-request') return { what: 'a request to it broke one of its documented limits and was not sent', nextStep: 'Report it; the decisions it would have made take their fallback meanwhile.' };
  return { what: 'it could not answer', nextStep: `Check the decision model server and its key, ${CHOOSE}` };
}

/**
 * The failure a decision model's error is, as the owner is told it, or
 * undefined when the error is not a judgment failure or is the caller's own
 * cancellation (see {@link isDecisionModelFailure}).
 */
export function describeDecisionModelFailure(model: string, error: unknown): DecisionModelFailure | undefined {
  if (!isDecisionModelFailure(error)) return undefined;
  const failed = error.lineage?.attempts.at(-1)?.requestedModel ?? model;
  return { model: failed, ...whatAndNext(error), kind: error.kind, ...(error.reason === undefined ? {} : { reason: error.reason }) };
}
