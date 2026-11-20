import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { judgmentPort } from '@goodvibes/engine/errors';
import { captureStrictJudgmentJson, judgmentInputBoundary } from '@goodvibes/engine/platform/platform/gate';
import { CONTENT_DERIVATION_SITE } from '@goodvibes/engine/platform/platform/security';
import { ToolInputProjectionError } from '@goodvibes/engine/platform/platform/tools/input-projection';
import { isDeepStrictEqual } from 'node:util';
import { evaluateOutwardEffect, getProcessUntrustedContentLedger } from '@goodvibes/engine/platform/platform/security';
import { screenOutboundForCardMaterial } from './payments-channel-guard.js';
import { decisionOrClassic } from '@goodvibes/engine/platform/platform/runtime/decision-policy';
import type { JudgmentPort } from '@goodvibes/judgment/decisions';

/** Operator effects whose host judges this turn's untrusted content against the effect itself. */
const HOST_JUDGED_METHODS: ReadonlySet<string> = new Set(['payments.checkout.begin', 'payments.purchase.cancel']);

/** Retain the local source record; this does not mint execution or human authority. */
export function captureOperatorRequestPolicy() {
  const ledger = getProcessUntrustedContentLedger();
  const origins = ledger.taintOriginsThisTurn, exposures = ledger.exposuresThisTurn, sources = ledger.taintSourcesThisTurn;
  const current = () => captureStrictJudgmentJson([origins.call(ledger), exposures.call(ledger), sources.call(ledger)]);
  const original = current();
  const assertCurrent = () => {
    if (getProcessUntrustedContentLedger() !== ledger || ledger.taintOriginsThisTurn !== origins
      || ledger.exposuresThisTurn !== exposures || ledger.taintSourcesThisTurn !== sources
      || !isDeepStrictEqual(current(), original)) throw new ToolInputProjectionError('stale');
  };
  assertCurrent();
  return { assertCurrent, async screen(request: { readonly toolName: string; readonly methodId: string; readonly endpoint: string; readonly payload: Record<string, unknown> },
    options: { readonly signal?: AbortSignal | undefined; readonly assertCurrent: () => void }) {
    const check = () => { options.signal?.throwIfAborted(); options.assertCurrent(); assertCurrent(); };
    check();
    const content = { endpoint: request.endpoint, payload: JSON.stringify(request.payload) };
    // Check the complete retained source before any truncated semantic comparison.
    if (!judgmentInputBoundary(request.toolName, { content, sources: original }).passed) throw new ToolInputProjectionError('held');
    const card = await screenOutboundForCardMaterial({ surface: 'connected-host', message: content.payload, title: content.endpoint },
      { signal: options.signal, assertCurrent: check });
    check();
    if (card) throw new ToolInputProjectionError('held');
    // A purchase is judged where it is made: checkout admission keeps this turn's taint
    // evidence and the checkout reads it against the purchase itself (evaluatePaymentTaint
    // in payments/checkout-flow.ts), with the owner's limits and windows. A second, coarser
    // reading here refused every purchase begun from the page the Agent had just read,
    // and refused it outright when no decision model is set.
    if (HOST_JUDGED_METHODS.has(request.methodId)) return;
    const evaluate = (port?: JudgmentPort) => evaluateOutwardEffect({ request: { toolName: request.toolName, action: request.methodId,
      description: 'invoking the selected connected-host operator effect' }, ledger, content,
      taintOptions: { signal: options.signal, exactMatchFields: ['endpoint'], ...(port ? { port: {
        get model() { return port.model; }, ...(port.recorder ? { recorder: port.recorder } : {}),
        async ask(reading) {
          check(); const prior = reading.beforeAttempt;
          const result = await port.ask({ ...reading, beforeAttempt() { assertSynchronousJudgmentGuard(() => prior?.()); check(); } });
          check(); return result;
        },
      } } : {}) } });
    const decision = await decisionOrClassic(() => evaluate(judgmentPort(CONTENT_DERIVATION_SITE)), () => evaluate());
    check();
    if (!decision.allowed) throw new ToolInputProjectionError('held');
  } };
}
