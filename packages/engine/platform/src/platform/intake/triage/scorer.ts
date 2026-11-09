import { fanOut, type JudgmentPort } from '@goodvibes-jev/judgment';
import { drainOwned } from '@goodvibes-jev/judgment/decisions';
import { inboxTriage } from './battery.js';
import { captureTriageData, captureTriageInputs, captureTriageReceiptScope, triageConclusion, triageBinding, type CapturedTriageInput } from './evidence.js';
import { captureTriageJudgment, triageConfiguredModel } from './model-result.js';
import type { TriageInput, TriagePreview, TriageReceipt, TriageReceiptScope } from './types.js';

export function scoreCapturedTriage(items: readonly CapturedTriageInput[], port?: JudgmentPort, signal?: AbortSignal, receiptScope?: TriageReceiptScope): Promise<readonly TriageReceipt[]>;
export function scoreCapturedTriage(items: readonly CapturedTriageInput[], port: JudgmentPort | undefined, signal: AbortSignal | undefined,
  receiptScope: TriageReceiptScope | undefined, preview: true): Promise<readonly TriagePreview[]>;
export async function scoreCapturedTriage(items: readonly CapturedTriageInput[], port?: JudgmentPort, signal?: AbortSignal,
  receiptScope?: TriageReceiptScope, preview = false): Promise<readonly (TriageReceipt | TriagePreview)[]> {
  const scope = captureTriageReceiptScope(receiptScope);
  // Only settled evidence has a later exact-input matching consumer. A failed
  // attempt needs enough metadata to withdraw an old label, never a hash of the
  // discarded private preview. Missing ports and cancellation perform no hashing.
  const metadata = items.map(item => Object.freeze({ id: item.id, battery: inboxTriage.name,
    batteryVersion: inboxTriage.version }));
  const unavailable = (): readonly (TriageReceipt | TriagePreview)[] => Object.freeze(metadata.map(binding => preview
    ? Object.freeze({ ...binding, status: 'unavailable' as const })
    : Object.freeze({ ...binding, receiptVersion: 3 as const, status: 'unavailable' as const })));
  if (!items.length) return Object.freeze([]);
  if (!port || signal?.aborted) return unavailable();
  // Each part is the same registered decision, addressed to one batch item.
  // Only the item address changes; questions, bands and fixtures do not. The authorized port selects its configured model.
  const parts: Record<string, typeof inboxTriage> = {};
  for (let i = 0; i < items.length; i++) {
    const addressed = (key: 'spam' | 'urgency') => ({ ...inboxTriage.items[key], question: {
      ...inboxTriage.items[key].question, instructions: `For items[${i}] only: ${String(inboxTriage.items[key].question.instructions)}`,
    } });
    parts[`item${i}`] = { ...inboxTriage, items: { spam: addressed('spam'), urgency: addressed('urgency') } };
  }
  try {
    const state = { items: items.map(item => Object.freeze({...item})) };
    Object.freeze(state.items); Object.freeze(state);
    // The shared fan-out owns request composition. This boundary decorator
    // validates an injected port's raw result before fan-out reads its fields.
    // It deliberately borrows neither the caller's recorder nor default model.
    const configured = triageConfiguredModel(port);
    let targetModel: string | undefined;
    const checkedPort: JudgmentPort = {
      // Internal fan-out grouping only: this marker is never sent to the port.
      model: 'configured',
      async ask(request) {
        const questions = captureTriageData(request.questions) as typeof request.questions;
        const captureResult: NonNullable<typeof request.captureResult> = original => captureTriageJudgment(original, questions, configured).result;
        const capturedRequest = Object.freeze({ ...request, questions, captureResult,
          context: Object.freeze({ ...request.context, batteryVersion: inboxTriage.version }) });
        const raw = await port.ask(capturedRequest);
        if (signal?.aborted) throw new Error('Triage judgment cancelled.');
        const captured = captureTriageJudgment(raw, questions, configured);
        targetModel = captured.targetModel;
        return captured.result;
      },
    };
    const run = await fanOut(checkedPort, state, parts, { label: inboxTriage.name, site: 'intake.triage', ...(signal ? { signal } : {}) });
    if (signal?.aborted) return unavailable();
    if (targetModel === undefined) throw new Error('Missing triage target attribution');
    const answeredTarget = targetModel;
    return Object.freeze(items.map((item, i) => {
      const readings = run.readings[`item${i}`]!;
      const attribution = { model: run.result.requestedModel, actualModel: run.result.model, targetModel: answeredTarget };
      const conclusion = triageConclusion(readings.spam, readings.urgency);
      if (preview) return Object.freeze({ ...metadata[i]!, ...attribution, ...conclusion });
      if (conclusion.status !== 'settled') {
        return Object.freeze({ ...metadata[i]!, receiptVersion: 3 as const, ...attribution, ...conclusion });
      }
      // One commitment for actual settled evidence. Explicit previews never
      // issue a persistence binding; normal enrichment compares saved evidence
      // without retaining the prior protected message preview.
      return Object.freeze({ ...triageBinding(item, scope), ...attribution, ...conclusion });
    }));
  } catch (error) { drainOwned(error); return unavailable(); }
}
/** One injected, typed judgment request per nonempty admissible batch; never creates a provider. */
export async function scoreInboxTriage(items: readonly TriageInput[], port?: JudgmentPort, signal?: AbortSignal): Promise<readonly TriageReceipt[]> {
  return scoreCapturedTriage(captureTriageInputs(items), port, signal);
}
