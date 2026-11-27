/**
 * Cursor-based pagination utilities for daemon route handlers.
 *
 * Cursor format: opaque base64url-encoded JSON `{id: string, createdAt: number}`
 * encoding the stable sort position. Cursors remain valid across inserts
 * (no offset-based pagination).
 *
 * @public
 */

import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Whether the caller of the request being served may reach one record, by kind (`chat`, `session`, `schedule`,
 * `schedule-run`, `approval`, `task`, `checkpoint`, `trigger`, `rule`, `memory-record`, `artifact`; `project` with a
 * project's folder for a row kept by the project it belongs to) and id: the one
 * check of what a caller may reach (platform control-plane/caller-reach.ts), set by the daemon around a call of a caller
 * that is not the owner himself. A paged list keeps only what this keeps BEFORE it cuts its page, so a page, its
 * `hasMore`, its cursor and its totals are about what the caller can reach.
 *
 * @public
 */
export type RecordReachFilter = (kind: string, id: string, owner?: RecordReachOwner) => boolean;

/**
 * A record's owner as the list holding it already knows it (its project, who made it), so the filter does not look
 * it up again: the same facts the kind's own lookup would give.
 *
 * @public
 */
export interface RecordReachOwner {
  readonly project: string | null;
  readonly madeBy?: string | undefined;
}

const recordReachScope = new AsyncLocalStorage<RecordReachFilter>();

/**
 * Serve `serve` with `filter` as the reach of the request's caller (absent: the owner, who reaches everything).
 *
 * @public
 */
export function withRecordReach<T>(filter: RecordReachFilter | null | undefined, serve: () => T): T {
  return filter ? recordReachScope.run(filter, serve) : serve();
}

/**
 * The request's caller's reach (see {@link RecordReachFilter}), for a store that pages inside itself and takes a
 * filter; undefined for the owner, or when no rule was set.
 *
 * @public
 */
export function currentRecordReach(): RecordReachFilter | undefined {
  return recordReachScope.getStore();
}

/**
 * The items the request's caller may reach, before a list is paged or counted (the same array when the caller is the
 * owner, or no rule was set).
 *
 * @public
 */
export function keepReachable<T>(items: readonly T[], kind: string, idOf: (item: T) => string | undefined): readonly T[] {
  const filter = recordReachScope.getStore();
  if (!filter) return items;
  return items.filter((item) => {
    const id = idOf(item);
    return typeof id === 'string' && filter(kind, id);
  });
}

/**
 * The items the request's caller may reach, for a list whose items name several records (a route binding: its
 * session, schedule and run): an item is kept when it names at least one and the caller may reach every one it names.
 *
 * @public
 */
export function keepReachableNaming<T>(items: readonly T[], named: readonly (readonly [kind: string, idOf: (item: T) => string | undefined])[]): readonly T[] {
  const filter = recordReachScope.getStore();
  if (!filter) return items;
  return items.filter((item) => {
    const ids = named.map(([kind, idOf]) => [kind, idOf(item)] as const).filter((entry): entry is readonly [string, string] => typeof entry[1] === 'string' && entry[1] !== '');
    return ids.length > 0 && ids.every(([kind, id]) => filter(kind, id));
  });
}

/**
 * Paginated response envelope. Returned by list endpoints that support
 * cursor-based pagination.
 *
 * @public
 */
export interface PaginatedResponse<T> {
  /** The page of items. */
  readonly items: readonly T[];
  /**
   * Opaque cursor to pass as `?cursor=` to retrieve the next page.
   * Absent when this is the last page.
   */
  readonly nextCursor?: string | undefined;
  /** Whether there are more items beyond this page. */
  readonly hasMore: boolean;
}

/** Internal cursor payload. @internal */
interface CursorPayload {
  readonly id: string;
  readonly createdAt?: number | undefined;
}

/**
 * Encode a cursor from a stable sort position.
 *
 * @param id - The item id used as the tiebreak.
 * @param createdAt - Optional creation timestamp for secondary sort key.
 * @returns Opaque base64url cursor string.
 * @public
 */
export function encodeCursor(id: string, createdAt?: number): string {
  const payload: CursorPayload = createdAt !== undefined ? { id, createdAt } : { id };
  const json = JSON.stringify(payload);
  // base64url encode (no padding, URL-safe characters)
  return Buffer.from(json, 'utf8').toString('base64url');
}

/**
 * Decode an opaque cursor string.
 *
 * @param raw - The cursor string from `?cursor=`.
 * @returns The decoded payload, or `null` if the cursor is invalid.
 * @public
 */
export function decodeCursor(raw: string): CursorPayload | null {
  try {
    const json = Buffer.from(raw, 'base64url').toString('utf8');
    const parsed: unknown = JSON.parse(json);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'id' in parsed &&
      typeof (parsed as Record<string, unknown>).id === 'string'
    ) {
      const p = parsed as Record<string, unknown>;
      return {
        id: p.id as string,
        createdAt: typeof p.createdAt === 'number' ? p.createdAt : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Options for `paginateItems`.
 * @public
 */
export interface PaginateItemsOptions {
  /**
   * Set to `true` when items are sorted **descending** by `createdAt` (newest
   * first).  This inverts the insertion-point comparison used during
   * deleted-cursor recovery so that the correct position is found regardless
   * of sort direction.  Defaults to `false` (ascending / oldest-first).
   */
  readonly descending?: boolean | undefined;
}

/**
 * Apply cursor-based pagination to an already-sorted array of items.
 *
 * Items must be sorted in a stable order. The cursor encodes the last-seen
 * item's `id` (and optionally `createdAt`). Items after the cursor position
 * are returned.
 *
 * ### Deleted-cursor recovery
 * When the cursor's `id` is not found in the current page (i.e. the item was
 * deleted mid-walk), the implementation falls back to the `createdAt`
 * timestamp in the cursor to locate the insertion point.
 *
 * - **Ascending** (default, `options.descending` falsy): finds the first item
 *   whose own `createdAt` is **strictly greater** than the cursor's
 *   `createdAt`, then starts the page from that position.
 * - **Descending** (`options.descending: true`): finds the first item whose
 *   own `createdAt` is **strictly less** than the cursor's `createdAt`, which
 *   is the correct forward position in a newest-first sequence.
 *
 * Without `createdAt` in the cursor the position cannot be found, and the
 * cursor is refused: restarting at the first item would hand the caller items
 * it already has, and a walk that keeps restarting never ends.
 *
 * Callers that need stable recovery across deletions should pass `getCreatedAt`
 * and ensure cursors are encoded with `createdAt`.  Callers whose store sorts
 * descending must also pass `options.descending: true`.
 *
 * @param items - Sorted array of all items.
 * @param limit - Maximum number of items to return (already clamped by caller).
 * @param rawCursor - Raw cursor string from the request (`?cursor=`).
 * @param getId - Extract the item's id.
 * @param getCreatedAt - Optional: extract the item's creation timestamp (ms since epoch).
 * @param options - Optional pagination options (e.g. sort direction).
 * @returns `PaginatedResponse<T>`, or an error string for a cursor that is invalid or cannot be placed.
 * @public
 */
export function paginateItems<T>(
  items: readonly T[],
  limit: number,
  rawCursor: string | null,
  getId: (item: T) => string,
  getCreatedAt?: (item: T) => number | undefined,
  options?: PaginateItemsOptions,
): PaginatedResponse<T> | { readonly error: string } {
  if (getCreatedAt) {
    const direction = options?.descending ? -1 : 1;
    items = [...items].sort((a, b) => direction * ((getCreatedAt(a) ?? 0) - (getCreatedAt(b) ?? 0)
      || (getId(a) < getId(b) ? -1 : getId(a) > getId(b) ? 1 : 0)));
  }
  let startIndex = 0;

  if (rawCursor !== null) {
    const decoded = decodeCursor(rawCursor);
    if (!decoded) {
      return { error: `Invalid cursor: ${rawCursor}` };
    }
    const afterIndex = items.findIndex((item) => getId(item) === decoded.id);
    if (afterIndex === -1) {
      // Recover the cursor's insertion point using the same timestamp/id order.
      if (decoded.createdAt !== undefined && getCreatedAt !== undefined) {
        const descending = options?.descending === true;
        const insertionIndex = items.findIndex(
          (item) => {
            const ts = getCreatedAt(item);
            if (ts === undefined) return false;
            const comparison = ts - decoded.createdAt! || (getId(item) < decoded.id ? -1 : getId(item) > decoded.id ? 1 : 0);
            return descending ? comparison < 0 : comparison > 0;
          },
        );
        startIndex = insertionIndex === -1 ? items.length : insertionIndex;
      } else {
        return { error: 'Cursor expired: the item it points at no longer exists. Restart the listing without a cursor.' };
      }
    } else {
      startIndex = afterIndex + 1;
    }
  }

  const page = items.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < items.length;

  const lastItem = page[page.length - 1];
  const nextCursor = hasMore && lastItem !== undefined
    ? encodeCursor(
        getId(lastItem),
        getCreatedAt !== undefined ? getCreatedAt(lastItem) : undefined,
      )
    : undefined;

  return { items: page, nextCursor, hasMore };
}

/**
 * Check whether the request URL contains pagination parameters.
 *
 * Every listing answers the same envelope with or without them; this only
 * tells a listing whether the caller bounded it.
 *
 * @public
 */
export function hasPaginationParams(url: URL): boolean {
  return url.searchParams.has('limit') || url.searchParams.has('cursor');
}

/**
 * One listing's response body: the `PaginatedResponse` envelope plus the
 * listing's older key (`sources`, `jobs`, ...) holding the same page, so a
 * client that reads the old key keeps working and one that reads `items`
 * never sees a different key because it passed `limit`.
 *
 * @public
 */
export function listingEnvelope<T>(
  legacyKey: string,
  page: PaginatedResponse<T>,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    items: page.items,
    hasMore: page.hasMore,
    ...(page.nextCursor !== undefined ? { nextCursor: page.nextCursor } : {}),
    [legacyKey]: page.items,
    ...extra,
  };
}
