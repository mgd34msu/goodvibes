/**
 * group-work.ts, work definitions a group keeps on its authority record and
 * runs on ONE machine: the holder of the `automation` role (roles.ts).
 *
 * A schedule, a reminder or a url watcher made on any machine of a group is a
 * `job:<family>/<id>` entry on the record, so it is listed on every machine,
 * and its timer is armed only where the role is held. Removing one is a
 * revocation, never a deletion: a machine that slept through it cannot bring
 * it back. The planned time of the last occurrence a holder started travels
 * with the entry and only rises, and a holder writes it before it starts the
 * run, so a new holder neither runs that occurrence again nor skips the next.
 *
 * Outside a group (clustering off, or a machine that coordinates elections but
 * joined no group) nothing here runs: the work stays the machine's own, at the
 * cost it had before.
 *
 * Every write takes the record's own path (authority-record-file.ts), which
 * carries it to the other machines at once (authority-sync.ts).
 */
import type { AuthorityChange, AuthorityRecordFile } from './authority-record-file.js';
import type { AuthorityEntry, AuthorityKey, AuthorityView } from './authority-record.js';
import type { ClusterRoles } from './roles.js';

export interface GroupWorkLink {
  readonly file: AuthorityRecordFile;
  readonly roles: Pick<ClusterRoles, 'holds' | 'coordinated' | 'onRoleChange'>;
}

/**
 * True when this machine shares its work with a group: it coordinates with
 * others and its record belongs to a group. A record that cannot be read
 * counts as shared, so the work runs only where the role is held rather than
 * on every machine at once.
 */
export function groupWorkShared(link: GroupWorkLink | undefined): link is GroupWorkLink {
  if (!link || !link.roles.coordinated()) return false;
  const view = link.file.view();
  return view === null || view.record.scope.groupId !== null;
}

/** JSON with object keys sorted, so two copies of one definition compare equal whatever order they were built in. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().filter((key) => record[key] !== undefined).map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

export type GroupJobFamilyName = 'automation' | 'watcher';

/** One piece of work as the record carries it. */
export interface GroupJobItem {
  readonly id: string;
  readonly definition: Readonly<Record<string, unknown>>;
  readonly lastOccurrenceAt: number;
}

interface Known { readonly definition: string; readonly lastOccurrenceAt: number }

/** What the record holds that this machine does not, and what this machine holds that the record does not. */
export interface GroupJobDifference {
  /** Live entries to take in: new here, or changed since this machine last saw them. */
  readonly adopt: readonly GroupJobItem[];
  /** Ids the group removed that this machine still holds. */
  readonly remove: readonly string[];
  /** Items to write: ones the record has never had (made before this machine joined), or whose started occurrence the record has not heard of. */
  readonly seed: readonly GroupJobItem[];
}

/** One family of group work on the record: automation jobs, or url watchers. */
export class GroupJobFamily {
  /** Per item, the definition and occurrence this machine last wrote or took from the record. */
  private readonly known = new Map<string, Known>();

  constructor(readonly link: GroupWorkLink, readonly family: GroupJobFamilyName) {}

  shared(): boolean {
    return groupWorkShared(this.link);
  }

  /**
   * True when this machine holds the automation role AND holds the group's
   * record: a machine back after longer than the retention may still list
   * work the group removed, so it arms nothing until it has taken the
   * group's record (authority-sync.ts).
   */
  holdsRole(): boolean {
    return this.link.roles.holds('automation') && this.caughtUp();
  }

  private caughtUp(): boolean {
    const groupId = this.link.file.view()?.record.scope.groupId;
    return !groupId || this.link.file.syncStanding(groupId) === 'current';
  }

  recordId(id: string): string {
    return `${this.family}/${id}`;
  }

  private key(id: string): AuthorityKey {
    return `job:${this.recordId(id)}`;
  }

  private itemId(key: AuthorityKey): string | null {
    const prefix = `job:${this.family}/`;
    return key.startsWith(prefix) ? key.slice(prefix.length) : null;
  }

  private entries(view: AuthorityView): AuthorityEntry<'job'>[] {
    return view.list('job').filter((entry) => entry.public.family === this.family && entry.id.startsWith(`${this.family}/`));
  }

  private toItem(entry: AuthorityEntry<'job'>): GroupJobItem {
    return { id: entry.id.slice(this.family.length + 1), definition: entry.public.definition, lastOccurrenceAt: entry.public.lastOccurrenceAt || 0 };
  }

  private remember(item: GroupJobItem): void {
    this.known.set(item.id, { definition: canonicalJson(item.definition), lastOccurrenceAt: item.lastOccurrenceAt });
  }

  /** True when `item` says nothing the record entry does not already hold. */
  private covered(entry: { readonly definition: string; readonly lastOccurrenceAt: number }, item: GroupJobItem): boolean {
    return entry.definition === canonicalJson(item.definition) && item.lastOccurrenceAt <= entry.lastOccurrenceAt;
  }

  /** The last started occurrence the record holds for an item; -1 when it is not on the record or was removed. */
  occurrenceOnRecord(id: string): number {
    const view = this.link.file.view();
    const entry = view?.entry('job', this.recordId(id));
    if (!view || !entry || view.isRevoked(this.key(id))) return -1;
    return entry.public.lastOccurrenceAt || 0;
  }

  /** Note that this machine took `item` from the record, so it is not written back. */
  adopted(item: GroupJobItem): void {
    this.remember(item);
  }

