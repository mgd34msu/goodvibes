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

/**
 * The one place host-confirmed setup receipts are read from: the setup read
 * model's `receipts`, answered by its `list()`. The connected host does not
 * publish it yet (no operator method declares it), so today this reads an
 * empty list; when the host publishes it there, every reader picks it up.
 */
export const SETUP_RECEIPTS_READ_MODEL_PATH = 'context.platform.readModels.setup.receipts';
export const SETUP_RECEIPTS_READ_METHOD = 'list';

function setupReceiptReadModelSources(context: CommandContext): readonly SetupReceiptReadModelSource[] {
  const contextRecord = context as unknown as Record<string, unknown>;
  const setup = readRecord(readRecord(readRecord(contextRecord.platform).readModels).setup);
  return [{ path: SETUP_RECEIPTS_READ_MODEL_PATH, source: setup.receipts }];
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
  const method = readRecord(source)[SETUP_RECEIPTS_READ_METHOD];
  return typeof method === 'function' ? settled((method as () => unknown).call(source)) : source;
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
