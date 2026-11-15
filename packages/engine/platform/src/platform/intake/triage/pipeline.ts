import type { JudgmentPort } from '@goodvibes-jev/judgment';
import type { InboxCursorStore, InboxTriageReceiptRow } from '../cursor-store.js';
import { captureTriageInputs } from './evidence.js';
import { scoreCapturedTriage } from './scorer.js';
import type { TriageInput, TriagePreview, TriageReceipt } from './types.js';

/** One stored row to score, with the content revision its label will name. */
export interface TriageRow {
  readonly id: string;
  readonly provider: string;
  readonly kind: string;
  readonly subject: string;
  readonly snippet: string;
  readonly unread: boolean;
  readonly revision: string;
}

/** One representation for scoring: no sender, route or metadata. */
function inputOf(row: Omit<TriageRow, 'revision'>): TriageInput {
  return { id: row.id, surface: row.provider, subject: row.subject, snippet: row.snippet,
    ...(row.kind === 'dm' ? { conversationKind: 'direct' as const } : row.kind === 'thread' ? { conversationKind: 'thread' as const } : {}),
    unread: row.unread };
}

function receiptRow(receipt: TriageReceipt, revision: string): InboxTriageReceiptRow {
  const battery = `${receipt.battery}@${receipt.batteryVersion}`;
  return receipt.status === 'settled'
    ? { id: receipt.id, revision, status: 'settled', label: receipt.label, score: receipt.score, tags: receipt.tags, receipt: JSON.stringify(receipt), battery }
    : { id: receipt.id, revision, status: receipt.status, receipt: JSON.stringify(receipt), battery };
}

/**
 * Score rows of one account's mirror and store each label beside its row. The
 * rows are read and privacy-checked once, the model is asked once for the
 * batch, and each row's revision is compared once, inside the commit: a row
 * whose content changed meanwhile keeps no stale label and is scored next time.
 */
export async function triageMirrorRows(store: InboxCursorStore, provider: string, port: JudgmentPort, options: {
  readonly candidates: readonly TriageRow[]; readonly signal?: AbortSignal;
}): Promise<{ readonly receipts: readonly TriageReceipt[]; readonly stored: number }> {
  const rows = options.candidates.filter(row => row.provider === provider).slice(0, 100);
  if (rows.length === 0) return { receipts: [], stored: 0 };
  const input = captureTriageInputs(rows.map(inputOf));
  const revisions = new Map(rows.map(row => [row.id, row.revision]));
  const scope = store.triageScope;
  const receipts = await scoreCapturedTriage(input, port, options.signal, false,
    scope ? new Map(rows.map(row => [row.id, { ...scope, sourceRevision: row.revision }])) : undefined);
  if (options.signal?.aborted || receipts.length === 0) return { receipts, stored: 0 };
  const written = await store.commitTriageReceipts(receipts.map(receipt => receiptRow(receipt, revisions.get(receipt.id)!)));
  return { receipts, stored: written.length };
}

/** A reading of arbitrary items that is shown, never stored. */
export async function previewInboxTriage(items: readonly { readonly id: string; readonly provider: string; readonly kind: string;
  readonly subject?: string | undefined; readonly bodyPreview: string; readonly unread: boolean }[], port?: JudgmentPort, signal?: AbortSignal): Promise<readonly TriagePreview[]> {
  const input = captureTriageInputs(items.map(item => inputOf({ id: item.id, provider: item.provider, kind: item.kind,
    subject: item.subject ?? '', snippet: item.bodyPreview, unread: item.unread })));
  return scoreCapturedTriage(input, port, signal, true);
}
