/**
 * channel-profiles/registry.ts
 *
 * The channel→profile binding registry: CRUD over the bindings plus the one
 * operation intake depends on, resolve(surfaceKind, channelId?), which returns
 * the MOST SPECIFIC binding for an inbound message (a channel-scoped binding
 * wins over the surface-wide default), so a session originated from that channel
 * inherits the right model/permission defaults.
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
} from './types.js';

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

  /**
   * Resolve the effective profile defaults for a channel-originated session: a
   * channel-scoped binding (surfaceKind + channelId) wins over the surface-wide
   * default (surfaceKind only). Returns null when no binding applies, intake
   * then falls back to the host defaults, unchanged.
   */
  async resolve(surfaceKind: string, channelId?: string): Promise<ChannelProfileDefaults | null> {
    const surface = requireSurfaceKind(surfaceKind);
    const bindings = await this.all();
    const channel = (channelId ?? '').trim();
    const specific = channel
      ? bindings.find((b) => b.id === channelProfileBindingId(surface, channel))
      : undefined;
    const chosen = specific ?? bindings.find((b) => b.id === channelProfileBindingId(surface));
    if (!chosen) return null;
    return {
      ...(chosen.model ? { model: chosen.model } : {}),
      ...(chosen.provider ? { provider: chosen.provider } : {}),
      ...(chosen.permissionMode ? { permissionMode: chosen.permissionMode } : {}),
    };
  }
}
