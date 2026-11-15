import { createHash } from 'node:crypto';
import { Parser } from 'tar';
import { parse } from 'smol-toml';
import { instrumentedFetch } from '../utils/fetch-with-timeout.js';
import { logger } from '../utils/logger.js';
import { MODEL_CATALOG_PIN, type ModelCatalogPin } from './model-catalog-pin.js';

type Table = Record<string, unknown>;
export type RepositoryCatalog = Record<string, Table & { models: Record<string, Table> }>;
/** The moving development head, read only while the build ships no pin. */
export const MODEL_CATALOG_REPOSITORY_URL = 'https://codeload.github.com/anomalyco/models.dev/tar.gz/refs/heads/dev';

/** Where the catalog archive is read from: the pinned commit, or the development head when no pin is set. */
export interface ModelCatalogSource {
  readonly url: string;
  /** The commit id, or `dev` for the moving head; stored with the cache so a new pin refetches. */
  readonly id: string;
  readonly sha256?: string | undefined;
}

export function modelCatalogSource(pin: ModelCatalogPin | null = MODEL_CATALOG_PIN): ModelCatalogSource {
  if (!pin) return { url: MODEL_CATALOG_REPOSITORY_URL, id: 'dev' };
  return { url: `https://codeload.github.com/anomalyco/models.dev/tar.gz/${pin.commit}`, id: pin.commit, sha256: pin.sha256.toLowerCase() };
}

/** One conditional read of the catalog archive. */
export type ModelCatalogArchiveRead =
  | { readonly status: 'fetched'; readonly catalog: RepositoryCatalog; readonly etag?: string | undefined; readonly source: string }
  | { readonly status: 'not-modified'; readonly source: string };

function table(value: unknown): value is Table {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function merge(base: Table, overrides: Table): Table {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(overrides)])].map(key => {
    const value = Object.hasOwn(overrides, key) ? overrides[key] : base[key];
    return [key, table(base[key]) && table(overrides[key]) ? merge(base[key], overrides[key]) : value];
  }));
}

/** Resolve published base_model links with provider overrides and explicit omissions. */
export async function parseModelCatalogRepository(files: ReadonlyMap<string, string>): Promise<RepositoryCatalog> {
  let parsed = 0;
  const yieldToHost = () => new Promise<void>(resolve => setImmediate(resolve));
  const metadata = new Map<string, Table>();
  for (const [path, text] of files) {
    if (path.startsWith('models/') && path.endsWith('.toml')) metadata.set(path.slice(7, -5), parse(text));
    if (++parsed % 128 === 0) await yieldToHost();
  }
  const providers = new Map<string, Table & { models: Record<string, Table> }>();
  for (const [path, text] of files) {
    const match = /^providers\/([^/]+)\/provider\.toml$/.exec(path);
    if (match) providers.set(match[1]!, { ...parse(text), id: match[1], models: Object.create(null) as Record<string, Table> });
  }
  for (const [path, text] of files) {
    const match = /^providers\/([^/]+)\/models\/(.+)\.toml$/.exec(path);
    if (!match) continue;
    const provider = providers.get(match[1]!);
    if (!provider) throw new Error(`Model catalog has no provider record for ${match[1]}`);
    const authored = parse(text), baseId = authored.base_model;
    let model: Table = authored;
    if (baseId !== undefined) {
      if (typeof baseId !== 'string' || !metadata.has(baseId)) {
        // One bad file upstream must not block every refresh; the rest of the snapshot is still coherent.
        logger.warn('Model catalog entry skipped: unresolved base_model', { path });
        continue;
      }
      const base = Object.fromEntries(Object.entries(metadata.get(baseId)!).filter(([key]) => !['id', 'benchmarks', 'license', 'links', 'weights'].includes(key)));
      const overrides = Object.fromEntries(Object.entries(authored).filter(([key]) => key !== 'base_model' && key !== 'base_model_omit'));
      model = structuredClone(merge(base, overrides));
      if (Array.isArray(authored.base_model_omit) && authored.base_model_omit.some(omitted => typeof omitted !== 'string')) {
        logger.warn('Model catalog entry skipped: invalid base_model_omit', { path });
        continue;
      }
      if (Array.isArray(authored.base_model_omit)) for (const omitted of authored.base_model_omit as string[]) {
        const parts = omitted.split('.');
        let parent = model;
        for (const part of parts.slice(0, -1)) { const child = parent[part]; if (!Object.hasOwn(parent, part) || !table(child)) { parent = {}; break; } parent = child; }
        delete parent[parts.at(-1)!];
      }
      model.canonical_model_id = baseId;
    }
    provider.models[match[2]!] = { ...model, id: match[2]! };
    if (++parsed % 128 === 0) await yieldToHost();
  }
  return Object.fromEntries(providers);
}

