import type { Questions, SystemOneRequest, SystemOneResult } from '@typesafe-ai/sdk';
import type { JudgmentConfig, JudgmentEndpoint } from './config.ts';
import { requestWithoutDeadline, systemOneWithoutDeadline, type PreparedBody } from './client.ts';
import { JudgmentError } from './errors.ts';
import { matchesJudgmentModel } from './endpoint-validation.ts';
import type { SharedContextForm } from './shared-context.ts';

import type { JudgmentAdapterKind } from './model-profiles.ts';
export { DECISION_MODEL_PROFILES, type JudgmentAdapterKind, type DecisionModelProfile } from './model-profiles.ts';

export function judgmentAdapter(endpoint: JudgmentEndpoint): JudgmentAdapterKind {
  if (endpoint.adapter !== undefined) return endpoint.adapter;
  const url = new URL(endpoint.baseURL);
  return url.hostname === 'api.cloudflare.com' && /\/ai\/run\/@cf\/cloudflare\/clef(?:-flash)?\/?$/.test(url.pathname)
    ? 'cloudflare-workers-ai' : 'system-one';
}

/**
 * How each adapter's wire carries a request's shared context. None of them has
 * a field for it, so each sends it once at the head of the state: the System
 * One body (TypeSafe's hosted Jev and every loopback model on the same wire:
 * Kev, DiffusionGemma Jev) is `SystemOneRequest` in @typesafe-ai/sdk, whose
 * only fields are state, questions and model; the Cloudflare run endpoint
 * (clef, clef-flash) and Laya take that same body.
 */
const SHARED_CONTEXT_FORMS: Readonly<Record<JudgmentAdapterKind, SharedContextForm>> = {
  'system-one': 'state-head',
  'cloudflare-workers-ai': 'state-head',
  laya: 'state-head',
};

export function sharedContextForm(endpoint: JudgmentEndpoint): SharedContextForm {
  return SHARED_CONTEXT_FORMS[judgmentAdapter(endpoint)];
}

/**
 * Whether a request body of `bytes` with `questions` questions fits the
 * Cloudflare run endpoint's context: four tokens a byte at most, plus room for
 * rendering and each question's template, within 64k tokens.
 */
export function cloudflareContextFits(bytes: number, questions: number): boolean {
  return bytes * 4 + 4096 + questions * 512 <= 65_536;
}

/** Capabilities are deployment facts. They never authorize dropping evidence.
 * `bytes` is the UTF-8 size of the request body this target would be sent. */
export function validateBackendInput(endpoint: JudgmentEndpoint, model: string, request: Pick<SystemOneRequest<Questions>, 'questions'>, bytes: number): void {
  const adapter = judgmentAdapter(endpoint);
  const questions = Object.keys(request.questions);
  if (endpoint.maxInputBytes !== undefined && bytes > endpoint.maxInputBytes
    || endpoint.maxQuestions !== undefined && questions.length > endpoint.maxQuestions) {
    throw new JudgmentError('invalid-request', 'the complete judgment input exceeds this target deployment capability', { reason: 'target-capability' });
  }
  if (adapter === 'cloudflare-workers-ai') {
    if (!['clef', 'clef-flash'].includes(model) || !new URL(endpoint.baseURL).pathname.replace(/\/$/, '').endsWith(`/${model}`)) {
      throw new JudgmentError('invalid-request', 'the Cloudflare decision model must match its configured run endpoint', { reason: 'target-configuration' });
    }
    if (questions.length > 64 || questions.some(name => !/^[A-Za-z0-9_.-]{1,100}$/.test(name))) {
      throw new JudgmentError('invalid-request', 'the questions exceed Cloudflare decision model capabilities', { reason: 'target-capability' });
    }
    // Cloudflare truncates overlong state instead of rejecting it. Bound the
    // whole serialized request using bytes (not the English chars/3 estimate),
    // with additional room for rendering and per-question template tokens.
    // Text/JSON only: no media token accounting is implied by this adapter.
    if (!cloudflareContextFits(bytes, questions.length)) {
      throw new JudgmentError('invalid-request', 'the complete input exceeds the conservative Cloudflare context budget; partition the evidence', { reason: 'target-capability' });
    }
  }
}

