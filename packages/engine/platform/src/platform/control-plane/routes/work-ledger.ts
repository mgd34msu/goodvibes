import type { GatewayMethodCatalog } from '../method-catalog.js';
import type { GatewayMethodInvocation } from '../method-catalog-shared.js';
import type { WorkLedgerReadClient } from '../../workflow/work-ledger/index.js';
import { WorkLedgerAccessError, projectWorkLedgerReadEvent, type WorkLedgerReadEvent } from '../../workflow/work-ledger/types.js';
import {
  WORK_LEDGER_READ_SCOPE, WORK_LEDGER_HISTORY_PAGE_SIZE, WORK_LEDGER_READ_MAX_BYTES,
  workLedgerReadSnapshotSchema, type WorkLedgerHistoryPage,
} from '../method-catalog-work-ledger.js';
import { GatewayVerbError } from './gateway-verb-error.js';
import { readInvocationParams } from './invocation-params.js';
import { missingScopes } from '@goodvibes/engine/daemon-api/route-helpers';


function invalid(field: string): never {
  throw new GatewayVerbError(`Invalid ${field}`, 'INVALID_ARGUMENT', 400, field);
}
function cursor(value: unknown, field: string): number {
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return invalid(field);
  return value;
}
function params(invocation: GatewayMethodInvocation, reader: WorkLedgerReadClient, history: boolean): Record<string, unknown> {
  // Defense in depth: direct catalog invocations must not bypass scope auth. A caller below an admin reads a project given
  // to it: the dispatch's project check held it there before this (effect-authority.ts `work.read`).
  if (!invocation.context.principalId
    || !invocation.context.scopes?.some(scope => scope === WORK_LEDGER_READ_SCOPE || scope === '*')) {
    throw new GatewayVerbError('Native ledger read requires read:work-ledger', 'FORBIDDEN', 403);
  }
  const input = readInvocationParams(invocation);
  const allowed = new Set(history ? ['projectId', 'afterSequence', 'throughSequence'] : ['projectId']);
  for (const key of Object.keys(input)) if (!allowed.has(key)) invalid(key);
  if (typeof input.projectId !== 'string' || input.projectId.length === 0 || input.projectId.length > 200) invalid('projectId');
  if (input.projectId !== reader.projectId) {
    throw new GatewayVerbError('Selected host does not own the requested project', 'WORK_LEDGER_PROJECT_MISMATCH', 403, 'projectId');
  }
  return input;
}
function bounded<T>(value: T): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > WORK_LEDGER_READ_MAX_BYTES) {
    throw new GatewayVerbError('Ledger response exceeds the read transport limit', 'WORK_LEDGER_READ_LIMIT', 413);
  }
  return value;
}
async function read<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); } catch (error) {
    if (error instanceof WorkLedgerAccessError) {
      const status = error.code === 'forbidden' ? 403 : error.code === 'invalid_cursor' ? 400 : 503;
      throw new GatewayVerbError('Authoritative work ledger read is unavailable', `WORK_LEDGER_${error.code.toUpperCase()}`, status);
    }
    if (error instanceof GatewayVerbError) throw error;
    throw new GatewayVerbError('Authoritative work ledger read is unavailable', 'WORK_LEDGER_UNAVAILABLE', 503);
  }
}

function provenance(invocation: GatewayMethodInvocation): 'available' | 'requires_read_knowledge' {
  return missingScopes(invocation.context.scopes, ['read:knowledge']).length === 0
    && invocation.isAuthorized?.(['read:knowledge']) === true ? 'available' : 'requires_read_knowledge';
}

