/** Seed an inbox mirror through the poller's own write path. */
import type { InboxCursorStore } from '../../platform/src/platform/intake/cursor-store.js';
import type { InboundChannelItem } from '../../platform/src/platform/intake/provider-adapter.js';

/** Commits the rows per provider, as one poll each would; returns how many were new. */
export async function seedInboxRows(store: InboxCursorStore, items: readonly InboundChannelItem[]): Promise<number> {
  const byProvider = new Map<string, InboundChannelItem[]>();
  for (const item of items) byProvider.set(item.provider, [...(byProvider.get(item.provider) ?? []), item]);
  let inserted = 0;
  for (const [provider, rows] of byProvider) inserted += await store.commitTimestampPoll(provider, rows, () => {});
  return inserted;
}
