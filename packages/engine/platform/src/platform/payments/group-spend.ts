/**
 * group-spend.ts, a group's daily spend on the authority record.
 *
 * Each machine keeps its own durable ledger (host/budget-store.ts) and writes
 * its total per day into one `budget-spend` record entry, in its own slot.
 * The record merges slots by max (authority-record.ts), so no machine's spend
 * is lost to another's write, and every machine that holds the payments role
 * counts what the others spent that day before it spends. A role that moves
 * mid-day therefore leaves one daily budget for the group, not one per holder.
 */
import type { AuthorityRecordFile } from '../cluster/authority-record-file.js';
import { logger } from '../utils/logger.js';
import type { GroupSpendSource } from './budget.js';
import type { DayKey } from './day.js';
import type { CurrencyCode } from './types.js';

/** The record could not be read: no machine spends against a group total it cannot see. */
export class GroupSpendUnavailableError extends Error {
  override readonly name = 'GroupSpendUnavailableError';
  constructor() { super('The group\'s spend record could not be read, so nothing is bought until it can be.'); }
}

type Pools = { readonly item: number; readonly overage: number; readonly tolerance: number };

/**
 * One entry per day AND currency: a currency change mid-day starts a new
 * group pool, and what was spent in the old currency stays in its own entry.
 */
function spendEntryId(day: DayKey, currency: CurrencyCode): string {
  return `${day}:${currency}`;
}

export function recordGroupSpend(file: AuthorityRecordFile): GroupSpendSource {
  return {
    othersSpent: (day: DayKey, currency: CurrencyCode) => {
      const view = file.view();
      if (!view) throw new GroupSpendUnavailableError();
      const entry = view.entry('budget-spend', spendEntryId(day, currency));
      const totals = { item: 0, overage: 0, tolerance: 0 };
      if (!entry) return totals;
      for (const [node, pools] of Object.entries(entry.public.spentByNode)) {
        if (node === file.nodeId) continue;
        totals.item += pools['item'] ?? 0;
        totals.overage += pools['overage'] ?? 0;
        totals.tolerance += pools['tolerance'] ?? 0;
      }
      return totals;
    },
    publish: (day: DayKey, currency: CurrencyCode, own: Pools) => {
      const id = spendEntryId(day, currency);
      void file.write((view) => {
        const entry = view.entry('budget-spend', id);
        const slot = { item: own.item, overage: own.overage, tolerance: own.tolerance };
        if (!entry) {
          return { kind: 'issue', value: null, entries: [{ kind: 'budget-spend', id,
            public: { dayKey: day, currency, spentByNode: { [file.nodeId]: slot } } }] };
        }
        const mine = entry.public.spentByNode[file.nodeId] ?? {};
        // A slot only rises: a pruned local ledger never lowers what the group was told.
        const raised = { item: Math.max(mine['item'] ?? 0, slot.item), overage: Math.max(mine['overage'] ?? 0, slot.overage), tolerance: Math.max(mine['tolerance'] ?? 0, slot.tolerance) };
        if (raised.item === (mine['item'] ?? 0) && raised.overage === (mine['overage'] ?? 0) && raised.tolerance === (mine['tolerance'] ?? 0) && entry.public.spentByNode[file.nodeId]) {
          return { kind: 'none', value: null };
        }
        return { kind: 'update', key: `budget-spend:${id}`, narrowsOrWidens: false, value: null,
          patch: { spentByNode: { ...entry.public.spentByNode, [file.nodeId]: raised } } };
      }).catch((error: unknown) => logger.warn('This machine\'s spend could not be written to the group\'s spend record; the other machines will count it once it is', { day, error: String(error) }));
    },
  };
}
