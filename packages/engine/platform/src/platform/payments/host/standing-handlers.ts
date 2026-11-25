/**
 * standing-handlers.ts, `payments.standing.list`, `payments.standing.create` and
 * `payments.standing.delete`: the owner's standing authorisations for
 * purchases a schedule or trigger starts (standing-store.ts).
 *
 * Adding and removing are the owner's own acts: the registration puts both
 * behind the confirmation gate (`confirm: true` AND the explicit-user-request
 * context) and their descriptors are owner-only, so an agent cannot write one.
 * Listing is a read an agent makes to learn which entry a scheduled purchase
 * names (`standingId` on `payments.checkout.begin`).
 */
import { formatMinorUnits } from '../message.js';
import { readPaymentsServiceConfig } from '../payments-config.js';
import { purchaseDisposition } from '../operation-view.js';
import type { CurrencyCode } from '../types.js';
import type { TypedHandler } from '../../control-plane/host-handlers.js';
import { GatewayVerbError } from '../../control-plane/routes/gateway-verb-error.js';
import { noteListChanged } from '../../runtime/list-changes.js';
import type { DurablePaymentOperations } from './operation-store.js';
import type { PaymentsHandlerDeps } from './register.js';
import {
  StandingAuthorizationError,
  type DaemonStandingAuthorizations,
  type StandingAuthorization,
  type StandingUseCounter,
} from './standing-store.js';

/**
 * What one purchase admitted under an entry counts against its period, read
 * from the operations store. Unbought counts nothing, completed counts its
 * total, anything still open (or unreadable) counts the most it may come to.
 */
export function standingUseCounter(operations: Pick<DurablePaymentOperations, 'get'>): StandingUseCounter {
  return use => {
    let operation: ReturnType<typeof operations.get>;
    try { operation = operations.get(use.purchaseId); } catch { return use.capMinorUnits; }
    if (!operation) return use.capMinorUnits;
    const outcome = purchaseDisposition(operation).outcome;
    if (operation.state === 'refused' || operation.state === 'cancelled' || operation.state === 'failed' || operation.state === 'interrupted') return 0;
    if (outcome.kind === 'owner-confirmed' && outcome.finding === 'not-purchased') return 0;
    if (operation.state === 'completed') return operation.totalMinorUnits ?? use.capMinorUnits;
    return Math.max(operation.totalMinorUnits ?? 0, use.capMinorUnits);
  };
}

