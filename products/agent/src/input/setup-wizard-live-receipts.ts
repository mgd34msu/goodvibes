import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { CommandContext } from './command-registry.ts';
import { buildSetupWizardDurableReceiptsFromReadModel, mergeSetupWizardDurableReceipts } from '../agent/setup-wizard-artifact-receipts.ts';
import type { AgentSetupWizardDurableReceipt } from '../agent/setup-wizard.ts';

export interface SetupReceiptReadModelSource {
  readonly path: string;
  readonly source: unknown;
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function setupReceiptReadModelSources(context: CommandContext): readonly SetupReceiptReadModelSource[] {
  const contextRecord = context as unknown as Record<string, unknown>;
  const platform = readRecord(contextRecord.platform);
  const clients = readRecord(contextRecord.clients);
  const readModels = readRecord(platform.readModels);
  const setup = readRecord(readModels.setup);
  const setupWizard = readRecord(readModels.setupWizard);
  const firstRun = readRecord(readModels.firstRun);
  const browserPwa = readRecord(readModels.browserPwa);
  const operator = readRecord(clients.operator);
  return [
    { path: 'context.platform.readModels.setup.receipts', source: setup.receipts },
    { path: 'context.platform.readModels.setup.setupReceipts', source: setup.setupReceipts },
    { path: 'context.platform.readModels.setup.receiptEvents', source: setup.receiptEvents },
    { path: 'context.platform.readModels.setup.eventStream', source: setup.eventStream },
    { path: 'context.platform.readModels.setup', source: readModels.setup },
    { path: 'context.platform.readModels.setupWizard.receipts', source: setupWizard.receipts },
    { path: 'context.platform.readModels.setupWizard.durableReceipts', source: setupWizard.durableReceipts },
    { path: 'context.platform.readModels.setupWizard.receiptEvents', source: setupWizard.receiptEvents },
    { path: 'context.platform.readModels.setupWizard.eventStream', source: setupWizard.eventStream },
    { path: 'context.platform.readModels.setupReceipts', source: readModels.setupReceipts },
    { path: 'context.platform.readModels.setupReceiptEvents', source: readModels.setupReceiptEvents },
    { path: 'context.platform.readModels.setupReceiptEventStream', source: readModels.setupReceiptEventStream },
    { path: 'context.platform.readModels.durableSetupReceipts', source: readModels.durableSetupReceipts },
    { path: 'context.platform.readModels.firstRun.receipts', source: firstRun.receipts },
    { path: 'context.platform.readModels.browserPwa.firstRunReceipts', source: browserPwa.firstRunReceipts },
    { path: 'context.platform.setupReceipts', source: platform.setupReceipts },
    { path: 'context.platform.setupReceiptEvents', source: platform.setupReceiptEvents },
    { path: 'context.clients.operator.setupReceipts', source: operator.setupReceipts },
    { path: 'context.clients.operator.setupReceiptEvents', source: operator.setupReceiptEvents },
  ];
}

/** Thrown for a source that can only answer asynchronously: its receipts cannot be read here. */
class AsyncReceiptSourceError extends Error {
  constructor() {
    super('the read model answers asynchronously');
  }
}

function settled(result: unknown): unknown {
  if (result instanceof Promise) {
    // Nothing waits on it, so a rejection must not surface as an unhandled one.
    result.catch(() => {});
    throw new AsyncReceiptSourceError();
  }
  return result;
}

function readSnapshot(source: unknown): unknown {
  if (typeof source === 'function') return settled((source as () => unknown)());
  const record = readRecord(source);
  for (const methodName of ['getSnapshot', 'snapshot', 'list', 'listReceipts', 'listEvents', 'listReceiptEvents', 'readEvents']) {
    const method = record[methodName];
    if (typeof method === 'function') return settled((method as () => unknown)());
  }
  return source;
}

export interface SetupWizardLiveReceipts {
  readonly receipts: readonly AgentSetupWizardDurableReceipt[];
  /** Read-model paths that exist but could not be read, so an empty list is not mistaken for "no receipts". */
  readonly unavailable: readonly string[];
}

export function readSetupWizardLiveDurableReceipts(
  context: CommandContext,
  acquiredSources?: readonly SetupReceiptReadModelSource[],
): SetupWizardLiveReceipts {
  const receipts: AgentSetupWizardDurableReceipt[][] = [];
  const unavailable: string[] = [];
  for (const entry of acquiredSources ?? setupReceiptReadModelSources(context)) {
    if (entry.source === undefined || entry.source === null) continue;
    try {
      receipts.push([...buildSetupWizardDurableReceiptsFromReadModel(readSnapshot(entry.source), entry.path)]);
    } catch (error) {
      // A broken host read model must not hide local setup posture, but it is reported.
      unavailable.push(entry.path);
      logger.debug('setup receipts: a read model could not be read', {
        path: entry.path,
        error: error instanceof AsyncReceiptSourceError ? error.message : summarizeError(error),
      });
    }
  }
  return { receipts: mergeSetupWizardDurableReceipts(...receipts), unavailable };
}

export function setupWizardLiveDurableReceipts(context: CommandContext, acquiredSources?: readonly SetupReceiptReadModelSource[]): readonly AgentSetupWizardDurableReceipt[] {
  return readSetupWizardLiveDurableReceipts(context, acquiredSources).receipts;
}

export { mergeSetupWizardDurableReceipts };