/** Read data only from one coherent GitHub repository snapshot; never execute repository code. */
export async function fetchModelCatalogRepository(options: { readonly pin?: ModelCatalogPin | null | undefined } = {}): Promise<RepositoryCatalog> {
  const read = await readModelCatalogArchive({ ...(options.pin !== undefined ? { pin: options.pin } : {}) });
  if (read.status !== 'fetched') throw new Error('Model catalog repository answered not-modified to an unconditional request');
  return read.catalog;
}

/**
 * Read the catalog archive, conditionally when `etag` is the one the cached
 * copy came with (a 304 costs one small request). With a pin, the archive's
 * SHA-256 must match the pinned one or the read is refused, so a moved branch
 * or an altered archive never replaces the cached catalog.
 */
export async function readModelCatalogArchive(options: {
  readonly etag?: string | undefined;
  readonly pin?: ModelCatalogPin | null | undefined;
} = {}): Promise<ModelCatalogArchiveRead> {
  const source = modelCatalogSource(options.pin === undefined ? MODEL_CATALOG_PIN : options.pin);
  if (!source.sha256) logger.debug('[model-catalog] No catalog pin is set; reading the unverified development head', { url: source.url });
  const response = await instrumentedFetch(source.url, {
    headers: { Accept: 'application/gzip', ...(options.etag ? { 'If-None-Match': options.etag } : {}) },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 304) {
    await response.body?.cancel().catch(() => {});
    return { status: 'not-modified', source: source.id };
  }
  if (!response.ok) throw new Error(`Model catalog repository returned HTTP ${response.status}`);
  const etag = response.headers.get('etag') ?? undefined;
  const digest = createHash('sha256');
  const files = new Map<string, string>();
  let totalBytes = 0;
  await new Promise<void>((resolve, rejectOnce) => {
    // Once the parser has failed the download is pointless: the reader loop
    // stops pulling and cancels the response instead of feeding a dead parser.
    let failed = false;
    const reject = (error: unknown): void => { failed = true; rejectOnce(error); };
    const parser = new Parser({ strict: true, onReadEntry(entry) {
      const path = entry.path.split('/').slice(1).join('/');
      if (entry.type !== 'File' || !/^(?:models\/.+\.toml|providers\/[^/]+\/(?:provider\.toml|models\/.+\.toml))$/.test(path)) { entry.resume(); return; }
      const chunks: Buffer[] = [];
      entry.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > 64 * 1024 * 1024) { const error = new Error('Model catalog exceeds its data budget'); parser.abort(error); reject(error); return; }
        chunks.push(chunk);
      });
      entry.on('end', () => files.set(path, Buffer.concat(chunks).toString('utf8')));
      entry.on('error', reject);
    } });
    parser.on('error', reject); parser.on('end', resolve);
    const consume = async () => {
      if (!response.body) throw new Error('Model catalog repository returned no archive');
      const reader = response.body.getReader();
      let compressedBytes = 0;
      try {
        while (!failed) {
          const { done, value } = await reader.read(); if (done) break;
          compressedBytes += value.byteLength;
          if (compressedBytes > 32 * 1024 * 1024) throw new Error('Model catalog archive exceeds its download budget');
          digest.update(value);
          parser.write(value);
        }
        if (!failed) parser.end();
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    };
    void consume().catch(error => { parser.abort(error instanceof Error ? error : new Error('Model catalog download failed')); reject(error); });
  });
  if (source.sha256) {
    const actual = digest.digest('hex');
    if (actual !== source.sha256) {
      throw new Error(`Model catalog archive for commit ${source.id} does not match its pinned checksum (got ${actual}); the cached catalog is kept.`);
    }
  }
  const catalog = await parseModelCatalogRepository(files);
  if (Object.keys(catalog).length === 0) throw new Error('Model catalog repository contains no provider data');
  return { status: 'fetched', catalog, ...(etag ? { etag } : {}), source: source.id };
}
