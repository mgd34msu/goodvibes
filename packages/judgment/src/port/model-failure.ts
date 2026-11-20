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

const CHOOSE = 'or choose another one in /settings open (Decision model, Decision model server).';

/**
 * Whether an error is the set model failing (unreachable, slow, rate limited,
 * a refused or missing credential, a malformed or mismatched answer, a target
 * it cannot serve) rather than an answer or the caller's own doing: an
 * abstention, a context or capability limit, a cancellation, a request that
 * broke a documented limit, or a decision log that could not record.
 */
export function isDecisionModelFailure(error: unknown): error is JudgmentError {
  if (!(error instanceof JudgmentError) || error instanceof JudgmentContextLimitError) return false;
  switch (error.kind) {
    case 'unavailable': case 'internal': return true;
    case 'rejected': return error.status === 401 || error.status === 403 || error.reason === 'no-credential';
    case 'invalid-response': return error.reason === undefined || error.reason === 'malformed-response' || error.reason === 'model-mismatch' || error.reason === 'target-configuration';
    case 'invalid-request': return error.reason === 'target-configuration' || error.reason === 'invalid-model';
    default: return false;
  }
}

function whatAndNext(error: JudgmentError): { readonly what: string; readonly nextStep: string } {
  switch (error.reason) {
    case 'no-credential': return { what: 'it has no API key', nextStep: `Give it a key in /settings open (Where the decision model key comes from, Decision model key name), ${CHOOSE}` };
    case 'unreachable': return { what: 'its endpoint could not be reached', nextStep: `Check that the decision model server is running and its address (Decision model server in /settings open) is right, ${CHOOSE}` };
    case 'endpoint-timeout': return { what: 'its endpoint did not answer in time', nextStep: `Check the decision model server's load, raise "Give up on the decision model after" in /settings open, ${CHOOSE}` };
    case 'deadline-missed': return { what: 'it did not answer within the decision deadline', nextStep: `Check the decision model server's load, raise "Longest a waiting decision may take" in /settings open, ${CHOOSE}` };
    case 'targets-slow': return { what: 'it kept missing the decision deadline and is skipped for a minute', nextStep: `Raise "Longest a waiting decision may take" in /settings open, ${CHOOSE}` };
    case 'rate-limited': return { what: 'it is rate limited', nextStep: `Wait for the limit to clear, add one under Backup decision models in /settings open, ${CHOOSE}` };
    case 'endpoint-status': return { what: `its endpoint answered${error.status === undefined ? ' with an error' : ` HTTP ${error.status}`}`, nextStep: `Retry later; if it persists, check the decision service, ${CHOOSE}` };
    case 'malformed-response': return { what: 'it sent an answer this client cannot read', nextStep: `Check that the Decision model server setting points at a supported decision server, ${CHOOSE}` };
    case 'model-mismatch': return { what: 'a different model answered than the one configured', nextStep: `Check the model name set for this target, ${CHOOSE}` };
    case 'target-configuration': return { what: 'its target is configured in a way it cannot serve', nextStep: `Check its endpoint address, model and server mode, ${CHOOSE}` };
    case 'invalid-model': return { what: 'its name is not a valid model identifier', nextStep: `Correct the Decision model setting in /settings open, ${CHOOSE}` };
    default: break;
  }
  if (error.kind === 'rejected' && (error.status === 401 || error.status === 403)) {
    return { what: `its endpoint refused the credential (HTTP ${error.status})`, nextStep: `Check its key in /settings open (Where the decision model key comes from, Decision model key name), ${CHOOSE}` };
  }
  if (error.kind === 'rejected') return { what: `its endpoint refused the request${error.status === undefined ? '' : ` (HTTP ${error.status})`}`, nextStep: `Check the decision service and its settings, ${CHOOSE}` };
  if (error.kind === 'invalid-response') return { what: 'it sent an answer that does not match the questions', nextStep: `Check that the Decision model server setting points at a supported decision server, ${CHOOSE}` };
  if (error.kind === 'internal') return { what: 'the decision client failed internally', nextStep: 'Restart the app; if it repeats, report it.' };
  return { what: 'it could not answer', nextStep: `Check the decision model server and its key, ${CHOOSE}` };
}

/**
 * The failure a set model's error is, or undefined when the error is not the
 * model's: the caller cancelled, the request broke a limit, the decision log
 * failed, or decision models are off.
 */
export function describeDecisionModelFailure(model: string, error: unknown): DecisionModelFailure | undefined {
  if (!isDecisionModelFailure(error)) return undefined;
  const failed = error.lineage?.attempts.at(-1)?.requestedModel ?? model;
  return { model: failed, ...whatAndNext(error), kind: error.kind, ...(error.reason === undefined ? {} : { reason: error.reason }) };
}
