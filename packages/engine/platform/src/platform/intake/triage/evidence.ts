import { types as nodeTypes } from 'node:util';
import type { YesNoReading } from '@goodvibes/judgment';
import { JudgmentInputError, snapshotJudgmentInput } from '../../gate/judgment-input.js';
import { inboxTriage } from './battery.js';
import type { TriageBinding, TriageEvidence, TriageInput, TriageLabel, TriageReceiptScope, TriageSourceBinding } from './types.js';

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
  /** Set when the item holds what may not be sent to a model (a credential, a card number): it is not read. */
  readonly withheld?: 'protected-content' | undefined;
}
const invalid = (): never => { throw new JudgmentInputError('unsupported-input'); };

/** Whether one item may be sent to a model; the privacy screen runs per item, so one item never blocks the page. */
function protectedContent(item: unknown): boolean {
  try { snapshotJudgmentInput(item); return false; }
  catch (error) {
    if (error instanceof JudgmentInputError) return true;
    throw error;
  }
}

/** Original input is fully captured, then each item is privacy-inspected on its own before any projection. */
export function captureTriageInputs(items: readonly TriageInput[]): readonly CapturedTriageInput[] {
  const captured = captureTriageData(items);
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
      unread: (item['unread'] ?? false) as boolean, ...(protectedContent(item) ? { withheld: 'protected-content' as const } : {}) });
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
  // Spam wins outright: a scam that demands action now reads yes on both, and is
  // exactly the message that must never be put at the top as Priority.
  const label: TriageLabel = spam.verdict === 'yes' ? 'spam'
    : urgency.verdict === 'yes' ? 'priority' : 'normal';
  const score = round(label === 'spam' ? spam.probability : label === 'priority' ? urgency.probability : 1 - Math.max(spam.probability, urgency.probability));
  return Object.freeze({ status: 'settled', spam: Object.freeze({...spam}), urgency: Object.freeze({...urgency}),
    label, score, tags: Object.freeze([labelToTag(label)]), signals: Object.freeze({ spam: round(spam.probability), urgency: round(urgency.probability) }) });
}
