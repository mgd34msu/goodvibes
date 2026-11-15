import { createDomainDispatch } from '../runtime/store/index.js';
import { isSurfaceEnabled } from '../daemon/surface-policy.js';
import type { DomainDispatch, RuntimeStore } from '../runtime/store/index.js';
import type { SurfaceConnectionState, SurfaceRecord } from '../runtime/store/domains/surfaces.js';
import type { ChannelHealthState, ChannelStatusSnapshot } from './types.js';
import { ConfigManager } from '../config/manager.js';
import type { ChannelPluginRegistry } from './plugin-registry.js';
import type { FeatureFlagReader } from '../runtime/feature-flags/index.js';
import { isSurfaceFeatureGateEnabled } from '../runtime/feature-flags/index.js';
import type { RuntimeEventBus } from '../runtime/events/index.js';
import { emitSurfaceCapabilityChanged, emitSurfaceDisabled, emitSurfaceEnabled } from '../runtime/emitters/surfaces.js';
import { CONFIG_SCHEMA } from '../config/schema.js';
import type { ConfigKey } from '../config/schema-types.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

/** The settings that switch a surface on or off; a change to one re-syncs the list. */
const SURFACE_SWITCH_KEYS: readonly ConfigKey[] = CONFIG_SCHEMA
  .map((setting) => setting.key as ConfigKey)
  .filter((key) => /^surfaces\.[^.]+\.enabled$/.test(key) || key === 'web.enabled' || key === 'controlPlane.enabled');

function now(): number {
  return Date.now();
}

export class SurfaceRegistry {
  private readonly configManager: ConfigManager;
  private readonly featureFlags: FeatureFlagReader;
  private readonly surfaces = new Map<string, SurfaceRecord>();
  private runtimeDispatch: DomainDispatch | null = null;
  private pluginRegistry: ChannelPluginRegistry | null = null;
  private runtimeBus: Pick<RuntimeEventBus, 'emit'> | null = null;
  private configUnsubscribes: Array<() => void> = [];
  /** The health snapshots the last `list()` read, by surface. */
  private health = new Map<string, ChannelStatusSnapshot>();

  constructor(configManager: ConfigManager, runtimeStore?: RuntimeStore, featureFlags?: FeatureFlagReader) {
    this.configManager = configManager;
    this.featureFlags = featureFlags ?? null;
    if (runtimeStore) this.runtimeDispatch = createDomainDispatch(runtimeStore);
  }

  attachRuntime(runtimeStore: RuntimeStore): void {
    this.runtimeDispatch = createDomainDispatch(runtimeStore);
    for (const surface of this.surfaces.values()) {
      this.runtimeDispatch.syncSurface(surface, 'surfaces.attach');
    }
  }

  attachPluginRegistry(pluginRegistry: ChannelPluginRegistry): void {
    this.pluginRegistry = pluginRegistry;
  }

  /**
   * Publish surface changes on `bus` (`surfaces` domain), so a client of
   * `surfaces.list` stays current without polling: switching a surface on or
   * off re-syncs the list, and each sync announces SURFACE_ENABLED,
   * SURFACE_DISABLED and SURFACE_CAPABILITY_CHANGED for what actually changed.
   * Cost: one in-memory re-sync per change of a surface switch, nothing per
   * request. Returns the detach function.
   */
  attachRuntimeBus(bus: Pick<RuntimeEventBus, 'emit'>): () => void {
    this.detachRuntimeBus();
    this.runtimeBus = bus;
    const resync = (): void => {
      try { this.syncConfiguredSurfaces(); }
      catch (error) { logger.warn('Surface list could not be re-read after a settings change', { error: summarizeError(error) }); }
    };
    this.configUnsubscribes = SURFACE_SWITCH_KEYS.map((key) => this.configManager.subscribe(key, resync));
    return () => this.detachRuntimeBus();
  }

  detachRuntimeBus(): void {
    for (const unsubscribe of this.configUnsubscribes.splice(0)) unsubscribe();
    this.runtimeBus = null;
  }

  /** Announce what changed between the last sync's record and this one's. */
  private publishChange(previous: SurfaceRecord | undefined, next: SurfaceRecord, reason: string): void {
    const bus = this.runtimeBus;
    // The first sight of a surface is its starting state, not a change.
    if (!bus || !previous) return;
    const ctx = { sessionId: 'system', source: 'surface-registry', traceId: next.id } as const;
    try {
      if (!previous.enabled && next.enabled) {
        emitSurfaceEnabled(bus, ctx, { surfaceKind: next.kind, surfaceId: next.id, accountId: next.accountId ?? next.kind });
      } else if (previous.enabled && !next.enabled) {
        emitSurfaceDisabled(bus, ctx, { surfaceKind: next.kind, surfaceId: next.id, reason });
      }
      const before = new Set(previous.capabilities);
      const after = new Set(next.capabilities);
      for (const capability of after) {
        if (!before.has(capability)) emitSurfaceCapabilityChanged(bus, ctx, { surfaceKind: next.kind, surfaceId: next.id, capability, enabled: true });
      }
      for (const capability of before) {
        if (!after.has(capability)) emitSurfaceCapabilityChanged(bus, ctx, { surfaceKind: next.kind, surfaceId: next.id, capability, enabled: false });
      }
    } catch (error) {
      logger.warn('Could not publish a surface change', { surface: next.id, error: summarizeError(error) });
    }
  }

