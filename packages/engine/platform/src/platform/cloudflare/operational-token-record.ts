import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { readDocument, writeDocument } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

const FILE_NAME = 'cloudflare-operational-token.json';

/**
 * The operational token this daemon created in the owner's Cloudflare account:
 * its id (never its value, which is in the secret store), the reference it is
 * stored under and what it was made for. Token creation reuses it while the
 * selection is the same, and revokes it when it makes a replacement; disable
 * revokes it. Without this record every retry left one more live token.
 */
export interface CloudflareOperationalTokenRecord {
  readonly version: 1;
  readonly accountId: string;
  readonly tokenId: string;
  readonly tokenName: string;
  readonly apiTokenRef: string;
  readonly zoneId?: string | undefined;
  /** Account, zone and components the token's permissions were built for. */
  readonly signature: string;
  readonly createdAt: number;
}

export interface CloudflareOperationalTokenRecordStore {
  read(): CloudflareOperationalTokenRecord | null;
  write(record: CloudflareOperationalTokenRecord): void;
  clear(): void;
}

/** The record lives beside the provisioned-resources record; no directory means nothing is recorded. */
export function openOperationalTokenRecord(directory: string | undefined): CloudflareOperationalTokenRecordStore {
  const path = directory ? join(directory, FILE_NAME) : '';
  return {
    read() {
      if (!path) return null;
      try {
        return readDocument(path, {
          label: 'cloudflare/operational-token',
          recovery: 'Token creation makes a new operational token and cannot revoke the earlier one; delete unused GoodVibes tokens in the Cloudflare dashboard (My Profile > API Tokens).',
          validate: parseRecord,
        });
      } catch (error: unknown) {
        logger.warn('cloudflare: operational-token record could not be read', { error: summarizeError(error) });
        return null;
      }
    },
    write(record) {
      if (path) writeDocument(path, record);
    },
    clear() {
      if (path) rmSync(path, { force: true });
    },
  };
}

function parseRecord(parsed: unknown): CloudflareOperationalTokenRecord {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== 1) throw new Error(`unknown version ${String(record['version'])}`);
  for (const key of ['accountId', 'tokenId', 'tokenName', 'apiTokenRef', 'signature'] as const) {
    if (typeof record[key] !== 'string' || record[key] === '') throw new Error(`${key} is missing`);
  }
  if (typeof record['createdAt'] !== 'number') throw new Error('createdAt is missing');
  return record as unknown as CloudflareOperationalTokenRecord;
}

/** What a token's permissions depend on: the account, the zone and the selected components. */
export function operationalTokenSignature(accountId: string, zoneId: string | undefined, components: object): string {
  const sorted = Object.fromEntries(Object.entries(components).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify({ accountId, zoneId: zoneId ?? null, components: sorted });
}
