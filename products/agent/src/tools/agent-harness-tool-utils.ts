import type { AgentHarnessToolArgs } from './agent-harness-tool-types.ts';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import { harnessCatalogInvocationAuthority } from '@goodvibes-jev/engine/terminal-shell/agent-turn/catalog-ingress';
import { inventoryDisclosure, withInventoryDisclosure } from '@goodvibes-jev/engine/terminal-shell/agent-turn/inventory-disclosure';

/**
 * Shows a path under the home directory as `~/...`. The account name and
 * layout of the home directory are not needed by a model or a provider log;
 * the owner can still find the file.
 */
export { homeRelativePath } from '@goodvibes-jev/engine/terminal-shell/agent-turn/home-path';

export function readString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function settingLookupArgs(args: AgentHarnessToolArgs) {
  return {
    key: readString(args.key) || undefined,
    target: readString(args.target) || undefined,
    query: readString(args.query) || undefined,
    category: readString(args.category) || undefined,
    prefix: readString(args.prefix) || undefined,
    includeHidden: args.includeHidden === true,
  };
}

/**
 * Reads a caller-supplied page size, bounded by a ceiling.
 *
 * `max` defaults to 500 because that suits the small catalogs, but a surface
 * whose catalog can outgrow it must pass its own, a ceiling below the catalog
 * silently drops the tail. Whatever ceiling applies, the caller of this
 * function still owes the response a `returned`/`total` pair (see
 * {@link catalogEnvelope}); clamping quietly is the failure this parameter
 * exists to make impossible to reach by accident.
 */
export function readLimit(value: unknown, fallback: number, max = 500): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return Math.max(1, Math.min(max, fallback));
  return Math.max(1, Math.min(max, Math.trunc(parsed)));
}

/**
 * The page a large catalog (settings, workspace actions, operator methods)
 * returns when the caller names no `limit`. A whole catalog runs to hundreds
 * of thousands of characters, past the cut every tool result gets, and a cut
 * document loses its own `returned`/`total`; a page that says where the next
 * one starts never reaches that cut.
 */
export const CATALOG_PAGE_SIZE = 50;

/** The largest page a caller can ask a large catalog for; it stays under the tool-result cut. */
export const CATALOG_PAGE_MAX = 100;

/** Reads a caller-supplied starting row: a whole number from 0, 0 when absent or unreadable. */
export function readOffset(value: unknown): number {
  const parsed = typeof value === 'string' && value.trim() ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

/** Where a paged catalog page starts, and how many rows matched in all. */
export interface CatalogPage {
  readonly offset: number;
  readonly matched: number;
}

export function readFieldMap(value: unknown): Readonly<Record<string, string>> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, typeof entry === 'string' ? entry : String(entry)]));
}

/** Filter arguments a catalog query applied, by argument name. */
export type CatalogFilters = Readonly<Record<string, string | undefined>>;

/**
 * Builds the `{ <key>: [...], returned, total }` envelope every catalog mode
 * returns, and makes an empty page explain itself.
 *
 * A catalog used to answer `{"actions": [], "returned": 0, "total": 463}`, it
 * reported that hundreds of entries exist and named none of them, and it never
 * echoed the filter that had excluded them. A caller who passed, say,
 * `category:"actions"` (matching no category) could not tell its own argument
 * was the cause, so the only way forward was to guess repeatedly. The envelope
 * now always echoes the filters it applied, and when a page comes back empty it
 * says why and what to send instead.
 *
 * @param key      - Field name holding the page (e.g. 'actions', 'tools').
 * @param items    - The page itself.
 * @param total    - How many entries exist in the whole catalog.
 * @param filters  - Filter arguments that were applied, by argument name.
 * @param discovery - Route that lists everything, quoted in the guidance.
 * @param page     - For a paged catalog: where the page starts and how many
 *                   matched, so the envelope names `nextOffset`.
 */
/**
 * Collects the named filter arguments a catalog query received, dropping the
 * ones that were not supplied, ready for {@link catalogEnvelope}.
 */
export function catalogFilters(
  args: object,
  names: readonly string[],
): CatalogFilters {
  const source = args as Readonly<Record<string, unknown>>;
  const filters: Record<string, string> = {};
  for (const name of names) {
    const value = readString(source[name]);
    if (value) filters[name] = value;
  }
  return filters;
}

/**
 * The other catalogs a query could be asked of, quoted when one comes back
 * empty.
 *
 * A capability lives on exactly one of these surfaces, and the model has no way
 * to know which before it looks. Asking `mode:"tools"` for "payment" returns
 * nothing, correctly, there is no payments tool, and that empty page was read
 * as "this platform cannot take a payment", while a `payments.*` settings
 * section and a `/payments` command sat one mode away. An empty page now says
 * where else to look.
 */
const SIBLING_CATALOG_ROUTES = 'agent_harness mode:"settings"|"commands"|"workspace_actions"|"tools"|"modes"';

