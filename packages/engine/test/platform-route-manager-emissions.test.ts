import { describe, it, expect, beforeEach } from 'bun:test';
import { RouteBindingManager } from '../platform/src/platform/channels/route-manager.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import type { AutomationRouteStore } from '../platform/src/platform/automation/store/routes.js';
import type { AutomationRouteBinding } from '../platform/src/platform/automation/routes.js';
import { settleEvents } from './_helpers/test-timeout.js';

// ---------------------------------------------------------------------------
// In-memory route store stub
// ---------------------------------------------------------------------------

function makeMemoryRouteStore(): AutomationRouteStore {
  let routes: AutomationRouteBinding[] = [];
  return {
    load: async () => ({ version: 1 as const, routes }),
    save: async (next: readonly AutomationRouteBinding[]) => { routes = [...next]; },
  } as unknown as AutomationRouteStore;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManager(bus: RuntimeEventBus): RouteBindingManager {
  return new RouteBindingManager({
    store: makeMemoryRouteStore(),
    runtimeBus: bus,
  });
}

const BASE_INPUT = {
  kind: 'session' as const,
  surfaceKind: 'slack' as const,
  surfaceId: 'T-test',
  externalId: 'U-test',
};

interface CapturedEvent {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

async function flush(): Promise<void> {
  await settleEvents(0);
}

function captureRouteEvents(bus: RuntimeEventBus): CapturedEvent[] {
  const captured: CapturedEvent[] = [];
  bus.onDomain('routes', (envelope) => {
    captured.push({
      type: (envelope.payload as { type: string }).type,
      data: envelope.payload as Record<string, unknown>,
    });
  });
  return captured;
}

// ---------------------------------------------------------------------------
// Tests, upsertBinding emissions
// ---------------------------------------------------------------------------

describe('RouteBindingManager.upsertBinding: emissions', () => {
  let bus: RuntimeEventBus;
  let manager: RouteBindingManager;
  let events: CapturedEvent[];

  beforeEach(() => {
    bus = new RuntimeEventBus();
    manager = makeManager(bus);
    events = captureRouteEvents(bus);
  });

  it('emits ROUTE_BINDING_CREATED when the binding is new', async () => {
    await manager.upsertBinding(BASE_INPUT);
    await flush();

    const created = events.find((e) => e.type === 'ROUTE_BINDING_CREATED')
    expect(created?.type).toBe('ROUTE_BINDING_CREATED');
  });

  it('emits ROUTE_BINDING_UPDATED naming the fields that changed when the binding already exists', async () => {
    const first = await manager.upsertBinding(BASE_INPUT);
    await flush();
    events.length = 0;

    await manager.upsertBinding({ ...BASE_INPUT, id: first.id, title: 'Renamed' });
    await flush();

    const updated = events.find((e) => e.type === 'ROUTE_BINDING_UPDATED');
    expect((updated?.data as { changedFields: string[] }).changedFields).toEqual(['title']);
    const created = events.find((e) => e.type === 'ROUTE_BINDING_CREATED');
    expect(created).toBeUndefined();
  });

  it('a repeated upsert that only touches lastSeenAt emits no UPDATED', async () => {
    const first = await manager.upsertBinding(BASE_INPUT);
    await flush();
    events.length = 0;

    await manager.upsertBinding({ ...BASE_INPUT, id: first.id });
    await flush();

    expect(events.filter((e) => e.type === 'ROUTE_BINDING_UPDATED')).toEqual([]);
  });

  it('an upsert whose only difference is per-message metadata emits no UPDATED but stores the new metadata', async () => {
    const first = await manager.upsertBinding({ ...BASE_INPUT, metadata: { updateId: '1' } });
    await flush();
    events.length = 0;

    const second = await manager.upsertBinding({ ...BASE_INPUT, id: first.id, metadata: { updateId: '2' } });
    await flush();

    expect(events.filter((e) => e.type === 'ROUTE_BINDING_UPDATED')).toEqual([]);
    expect(manager.getBinding(second.id)?.metadata).toEqual({ updateId: '2' });
  });

  it('ROUTE_BINDING_CREATED contains surfaceKind and externalId', async () => {
    await manager.upsertBinding(BASE_INPUT);
    await flush();

    const evt = events.find((e) => e.type === 'ROUTE_BINDING_CREATED');
    expect((evt?.data as { surfaceKind: string }).surfaceKind).toBe('slack');
    expect((evt?.data as { externalId: string }).externalId).toBe('U-test');
  });

  it('stores the binding without error when no runtimeBus is configured', async () => {
    const nobusMgr = new RouteBindingManager({ store: makeMemoryRouteStore() });

    const binding = await nobusMgr.upsertBinding(BASE_INPUT);

    expect(nobusMgr.getBinding(binding.id)).toMatchObject({ surfaceKind: 'slack', externalId: 'U-test' });
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Tests, removeBinding emissions
// ---------------------------------------------------------------------------

describe('RouteBindingManager.removeBinding: emissions', () => {
  let bus: RuntimeEventBus;
  let manager: RouteBindingManager;
  let events: CapturedEvent[];

  beforeEach(() => {
    bus = new RuntimeEventBus();
    manager = makeManager(bus);
    events = captureRouteEvents(bus);
  });

  it('emits ROUTE_BINDING_REMOVED after successful removal', async () => {
    const binding = await manager.upsertBinding(BASE_INPUT);
    await flush();
    events.length = 0;

    await manager.removeBinding(binding.id);
    await flush();

    const removed = events.find((e) => e.type === 'ROUTE_BINDING_REMOVED')
    expect(removed?.type).toBe('ROUTE_BINDING_REMOVED');
  });

  it('ROUTE_BINDING_REMOVED contains bindingId, surfaceKind, externalId', async () => {
    const binding = await manager.upsertBinding(BASE_INPUT);
    await flush();
    events.length = 0;

    await manager.removeBinding(binding.id);
    await flush();

    const evt = events.find((e) => e.type === 'ROUTE_BINDING_REMOVED');
    expect((evt?.data as { bindingId: string }).bindingId).toBe(binding.id);
    expect((evt?.data as { surfaceKind: string }).surfaceKind).toBe('slack');
    expect((evt?.data as { externalId: string }).externalId).toBe('U-test');
  });

  it('does NOT emit ROUTE_BINDING_REMOVED when binding does not exist', async () => {
    await manager.removeBinding('non-existent-id');
    await flush();

    const removed = events.find((e) => e.type === 'ROUTE_BINDING_REMOVED');
    expect(removed).toBeUndefined();
  });

  it('removal is idempotent: second call emits nothing', async () => {
    const binding = await manager.upsertBinding(BASE_INPUT);
    await flush();
    await manager.removeBinding(binding.id);
    await flush();
    events.length = 0;

    await manager.removeBinding(binding.id);
    await flush();

    const removed = events.find((e) => e.type === 'ROUTE_BINDING_REMOVED');
    expect(removed).toBeUndefined();
  });

  it('ROUTE_BINDING_REMOVED fires AFTER the binding is deleted from storage', async () => {
    const binding = await manager.upsertBinding(BASE_INPUT);
    let listingAfterRemove: AutomationRouteBinding[] | null = null;

    bus.onDomain('routes', (envelope) => {
      if ((envelope.payload as { type: string }).type === 'ROUTE_BINDING_REMOVED') {
        listingAfterRemove = manager.listBindings();
      }
    });

    await manager.removeBinding(binding.id);
    await flush();

    expect(listingAfterRemove).not.toBeNull();
    const finalListing = listingAfterRemove as unknown as AutomationRouteBinding[];
    expect(finalListing.find((b) => b.id === binding.id)).toBeUndefined();
  });
});

describe('RouteBindingManager: loading and persistence', () => {
  it('concurrent first callers share one load and both bindings survive', async () => {
    let routes: AutomationRouteBinding[] = [];
    const gate = Promise.withResolvers<void>();
    let loads = 0;
    const store = {
      load: async () => { loads += 1; await gate.promise; return { version: 1 as const, routes }; },
      save: async (next: readonly AutomationRouteBinding[]) => { routes = [...next]; },
    } as unknown as AutomationRouteStore;
    const manager = new RouteBindingManager({ store });
    const a = manager.upsertBinding({ ...BASE_INPUT, externalId: 'A' });
    const b = manager.upsertBinding({ ...BASE_INPUT, externalId: 'B' });
    gate.resolve();
    await Promise.all([a, b]);
    expect(loads).toBe(1);
    expect(manager.listBindings().map((x) => x.externalId).sort()).toEqual(['A', 'B']);
    expect(routes.map((x) => x.externalId).sort()).toEqual(['A', 'B']);
  });

  it('a failed save leaves memory as it was', async () => {
    let fail = false;
    const store = {
      load: async () => ({ version: 1 as const, routes: [] }),
      save: async () => { if (fail) throw new Error('disk full'); },
    } as unknown as AutomationRouteStore;
    const manager = new RouteBindingManager({ store });
    const kept = await manager.upsertBinding(BASE_INPUT);
    fail = true;
    await expect(manager.upsertBinding({ ...BASE_INPUT, externalId: 'other' })).rejects.toThrow('disk full');
    await expect(manager.removeBinding(kept.id)).rejects.toThrow('disk full');
    await expect(manager.patchBinding(kept.id, { title: 'x' })).rejects.toThrow('disk full');
    expect(manager.listBindings().map((x) => x.id)).toEqual([kept.id]);
    expect(manager.getBinding(kept.id)?.title).toBeUndefined();
  });
});

describe('RouteBindingManager.removeBinding: runtime store mirror', () => {
  it('drops the removed binding from the routes domain and keeps the others', async () => {
    const store = createRuntimeStore();
    const manager = new RouteBindingManager({ store: makeMemoryRouteStore(), runtimeStore: store });
    const keep = await manager.upsertBinding({ ...BASE_INPUT, externalId: 'U-keep' });
    const drop = await manager.upsertBinding({ ...BASE_INPUT, externalId: 'U-drop' });
    expect(store.getState().routes.bindingIds.sort()).toEqual([keep.id, drop.id].sort());

    expect(await manager.removeBinding(drop.id)).toBe(true);

    const routes = store.getState().routes;
    expect(routes.bindings.has(drop.id)).toBe(false);
    expect(routes.bindingIds).toEqual([keep.id]);
    expect(routes.activeBindingIds).toEqual([keep.id]);
    expect(routes.recentBindingIds).toEqual([keep.id]);
    expect(routes.totalBindings).toBe(1);
    expect(routes.bindingIdsBySurface['slack']).toEqual([keep.id]);
  });
});
