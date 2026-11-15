/**
 * How each catalog provider's models are paid for. Whether a provider runs
 * locally is a fact of its API address and is decided here in code; whether it
 * sells access as a plan is read once per set of published provider facts
 * (routing.catalog-provider-access) and remembered on disk beside the catalog
 * cache, so a catalog refresh asks only about providers that are new or whose
 * facts changed. Remembered readings answer on every path, Classic included.
 */
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { YesNoReading } from '@goodvibes-jev/judgment';
import { judgmentPort } from '@goodvibes-jev/engine/errors';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { isLocalBaseUrl } from '../providers/context-window-catalog.js';
import { catalogProviderAccess, type ProviderAccess } from './batteries/catalog.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';

export type { ProviderAccess };

/** A catalog provider's published facts. */
export interface ProviderFacts {
  readonly id: string;
  readonly name: string;
  readonly api?: string | undefined;
  readonly doc?: string | undefined;
  readonly envVars: readonly string[];
  /** A few model names, for context. */
  readonly sampleModels: readonly string[];
}

/** Provider readings in flight at once during a catalog refresh. */
const ACCESS_READ_CONCURRENCY = 8;

/** An unsure plan reading is asked again after this long rather than on every hourly refresh. */
const UNSETTLED_RETRY_MS = 24 * 60 * 60 * 1000;

/** A provider whose API is on this machine or a private network runs its models locally. */
export function isLocalProvider(facts: Pick<ProviderFacts, 'api'>): boolean {
  return typeof facts.api === 'string' && isLocalBaseUrl(facts.api);
}

/**
 * The access a plan reading supports for a provider that is not local:
 * subscription when access is clearly sold as a plan, metered when the reading
 * clearly says no. An unsure reading gives no access, and such a provider's
 * zero prices are never taken to mean free.
 */
export function providerAccessFrom(readings: { readonly plan: YesNoReading }): ProviderAccess | undefined {
  const { plan } = readings;
  if (plan.outcome !== 'act') return undefined;
  if (plan.verdict === 'yes') return 'subscription';
  if (plan.verdict === 'no') return 'metered';
  return undefined;
}

export function providerFactsState(facts: ProviderFacts): { provider: Record<string, string | string[]> } {
  return {
    provider: {
      id: facts.id,
      name: facts.name,
      ...(facts.api ? { api: facts.api } : {}),
      ...(facts.doc ? { doc: facts.doc } : {}),
      env_vars: [...facts.envVars],
      sample_models: [...facts.sampleModels],
    },
  };
}

/** The facts an access reading depends on and the battery version that read them. */
const accessFingerprint = (facts: ProviderFacts): string => `v${catalogProviderAccess.version}:${JSON.stringify(providerFactsState(facts))}`;

interface StoredAccess {
  readonly fingerprint: string;
  /** Null: the reading was unsure; it is asked again once `readAt` is a day old. */
  readonly access: ProviderAccess | null;
  readonly readAt?: number;
}

const ACCESS_VALUES: readonly unknown[] = ['metered', 'subscription', 'local'];

function isStoredAccess(value: unknown): value is StoredAccess {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  if (typeof entry['fingerprint'] !== 'string') return false;
  if (ACCESS_VALUES.includes(entry['access'])) return true;
  return entry['access'] === null && typeof entry['readAt'] === 'number' && Number.isFinite(entry['readAt']);
}

export class ProviderAccessReadings {
  readonly #path: string | undefined;
  readonly #entries = new Map<string, StoredAccess>();
  readonly #now: () => number;

  constructor(options: { readonly path?: string | undefined; readonly now?: () => number } = {}) {
    this.#path = options.path;
    this.#now = options.now ?? Date.now;
    if (this.#path) this.#load(this.#path);
  }

  /**
   * Each provider's access as far as it is already known, with no model
   * request: local from its address, otherwise the remembered reading of the
   * same facts. Undefined when it has not been read or the reading was unsure.
   */
  known(providers: readonly ProviderFacts[]): ReadonlyMap<string, ProviderAccess | undefined> {
    return new Map(providers.map((facts) => [facts.id, this.#known(facts)]));
  }

  /**
   * Reads the providers whose access is not known yet. Each reading is kept
   * as it completes and what completed is saved even when one fails; the
   * first failure is then raised so an unavailable decision model switches
   * the operation to Classic. Under Classic nothing is asked.
   */
  async readMissing(providers: readonly ProviderFacts[], site = 'providers.model-catalog.provider-access'): Promise<void> {
    const pending = providers.filter((facts) => this.#needsReading(facts));
    if (pending.length === 0) return;
    await decisionOrClassic(() => this.#read(pending, site), () => undefined);
  }

  /** `readMissing`, then every provider's access (undefined when unsettled). */
  async readAll(providers: readonly ProviderFacts[], site = 'providers.model-catalog.provider-access'): Promise<ReadonlyMap<string, ProviderAccess | undefined>> {
    await this.readMissing(providers, site);
    return this.known(providers);
  }

  #known(facts: ProviderFacts): ProviderAccess | undefined {
    if (isLocalProvider(facts)) return 'local';
    const entry = this.#entries.get(facts.id);
    return entry && entry.fingerprint === accessFingerprint(facts) ? entry.access ?? undefined : undefined;
  }

  #needsReading(facts: ProviderFacts): boolean {
    if (isLocalProvider(facts)) return false;
    const entry = this.#entries.get(facts.id);
    if (!entry || entry.fingerprint !== accessFingerprint(facts)) return true;
    return entry.access === null && this.#now() - (entry.readAt ?? 0) >= UNSETTLED_RETRY_MS;
  }

  async #read(pending: readonly ProviderFacts[], site: string): Promise<void> {
    let next = 0;
    let failure: { readonly error: unknown } | undefined;
    let changed = false;
    const worker = async (): Promise<void> => {
      while (!failure && next < pending.length) {
        const facts = pending[next++]!;
        try {
          const run = await catalogProviderAccess.run(judgmentPort(site), providerFactsState(facts), { site });
          const access = providerAccessFrom(run.readings);
          run.recordAction(`access:${access ?? 'unsettled'}`);
          this.#entries.set(facts.id, { fingerprint: accessFingerprint(facts), access: access ?? null, ...(access ? {} : { readAt: this.#now() }) });
          changed = true;
        } catch (error) {
          failure ??= { error };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(ACCESS_READ_CONCURRENCY, pending.length) }, worker));
    if (changed) this.#save();
    if (failure) throw failure.error;
  }

  #load(path: string): void {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf-8')) as { version?: number; entries?: Record<string, unknown> };
      if (parsed.version !== 1 || typeof parsed.entries !== 'object' || parsed.entries === null) return;
      for (const [id, entry] of Object.entries(parsed.entries)) if (isStoredAccess(entry)) this.#entries.set(id, entry);
    } catch (error) {
      const message = summarizeError(error);
      if (!message.includes('ENOENT') && !message.includes('no such file')) logger.warn('[routing] Ignoring unreadable provider access file', { path, error: message });
    }
  }

  #save(): void {
    if (!this.#path) return;
    try {
      mkdirSync(dirname(this.#path), { recursive: true });
      writeJsonFileAtomic(this.#path, { version: 1, entries: Object.fromEntries(this.#entries) }, { indent: null, trailingNewline: false });
    } catch (error) {
      logger.warn('[routing] Provider access file write failed', { path: this.#path, error: summarizeError(error) });
    }
  }
}
