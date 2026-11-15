/**
 * principals/registry.ts
 *
 * The principal identity registry: the CRUD gateway backing store plus the one
 * operation channel intake actually depends on, resolveByIdentity, which turns
 * a channel-specific sender identity into the named principal it belongs to (or
 * the honest unknown principal when nothing maps).
 *
 * Identity uniqueness is a hard invariant: a given {channel, value} identity
 * belongs to at most one principal. create/update refuse (CONFLICT) to attach an
 * identity already claimed by a different principal rather than silently moving
 * it, reattaching an identity must be a deliberate delete-then-recreate.
 */
import { randomUUID } from 'node:crypto';
import { StoreWriteQueue } from '../state/store-write-queue.js';
import type { PrincipalStore } from './store.js';
import {
  PrincipalRegistryError,
  identityKey,
  normalizeIdentity,
  unknownPrincipal,
  type PrincipalIdentity,
  type PrincipalKind,
  type PrincipalRecord,
  PRINCIPAL_KINDS,
} from './types.js';

export interface CreatePrincipalInput {
  readonly name: string;
  readonly kind: PrincipalKind;
  readonly identities?: readonly PrincipalIdentity[] | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

export interface UpdatePrincipalInput {
  readonly name?: string | undefined;
  readonly kind?: PrincipalKind | undefined;
  readonly identities?: readonly PrincipalIdentity[] | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

/** The outcome of resolving a sender identity: the principal plus whether it was a real mapping. */
export interface PrincipalResolution {
  readonly principal: PrincipalRecord;
  readonly known: boolean;
}

function requireKind(kind: unknown): PrincipalKind {
  if (typeof kind !== 'string' || !PRINCIPAL_KINDS.includes(kind as PrincipalKind)) {
    throw new PrincipalRegistryError(
      `kind must be one of ${PRINCIPAL_KINDS.join(', ')}`,
      'INVALID_ARGUMENT',
    );
  }
  return kind as PrincipalKind;
}

function normalizeIdentities(identities: readonly PrincipalIdentity[] | undefined): PrincipalIdentity[] {
  if (!identities) return [];
  const seen = new Set<string>();
  const out: PrincipalIdentity[] = [];
  for (const raw of identities) {
    if (typeof raw?.channel !== 'string' || typeof raw?.value !== 'string') {
      throw new PrincipalRegistryError('each identity needs a string channel and value', 'INVALID_ARGUMENT');
    }
    const normalized = normalizeIdentity(raw);
    if (!normalized.channel || !normalized.value) {
      throw new PrincipalRegistryError('identity channel and value must be non-empty', 'INVALID_ARGUMENT');
    }
    const key = identityKey(normalized);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(normalized);
  }
  return out;
}

export class PrincipalRegistry {
  private records: PrincipalRecord[] | null = null;
  private loading: Promise<PrincipalRecord[]> | null = null;
  /** Whole-store writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(private readonly store: PrincipalStore) {}

  /**
   * Apply one change to the principals and make it durable, one change at a time.
   *
   * `change` builds the NEXT array from the current one and never edits the
   * current one. The next array is saved first and becomes live only after the
   * save succeeded, so a failed write leaves memory and disk agreeing on the old
   * state (a retry of a failed `create` must not meet a CONFLICT with a
   * principal the caller was told was not created, and a failed `delete` must
   * not leave a person unmapped until the next restart).
   *
   * Changes run through the write queue as a whole, load included. `PrincipalStore.save`
   * replaces the file atomically but says nothing about ORDER, and two changes
   * that both started from the same array would each save a list missing the
   * other's principal. A principal is what channel intake resolves a sender
   * identity against, so a lost or resurrected one is a person attributed to the
   * wrong identity.
   */
  private mutate<T>(
    change: (records: readonly PrincipalRecord[]) => { readonly next: PrincipalRecord[] | null; readonly result: T },
  ): Promise<T> {
    return (async () => {
      let outcome: T | undefined;
      await this.writes.run(async () => {
        const { next, result } = change(await this.all());
        outcome = result;
        if (next === null) return;
        await this.store.save(next);
        this.records = next;
      });
      return outcome as T;
    })();
  }

