import type { Questions, SystemOneRequest, SystemOneResult } from '@typesafe-ai/sdk';
import type { JudgmentConfig, JudgmentEndpoint } from './config.ts';
import { requestWithoutDeadline, systemOneWithoutDeadline } from './client.ts';
import { JudgmentError } from './errors.ts';
import { matchesJudgmentModel } from './endpoint-validation.ts';

import type { JudgmentAdapterKind } from './model-profiles.ts';
export { DECISION_MODEL_PROFILES, type JudgmentAdapterKind, type DecisionModelProfile } from './model-profiles.ts';

export function judgmentAdapter(endpoint: JudgmentEndpoint): JudgmentAdapterKind {
  if (endpoint.adapter !== undefined) return endpoint.adapter;
  const url = new URL(endpoint.baseURL);
  return url.hostname === 'api.cloudflare.com' && /\/ai\/run\/@cf\/cloudflare\/clef(?:-flash)?\/?$/.test(url.pathname)
    ? 'cloudflare-workers-ai' : 'system-one';
}

/** Capabilities are deployment facts. They never authorize dropping evidence. */
export function validateBackendInput(endpoint: JudgmentEndpoint, model: string, request: SystemOneRequest<Questions>): void {
  const adapter = judgmentAdapter(endpoint);
  const questions = Object.keys(request.questions);
  const bytes = new TextEncoder().encode(JSON.stringify(request)).byteLength;
  if (endpoint.maxInputBytes !== undefined && bytes > endpoint.maxInputBytes
    || endpoint.maxQuestions !== undefined && questions.length > endpoint.maxQuestions) {
    throw new JudgmentError('invalid-request', 'the complete judgment input exceeds this target deployment capability');
  }
  if (adapter === 'cloudflare-workers-ai') {
    if (!['clef', 'clef-flash'].includes(model) || !new URL(endpoint.baseURL).pathname.replace(/\/$/, '').endsWith(`/${model}`)) {
      throw new JudgmentError('invalid-request', 'the Cloudflare decision model must match its configured run endpoint');
    }
    if (questions.length > 64 || questions.some(name => !/^[A-Za-z0-9_.-]{1,100}$/.test(name))) {
      throw new JudgmentError('invalid-request', 'the questions exceed Cloudflare decision model capabilities');
    }
    // Cloudflare truncates overlong state instead of rejecting it. Bound the
    // whole serialized request using bytes (not the English chars/3 estimate),
    // with additional room for rendering and per-question template tokens.
    // Text/JSON only: no media token accounting is implied by this adapter.
    if (bytes * 4 + 4096 + questions.length * 512 > 65_536) {
      throw new JudgmentError('invalid-request', 'the complete input exceeds the conservative Cloudflare context budget; partition the evidence');
    }
  }
}

export function acceptsBackendModel(endpoint: JudgmentEndpoint, requested: string, actual: string): boolean {
  return matchesJudgmentModel(requested, actual) || (endpoint.responseModels?.includes(actual) ?? false);
}

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

/** Translate only declared wire fields; never fabricate probabilities or confidence. */
export async function askBackend<Q extends Questions>(
  config: JudgmentConfig, request: SystemOneRequest<Q>, signal: AbortSignal,
  headers?: Readonly<Record<string, string>>,
): Promise<SystemOneResult<Q>> {
  const adapter = judgmentAdapter(config.endpoint);
  let raw: unknown = adapter === 'cloudflare-workers-ai'
    ? await requestWithoutDeadline(config, 'POST', '', signal, request)
    : await systemOneWithoutDeadline(config, request, signal, headers);
  if (adapter === 'cloudflare-workers-ai') {
    if (!record(raw) || raw.success !== true || !record(raw.result)) {
      throw new JudgmentError('invalid-response', 'Cloudflare did not return a successful decision envelope');
    }
    raw = raw.result;
  }
  if (!record(raw) || !record(raw.usage)) throw new JudgmentError('invalid-response', 'the decision model returned no usage evidence');
  const usage = raw.usage;
  if (usage.truncated !== undefined && typeof usage.truncated !== 'boolean'
      && (typeof usage.truncated !== 'number' || !Number.isSafeInteger(usage.truncated) || usage.truncated < 0)
    || usage.state_tokens_dropped !== undefined && (typeof usage.state_tokens_dropped !== 'number'
      || !Number.isSafeInteger(usage.state_tokens_dropped) || usage.state_tokens_dropped < 0)
    || usage.truncated_questions !== undefined && (!Array.isArray(usage.truncated_questions)
      || usage.truncated_questions.some(question => typeof question !== 'string'))) {
    throw new JudgmentError('invalid-response', 'the decision model returned invalid truncation evidence');
  }
  if (usage.truncated === true || typeof usage.truncated === 'number' && usage.truncated > 0
    || typeof usage.state_tokens_dropped === 'number' && usage.state_tokens_dropped > 0
    || Array.isArray(usage.truncated_questions) && usage.truncated_questions.length > 0) {
    throw new JudgmentError('invalid-response', 'the decision model reported incomplete evidence');
  }
  if (adapter === 'laya') {
    // Laya's native confidence is normalized entropy. Its explicit Jev field
    // carries the confidence our battery bands consume. Strict-mode servers
    // remove that field and truncation evidence, so they cannot use this adapter.
    if (!record(raw.answers) || !Object.hasOwn(usage, 'truncated')) {
      throw new JudgmentError('invalid-response', 'Laya must expose truncation and Jev confidence metadata; disable LAYA_JEV_STRICT');
    }
    if (record(usage.options) && Object.keys(usage.options).length > 0) {
      throw new JudgmentError('invalid-response', 'Laya reported collapsed question options');
    }
    raw = { ...raw, answers: Object.fromEntries(Object.entries(raw.answers).map(([name, value]) => {
      if (!record(value)) throw new JudgmentError('invalid-response', 'Laya returned an invalid answer');
      if (value.abstain === true || value.unbound === true || value.route === 'review') {
        throw new JudgmentError('rejected', 'the decision model abstained; the operation cannot proceed');
      }
      return [name, value.type === 'noul' ? value : { ...value, confidence: value.x_jev_confidence }];
    })) };
  }
  return raw as SystemOneResult<Q>;
}
