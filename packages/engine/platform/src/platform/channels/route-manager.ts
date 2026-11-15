import { randomUUID } from 'node:crypto';
import { createDomainDispatch } from '../runtime/store/index.js';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import type { RouteSurfaceKind } from '../../events/routes.js';
import {
  emitRouteBindingCreated,
  emitRouteBindingFailed,
  emitRouteBindingRemoved,
  emitRouteBindingResolved,
  emitRouteBindingUpdated,
  emitRouteReplyTargetCaptured,
} from '../runtime/emitters/index.js';
import type { AutomationRouteBinding } from '../automation/routes.js';
import type { AutomationSurfaceKind } from '../automation/types.js';
import { AutomationRouteStore } from '../automation/store/routes.js';
import type { FeatureFlagManager } from '../runtime/feature-flags/index.js';
import { isFeatureGateEnabled } from '../runtime/feature-flags/index.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/**
 * A thread or per-message binding nobody has written through for this long is
 * dropped when the bindings load: its conversation is over, and a reply to it
 * later simply binds again.
 */
const IDLE_THREAD_BINDING_MS = 30 * 24 * 60 * 60 * 1000;
/** How long last-seen times and per-message values wait in memory before they are written. */
const TOUCH_FLUSH_DELAY_MS = 60_000;

export interface UpsertRouteBindingInput {
  readonly id?: string | undefined;
  readonly kind: AutomationRouteBinding['kind'];
  readonly surfaceKind: AutomationRouteBinding['surfaceKind'];
  readonly surfaceId: string;
  readonly externalId: string;
  readonly sessionPolicy?: AutomationRouteBinding['sessionPolicy'] | undefined;
  readonly threadPolicy?: AutomationRouteBinding['threadPolicy'] | undefined;
  readonly deliveryGuarantee?: AutomationRouteBinding['deliveryGuarantee'] | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly sessionId?: string | undefined;
  readonly jobId?: string | undefined;
  readonly runId?: string | undefined;
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

export interface PatchRouteBindingInput {
  readonly sessionPolicy?: AutomationRouteBinding['sessionPolicy'] | undefined;
  readonly threadPolicy?: AutomationRouteBinding['threadPolicy'] | undefined;
  readonly deliveryGuarantee?: AutomationRouteBinding['deliveryGuarantee'] | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly sessionId?: string | null | undefined;
  readonly jobId?: string | null | undefined;
  readonly runId?: string | null | undefined;
  readonly title?: string | undefined;
  readonly metadata?: Record<string, unknown> | undefined;
}

type RouteBindingFeatureFlags = Pick<FeatureFlagManager, 'isEnabled'>;

function toEventSurfaceKind(surfaceKind: AutomationSurfaceKind): RouteSurfaceKind {
  switch (surfaceKind) {
    case 'tui':
    case 'slack':
    case 'discord':
    case 'web':
    case 'ntfy':
    case 'webhook':
    case 'homeassistant':
    case 'telegram':
    case 'google-chat':
    case 'signal':
    case 'whatsapp':
    case 'telephony':
    case 'imessage':
    case 'msteams':
    case 'bluebubbles':
    case 'mattermost':
    case 'matrix':
    case 'service':
      return surfaceKind;
  }
  const _exhaustive: never = surfaceKind;
  return _exhaustive;
}

function sortBindings(bindings: Iterable<AutomationRouteBinding>): AutomationRouteBinding[] {
  return [...bindings].sort((a, b) => b.lastSeenAt - a.lastSeenAt || a.id.localeCompare(b.id));
}

function routeNaturalKey(input: Pick<UpsertRouteBindingInput, 'surfaceKind' | 'surfaceId' | 'externalId' | 'threadId' | 'channelId'>): string {
  return JSON.stringify([
    input.surfaceKind,
    input.surfaceId,
    input.externalId,
    input.threadId ?? '',
    input.channelId ?? '',
  ]);
}

const DIFFED_BINDING_FIELDS = ['sessionPolicy', 'threadPolicy', 'deliveryGuarantee', 'threadId', 'channelId', 'sessionId', 'jobId', 'runId', 'title'] as const;

/**
 * The fields an upsert actually changed (`lastSeenAt` and `updatedAt` move on every touch and are not changes).
 * `metadata` values are not diffed: adapters put per-message values in it (update, event and message ids), so it
 * differs on every inbound message and would make each one an update. A metadata key the binding did not have yet
 * is a change.
 */
function changedBindingFields(previous: AutomationRouteBinding, next: AutomationRouteBinding): string[] {
  const changed: string[] = DIFFED_BINDING_FIELDS.filter((field) => previous[field] !== next[field]);
  if (Object.keys(next.metadata).some((key) => !Object.hasOwn(previous.metadata, key))) changed.push('metadata');
  return changed;
}

function isIdleThreadBinding(binding: AutomationRouteBinding, now: number): boolean {
  return (binding.kind === 'thread' || binding.kind === 'message') && now - binding.lastSeenAt > IDLE_THREAD_BINDING_MS;
}

export class RouteBindingManager {
  private readonly store: AutomationRouteStore;
  private readonly incarnations = new Map<string, string>();
  private readonly bindings = new Map<string, AutomationRouteBinding>();
  /** Natural key to binding id, so an inbound message finds its binding without a scan. */
  private readonly byNaturalKey = new Map<string, string>();
  /** In-memory changes (last-seen, per-message values) not written yet. */
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private runtimeDispatch: DomainDispatch | null = null;
  private runtimeBus: RuntimeEventBus | null = null;
  private readonly featureFlags: RouteBindingFeatureFlags | null;
  private loaded = false;
  private starting: Promise<void> | undefined;