export function catalogEnvelope(
  key: string,
  items: readonly unknown[],
  total: number,
  filters: CatalogFilters = {},
  discovery?: string,
  page?: CatalogPage,
): Record<string, unknown> {
  const applied = Object.entries(filters)
    .filter((entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].length > 0);

  const searched = applied.some(([name]) => name === 'query' || name === 'target');
  const elsewhere = searched
    ? ` A capability may live on another surface: ${SIBLING_CATALOG_ROUTES} each search a different one.`
    : '';
  const nextOffset = page && page.offset + items.length < page.matched ? page.offset + items.length : undefined;

  // The counts, the next page and the note come before the rows, so a reader
  // that sees only the start of the answer still knows what it holds.
  const envelope: Record<string, unknown> = {
    returned: items.length,
    total,
    ...(page ? { matched: page.matched, offset: page.offset } : {}),
    ...(nextOffset !== undefined ? { nextOffset } : {}),
    ...(applied.length > 0 ? { appliedFilters: Object.fromEntries(applied) } : {}),
  };
  const withRows = (): Record<string, unknown> => {
    envelope[key] = items;
    return envelope;
  };

  // An empty catalog still owes the reader a sentence, and that sentence is not
  // about the filter: `total` is the catalog's own size (which the settings
  // page finally reports), so zero here means the catalog holds nothing and no
  // other arguments would change that. It used to return with three bare
  // fields, and `{"x": [], "returned": 0, "total": 0}` as a whole answer is the
  // shape a reader takes for "this platform cannot do that".
  if (total === 0) {
    envelope.note = `This catalog holds no ${key} at all, so no argument emptied this page.${elsewhere}`;
    return withRows();
  }

  // A shortened or emptied page says so, in the one wording every list uses.
  const context = [
    ...(nextOffset !== undefined ? [`More match: repeat the same call with offset:${String(nextOffset)} for the next page.`] : []),
    ...(items.length === 0 && elsewhere ? [elsewhere.trim()] : []),
  ];
  const disclosure = inventoryDisclosure({
    subject: key, returned: items.length, total, filters: Object.fromEntries(applied),
    listAllRoute: discovery ?? 'the same call without filters or limit',
    ...(context.length > 0 ? { context } : {}),
  });
  if (disclosure) { envelope.note = disclosure.note; envelope.listAllRoute = disclosure.listAllRoute; }
  return withRows();
}

/**
 * Every harness list that withholds rows says so, whichever mode built it: a
 * payload carrying `returned` < `total` and no note of its own gets the shared
 * inventory disclosure. A key lookup per result; nothing when nothing was withheld.
 */
function discloseWithheldRows(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const payload = value as Record<string, unknown>;
  const { returned, total } = payload;
  if (typeof returned !== 'number' || typeof total !== 'number' || returned >= total
    || typeof payload.note === 'string' || typeof payload.listAllRoute === 'string') return value;
  const subject = Object.entries(payload).find(([, entry]) => Array.isArray(entry) && entry.length === returned)?.[0] ?? 'records';
  const applied = payload.appliedFilters && typeof payload.appliedFilters === 'object' && !Array.isArray(payload.appliedFilters)
    ? payload.appliedFilters as Record<string, unknown> : {};
  return withInventoryDisclosure(payload, { subject, returned, total,
    filters: { ...applied, query: payload.query, target: payload.target },
    listAllRoute: 'the same call without query, target, filters or limit' });
}

export function output(value: unknown): { readonly success: true; readonly output: string } {
  return {
    success: true,
    output: typeof value === 'string' ? value : JSON.stringify(discloseWithheldRows(value), null, 2),
  };
}

/**
 * Reports the outcome of a nested model-tool dispatch. A failed nested call is
 * a failed tool result at this layer too, so retry policy, tool cards and
 * execution history do not record a success for an effect that did not happen.
 * The status body stays in `output` for callers that read it.
 */
export function nestedToolOutput(
  result: { readonly success: boolean },
  body: Readonly<Record<string, unknown>>,
): { readonly success: boolean; readonly output: string; readonly error?: string } {
  const text = JSON.stringify({ status: result.success ? 'executed_model_tool' : 'model_tool_failed', ...body }, null, 2);
  if (result.success) return { success: true, output: text };
  const reason = typeof body.error === 'string' && body.error.trim() ? body.error : 'The nested model tool reported a failure.';
  return { success: false, output: text, error: `${typeof body.tool === 'string' ? `${body.tool} failed: ` : ''}${reason}` };
}

/** What an effect handler returns: its own body, and whether the effect happened. */
export interface EffectResult {
  readonly done: boolean;
  readonly [field: string]: unknown;
}

/**
 * Reports the result of an effect handler. Every effect handler says whether
 * its effect happened with `done` (a real no-op such as nothing to recover is
 * `done: true`). Only `done: true` is a successful tool result; anything else
 * fails, with the handler's own body kept in `output`, so the result flag and
 * tool cards agree with what happened.
 */
export function effectOutput(value: EffectResult): { readonly success: boolean; readonly output: string; readonly error?: string } {
  const body = typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Readonly<Record<string, unknown>> : null;
  if (body?.done === true) return output(value);
  const status = typeof body?.status === 'string' ? body.status : 'not_done';
  const reason = body ? [body.error, body.reason, body.usage, body.note].find((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0) : undefined;
  return { success: false, output: JSON.stringify(value, null, 2), error: `${status}: ${reason ?? (Array.isArray(body?.candidates) ? 'the request matched more than one target, so nothing was done. Repeat with one exact id from candidates.' : 'the requested effect did not happen.')}` };
}

export function error(message: string): { readonly success: false; readonly error: string } { return { success: false, error: message }; }

function admissionRefusal(action: string): string {
  return `${action} was not run and nothing was changed: this call carries no permission-gate admission for that effect (it was forwarded or nested without one). confirm and explicitUserRequest grant nothing. Make the same call directly as an ordinary tool call; the permission gate decides it as it decides any change.`;
}

export function requireConfirmedAction(args: Record<string, unknown>, options: Parameters<Tool['execute']>[1], action: string): string | null {
  if (!harnessCatalogInvocationAuthority(args, options)) return admissionRefusal(action);
  const mode = args.mode;
  const outward = typeof mode === 'string' && ['run_local_model_smoke', 'run_memory_refinement',
    'remote_pair_approve', 'remote_pair_reject', 'remote_peers_invoke', 'remote_work_cancel', 'inbox_labels_apply'].includes(mode);
  return harnessCatalogInvocationAuthority(args, options, outward ? 'send' : 'write')
    ? null : admissionRefusal(action);
}
