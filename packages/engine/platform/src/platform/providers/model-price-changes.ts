/**
 * model-price-changes.ts, the models whose price tier moved from free since
 * they were chosen, kept until the person answers for each change.
 *
 * A catalog check that finds a model the person uses (the current one, a
 * pinned or a recent one) moved from free to paid or to a subscription records
 * the change here. Before the first send to that model the turn asks (the
 * ordinary ask card, opening on No: "<model> is no longer free: about <price>.
 * Keep using it?"). A yes is remembered for that change, so it is asked once;
 * a no sends nothing and asks again at the next send to that model. Selecting
 * the model again does not settle it (a failover selects models too): only the
 * answer does.
 *
 * Stored at `<home>/.goodvibes/shared/model-price-changes.json`, version 1: one
 * record for the daemon, its hosted sessions and every program on the machine.
 * A missing or unreadable file is no changes (nothing was recorded, or it is
 * asked again). Read once per process; written only when a change is found or
 * answered, never per turn.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** One recorded move away from free. */
export interface ModelPriceChange {
  /** The model's name as the catalog gives it ("RT-1"). */
  readonly name: string;
  readonly providerId: string;
  readonly tier: 'paid' | 'subscription';
  /** USD per 1M tokens, when the catalog prices it. */
  readonly pricing?: { readonly input: number; readonly output: number } | undefined;
  /** When the check found it (epoch ms). */
  readonly detectedAt: number;
  /** When the person said to keep using it (epoch ms); absent while unanswered. */
  readonly acceptedAt?: number | undefined;
}

interface StoredChanges {
  readonly version: 1;
  readonly changes: Readonly<Record<string, ModelPriceChange>>;
}

export const MODEL_PRICE_CHANGES_FILE = 'model-price-changes.json';

function readStored(path: string): Record<string, ModelPriceChange> {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<StoredChanges>;
    if (parsed.version !== 1 || typeof parsed.changes !== 'object' || parsed.changes === null) return {};
    const out: Record<string, ModelPriceChange> = {};
    for (const [key, value] of Object.entries(parsed.changes)) {
      if (typeof value?.name === 'string' && typeof value.providerId === 'string' && (value.tier === 'paid' || value.tier === 'subscription')
        && typeof value.detectedAt === 'number') out[key] = value;
    }
    return out;
  } catch (error) {
    logger.warn('[model-price-changes] the stored price changes could not be read; any change is asked about again', { path, error: summarizeError(error) });
    return {};
  }
}

/**
 * The record read once per process per file and shared by every registry in
 * the process (the daemon's own and each hosted session's), so a change one
 * records or one answers is the one the others ask about.
 */
const loaded = new Map<string, Record<string, ModelPriceChange>>();

/** The price changes this machine recorded, by registry key. */
export class ModelPriceChanges {
  /** `root`: the directory the record lives in, `<home>/.goodvibes/shared` (the tier every program and the daemon share). */
  constructor(private readonly root: () => string) {}

  private path(): string { return join(this.root(), MODEL_PRICE_CHANGES_FILE); }
  private all(): Record<string, ModelPriceChange> {
    const path = this.path();
    let changes = loaded.get(path);
    if (!changes) { changes = readStored(path); loaded.set(path, changes); }
    return changes;
  }
  private save(): void {
    try { writeJsonFileAtomic(this.path(), { version: 1, changes: this.all() } satisfies StoredChanges); }
    catch (error) { logger.warn('[model-price-changes] the price change could not be saved; it is asked about again after a restart', { error: summarizeError(error) }); }
  }

  /** A change not yet answered for this model, or undefined. A memory read. */
  pending(registryKey: string): ModelPriceChange | undefined {
    const change = this.all()[registryKey];
    return change !== undefined && change.acceptedAt === undefined ? change : undefined;
  }

  /** Every change on record (answered or not), for a picker that marks them. */
  list(): Readonly<Record<string, ModelPriceChange>> { return { ...this.all() }; }

  /** Record a new move away from free; a later move replaces an earlier one and is asked about again. */
  record(registryKey: string, change: Omit<ModelPriceChange, 'acceptedAt'>): void {
    this.all()[registryKey] = { ...change };
    this.save();
  }

  /** The person said to keep using it: not asked again for this change. */
  accept(registryKey: string, now = Date.now()): void {
    const change = this.all()[registryKey];
    if (change === undefined || change.acceptedAt !== undefined) return;
    this.all()[registryKey] = { ...change, acceptedAt: now };
    this.save();
  }
}