export function acceptsBackendModel(endpoint: JudgmentEndpoint, requested: string, actual: string): boolean {
  return matchesJudgmentModel(requested, actual) || (endpoint.responseModels?.includes(actual) ?? false);
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Translate only declared wire fields; never fabricate probabilities or confidence. */
export async function askBackend<Q extends Questions>(
  config: JudgmentConfig, request: SystemOneRequest<Q> | PreparedBody, signal: AbortSignal,
  headers?: Readonly<Record<string, string>>,
): Promise<SystemOneResult<Q>> {
  const adapter = judgmentAdapter(config.endpoint);
  let raw: unknown = adapter === 'cloudflare-workers-ai'
    ? await requestWithoutDeadline(config, 'POST', '', signal, request)
    : await systemOneWithoutDeadline(config, request, signal, headers);
  if (adapter === 'cloudflare-workers-ai') {
    if (!record(raw) || raw.success !== true || !record(raw.result)) {
      throw new JudgmentError('invalid-response', 'Cloudflare did not return a successful decision envelope', { reason: 'malformed-response' });
    }
    raw = raw.result;
  }
  if (!record(raw) || !record(raw.usage)) throw new JudgmentError('invalid-response', 'the decision model returned no usage evidence', { reason: 'malformed-response' });
  const usage = raw.usage;
  // Kev exposes the cut on the result, with original/used state-token counts
  // in usage. Other supported servers put it in usage. Neither location may
  // be discarded before complete-evidence admission.
  const stateTokenCounts = usage.state_tokens !== undefined || usage.state_tokens_used !== undefined;
  const tokenCount = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
  if (raw.truncated !== undefined && typeof raw.truncated !== 'boolean') {
    throw new JudgmentError('invalid-response', 'the decision model returned invalid truncation evidence', { reason: 'malformed-response' });
  }
  if (stateTokenCounts) {
    const original = usage.state_tokens, used = usage.state_tokens_used;
    if (!tokenCount(original) || !tokenCount(used) || used > original) {
      throw new JudgmentError('invalid-response', 'the decision model returned invalid truncation evidence', { reason: 'malformed-response' });
    }
    if (used < original) throw new JudgmentError('invalid-response', 'the decision model reported incomplete evidence', { reason: 'truncated-evidence' });
  }
  if (usage.truncated !== undefined && typeof usage.truncated !== 'boolean'
      && (typeof usage.truncated !== 'number' || !Number.isSafeInteger(usage.truncated) || usage.truncated < 0)
    || usage.state_tokens_dropped !== undefined && (typeof usage.state_tokens_dropped !== 'number'
      || !Number.isSafeInteger(usage.state_tokens_dropped) || usage.state_tokens_dropped < 0)
    || usage.truncated_questions !== undefined && (!Array.isArray(usage.truncated_questions)
      || usage.truncated_questions.some(question => typeof question !== 'string'))) {
    throw new JudgmentError('invalid-response', 'the decision model returned invalid truncation evidence', { reason: 'malformed-response' });
  }
  if (raw.truncated === true || usage.truncated === true || typeof usage.truncated === 'number' && usage.truncated > 0
    || typeof usage.state_tokens_dropped === 'number' && usage.state_tokens_dropped > 0
    || Array.isArray(usage.truncated_questions) && usage.truncated_questions.length > 0) {
    throw new JudgmentError('invalid-response', 'the decision model reported incomplete evidence', { reason: 'truncated-evidence' });
  }
  if (adapter === 'laya') {
    // Laya's native confidence is normalized entropy. Its explicit Jev field
    // carries the confidence our battery bands consume. Strict-mode servers
    // remove that field and truncation evidence, so they cannot use this adapter.
    if (!record(raw.answers) || !Object.hasOwn(usage, 'truncated')) {
      throw new JudgmentError('invalid-response', 'Laya must expose truncation and Jev confidence metadata; disable LAYA_JEV_STRICT', { reason: 'target-configuration' });
    }
    if (record(usage.options) && Object.keys(usage.options).length > 0) {
      throw new JudgmentError('invalid-response', 'Laya reported collapsed question options', { reason: 'target-capability' });
    }
    raw = { ...raw, answers: Object.fromEntries(Object.entries(raw.answers).map(([name, value]) => {
      if (!record(value)) throw new JudgmentError('invalid-response', 'Laya returned an invalid answer', { reason: 'malformed-response' });
      if (value.abstain === true || value.unbound === true || value.route === 'review') {
        throw new JudgmentError('rejected', 'the decision model abstained; the operation cannot proceed', { reason: 'abstained' });
      }
      return [name, value.type === 'noul' ? value : { ...value, confidence: value.x_jev_confidence }];
    })) };
  }
  return raw as SystemOneResult<Q>;
}
