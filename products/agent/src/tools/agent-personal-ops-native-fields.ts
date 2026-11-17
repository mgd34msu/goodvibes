import type { StructuredRedactionOptions } from '@goodvibes-jev/engine/platform/platform/utils';
import { captureOwnedJson } from '@goodvibes-jev/engine/platform/platform/gate';
import { LANE_IDS } from './agent-harness-personal-ops-types.ts';

/** Written by `writePersonalOpsEffectReceipt` after a provider effect the Agent performed. */
export const PERSONAL_OPS_EFFECT_RECEIPT_PURPOSE = 'personal-ops-effect-receipt';
export const PERSONAL_OPS_REVIEW_PURPOSE = 'personal-ops-review-cards';
const NATIVE_METADATA_PURPOSES = new Set([
  PERSONAL_OPS_EFFECT_RECEIPT_PURPOSE, PERSONAL_OPS_REVIEW_PURPOSE, 'watcher-run-receipt',
  'watcher-receipt', 'automation-watcher-receipt',
  'agent-watcher-receipt', 'agent-watcher-run-receipt', 'connected-host-watcher-receipt', 'connected-host-watcher-run-receipt',
  'automation-run-history-receipt', 'durable-run-history-receipt', 'connected-host-automation-run-history-receipt', 'provider-source-record-receipt',
  'remote-runner-artifact-receipt', 'remote-runner-closeout-receipt', 'remote-runner-export-receipt',
  'agent-remote-runner-artifact-receipt', 'agent-remote-runner-closeout-receipt', 'connected-host-remote-runner-artifact-receipt',
  'connected-host-remote-runner-closeout-receipt',
]);

/**
 * Field roles for a DTO the Agent's own code built: saved artifact descriptors
 * and the receipt metadata this product writes, the memory doctor and vector
 * reports. Every field is structural: its strings are shown with
 * credential-shaped text masked, and a name the engine's field table marks as
 * credential or owner-profile material stays withheld (a declaration cannot
 * weaken it). Two kinds of subtree are not ours and stay withheld: an
 * artifact's `metadata` unless its purpose names a receipt this product
 * writes (or it is a native embedding provider's or watcher's own metadata),
 * and any field the caller names in `withheld` for its read model (a URL or
 * command line that can carry a secret in its path or arguments).
 */
export function personalOpsNativeFields(value: unknown, withheld: ReadonlySet<string> = NOTHING_WITHHELD): NonNullable<StructuredRedactionOptions['declaredFields']> {
  const fields: Array<{ path: string[]; kind: 'other' }> = [];
  const declared = new Set<string>();
  const visit = (entry: unknown, path: readonly string[]): void => {
    if (Array.isArray(entry)) { for (const child of entry) visit(child, [...path, '*']); return; }
    if (entry === null || typeof entry !== 'object') return;
    if (path.at(-1) === 'metadata') {
      const purpose = (entry as Record<string, unknown>).purpose;
      const embeddingProvider = path.slice(-4).join('.') === 'embeddings.providers.*.metadata';
      const nativeWatcher = path.join('.') === 'nativeSnapshot.watchers.*.metadata'
        || path.join('.') === 'nativeSnapshot.watchers.*.source.metadata';
      if (!embeddingProvider && !nativeWatcher && (typeof purpose !== 'string' || !NATIVE_METADATA_PURPOSES.has(purpose.trim()))) return;
    }
    for (const [key, child] of Object.entries(entry)) {
      if (withheld.has(key)) continue;
      const childPath = [...path, key], identity = JSON.stringify(childPath);
      // A laneId in receipt metadata is shown only when it names a lane this product has.
      const validLane = key !== 'laneId' || path.at(-1) !== 'metadata'
        || typeof child === 'string' && LANE_IDS.some(lane => lane === child.trim());
      if (validLane && !declared.has(identity)) { fields.push({ path: childPath, kind: 'other' }); declared.add(identity); }
      visit(child, childPath);
    }
  };
  visit(value, []);
  return captureOwnedJson(fields) as NonNullable<StructuredRedactionOptions['declaredFields']>;
}

const NOTHING_WITHHELD: ReadonlySet<string> = new Set();

/** The MCP text/structured result envelope and the Personal Ops record DTOs
 * have explicit content fields. Extension fields and arbitrary metadata retain
 * the canonical withholding policy; credentials always override declarations. */
export function personalOpsResultFields(value: unknown): NonNullable<StructuredRedactionOptions['declaredFields']> {
  const names = new Set(['content', 'structuredContent', 'type', 'text', 'messages', 'threads', 'events',
    'items', 'results', 'id', 'threadId', 'messageId', 'eventId', 'subject', 'title', 'label', 'summary',
    'from', 'to', 'receivedAt', 'snippet', 'body', 'start', 'end', 'startsAt', 'endsAt', 'attendees',
    'organizer', 'location', 'status', 'kind', 'sourceTool', 'followUpBoundary', 'rawKeys']);
  const fields: Array<{ path: string[]; kind: 'content' }> = [];
  const seen = new Set<string>();
  const visit = (entry: unknown, path: string[]): void => {
    if (Array.isArray(entry)) { for (const child of entry) visit(child, [...path, '*']); return; }
    if (!entry || typeof entry !== 'object') return;
    for (const [name, child] of Object.entries(entry)) {
      if (!names.has(name)) continue;
      const childPath = [...path, name], key = JSON.stringify(childPath);
      if (!seen.has(key)) { seen.add(key); fields.push({ path: childPath, kind: 'content' }); }
      visit(child, childPath);
    }
  };
  visit(value, []);
  return captureOwnedJson(fields) as NonNullable<StructuredRedactionOptions['declaredFields']>;
}