function asRecord(body: unknown): Record<string, unknown> {
  return typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function invalid(field: string, requirement: string): GatewayVerbError {
  return new GatewayVerbError(`${field} ${requirement}`, 'INVALID_ARGUMENT', 400);
}

function unavailable(): GatewayVerbError {
  return new GatewayVerbError('Standing purchase authorisations are not kept on this payment host.', 'FAILED_PRECONDITION', 409);
}

function overStore<T>(run: () => T): T {
  try { return run(); }
  catch (error) {
    if (error instanceof StandingAuthorizationError) {
      throw new GatewayVerbError(error.message, error.kind === 'invalid' ? 'INVALID_ARGUMENT' : 'FAILED_PRECONDITION', error.kind === 'invalid' ? 400 : 409);
    }
    throw new GatewayVerbError('The standing purchase authorisations could not be used. Nothing was changed.', 'INTERNAL_ERROR', 500);
  }
}

/** The one line a surface shows for an entry, rendered by code from the stored numbers. */
export function describeStandingAuthorization(entry: StandingAuthorization, spentMinorUnits: number, nowMs: number): string {
  const currency = entry.currency as CurrencyCode;
  const left = Math.max(0, entry.maxPerPeriodMinorUnits - spentMinorUnits);
  const until = entry.expiresAtMs === null ? 'until removed'
    : entry.expiresAtMs > nowMs ? `until ${new Date(entry.expiresAtMs).toISOString().slice(0, 10)}`
      : `expired ${new Date(entry.expiresAtMs).toISOString().slice(0, 10)}`;
  return `"${entry.item}" from ${entry.merchants.join(', ')}: at most ${formatMinorUnits(entry.maxPerPurchaseMinorUnits, currency)} a purchase and `
    + `${formatMinorUnits(entry.maxPerPeriodMinorUnits, currency)} every ${String(entry.periodDays)} days `
    + `(${formatMinorUnits(left, currency)} left now), ${until}.`;
}

function view(entry: StandingAuthorization, spentMinorUnits: number, nowMs: number): Record<string, unknown> {
  return {
    id: entry.id,
    item: entry.item,
    merchants: [...entry.merchants],
    currency: entry.currency,
    maxPerPurchaseMinorUnits: entry.maxPerPurchaseMinorUnits,
    maxPerPeriodMinorUnits: entry.maxPerPeriodMinorUnits,
    periodDays: entry.periodDays,
    spentMinorUnits,
    leftMinorUnits: Math.max(0, entry.maxPerPeriodMinorUnits - spentMinorUnits),
    createdAt: new Date(entry.createdAtMs).toISOString(),
    expiresAt: entry.expiresAtMs === null ? null : new Date(entry.expiresAtMs).toISOString(),
    live: entry.expiresAtMs === null || entry.expiresAtMs > nowMs,
    summary: describeStandingAuthorization(entry, spentMinorUnits, nowMs),
  };
}

function readMerchants(value: unknown): string[] {
  if (typeof value === 'string') return value.split(/[,\s]+/).filter(Boolean);
  if (Array.isArray(value) && value.every(entry => typeof entry === 'string')) return value as string[];
  throw invalid('merchants', 'is required: one or more shop domains, as a list or comma separated.');
}

export function standingListHandler(deps: PaymentsHandlerDeps, operations: Pick<DurablePaymentOperations, 'get'>): TypedHandler<unknown, Record<string, unknown>> {
  return async () => {
    const store = deps.checkout.standing;
    if (!store) throw unavailable();
    const count = standingUseCounter(operations), nowMs = (deps.now ?? Date.now)();
    return overStore(() => ({ authorizations: store.list().map(entry => view(entry, store.spent(entry, count), nowMs)) }));
  };
}

export function standingCreateHandler(deps: PaymentsHandlerDeps, operations: Pick<DurablePaymentOperations, 'get'>): TypedHandler<unknown, Record<string, unknown>> {
  return async ({ body }) => {
    const store: DaemonStandingAuthorizations | undefined = deps.checkout.standing;
    if (!store) throw unavailable();
    const params = asRecord(body);
    const text = (field: string): string => {
      const value = params[field];
      if (typeof value !== 'string' || value.trim().length === 0) throw invalid(field, 'is required.');
      return value.trim();
    };
    const periodDays = params['periodDays'];
    if (typeof periodDays !== 'number' || !Number.isInteger(periodDays)) throw invalid('periodDays', 'must be a whole number of days.');
    const expires = params['expires'];
    if (expires !== undefined && typeof expires !== 'string') throw invalid('expires', 'must be a date such as 2027-06-30.');
    const currency = readPaymentsServiceConfig(deps.config).budgetCurrency;
    const input = {
      item: text('item'), merchants: readMerchants(params['merchants']),
      maxPerPurchase: text('maxPerPurchase'), maxPerPeriod: text('maxPerPeriod'), periodDays,
      ...(expires === undefined ? {} : { expires }),
    };
    const entry = overStore(() => store.add(input, currency));
    noteListChanged({ list: 'payments', change: 'created', id: entry.id });
    return { created: true, authorization: view(entry, store.spent(entry, standingUseCounter(operations)), (deps.now ?? Date.now)()) };
  };
}

export function standingDeleteHandler(deps: PaymentsHandlerDeps): TypedHandler<unknown, Record<string, unknown>> {
  return async ({ body }) => {
    const store = deps.checkout.standing;
    if (!store) throw unavailable();
    const id = asRecord(body)['id'];
    if (typeof id !== 'string' || id.trim().length === 0) throw invalid('id', 'is required: the id payments.standing.list answers (the Money place lists them).');
    const removed = overStore(() => store.remove(id.trim()));
    if (removed) noteListChanged({ list: 'payments', change: 'deleted', id: id.trim() });
    return { id: id.trim(), deleted: removed };
  };
}
