/** Platform module maintained in the GoodVibes engine. */

import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';
import { withProcessLock } from '../utils/process-lock.js';

export interface FavoriteEntry {
  registryKey: string;
  pinnedAt: string;
}

export interface UsageEntry {
  registryKey: string;
  lastUsed: string;
  count: number;
}

export interface FavoritesData {
  pinned: FavoriteEntry[];
  history: UsageEntry[];
}

const MAX_HISTORY = 100;

function emptyData(): FavoritesData {
  return { pinned: [], history: [] };
}

function normalizeFavoriteEntries(entries: unknown): FavoriteEntry[] {
  if (!Array.isArray(entries)) throw new Error('"pinned" must be an array');
  const seen = new Set<string>();
  const normalized: FavoriteEntry[] = [];
  for (const [index, rawEntry] of entries.entries()) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      throw new Error(`"pinned[${index}]" must be an object`);
    }
    const entry = rawEntry as Partial<FavoriteEntry>;
    const registryKey = typeof entry.registryKey === 'string' ? entry.registryKey.trim() : '';
    if (!registryKey) throw new Error(`"pinned[${index}].registryKey" must be a non-empty string`);
    if (seen.has(registryKey)) throw new Error(`Duplicate pinned registryKey '${registryKey}'`);
    if (typeof entry.pinnedAt !== 'string') throw new Error(`"pinned[${index}].pinnedAt" must be a string`);
    seen.add(registryKey);
    normalized.push({ registryKey, pinnedAt: entry.pinnedAt });
  }
  return normalized;
}

function normalizeUsageEntries(entries: unknown): UsageEntry[] {
  if (!Array.isArray(entries)) throw new Error('"history" must be an array');
  const byRegistryKey = new Map<string, UsageEntry>();
  for (const [index, rawEntry] of entries.entries()) {
    if (typeof rawEntry !== 'object' || rawEntry === null || Array.isArray(rawEntry)) {
      throw new Error(`"history[${index}]" must be an object`);
    }
    const entry = rawEntry as Partial<UsageEntry>;
    const registryKey = typeof entry.registryKey === 'string' ? entry.registryKey.trim() : '';
    if (!registryKey) throw new Error(`"history[${index}].registryKey" must be a non-empty string`);
    if (typeof entry.lastUsed !== 'string') throw new Error(`"history[${index}].lastUsed" must be a string`);
    if (typeof entry.count !== 'number' || !Number.isFinite(entry.count) || entry.count < 1) {
      throw new Error(`"history[${index}].count" must be a positive finite number`);
    }
    const count = Math.trunc(entry.count);
    const existing = byRegistryKey.get(registryKey);
    if (!existing) {
      byRegistryKey.set(registryKey, { registryKey, lastUsed: entry.lastUsed, count });
      continue;
    }
    existing.count += count;
    if (entry.lastUsed.localeCompare(existing.lastUsed) > 0) existing.lastUsed = entry.lastUsed;
  }
  return [...byRegistryKey.values()];
}

function parseFavoritesData(value: unknown): { data: FavoritesData; warnings: string[] } {
  const warnings: string[] = [];
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Favorites data root value must be a JSON object');
  }
  const parsed = value as Record<string, unknown>;
  return {
    data: {
      pinned: normalizeFavoriteEntries(parsed['pinned'] ?? []),
      history: normalizeUsageEntries(parsed['history'] ?? []),
    },
    warnings,
  };
}

export interface FavoritesStoreOptions {
  readonly dir: string;
}

/** A caller's own cancellation and currency check, consulted once before a write starts; never write authority. */
export interface FavoritesUsageRestriction {
  readonly signal?: AbortSignal | undefined;
  readonly assertCurrent?: (() => void) | undefined;
}

