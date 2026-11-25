/**
 * money-lists.ts, the terminal side of the Money place (money-place.ts holds its lists and actions): the live lists a
 * Money form's inputs choose from (a card to remove, a repeat purchase to stop, a shop bought from), read from the
 * daemon through the program's binding. Kept out of the declaration so it holds no terminal code and the web UI draws
 * it too. (Until this release `/payments` defined them; the command is gone, its actions are the place's controls.)
 */
import { PAYMENT_CARDS_LIST, PAYMENT_SHOPS_LIST, REPEAT_PURCHASES_LIST } from '@goodvibes/engine/platform/platform/capabilities';
import { defineList, type ListRow } from '../command-actions/lists.js';
import { runDaemonCapability, type DaemonCapabilityBinding } from '../command-actions/capability-actions.js';
import type { CommandActionContext } from '../command-actions/types.js';
import { stripDangerousAnsi } from '../ansi-sanitize.js';

function text(value: unknown): string {
  return stripDangerousAnsi(String(value ?? '')).replace(/\x1b\[[0-9;]*m/g, '').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '');
}

function rowsOf(data: Readonly<Record<string, unknown>> | undefined, field: string): readonly Readonly<Record<string, unknown>>[] {
  const rows = data?.[field];
  return Array.isArray(rows) ? rows.filter((row): row is Readonly<Record<string, unknown>> => row !== null && typeof row === 'object') : [];
}

let binding: DaemonCapabilityBinding<CommandActionContext> | undefined;

/** Each program gives the binding its places use (capability-binding.ts), so a Money form's lists read the daemon. */
export function bindMoneyLists(next: DaemonCapabilityBinding<never>): void {
  binding = next as unknown as DaemonCapabilityBinding<CommandActionContext>;
}

defineList<CommandActionContext>({
  name: PAYMENT_CARDS_LIST,
  async read(ctx) {
    if (!binding) return [];
    const answer = await runDaemonCapability('payments.cards', {}, ctx, binding);
    return rowsOf(answer.data, 'cards').map((card): ListRow => ({
      value: text(card.id), label: text(card.name), detail: text(card.detail), ...(card.state === 'default' ? { state: 'used by default' } : {}),
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'payments.cards' }, rows: { from: 'data.cards', value: 'id', label: 'name', detail: 'detail' } },
});

defineList<CommandActionContext>({
  name: REPEAT_PURCHASES_LIST,
  async read(ctx) {
    if (!binding) return [];
    const answer = await runDaemonCapability('payments.repeats', {}, ctx, binding);
    return rowsOf(answer.data, 'authorizations').map((row): ListRow => ({
      value: text(row.id), label: text(row.name), detail: text(row.detail), ...(row.state === 'ended' ? { state: 'ended' } : {}),
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'payments.repeats' }, rows: { from: 'data.authorizations', value: 'id', label: 'name', detail: 'detail' } },
});

defineList<CommandActionContext>({
  name: PAYMENT_SHOPS_LIST,
  async read(ctx) {
    if (!binding) return [];
    const answer = await binding.daemon(ctx).invoke<{ readonly purchases?: unknown }>('payments.purchases.list', {});
    const purchases = Array.isArray(answer.purchases) ? answer.purchases as readonly Readonly<Record<string, unknown>>[] : [];
    const seen = new Map<string, number>();
    for (const purchase of purchases) {
      const shop = text(purchase.merchantDomain);
      if (shop) seen.set(shop, (seen.get(shop) ?? 0) + 1);
    }
    return [...seen].map(([shop, count]): ListRow => ({ value: shop, label: shop, state: `${count} purchase${count === 1 ? '' : 's'}` }));
  },
  operator: { method: 'payments.purchases.list', input: {}, rows: { from: 'purchases', value: 'merchantDomain', label: 'merchantDomain' } },
});