/** One trusted host reader, already scoped to the selected project. No path or actor inputs. */
export function registerWorkLedgerGatewayMethods(catalog: GatewayMethodCatalog, reader: WorkLedgerReadClient): void {
  const attach = (id: string, handler: (invocation: GatewayMethodInvocation) => Promise<unknown>) => {
    const descriptor = catalog.get(id);
    if (!descriptor) throw new Error(`Missing native ledger method descriptor: ${id}`);
    catalog.register(descriptor, handler, { replace: true });
  };
  attach('workLedger.project', async invocation => {
    if (!invocation.context.principalId
      || !invocation.context.scopes?.some(scope => scope === WORK_LEDGER_READ_SCOPE || scope === '*')
      || invocation.isAuthorized?.([WORK_LEDGER_READ_SCOPE]) !== true) {
      throw new GatewayVerbError('Native ledger discovery requires current read:work-ledger', 'FORBIDDEN', 403);
    }
    const input = readInvocationParams(invocation);
    for (const key of Object.keys(input)) invalid(key);
    // This identity is from the native ledger owner already composed by this
    // host, never from the legacy project-planning service or request payload.
    return { projectId: reader.projectId };
  });
  attach('workLedger.snapshot', async invocation => {
    params(invocation, reader, false);
    return read(async () => {
      const snapshot = workLedgerReadSnapshotSchema.parse(await reader.readSnapshot());
      if (snapshot.projectId !== reader.projectId) throw new Error('Host reader project mismatch');
      if (invocation.isAuthorized?.() === false) throw new GatewayVerbError('Owner authorization changed', 'FORBIDDEN', 403);
      // The reader already projected each work for reading.
      return bounded({ ...snapshot, provenance: provenance(invocation) });
    });
  });
  attach('workLedger.history', async invocation => {
    const input = params(invocation, reader, true);
    const afterSequence = cursor(input.afterSequence, 'afterSequence');
    const through = input.throughSequence === undefined ? undefined : cursor(input.throughSequence, 'throughSequence');
    if (through !== undefined && through < afterSequence) invalid('throughSequence');
    // Authorisation is checked once before the read and once before the reply;
    // nothing between them can change it for this call.
    if (invocation.isAuthorized?.() === false) throw new GatewayVerbError('Owner authorization changed', 'FORBIDDEN', 403);
    const withProvenance = provenance(invocation) === 'available';
    return read(async () => {
      // One read gives both the high-water mark and the page.
      const { cursor: highWater, events } = await readHistoryPage(reader, afterSequence);
      if (afterSequence > highWater) invalid('afterSequence');
      if (through !== undefined && through > highWater) invalid('throughSequence');
      const throughSequence = through ?? highWater;
      const page: WorkLedgerHistoryPage = {
        projectId: reader.projectId, afterSequence, cursor: afterSequence, throughSequence,
        hasMore: afterSequence < throughSequence, provenance: withProvenance ? 'available' : 'requires_read_knowledge', events: [],
      };
      // The page is sized by a running total: the envelope at its widest
      // (largest cursor, `hasMore: false`) plus each event and its comma.
      const encoder = new TextEncoder();
      let bytes = encoder.encode(JSON.stringify({ ...page, cursor: throughSequence, hasMore: false })).byteLength;
      for (const readEvent of events) {
        if (readEvent.sequence > throughSequence) break;
        if (readEvent.sequence !== page.cursor + 1) throw new Error('History cursor is not contiguous');
        // The reader projected the event; only a caller without read:knowledge narrows it further.
        const event = !withProvenance && readEvent.type === 'import_legacy' ? projectWorkLedgerReadEvent(readEvent, false) : readEvent;
        const size = encoder.encode(JSON.stringify(event)).byteLength + (page.events.length > 0 ? 1 : 0);
        if (bytes + size > WORK_LEDGER_READ_MAX_BYTES) {
          if (page.events.length === 0) bounded({ ...page, events: [event] });
          break;
        }
        bytes += size;
        page.events.push(event); page.cursor = event.sequence; page.hasMore = event.sequence < throughSequence;
      }
      if (page.hasMore && page.events.length === 0) throw new Error('History cursor did not advance');
      if (invocation.isAuthorized?.() === false) throw new GatewayVerbError('Owner authorization changed', 'FORBIDDEN', 403);
      return page;
    });
  });
}

/** One page and the high-water mark; a reader without a page read pays the two reads. */
async function readHistoryPage(reader: WorkLedgerReadClient, afterSequence: number): Promise<{ readonly cursor: number; readonly events: readonly WorkLedgerReadEvent[] }> {
  if (reader.historyPage) return reader.historyPage(afterSequence, WORK_LEDGER_HISTORY_PAGE_SIZE);
  const snapshot = await reader.readSnapshot();
  if (snapshot.projectId !== reader.projectId) throw new Error('Host reader project mismatch');
  if (afterSequence > snapshot.cursor) return { cursor: snapshot.cursor, events: [] };
  return { cursor: snapshot.cursor, events: (await reader.history(afterSequence)).slice(0, WORK_LEDGER_HISTORY_PAGE_SIZE) };
}