  private async all(): Promise<readonly PrincipalRecord[]> {
    if (this.records === null) {
      // One shared load: two first callers must end up holding the same array.
      this.loading ??= this.store.load().then(
        (loaded) => {
          this.records ??= loaded;
          return loaded;
        },
        (error: unknown) => {
          this.loading = null;
          throw error;
        },
      );
      await this.loading;
    }
    return this.records!;
  }

  /** Throw CONFLICT if any of `identities` already belongs to a principal other than `exceptId`. */
  private assertIdentitiesFree(
    records: readonly PrincipalRecord[],
    identities: readonly PrincipalIdentity[],
    exceptId: string | null,
  ): void {
    const owner = new Map<string, string>();
    for (const record of records) {
      if (record.id === exceptId) continue;
      for (const identity of record.identities) owner.set(identityKey(identity), record.id);
    }
    for (const identity of identities) {
      const existing = owner.get(identityKey(identity));
      if (existing) {
        throw new PrincipalRegistryError(
          `identity ${identity.channel}:${identity.value} is already mapped to principal ${existing}`,
          'CONFLICT',
        );
      }
    }
  }

  async list(): Promise<PrincipalRecord[]> {
    return [...(await this.all())];
  }

  async get(id: string): Promise<PrincipalRecord> {
    const record = (await this.all()).find((r) => r.id === id);
    if (!record) throw new PrincipalRegistryError(`No principal with id ${id}`, 'NOT_FOUND');
    return record;
  }

  async create(input: CreatePrincipalInput): Promise<PrincipalRecord> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new PrincipalRegistryError('name is required', 'INVALID_ARGUMENT');
    const kind = requireKind(input.kind);
    const identities = normalizeIdentities(input.identities);
    return this.mutate((records) => {
      this.assertIdentitiesFree(records, identities, null);
      const now = Date.now();
      const record: PrincipalRecord = {
        id: `principal:${randomUUID().slice(0, 12)}`,
        name,
        kind,
        identities,
        createdAt: now,
        updatedAt: now,
        ...(input.metadata ? { metadata: input.metadata } : {}),
      };
      return { next: [...records, record], result: record };
    });
  }

  async update(id: string, input: UpdatePrincipalInput): Promise<PrincipalRecord> {
    return this.mutate((records) => {
      const index = records.findIndex((r) => r.id === id);
      if (index === -1) throw new PrincipalRegistryError(`No principal with id ${id}`, 'NOT_FOUND');
      const current = records[index]!;
      const identities = input.identities !== undefined
        ? normalizeIdentities(input.identities)
        : current.identities;
      if (input.identities !== undefined) this.assertIdentitiesFree(records, identities, id);
      const name = input.name !== undefined ? input.name.trim() : current.name;
      if (!name) throw new PrincipalRegistryError('name cannot be empty', 'INVALID_ARGUMENT');
      const next: PrincipalRecord = {
        ...current,
        name,
        kind: input.kind !== undefined ? requireKind(input.kind) : current.kind,
        identities,
        updatedAt: Date.now(),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
      };
      const nextRecords = [...records];
      nextRecords[index] = next;
      return { next: nextRecords, result: next };
    });
  }

  async delete(id: string): Promise<boolean> {
    return this.mutate((records) => {
      if (!records.some((r) => r.id === id)) return { next: null, result: false };
      return { next: records.filter((r) => r.id !== id), result: true };
    });
  }

  /**
   * Resolve a channel-specific sender identity to its named principal. An
   * unmapped identity resolves to the unknown principal with known:false, the
   * registry never guesses.
   */
  async resolveByIdentity(identity: PrincipalIdentity): Promise<PrincipalResolution> {
    if (typeof identity?.channel !== 'string' || typeof identity?.value !== 'string') {
      throw new PrincipalRegistryError('channel and value are required', 'INVALID_ARGUMENT');
    }
    const normalized = normalizeIdentity(identity);
    if (!normalized.channel || !normalized.value) {
      throw new PrincipalRegistryError('channel and value must be non-empty', 'INVALID_ARGUMENT');
    }
    const key = identityKey(normalized);
    const record = (await this.all()).find((r) => r.identities.some((i) => identityKey(i) === key));
    if (record) return { principal: record, known: true };
    return { principal: unknownPrincipal(normalized), known: false };
  }
}
