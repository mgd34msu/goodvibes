import { join } from 'node:path';
import { readDocument, writeDocument } from '../utils/atomic-json-store.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * What provisioning created or confirmed at Cloudflare. Settings name
 * resources (and most have a default name); this record says which ones
 * exist, so status reports a component only after a provision made it and
 * disable can list what is still deployed.
 */
export interface CloudflareProvisionedResources {
  readonly version: 1;
  readonly accountId: string;
  readonly updatedAt: number;
  readonly worker?: {
    readonly name: string;
    readonly baseUrl?: string | undefined;
    readonly workersDevRoute?: boolean | undefined;
    readonly cron?: string | undefined;
    /** Where the Worker holds the daemon credential; `removed` after disable took it out. */
    readonly daemonCredential?: 'script-secret' | 'secrets-store' | 'removed' | undefined;
  } | undefined;
  readonly queues?: {
    readonly queueName: string;
    readonly queueId: string;
    readonly deadLetterQueueName: string;
    readonly deadLetterQueueId: string;
  } | undefined;
  readonly tunnel?: { readonly id: string; readonly name: string } | undefined;
  readonly access?: { readonly appId: string; readonly serviceTokenId?: string | undefined; readonly hostname: string } | undefined;
  readonly dns?: readonly { readonly name: string; readonly id?: string | undefined }[] | undefined;
  readonly kv?: { readonly namespaceId: string; readonly title: string } | undefined;
  readonly r2?: { readonly bucketName: string } | undefined;
  readonly durableObjects?: { readonly className: string; readonly namespaceId?: string | undefined } | undefined;
  readonly secretsStore?: {
    readonly storeId: string;
    readonly storeName: string;
    /** Secrets this daemon wrote into the store, by name and id. */
    readonly secrets: readonly { readonly name: string; readonly id: string }[];
  } | undefined;
}

export type CloudflareProvisionedPatch = Partial<Omit<CloudflareProvisionedResources, 'version' | 'updatedAt'>>;

const FILE_NAME = 'cloudflare-resources.json';

export interface CloudflareProvisionedStore {
  read(): CloudflareProvisionedResources | null;
  /** Merge what one run confirmed into the record; another account's record is replaced. */
  merge(patch: CloudflareProvisionedPatch & { readonly accountId: string }): CloudflareProvisionedResources;
  replace(next: CloudflareProvisionedResources): void;
}

/** The record lives beside the daemon's other control-plane state; no directory means nothing is recorded. */
export function openProvisionedStore(directory: string | undefined): CloudflareProvisionedStore {
  const path = directory ? join(directory, FILE_NAME) : '';
  let cached: CloudflareProvisionedResources | null | undefined;
  const read = (): CloudflareProvisionedResources | null => {
    if (!path) return null;
    if (cached !== undefined) return cached;
    try {
      cached = readDocument(path, {
        label: 'cloudflare/resources',
        recovery: 'Cloudflare status reports no provisioned components until provisioning runs again; provisioning finds existing resources by name and records them.',
        validate: parseRecord,
      });
    } catch (error: unknown) {
      logger.warn('cloudflare: provisioned-resources record could not be read', { error: summarizeError(error) });
      cached = null;
    }
    return cached;
  };
  const replace = (next: CloudflareProvisionedResources): void => {
    if (!path) return;
    writeDocument(path, next);
    cached = next;
  };
  return {
    read,
    replace,
    merge(patch) {
      const previous = read();
      const sameAccount = previous && previous.accountId === patch.accountId ? previous : null;
      const base = sameAccount ?? { version: 1 as const, accountId: patch.accountId, updatedAt: 0 };
      // Secrets placed in the same store by earlier runs stay listed: a run that
      // placed none (or fewer) must not erase where an earlier run put one.
      const earlierStore = sameAccount?.secretsStore;
      const secretsStore = patch.secretsStore && earlierStore && earlierStore.storeId === patch.secretsStore.storeId
        ? { ...patch.secretsStore, secrets: mergeSecretsByName(earlierStore.secrets, patch.secretsStore.secrets) }
        : patch.secretsStore;
      const next: CloudflareProvisionedResources = {
        ...base,
        ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
        ...(secretsStore ? { secretsStore } : {}),
        version: 1,
        updatedAt: Date.now(),
      };
      replace(next);
      return next;
    },
  };
}

type PlacedSecret = { readonly name: string; readonly id: string };

/** The earlier list with each name the later list carries replaced by the later entry, then the later list's new names. */
function mergeSecretsByName(earlier: readonly PlacedSecret[], later: readonly PlacedSecret[]): readonly PlacedSecret[] {
  const byName = new Map<string, PlacedSecret>();
  for (const secret of earlier) byName.set(secret.name, secret);
  for (const secret of later) byName.set(secret.name, secret);
  return [...byName.values()];
}

function parseRecord(parsed: unknown): CloudflareProvisionedResources {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
  const record = parsed as Record<string, unknown>;
  if (record['version'] !== 1) throw new Error(`unknown version ${String(record['version'])}`);
  if (typeof record['accountId'] !== 'string') throw new Error('accountId is missing');
  return record as unknown as CloudflareProvisionedResources;
}

/** One line per resource still at Cloudflare, for disable and status. */
export function describeDeployedResources(record: CloudflareProvisionedResources | null): readonly { readonly kind: string; readonly id: string; readonly message: string }[] {
  if (!record) return [];
  const out: { kind: string; id: string; message: string }[] = [];
  if (record.worker) out.push({ kind: 'worker', id: record.worker.name, message: `Worker script ${record.worker.name}${record.worker.baseUrl ? ` (${record.worker.baseUrl})` : ''}` });
  if (record.queues) {
    out.push({ kind: 'queue', id: record.queues.queueId, message: `Queue ${record.queues.queueName}` });
    out.push({ kind: 'dead-letter-queue', id: record.queues.deadLetterQueueId, message: `Dead-letter queue ${record.queues.deadLetterQueueName}` });
  }
  if (record.tunnel) out.push({ kind: 'tunnel', id: record.tunnel.id, message: `Zero Trust Tunnel ${record.tunnel.name}` });
  if (record.access) out.push({ kind: 'access-application', id: record.access.appId, message: `Access application protecting ${record.access.hostname}` });
  for (const entry of record.dns ?? []) out.push({ kind: 'dns-record', id: entry.id ?? entry.name, message: `DNS record ${entry.name}` });
  if (record.kv) out.push({ kind: 'kv-namespace', id: record.kv.namespaceId, message: `KV namespace ${record.kv.title}` });
  if (record.r2) out.push({ kind: 'r2-bucket', id: record.r2.bucketName, message: `R2 bucket ${record.r2.bucketName}` });
  if (record.secretsStore) out.push({ kind: 'secrets-store', id: record.secretsStore.storeId, message: `Secrets Store ${record.secretsStore.storeName}` });
  return out;
}