/**
 * The model picker's pinned list and usage counts, shared by every window of
 * one product on one home (each product keeps its own file under its surface
 * directory). Every read is of the file as it is now, so a pin made in one
 * window shows in another's picker; every change (pin, unpin, usage) is one
 * read, change and rename under the file's process lock, so a pin made in one
 * window while another records usage keeps both.
 */
export class FavoritesStore {
  private readonly dir: string;

  constructor(options: FavoritesStoreOptions) {
    this.dir = options.dir;
  }

  getDirectory(): string {
    return this.dir;
  }

  getPath(): string {
    return join(this.dir, 'favorites.json');
  }

  async load(ownership?: FavoritesUsageRestriction): Promise<FavoritesData> {
    ownership?.signal?.throwIfAborted();
    return this.readFile();
  }

  private async readFile(): Promise<FavoritesData> {
    const path = this.getPath();
    const file = Bun.file(path);
    if (!(await file.exists())) return emptyData();
    try {
      const { data, warnings } = parseFavoritesData(JSON.parse(await file.text()) as unknown);
      if (warnings.length > 0) logger.warn('[favorites] Ignoring malformed favorites data', { path, warnings });
      return data;
    } catch (error) {
      logger.warn('[favorites] Favorites load failed; preserving existing file', { path, error: summarizeError(error) });
      throw error;
    }
  }

  async save(data: FavoritesData): Promise<void> {
    await this.mutate(() => data);
  }

  /** Read what is on disk now, change it, and replace the file, all under the process lock. */
  private async mutate(change: (data: FavoritesData) => FavoritesData | void, signal?: AbortSignal): Promise<void> {
    mkdirSync(this.dir, { recursive: true });
    const path = this.getPath();
    await withProcessLock(`${path}.writer.sqlite`, async () => {
      const current = await this.readFile();
      const next = change(current) ?? current;
      signal?.throwIfAborted();
      const tmp = `${path}.tmp.${randomUUID()}`;
      try {
        await Bun.write(tmp, JSON.stringify(next, null, 2));
        await rename(tmp, path);
      } catch (error) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw error;
      }
    }, signal ? { signal } : {});
  }

  async pinModel(registryKey: string): Promise<void> {
    await this.mutate((data) => {
      if (!data.pinned.some((entry) => entry.registryKey === registryKey)) {
        data.pinned.push({ registryKey, pinnedAt: new Date().toISOString() });
      }
    });
  }

  async unpinModel(registryKey: string): Promise<void> {
    await this.mutate((data) => {
      data.pinned = data.pinned.filter((entry) => entry.registryKey !== registryKey);
    });
  }

  async getPinned(): Promise<string[]> {
    const data = await this.getData();
    return data.pinned.map((entry) => entry.registryKey);
  }

  async isModelPinned(registryKey: string): Promise<boolean> {
    const data = await this.getData();
    return data.pinned.some((entry) => entry.registryKey === registryKey);
  }

  async recordUsage(registryKey: string, ownership?: FavoritesUsageRestriction): Promise<void> {
    ownership?.signal?.throwIfAborted();
    ownership?.assertCurrent?.();
    await this.mutate((data) => {
      const now = new Date().toISOString();
      const existing = data.history.find((entry) => entry.registryKey === registryKey);
      if (existing) {
        existing.count += 1;
        existing.lastUsed = now;
      } else {
        data.history.push({ registryKey, lastUsed: now, count: 1 });
      }
      if (data.history.length > MAX_HISTORY) {
        data.history.sort((a, b) => a.lastUsed.localeCompare(b.lastUsed));
        data.history = data.history.slice(data.history.length - MAX_HISTORY);
      }
    }, ownership?.signal);
  }

  async getRecentModels(n: number): Promise<string[]> {
    const data = await this.getData();
    return data.history
      .slice()
      .sort((a, b) => b.lastUsed.localeCompare(a.lastUsed))
      .slice(0, n)
      .map((entry) => entry.registryKey);
  }

  private getData(): Promise<FavoritesData> {
    return this.readFile();
  }
}
