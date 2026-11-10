import { isDeepStrictEqual } from 'node:util';
import { captureTriageData, captureTriageInputs, captureTriageReceiptScope, checkTriageReceipt } from './evidence.js';
import { captureInboxTriageSource } from '../cursor-store.js';
import { scoreCapturedTriage } from './scorer.js';
import { SqliteTriageStore } from './store.js';
import type { RunInboxTriageOptions, TriageEvidence, TriageInput, TriagePreview, TriageReceipt, TriageStore, TriageStoredRecord, TriageReceiptScope } from './types.js';

/** Scores first, then atomically publishes; dry-run does not open, read, close or write a receipt store. */
export function runInboxTriage(items: readonly TriageInput[], options: RunInboxTriageOptions & { readonly dryRun: true }): Promise<readonly TriagePreview[]>;
export function runInboxTriage(items: readonly TriageInput[], options?: RunInboxTriageOptions & { readonly dryRun?: false | undefined }): Promise<readonly TriageReceipt[]>;
export function runInboxTriage(items: readonly TriageInput[], options: RunInboxTriageOptions): Promise<readonly (TriageReceipt | TriagePreview)[]>;
export async function runInboxTriage(items: readonly TriageInput[], options: RunInboxTriageOptions = {}): Promise<readonly (TriageReceipt | TriagePreview)[]> {
  const input = captureTriageInputs(items), scope = captureTriageReceiptScope(options.receiptScope);
  if (options.dryRun) return scoreCapturedTriage(input, options.port, options.signal, scope, true);
  const original = options.receiptSource;
  if (original && !scope) throw new Error('Native triage receipt matching requires its original account scope');
  const source = original && scope ? captureInboxTriageSource(original, input, scope) : undefined;
  const receipts = await scoreCapturedTriage(input, options.port, options.signal, scope, false, source);
  source?.assertCurrent();
  if (!receipts.length || options.signal?.aborted) return receipts;
  const injected = options.store;
  if (!injected && !options.workingDirectory) throw new Error('Triage persistence requires a store or working directory.');
  const store = injected ?? new SqliteTriageStore(options.workingDirectory!, undefined, options.beforeReceiptWrite);
  try {
    source?.assertCurrent();
    if (source) await store.commit(receipts, options.signal, source.assertCurrent);
    else await store.commit(receipts, options.signal);
    source?.assertCurrent();
  }
  finally { if (!injected) await store.close(); }
  return receipts;
}

/** One batched read; historical evidence is projected only when the latest receipt still agrees. */
export async function readTriageMetadataBatch(items: readonly TriageInput[], store: TriageStore, receiptScope?: TriageReceiptScope, receiptSource?: object): Promise<ReadonlyMap<string, TriageEvidence>> {
  const input = captureTriageInputs(items), scope = captureTriageReceiptScope(receiptScope);
  const current = new Map(input.map(item => [item.id, item]));
  if (!current.size) return new Map();
  // Generic input is not native source provenance. Old digest rows remain
  // historical; no compatibility hashing or retained protected snapshots.
  if (!receiptSource || !scope) return new Map();
  const source = captureInboxTriageSource(receiptSource, input, scope, false);
  const records = await store.readBatch([...current.keys()]);
  source.assertCurrent();
  const out = new Map<string, TriageEvidence>();
  // Native iteration rejects forged/proxy Maps and ignores overridden getters/iterators.
  const entries = Map.prototype.entries.call(records) as IterableIterator<[string, TriageStoredRecord]>;
  for (const [id, raw] of entries) {
    const original = current.get(id);
    if (!original) continue;
    try {
      const captured = captureTriageData(raw);
      if (!captured || typeof captured !== 'object' || Array.isArray(captured)) continue;
      const record = captured as unknown as TriageStoredRecord;
      const latest = checkTriageReceipt(record.latest);
      if (latest.status !== 'settled' || latest.id !== id || latest.receiptVersion !== 4) continue;
      const settled = checkTriageReceipt(record.settled);
      // Only the exact native mutation revision and account can lend a current label.
      if (settled.status === 'settled' && isDeepStrictEqual(settled, latest)
        && latest.source !== undefined && isDeepStrictEqual(latest.source, source.bindingFor(id))) out.set(id, settled);
    } catch { /* Invalid stored evidence is never converted into a current label. */ }
  }
  source.assertCurrent();
  return out;
}

/** Removes stale incoming projections before adding checked evidence for this exact semantic input. */
export async function enrichItemsWithTriage(items: readonly TriageInput[], store: TriageStore, receiptScope?: TriageReceiptScope, receiptSource?: object): Promise<readonly (TriageInput & { readonly triage?: TriageEvidence })[]> {
  const captured = captureTriageData(items) as readonly TriageInput[];
  const evidence = await readTriageMetadataBatch(captured, store, receiptScope, receiptSource);
  return Object.freeze(captured.map(item => {
    const clean = { ...item } as Record<string, unknown>;
    for (const key of ['triage', 'triageScore', 'triageTags', 'triageLabel']) delete clean[key];
    const triage = evidence.get(item.id);
    return Object.freeze({ ...clean, ...(triage ? { triage } : {}) }) as TriageInput & { readonly triage?: TriageEvidence };
  }));
}