  constructor(config: {
    readonly store?: AutomationRouteStore | undefined;
    readonly runtimeStore?: RuntimeStore | undefined;
    readonly runtimeBus?: RuntimeEventBus | undefined;
    readonly featureFlags?: RouteBindingFeatureFlags | null | undefined;
  } = {}) {
    this.store = config.store ?? new AutomationRouteStore();
    if (config.runtimeStore) this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
    this.runtimeBus = config.runtimeBus ?? null;
    this.featureFlags = config.featureFlags ?? null;
  }

  private isEnabled(): boolean {
    return isFeatureGateEnabled(this.featureFlags, 'route-binding');
  }

  /**
   * Whether route binding is switched on at all.
   *
   * Public because a caller has to be able to tell "you have no bindings" from
   * "bindings are turned off", and from the outside those are the same answer:
   * `listBindings()` returns `[]` for both, `getBinding()` returns `undefined`
   * for both, and `resolve()` returns `undefined` for both. Inbound mail is the
   * case that made it matter, with `integrations.routeBinding` off it resolved
   * no notice route, recorded every arriving message as `no-route-binding`, and
   * went on reporting healthy while announcing nothing. An unrelated flag
   * turning a capability into a recorder is only diagnosable if the flag's
   * state is askable.
   */
  isRouteBindingEnabled(): boolean {
    return this.isEnabled();
  }

  private requireEnabled(operation: string): void {
    if (this.isEnabled()) return;
    throw new Error(`route binding is turned off (see the integrations.routeBinding setting); cannot ${operation}`);
  }

  attachRuntime(config: {
    readonly runtimeStore?: RuntimeStore | null | undefined;
    readonly runtimeBus?: RuntimeEventBus | null | undefined;
  }): void {
    if (config.runtimeStore) {
      this.runtimeDispatch = createDomainDispatch(config.runtimeStore);
      for (const binding of this.bindings.values()) {
        this.runtimeDispatch.syncRouteBinding(binding, 'routes.attach');
      }
    }
    if (config.runtimeBus) {
      this.runtimeBus = config.runtimeBus;
    }
  }

  async start(): Promise<void> {
    if (!this.isEnabled()) return;
    if (this.loaded) return;
    // One load for every caller that arrives before it finishes. A second load
    // resolving later would clear the map and reload the old snapshot over a
    // binding the first caller had already created.
    this.starting ??= this.load();
    try { await this.starting; }
    finally { this.starting = undefined; }
  }

  private async load(): Promise<void> {
    const snapshot = await this.store.load();
    this.bindings.clear();
    this.byNaturalKey.clear();
    const now = Date.now();
    let reaped = 0;
    // Oldest first, so the newest binding owns a natural key two rows share.
    for (const binding of [...snapshot.routes].sort((a, b) => a.lastSeenAt - b.lastSeenAt)) {
      if (isIdleThreadBinding(binding, now)) { reaped += 1; continue; }
      this.place(binding);
      this.runtimeDispatch?.syncRouteBinding(binding, 'routes.load');
    }
    this.loaded = true;
    if (reaped > 0) {
      logger.info('Route bindings: dropped thread bindings idle for more than 30 days', { reaped });
      this.markDirty();
    }
  }

