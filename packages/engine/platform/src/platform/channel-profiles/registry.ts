/**
 * channel-profiles/registry.ts
 *
 * The channel→profile binding registry: CRUD over the bindings plus the one
 * operation intake depends on, resolve(surfaceKind, channelId?), which merges
 * the two bindings that can apply to a channel FIELD BY FIELD: a field the
 * channel-scoped binding sets wins, and every field it leaves unset comes from
 * the surface-wide default. Binding one Slack channel to a model therefore
 * keeps the permission mode the owner set for all of Slack.
 *
 * `set` is an upsert keyed on (surfaceKind, channelId?): binding the same
 * channel again replaces the previous binding rather than accumulating rows.
 */
import { StoreWriteQueue } from '../state/store-write-queue.js';
import { isSettableGatePresetName } from '../gate/presets.js';
import type { ChannelProfileStore } from './store.js';
import {
  CHANNEL_PERMISSION_MODES,
  ChannelProfileError,
  channelProfileBindingId,
  type ChannelPermissionMode,
  type ChannelProfileBinding,
  type ChannelProfileDefaults,
  type ChannelProfileField,
  type ChannelProfileResolution,
} from './types.js';

const PROFILE_FIELDS: readonly ChannelProfileField[] = ['model', 'provider', 'permissionMode'];

export interface SetChannelProfileInput {
  readonly surfaceKind: string;
  readonly channelId?: string | undefined;
  readonly model?: string | undefined;
  readonly provider?: string | undefined;
  readonly permissionMode?: ChannelPermissionMode | undefined;
  readonly metadata?: Readonly<Record<string, unknown>> | undefined;
}

function requireSurfaceKind(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ChannelProfileError('surfaceKind is required', 'INVALID_ARGUMENT');
  }
  return value.trim().toLowerCase();
}

export function parseChannelPermissionMode(value: unknown): ChannelPermissionMode | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || !isSettableGatePresetName(value)) {
    throw new ChannelProfileError(
      `permissionMode must be one of ${CHANNEL_PERMISSION_MODES.join(', ')}`,
      'INVALID_ARGUMENT',
    );
  }
  return value;
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ChannelProfileError(`${field} must be a string`, 'INVALID_ARGUMENT');
  return value.trim() || undefined;
}

export class ChannelProfileRegistry {
  private bindings: ChannelProfileBinding[] | null = null;
  /** The first load, shared: two first calls must read the file once and see one array. */
  private loading: Promise<ChannelProfileBinding[]> | null = null;
  /** Whole-store writes run one at a time, in call order. See StoreWriteQueue. */
  private readonly writes = new StoreWriteQueue();

  constructor(private readonly store: ChannelProfileStore) {}

  /**
   * Change the bindings: compute the new table from the current one, write it,
   * and only then make it the live one.
   *
   * Mutations run one at a time, in call order. `ChannelProfileStore.save`
   * replaces the file atomically but says nothing about ORDER, so unordered a
   * `set` could land after the `delete` that followed it and put the removed
   * binding back on disk. This binding decides the model and permission mode a
   * channel-originated session runs under, so a deleted one returning means a
   * channel keeps running under defaults its owner unbound. Memory changes only
   * after the write succeeds: a write that failed (and was reported as failed)
   * must not keep governing sessions until restart.
   */
  private async mutate<T>(change: (current: readonly ChannelProfileBinding[]) => { next: ChannelProfileBinding[] | null; result: T }): Promise<T> {
    let outcome: T | undefined;
    await this.writes.run(async () => {
      const current = await this.all();
      const { next, result } = change(current);
      if (next !== null) {
        await this.store.save(next);
        this.bindings = next;
      }
      outcome = result;
    });
    return outcome as T;
  }

