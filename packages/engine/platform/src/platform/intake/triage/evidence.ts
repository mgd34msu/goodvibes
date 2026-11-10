import { isDeepStrictEqual, types as nodeTypes } from 'node:util';
import { readYesNo, isPinnedJudgmentModel, matchesJudgmentModel, type YesNoReading } from '@goodvibes-jev/judgment';
import { JudgmentInputError, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { inboxTriage, TRIAGE_MODEL } from './battery.js';
import type { TriageBinding, TriageFailureReceipt, TriageEvidence, TriageInput, TriageLabel, TriageReceipt, TriageReceiptScope, TriageSourceBinding } from './types.js';

/** Descriptor-only capture checks every property, including hidden data, without invoking user code. */
export function captureTriageData(value: unknown): unknown {
  let nodes = 0, chars = 0;
  const active = new Set<object>();
  const invalid = (): never => { throw new JudgmentInputError('unsupported-input'); };
  const capture = (entry: unknown, depth: number): unknown => {
    if (++nodes > 20_000 || depth > 64) return invalid();
    if (typeof entry === 'string') { chars += entry.length; return chars > 1_000_000 ? invalid() : entry; }
    if (entry === undefined || entry === null || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number') return Number.isFinite(entry) ? entry : invalid();
    if (typeof entry !== 'object' || nodeTypes.isProxy(entry) || active.has(entry)) return invalid();
    const array = Array.isArray(entry), proto: unknown = Object.getPrototypeOf(entry);
    if (array ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(entry), keys = Reflect.ownKeys(descriptors);
    if (keys.some(key => typeof key !== 'string') || keys.length > 20_000) return invalid();
    if (Object.values(descriptors).some(d => !('value' in d))) return invalid();
    const length: unknown = array ? descriptors['length']?.value : 0;
    if (typeof length !== 'number' || !Number.isInteger(length) || length < 0 || length > 20_000) return invalid();
    if (array && (keys.length !== length + 1 || Array.from({length}, (_, i) => i).some(i => !Object.hasOwn(descriptors, String(i))))) return invalid();
    active.add(entry);
    const copy: object = array ? new Array(length) : {};
    for (const key of Object.keys(descriptors).sort()) {
      if (array && key === 'length') continue;
      Object.defineProperty(copy, key, { value: capture(descriptors[key]!.value, depth + 1), enumerable: true });
    }
    active.delete(entry);
    return Object.freeze(copy);
  };
  return capture(value, 0);
}

export interface CapturedTriageInput {
  readonly id: string; readonly surface: string; readonly subject: string; readonly snippet: string;
  readonly conversationKind: string; readonly unread: boolean;
}
const invalid = (): never => { throw new JudgmentInputError('unsupported-input'); };
/** Original input is fully captured and privacy-inspected before any projection. */
export function captureTriageInputs(items: readonly TriageInput[]): readonly CapturedTriageInput[] {
  const captured = captureTriageData(items);
  snapshotJudgmentInput(captured);
  if (!Array.isArray(captured) || captured.length > 100) return invalid();
  const seen = new Set<string>();
  return Object.freeze(captured.map((value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
    const item = value as Record<string, unknown>;
    if (typeof item['id'] !== 'string' || !item['id'].trim() || item['id'].length > 500 || seen.has(item['id'])
      || typeof item['surface'] !== 'string' || !item['surface'].trim() || item['surface'].length > 100
      || (item['subject'] !== undefined && typeof item['subject'] !== 'string')
      || (item['snippet'] !== undefined && typeof item['snippet'] !== 'string')
      || (item['unread'] !== undefined && typeof item['unread'] !== 'boolean')
      || (item['conversationKind'] !== undefined && !['direct','group','channel','thread','service'].includes(String(item['conversationKind'])))) return invalid();
    seen.add(item['id']);
    return Object.freeze({ id: item['id'], surface: item['surface'], subject: (item['subject'] ?? '') as string,
      snippet: (item['snippet'] ?? '') as string, conversationKind: (item['conversationKind'] ?? 'service') as string,
      unread: (item['unread'] ?? false) as boolean });
  }));
}
/** Capture only a private comparison domain. No scope text enters the model
 * request; the original account constructor independently owns authorization. */
export function captureTriageReceiptScope(scope: TriageReceiptScope | undefined): TriageReceiptScope | undefined {
  if (scope === undefined) return undefined;
  const captured = captureTriageData(scope);
  if (!captured || typeof captured !== 'object' || Array.isArray(captured)) return invalid();
  const value = captured as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || typeof value.providerId !== 'string' || !value.providerId || value.providerId.length > 100
    || typeof value.accountScopeId !== 'string' || !value.accountScopeId || value.accountScopeId.length > 500) return invalid();
  return captured as TriageReceiptScope;
}
/** A native mutation revision names the original mirror row. Generic input
 * has no source binding; it can produce a displayed conclusion/history only. */
export function triageBinding(input: CapturedTriageInput, source?: TriageSourceBinding): TriageBinding {
  return Object.freeze({ id: input.id, battery: inboxTriage.name, batteryVersion: inboxTriage.version,
    receiptVersion: 4, ...(source ? { source } : {}) });
}
const round = (p: number): number => Math.round(p * 100) / 100;
export function labelToTag(label: TriageLabel): string {
  return ({ spam: 'GoodVibes/Spam', priority: 'GoodVibes/Priority', normal: 'GoodVibes/Normal' })[label];
}
/** The same model conclusion serves persisted receipts and explicit previews. */
export function triageConclusion(spam: YesNoReading, urgency: YesNoReading):
  Omit<TriageEvidence, keyof TriageBinding> | { readonly status: 'held' } {
  if (spam.outcome !== 'act' || urgency.outcome !== 'act') return Object.freeze({ status: 'held' });
  const label: TriageLabel = spam.verdict === 'yes' && spam.probability >= urgency.probability ? 'spam'
    : urgency.verdict === 'yes' ? 'priority' : 'normal';
  const score = round(label === 'spam' ? spam.probability : label === 'priority' ? urgency.probability : 1 - Math.max(spam.probability, urgency.probability));
  return Object.freeze({ status: 'settled', spam: Object.freeze({...spam}), urgency: Object.freeze({...urgency}),
    label, score, tags: Object.freeze([labelToTag(label)]), signals: Object.freeze({ spam: round(spam.probability), urgency: round(urgency.probability) }) });
}
export function settleTriage(binding: TriageBinding, spam: YesNoReading, urgency: YesNoReading): TriageReceipt {
  const conclusion = triageConclusion(spam, urgency);
  if (conclusion.status === 'held') {
    if (binding.receiptVersion === 4) {
      const { source: _source, inputHash: _hash, receiptVersion: _version, ...attribution } = binding;
      return Object.freeze({ ...attribution, receiptVersion: 3, status: 'held' });
    }
    return Object.freeze({ ...binding, status: 'held' });
  }
  return Object.freeze({ ...binding, ...conclusion });
}
/** Validate untrusted evidence as data, re-derive its conclusions, and return an immutable owned value. */
export function checkTriageReceipt(value: unknown): TriageReceipt {
  const safe = captureTriageData(value);
  if (!safe || typeof safe !== 'object' || Array.isArray(safe)) return invalid();
  const row = safe as Record<string, unknown>;
  if (typeof row['id'] !== 'string' || !row['id'].trim() || row['id'].length > 500
    || row['battery'] !== inboxTriage.name || row['batteryVersion'] !== inboxTriage.version) return invalid();
  const failedV3 = row['receiptVersion'] === 3, sourceV4 = row['receiptVersion'] === 4;
  if (failedV3 || sourceV4 ? Object.hasOwn(row, 'inputHash') || (failedV3 ? row['status'] !== 'held' && row['status'] !== 'unavailable' : row['status'] !== 'settled')
    : typeof row['inputHash'] !== 'string' || !/^[a-f0-9]{64}$/.test(row['inputHash'])) return invalid();
  const model = row['model'], actualModel = row['actualModel'], targetModel = row['targetModel'];
  const identifier = (entry: unknown): entry is string => typeof entry === 'string' && /^[A-Za-z0-9@][A-Za-z0-9._:/@+-]{0,255}$/.test(entry);
  const modern = row['receiptVersion'] === 2 || failedV3 || sourceV4;
  if (row['receiptVersion'] !== undefined && !modern) return invalid();
  if (modern) {
    // Stored attribution describes the validated port response. It neither
    // revalidates a provider alias nor authorizes an action from disk.
    if (row['status'] === 'unavailable') {
      if (model !== undefined || actualModel !== undefined || targetModel !== undefined) return invalid();
    } else if (!identifier(model) || !identifier(actualModel) || !identifier(targetModel)) return invalid();
  } else {
    // Historical Jev-only receipts keep their original interpretation.
    if (model !== TRIAGE_MODEL && (typeof model !== 'string' || !isPinnedJudgmentModel(model))) return invalid();
    if (actualModel !== undefined && (typeof actualModel !== 'string' || !matchesJudgmentModel(model as string, actualModel))) return invalid();
    if (model === TRIAGE_MODEL && row['status'] !== 'unavailable' && actualModel === undefined) return invalid();
    if (targetModel !== undefined) return invalid();
  }
  if (failedV3) {
    const expected: TriageFailureReceipt = Object.freeze({ id: row['id'], battery: inboxTriage.name, batteryVersion: inboxTriage.version,
      receiptVersion: 3, status: row['status'] as 'held' | 'unavailable',
      ...(model === undefined ? {} : { model: model as string }), ...(actualModel === undefined ? {} : { actualModel: actualModel as string }),
      ...(targetModel === undefined ? {} : { targetModel: targetModel as string }) });
    if (!isDeepStrictEqual(safe, expected)) return invalid();
    return expected;
  }
  let source: TriageSourceBinding | undefined;
  if (sourceV4 && row.source !== undefined) {
    if (!row.source || typeof row.source !== 'object' || Array.isArray(row.source)) return invalid();
    const value = row.source as Record<string, unknown>;
    const scope = captureTriageReceiptScope({ providerId: value.providerId, accountScopeId: value.accountScopeId } as TriageReceiptScope);
    if (!scope || typeof value.sourceRevision !== 'string' || value.sourceRevision.length !== 35 || !/^ir-[0-9a-f]{32}$/.test(value.sourceRevision)
      || Object.keys(value).length !== 3) return invalid();
    source = Object.freeze({ ...scope, sourceRevision: value.sourceRevision });
  }
  const attribution = { id: row['id'], battery: inboxTriage.name, batteryVersion: inboxTriage.version,
    ...(model === undefined ? {} : { model: model as string }), ...(actualModel === undefined ? {} : { actualModel: actualModel as string }),
    ...(targetModel === undefined ? {} : { targetModel: targetModel as string }) };
  const binding: TriageBinding = sourceV4 ? { ...attribution, receiptVersion: 4, ...(source ? { source } : {}) }
    : { ...attribution, inputHash: row['inputHash'] as string, ...(modern ? { receiptVersion: 2 as const } : {}) };
  if (row['status'] === 'held' || row['status'] === 'unavailable') {
    if (binding.receiptVersion === 4) return invalid();
    const expected = Object.freeze({ ...binding, status: row['status'] });
    if (!isDeepStrictEqual(safe, expected)) return invalid();
    return expected;
  }
  if (row['status'] !== 'settled') return invalid();
  const reading = (raw: unknown, key: 'spam' | 'urgency'): YesNoReading => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
    const p: unknown = (raw as Record<string, unknown>)['probability'];
    if (typeof p !== 'number' || p < 0 || p > 1) return invalid();
    const checked = readYesNo({ type: 'noul', noul: p }, inboxTriage.items[key].band);
    if (!isDeepStrictEqual(raw, checked)) return invalid();
    return checked;
  };
  const expected = settleTriage(binding, reading(row['spam'], 'spam'), reading(row['urgency'], 'urgency'));
  if (expected.status !== 'settled' || !isDeepStrictEqual(safe, expected)) return invalid();
  return expected as TriageEvidence;
}