  private place(binding: AutomationRouteBinding): void {
    const previous = this.bindings.get(binding.id);
    if (previous) {
      const previousKey = routeNaturalKey(previous);
      if (this.byNaturalKey.get(previousKey) === binding.id) this.byNaturalKey.delete(previousKey);
    }
    this.bindings.set(binding.id, binding);
    this.byNaturalKey.set(routeNaturalKey(binding), binding.id);
  }

  private unplace(bindingId: string): void {
    const previous = this.bindings.get(bindingId);
    if (!previous) return;
    const key = routeNaturalKey(previous);
    if (this.byNaturalKey.get(key) === bindingId) this.byNaturalKey.delete(key);
    this.bindings.delete(bindingId);
  }

  /** Remember an in-memory change and write it with the next real change, or within a minute. */
  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush().catch((error: unknown) => {
        logger.warn('Route bindings: last-seen times could not be written; they are kept in memory', { error: summarizeError(error) });
      });
    }, TOUCH_FLUSH_DELAY_MS);
    (this.flushTimer as unknown as { unref?: () => void }).unref?.();
  }

  /**
   * Write in-memory changes (last-seen times, per-message values) now. The
   * daemon calls this when it stops; otherwise they are written within a
   * minute or with the next real change, whichever comes first.
   */
  async flush(): Promise<void> {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (!this.dirty || !this.loaded) return;
    this.dirty = false;
    try {
      await this.store.save(sortBindings(this.bindings.values()));
    } catch (error) {
      this.dirty = true;
      throw error;
    }
  }

  /**
   * Put `next` in the map (or remove the binding when `next` is undefined) and
   * write it to disk. When the write fails the in-memory change is undone, so
   * this process never routes by a binding that disk does not have: it would
   * work until the next restart and then vanish. A newer change to the same
   * binding made while the write was pending is left alone.
   */
  private async commit(bindingId: string, next: AutomationRouteBinding | undefined): Promise<void> {
    const previous = this.bindings.get(bindingId);
    if (next) this.place(next); else this.unplace(bindingId);
    const wasDirty = this.dirty;
    this.dirty = false;
    try {
      await this.store.save(sortBindings(this.bindings.values()));
    } catch (error) {
      this.dirty = wasDirty;
      if (this.bindings.get(bindingId) === next) {
        if (previous) this.place(previous); else this.unplace(bindingId);
      }
      throw error;
    }
  }

  listBindings(): AutomationRouteBinding[] {
    if (!this.isEnabled()) return [];
    return sortBindings(this.bindings.values());
  }

  /** Host-private currentness fence; never a grant or a persisted source proof. */
  getBindingIncarnation(bindingId: string): string | null {
    if (!this.getBinding(bindingId)) return null;
    let incarnation = this.incarnations.get(bindingId);
    if (!incarnation) { incarnation = randomUUID(); this.incarnations.set(bindingId, incarnation); }
    return incarnation;
  }

  getBinding(bindingId: string): AutomationRouteBinding | undefined {
    if (!this.isEnabled()) return undefined;
    return this.bindings.get(bindingId);
  }

  resolve(surfaceKind: AutomationSurfaceKind, externalId: string, threadId?: string): AutomationRouteBinding | undefined {
    if (!this.isEnabled()) return undefined;
    // The most recently seen match, in one pass (no sort of every binding).
    let binding: AutomationRouteBinding | undefined;
    for (const entry of this.bindings.values()) {
      if (entry.surfaceKind !== surfaceKind || entry.externalId !== externalId) continue;
      if (threadId && entry.threadId !== threadId && entry.channelId !== threadId) continue;
      if (!binding || entry.lastSeenAt > binding.lastSeenAt || (entry.lastSeenAt === binding.lastSeenAt && entry.id < binding.id)) binding = entry;
    }
    if (!binding) return undefined;
    const eventSurfaceKind = toEventSurfaceKind(binding.surfaceKind);
    if (this.runtimeBus) {
      const targetId = binding.sessionId ?? binding.runId ?? binding.jobId ?? binding.externalId;
      const targetKind = binding.sessionId ? 'session' : binding.runId ? 'run' : binding.jobId ? 'job' : 'message';
      emitRouteBindingResolved(this.runtimeBus, {
        sessionId: binding.sessionId ?? 'routes',
        source: 'route-binding-manager',
        traceId: binding.id,
      }, {
        bindingId: binding.id,
        surfaceKind: eventSurfaceKind,
        externalId: binding.externalId,
        targetKind,
        targetId,
      });
    }
    return binding;
  }

  async upsertBinding(input: UpsertRouteBindingInput): Promise<AutomationRouteBinding> {
    this.requireEnabled('upsert route bindings');
    await this.start();
    const now = Date.now();
    const knownId = input.id ?? this.byNaturalKey.get(routeNaturalKey(input));
    const previous = knownId ? this.bindings.get(knownId) : undefined;
    const binding: AutomationRouteBinding = {
      id: input.id ?? previous?.id ?? `route-${randomUUID()}`,
      kind: input.kind,
      surfaceKind: input.surfaceKind,
      surfaceId: input.surfaceId,
      externalId: input.externalId,
      sessionPolicy: input.sessionPolicy ?? previous?.sessionPolicy ?? 'create-or-bind',
      threadPolicy: input.threadPolicy ?? previous?.threadPolicy ?? 'preserve',
      deliveryGuarantee: input.deliveryGuarantee ?? previous?.deliveryGuarantee ?? 'best-effort',
      threadId: input.threadId ?? previous?.threadId,
      channelId: input.channelId ?? previous?.channelId,
      sessionId: input.sessionId ?? previous?.sessionId,
      jobId: input.jobId ?? previous?.jobId,
      runId: input.runId ?? previous?.runId,
      title: input.title ?? previous?.title,
      lastSeenAt: now,
      createdAt: previous?.createdAt ?? now,
      updatedAt: now,
      metadata: {
        ...(previous?.metadata ?? {}),
        ...(input.metadata ?? {}),
      },
    };
    // Every inbound message upserts its route, and usually only `lastSeenAt`
    // and per-message values moved. Those stay in memory (written within a
    // minute); the file is written only when something durable changed.
    const changedFields = previous ? changedBindingFields(previous, binding) : [];
    if (previous && changedFields.length === 0 && previous.surfaceId === binding.surfaceId && previous.kind === binding.kind) {
      this.place(binding);
      this.markDirty();
    } else {
      await this.commit(binding.id, binding);
    }
    this.runtimeDispatch?.syncRouteBinding(binding, 'routes.upsert');

    const eventSurfaceKind = toEventSurfaceKind(binding.surfaceKind);
    if (this.runtimeBus) {
      const targetId = binding.sessionId ?? binding.runId ?? binding.jobId ?? binding.externalId;
      const targetKind = binding.sessionId ? 'session' : binding.runId ? 'run' : binding.jobId ? 'job' : 'message';
      if (previous) {
        // An UPDATED event names what really changed, and a touch alone is not one.
        if (changedFields.length > 0) {
          emitRouteBindingUpdated(this.runtimeBus, {
            sessionId: binding.sessionId ?? 'routes',
            source: 'route-binding-manager',
            traceId: binding.id,
          }, { bindingId: binding.id, changedFields });
        }
      } else {
        emitRouteBindingCreated(this.runtimeBus, {
          sessionId: binding.sessionId ?? 'routes',
          source: 'route-binding-manager',
          traceId: binding.id,
        }, {
          bindingId: binding.id,
          surfaceKind: eventSurfaceKind,
          externalId: binding.externalId,
          targetKind,
          targetId,
        });
      }
    }

    return binding;
  }

  async captureReplyTarget(bindingId: string, replyTargetId: string, threadId?: string): Promise<AutomationRouteBinding | null> {
    this.requireEnabled('capture route reply targets');
    await this.start();
    const binding = this.bindings.get(bindingId);
    if (!binding) return null;
    const updated: AutomationRouteBinding = {
      ...binding,
      threadId: threadId ?? binding.threadId,
      updatedAt: Date.now(),
      lastSeenAt: Date.now(),
      metadata: {
        ...binding.metadata,
        replyTargetId,
      },
    };
    // A new reply target on a binding that already had one is a per-message
    // value: kept in memory and written within a minute, like last-seen.
    if (updated.threadId === binding.threadId && Object.hasOwn(binding.metadata, 'replyTargetId')) {
      this.place(updated);
      this.markDirty();
    } else {
      await this.commit(bindingId, updated);
    }
    this.runtimeDispatch?.syncRouteBinding(updated, 'routes.reply-target');
    const eventSurfaceKind = toEventSurfaceKind(updated.surfaceKind);
    if (this.runtimeBus) {
      emitRouteReplyTargetCaptured(this.runtimeBus, {
        sessionId: updated.sessionId ?? 'routes',
        source: 'route-binding-manager',
        traceId: updated.id,
      }, {
        bindingId: updated.id,
        surfaceKind: eventSurfaceKind,
        externalId: updated.externalId,
        replyTargetId,
        threadId: updated.threadId ?? '',
      });
    }
    return updated;
  }

  async patchBinding(bindingId: string, patch: PatchRouteBindingInput): Promise<AutomationRouteBinding | null> {
    this.requireEnabled('patch route bindings');
    await this.start();
    const binding = this.bindings.get(bindingId);
    if (!binding) return null;
    const updated: AutomationRouteBinding = {
      ...binding,
      ...(patch.sessionPolicy !== undefined ? { sessionPolicy: patch.sessionPolicy } : {}),
      ...(patch.threadPolicy !== undefined ? { threadPolicy: patch.threadPolicy } : {}),
      ...(patch.deliveryGuarantee !== undefined ? { deliveryGuarantee: patch.deliveryGuarantee } : {}),
      ...(patch.threadId !== undefined ? { threadId: patch.threadId } : {}),
      ...(patch.channelId !== undefined ? { channelId: patch.channelId } : {}),
      ...(patch.sessionId !== undefined ? { sessionId: patch.sessionId ?? undefined } : {}),
      ...(patch.jobId !== undefined ? { jobId: patch.jobId ?? undefined } : {}),
      ...(patch.runId !== undefined ? { runId: patch.runId ?? undefined } : {}),
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      updatedAt: Date.now(),
      lastSeenAt: Date.now(),
      metadata: {
        ...binding.metadata,
        ...(patch.metadata ?? {}),
      },
    };
    await this.commit(bindingId, updated);
    this.runtimeDispatch?.syncRouteBinding(updated, 'routes.patch');

    const eventSurfaceKind = toEventSurfaceKind(updated.surfaceKind);
    if (this.runtimeBus) {
      emitRouteBindingUpdated(this.runtimeBus, {
        sessionId: updated.sessionId ?? 'routes',
        source: 'route-binding-manager',
        traceId: updated.id,
      }, {
        bindingId: updated.id,
        changedFields: [
          ...(patch.threadId !== undefined ? ['threadId'] : []),
          ...(patch.channelId !== undefined ? ['channelId'] : []),
          ...(patch.sessionId !== undefined ? ['sessionId'] : []),
          ...(patch.jobId !== undefined ? ['jobId'] : []),
          ...(patch.runId !== undefined ? ['runId'] : []),
          ...(patch.title !== undefined ? ['title'] : []),
          ...(patch.metadata ? ['metadata'] : []),
        ],
      });
    }

    return updated;
  }

  async removeBinding(bindingId: string): Promise<boolean> {
    this.requireEnabled('remove route bindings');
    await this.start();
    const binding = this.bindings.get(bindingId);
    if (!binding) return false;
    await this.commit(bindingId, undefined);
    this.incarnations.delete(bindingId);
    this.runtimeDispatch?.removeRouteBinding(bindingId, 'routes.remove');
    const eventSurfaceKind = toEventSurfaceKind(binding.surfaceKind);
    if (this.runtimeBus) {
      emitRouteBindingRemoved(this.runtimeBus, {
        sessionId: binding.sessionId ?? 'routes',
        source: 'route-binding-manager',
        traceId: binding.id,
      }, {
        bindingId: binding.id,
        surfaceKind: eventSurfaceKind,
        externalId: binding.externalId,
      });
    }
    return true;
  }

  /**
   * A session closed: its thread and per-message bindings are over. Channel
   * and direct-conversation bindings stay, since the next message in that
   * conversation reuses them. Returns how many were removed.
   */
  async releaseSession(sessionId: string): Promise<number> {
    if (!this.isEnabled()) return 0;
    await this.start();
    const ended = [...this.bindings.values()].filter((binding) => binding.sessionId === sessionId && (binding.kind === 'thread' || binding.kind === 'message'));
    for (const binding of ended) await this.removeBinding(binding.id);
    return ended.length;
  }

  recordFailure(surfaceKind: AutomationSurfaceKind, externalId: string, error: string): void {
    if (!this.isEnabled()) return;
    this.runtimeDispatch?.recordRouteBindingFailure(surfaceKind, externalId, 'routes.failure');
    const eventSurfaceKind = toEventSurfaceKind(surfaceKind);
    if (this.runtimeBus) {
      emitRouteBindingFailed(this.runtimeBus, {
        sessionId: 'routes',
        source: 'route-binding-manager',
        traceId: `${surfaceKind}:${externalId}`,
      }, {
        surfaceKind: eventSurfaceKind,
        externalId,
        error,
      });
    }
  }
}