  private all(): Promise<ChannelProfileBinding[]> {
    if (this.bindings !== null) return Promise.resolve(this.bindings);
    this.loading ??= this.store.load().then(
      (loaded) => {
        this.bindings ??= loaded;
        return this.bindings;
      },
      (error: unknown) => {
        // A failed load is retried by the next call, not cached.
        this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  async list(): Promise<ChannelProfileBinding[]> {
    return [...(await this.all())];
  }

  async get(surfaceKind: string, channelId?: string): Promise<ChannelProfileBinding> {
    const id = channelProfileBindingId(requireSurfaceKind(surfaceKind), channelId);
    const binding = (await this.all()).find((b) => b.id === id);
    if (!binding) throw new ChannelProfileError(`No channel profile binding for ${id}`, 'NOT_FOUND');
    return binding;
  }

  async set(input: SetChannelProfileInput): Promise<ChannelProfileBinding> {
    const surfaceKind = requireSurfaceKind(input.surfaceKind);
    const channelId = optionalString(input.channelId, 'channelId');
    const id = channelProfileBindingId(surfaceKind, channelId);
    const permissionMode = parseChannelPermissionMode(input.permissionMode);
    const binding: ChannelProfileBinding = {
      id,
      surfaceKind,
      ...(channelId ? { channelId } : {}),
      ...(optionalString(input.model, 'model') ? { model: optionalString(input.model, 'model') } : {}),
      ...(optionalString(input.provider, 'provider') ? { provider: optionalString(input.provider, 'provider') } : {}),
      ...(permissionMode ? { permissionMode } : {}),
      updatedAt: Date.now(),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    return this.mutate((current) => {
      const next = current.filter((b) => b.id !== id);
      const index = current.findIndex((b) => b.id === id);
      // An update keeps the binding's place in the list.
      if (index === -1) next.push(binding);
      else next.splice(index, 0, binding);
      return { next, result: binding };
    });
  }

  async delete(surfaceKind: string, channelId?: string): Promise<boolean> {
    const id = channelProfileBindingId(requireSurfaceKind(surfaceKind), channelId);
    return this.mutate((current) => {
      if (!current.some((b) => b.id === id)) return { next: null, result: false };
      return { next: current.filter((b) => b.id !== id), result: true };
    });
  }

  /** The effective profile for a channel-originated session, or null when no binding applies (host defaults stay). */
  async resolve(surfaceKind: string, channelId?: string): Promise<ChannelProfileDefaults | null> {
    return (await this.explain(surfaceKind, channelId))?.profile ?? null;
  }

  /** The effective profile plus the binding id that supplied each field, for showing an operator why. */
  async explain(surfaceKind: string, channelId?: string): Promise<ChannelProfileResolution | null> {
    return resolveFrom(await this.all(), requireSurfaceKind(surfaceKind), channelId);
  }

  /**
   * The same answer as `resolve`, synchronously, from the bindings already in
   * memory; `undefined` when they have not been read yet. For the spawn path,
   * which runs after intake has read them for the message that created the session.
   */
  resolveLoaded(surfaceKind: string, channelId?: string): ChannelProfileDefaults | null | undefined {
    if (this.bindings === null) return undefined;
    return resolveFrom(this.bindings, requireSurfaceKind(surfaceKind), channelId)?.profile ?? null;
  }

  /** Read the bindings now, so the first channel message after start does not wait on the file. */
  async preload(): Promise<void> {
    await this.all();
  }
}

function resolveFrom(bindings: readonly ChannelProfileBinding[], surface: string, channelId?: string): ChannelProfileResolution | null {
  const channel = (channelId ?? '').trim();
  const specific = channel ? bindings.find((b) => b.id === channelProfileBindingId(surface, channel)) : undefined;
  const wide = bindings.find((b) => b.id === channelProfileBindingId(surface));
  if (!specific && !wide) return null;
  const profile: { model?: string; provider?: string; permissionMode?: ChannelPermissionMode } = {};
  const sources: Partial<Record<ChannelProfileField, string>> = {};
  for (const field of PROFILE_FIELDS) {
    const from = specific?.[field] !== undefined ? specific : wide?.[field] !== undefined ? wide : undefined;
    if (!from) continue;
    sources[field] = from.id;
    if (field === 'permissionMode') profile.permissionMode = from.permissionMode!;
    else profile[field] = from[field]!;
  }
  return { profile, sources };
}