  /**
   * Hear about entries of this family changed by another machine or process.
   * `caughtUp` is true on the change that brought this machine back in step
   * with its group, when the work it held back can be armed.
   */
  onRemoteChange(listener: (ids: readonly string[], caughtUp: boolean) => void): () => void {
    let wasCaughtUp = this.caughtUp();
    return this.link.file.onChange((notice) => {
      if (notice.local) return;
      const nowCaughtUp = this.caughtUp();
      const caughtUp = nowCaughtUp && !wasCaughtUp;
      wasCaughtUp = nowCaughtUp;
      const ids = [...notice.keys, ...notice.cascade].map((key) => this.itemId(key)).filter((id): id is string => id !== null);
      if (ids.length > 0 || caughtUp) listener([...new Set(ids)], caughtUp);
    });
  }

  /**
   * Compare this machine's items with the record. With `only`, just those ids
   * (a change heard from elsewhere); without, everything (start, or a role
   * change). An item changed on both sides takes the record's version: the
   * newer write in the group wins, and its occurrence never falls.
   */
  difference(local: ReadonlyMap<string, GroupJobItem>, only?: readonly string[]): GroupJobDifference {
    const view = this.link.file.view();
    if (!view) return { adopt: [], remove: [], seed: [] };
    const adopt: GroupJobItem[] = [], remove: string[] = [], seed: GroupJobItem[] = [];
    const onRecord = new Set<string>();
    const wanted = only ? new Set(only) : null;
    for (const entry of this.entries(view)) {
      const item = this.toItem(entry);
      onRecord.add(item.id);
      if (wanted && !wanted.has(item.id)) continue;
      const mine = local.get(item.id);
      if (view.isRevoked(`job:${entry.id}`)) {
        this.known.delete(item.id);
        if (mine) remove.push(item.id);
        continue;
      }
      if (mine && canonicalJson(mine.definition) === canonicalJson(item.definition)) {
        this.remember(item);
        // Only this machine's started occurrence is newer (its write was lost): send it.
        if (mine.lastOccurrenceAt > item.lastOccurrenceAt) seed.push(mine);
        continue;
      }
      adopt.push(mine ? { ...item, lastOccurrenceAt: Math.max(item.lastOccurrenceAt, mine.lastOccurrenceAt) } : item);
    }
    for (const [id, item] of local) {
      if (onRecord.has(id) || (wanted && !wanted.has(id))) continue;
      // Dropped by this machine on returning too far behind its group: the
      // group removed it while this machine was away, so it goes here too.
      if (this.link.file.isForgotten(this.key(id))) {
        this.known.delete(id);
        remove.push(id);
      } else if (!wanted) seed.push(item);
    }
    return { adopt, remove, seed };
  }

  /**
   * Write each item whose definition or occurrence moved since this machine
   * last saw its entry, in one record write. An entry another machine changed
   * in the meantime is left alone (its change is adopted here instead), and a
   * removed one is never written again. Throws when the record cannot be
   * written; the caller decides whether that stops the work.
   */
  async publish(items: readonly GroupJobItem[]): Promise<void> {
    const pending = items.filter((item) => {
      const known = this.known.get(item.id);
      return !known || !this.covered(known, item);
    });
    if (pending.length === 0) return;
    const before = new Map(pending.map((item) => [item.id, this.known.get(item.id)]));
    try {
      await this.link.file.write((view) => {
        const changes: AuthorityChange<null>[] = [];
        for (const item of pending) {
          const entry = view.entry('job', this.recordId(item.id));
          const known = this.known.get(item.id);
          if (entry?.revoked || (entry && view.isRevoked(this.key(item.id)))) continue;
          if (!entry) {
            if (known) continue; // compacted after a removal: never brought back
            changes.push({ kind: 'issue', value: null, entries: [{ kind: 'job', id: this.recordId(item.id), public: { family: this.family, definition: item.definition, lastOccurrenceAt: item.lastOccurrenceAt } }] });
            this.remember(item);
            continue;
          }
          const current = { definition: canonicalJson(entry.public.definition), lastOccurrenceAt: entry.public.lastOccurrenceAt || 0 };
          if (this.covered(current, item)) { this.remember({ ...item, lastOccurrenceAt: current.lastOccurrenceAt }); continue; }
          // Changed elsewhere since this machine last saw it: the newer edit stands.
          if (!known || known.definition !== current.definition || known.lastOccurrenceAt !== current.lastOccurrenceAt) continue;
          const lastOccurrenceAt = Math.max(item.lastOccurrenceAt, current.lastOccurrenceAt);
          changes.push({ kind: 'update', key: this.key(item.id), narrowsOrWidens: false, value: null, patch: { definition: item.definition, lastOccurrenceAt } });
          this.remember({ ...item, lastOccurrenceAt });
        }
        const decided: AuthorityChange<null> = changes.length > 0 ? { kind: 'many', changes, value: null } : { kind: 'none', value: null };
        return decided;
      });
    } catch (error) {
      for (const [id, known] of before) {
        if (known) this.known.set(id, known);
        else this.known.delete(id);
      }
      throw error;
    }
  }

  /** Remove an item in the group. Terminal: no machine runs or lists it again. */
  async remove(id: string, by: string, reason: string): Promise<void> {
    this.known.delete(id);
    await this.link.file.write((view) => {
      const entry = view.entry('job', this.recordId(id));
      const decided: AuthorityChange<null> = entry && !entry.revoked
        ? { kind: 'revoke', key: this.key(id), by, reason, value: null }
        : { kind: 'none', value: null };
      return decided;
    });
  }
}