  /**
   * The surface list as it is now: one record per registered plugin, `enabled`
   * from the one rule (`isSurfaceEnabled` behind the surface's feature gate)
   * and `state` from that surface's health snapshot, the same answer channel
   * status and the health watcher read. Built on each call, so a surface turned
   * on or a channel that died shows at once; a change since the last call is
   * published on the runtime store and bus. Cost: one status read per plugin.
   */
  async list(): Promise<SurfaceRecord[]> {
    const snapshots = new Map<string, ChannelStatusSnapshot>();
    try {
      for (const snapshot of await this.pluginRegistry?.listStatus() ?? []) snapshots.set(snapshot.surface, snapshot);
    } catch (error) {
      logger.warn('Surface health could not be read; listing surfaces without it', { error: summarizeError(error) });
    }
    this.health = snapshots;
    return this.publish(this.buildRecords());
  }

  /**
   * Re-read which surfaces are switched on now and publish what changed, with
   * the health last read by `list()`; a fresh health reading follows in the
   * background. For callers that need the answer synchronously.
   */
  syncConfiguredSurfaces(): SurfaceRecord[] {
    const records = this.publish(this.buildRecords());
    if (this.pluginRegistry) {
      void this.list().catch((error: unknown) => {
        logger.warn('Surface health could not be refreshed', { error: summarizeError(error) });
      });
    }
    return records;
  }

  private surfaceEnabled(surface: string): boolean {
    return isSurfaceFeatureGateEnabled(this.featureFlags, surface) && isSurfaceEnabled(this.configManager, surface);
  }

  private buildRecords(): SurfaceRecord[] {
    const at = now();
    return (this.pluginRegistry?.listDescriptors() ?? []).map((descriptor) => {
      const enabled = this.surfaceEnabled(descriptor.surface);
      const snapshot = this.health.get(descriptor.surface);
      return {
        id: `surface:${descriptor.surface}`,
        kind: descriptor.surface,
        label: descriptor.displayName,
        enabled,
        state: !enabled ? 'disabled' : snapshot ? connectionState(snapshot.state) : 'connecting',
        configuredAt: this.surfaces.get(`surface:${descriptor.surface}`)?.configuredAt ?? at,
        lastSeenAt: at,
        ...(snapshot?.accountId ? { accountId: snapshot.accountId } : {}),
        capabilities: [...descriptor.capabilities],
        metadata: snapshot ? { health: snapshot.state } : {},
      } satisfies SurfaceRecord;
    }).sort((a, b) => a.label.localeCompare(b.label));
  }

  private publish(records: SurfaceRecord[]): SurfaceRecord[] {
    // A surface that dropped out of this list (its feature gate went off, its
    // plugin was unregistered) must not stay `healthy` in the runtime store from
    // an earlier sync. The store has no removal, so it is published as disabled.
    const current = new Set(records.map((record) => record.id));
    for (const gone of this.surfaces.values()) {
      if (current.has(gone.id)) continue;
      const disabled: SurfaceRecord = { ...gone, enabled: false, state: 'disabled' };
      this.runtimeDispatch?.syncSurface(disabled, 'surfaces.sync');
      this.publishChange(gone, disabled, 'the surface is no longer available (its feature gate or plugin was removed)');
    }
    const previous = new Map(this.surfaces);
    this.surfaces.clear();
    for (const record of records) {
      this.surfaces.set(record.id, record);
      const before = previous.get(record.id);
      if (before && before.enabled === record.enabled && before.state === record.state && before.accountId === record.accountId
        && before.capabilities.join() === record.capabilities.join()) continue;
      this.runtimeDispatch?.syncSurface(record, 'surfaces.sync');
      this.publishChange(before, record, 'the surface was turned off (its setting, feature gate or ingress policy)');
    }
    return records;
  }
}

/** How a channel's health answer reads in the surface list (the exact state is in `metadata.health`). */
function connectionState(state: ChannelHealthState): SurfaceConnectionState {
  switch (state) {
    case 'healthy':
    case 'unknown':
      return 'healthy';
    case 'degraded':
    case 'unresolved':
      return 'degraded';
    case 'dead':
    case 'unconfigured':
      return 'error';
    case 'disabled':
      return 'disabled';
  }
}
