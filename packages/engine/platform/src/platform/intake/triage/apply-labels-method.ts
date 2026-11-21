/**
 * `channels.inbox.applyLabels`: put triage labels on inbox messages at their
 * provider (an IMAP keyword, a Slack reaction, a Discord reaction or forum
 * tag), and say for every message what happened.
 *
 * The provider of an item is the prefix of its id (`slack:`, `discord:`,
 * `email:`), so no lookup decides where a message lives. Each provider's
 * labels are written by the tagging its live account source holds
 * (tagged-owned.ts), which checks the owner's per-account switch
 * `surfaces.<provider>.inboxTagging` and the message's revision around the
 * write. A refusal or failure for one message never stops the others.
 *
 * Cost: one provider write per message (plus one per stale built-in mark it
 * takes off); no model request for the built-in labels.
 */
import type { GatewayMethodCatalog } from '../../control-plane/method-catalog.js';
import { registerCatalogHandler, type Unregister } from '../../control-plane/host-handlers.js';
import { GatewayVerbError } from '../../control-plane/routes/gateway-verb-error.js';
import type { OwnedInboxTagging, OwnedInboxTagResult } from './tagged-owned.js';

export const INBOX_APPLY_LABELS_METHOD_ID = 'channels.inbox.applyLabels';
/** Messages one call may label. */
export const MAX_INBOX_LABEL_ITEMS = 100;
const MAX_LABELS = 8;
/** Provider writes in flight at once for one call. */
const CONCURRENCY = 4;
const LABEL_PROVIDERS: ReadonlySet<string> = new Set(['slack', 'discord', 'email']);

export interface InboxApplyLabelsInput {
  readonly itemIds?: unknown;
  readonly labels?: unknown;
}

export interface InboxApplyLabelsOutput {
  /** One result per requested id, in request order. */
  readonly results: readonly OwnedInboxTagResult[];
  readonly applied: number;
  readonly refused: number;
  readonly failed: number;
}

function stringList(value: unknown, field: string, max: number): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > max
    || value.some(entry => typeof entry !== 'string' || entry.trim().length === 0 || entry.length > 400)) {
    throw new GatewayVerbError(`${field} must be a list of 1 to ${String(max)} non-empty strings`, 'INBOX_LABELS_INVALID', 400, field);
  }
  return [...new Set((value as string[]).map(entry => entry.trim()))];
}

/** The provider an inbox item id belongs to: the part before its first colon. */
export function inboxItemProvider(itemId: string): string | null {
  const at = itemId.indexOf(':');
  return at > 0 ? itemId.slice(0, at) : null;
}

/**
 * Attach the handler. `taggingFor` answers the tagging of the provider's live
 * account source, or undefined when none is running on this host.
 */
export function registerInboxLabelsMethod(
  catalog: GatewayMethodCatalog,
  taggingFor: (provider: string) => OwnedInboxTagging | undefined,
): Unregister {
  return registerCatalogHandler<InboxApplyLabelsInput, InboxApplyLabelsOutput>(catalog, INBOX_APPLY_LABELS_METHOD_ID, async ({ body, context }) => {
    const itemIds = stringList(body.itemIds, 'itemIds', MAX_INBOX_LABEL_ITEMS);
    const labels = stringList(body.labels, 'labels', MAX_LABELS);
    const signal = context.signal;
    const one = async (itemId: string): Promise<OwnedInboxTagResult> => {
      const provider = inboxItemProvider(itemId);
      if (provider === null || !LABEL_PROVIDERS.has(provider)) {
        return { itemId, state: 'refused', applied: [], reason: 'Not an inbox item id; use an id from channels.inbox.list (slack:, discord: or email:)' };
      }
      const tagging = taggingFor(provider);
      if (!tagging) {
        return { itemId, state: 'refused', applied: [],
          reason: `No ${provider} inbox account is running on this host; set the account up and turn on surfaces.${provider}.inboxTagging, then try again` };
      }
      return tagging.applyTags(itemId, labels, signal ? { signal } : {});
    };
    const results: OwnedInboxTagResult[] = new Array(itemIds.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < itemIds.length) {
        const index = next++;
        signal?.throwIfAborted();
        results[index] = await one(itemIds[index]!);
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, itemIds.length) }, worker));
    return {
      results,
      applied: results.filter(result => result.state === 'applied').length,
      refused: results.filter(result => result.state === 'refused').length,
      failed: results.filter(result => result.state === 'failed').length,
    };
  });
}
