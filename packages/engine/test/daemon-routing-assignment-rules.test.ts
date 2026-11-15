/**
 * An assignment that could never match an inbound route is refused when it is
 * made, a list page reports the full count, and a write that cannot be saved
 * does not change what the resolver reads.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { registerRoutingMethods } from '../platform/src/platform/channels/host-routing/registration.js';
import type { GatewayMethodCatalog } from '../platform/src/platform/control-plane/index.js';
import { makeHandlerContext, makeInvocation, makeTmpWorkingDir } from './_helpers/routing-registration.js';

const LIST = 'channels.routing.list';
const ASSIGN = 'channels.routing.assign';

function confirmed(body: Record<string, unknown>) {
  return makeInvocation({ ...body, confirm: true });
}

describe('channels.routing assignment rules', () => {
  let tmp: ReturnType<typeof makeTmpWorkingDir>;
  let catalog: GatewayMethodCatalog;
  let logger: ReturnType<typeof makeHandlerContext>['logger'];
  let registration: ReturnType<typeof registerRoutingMethods>;

  beforeEach(() => {
    tmp = makeTmpWorkingDir();
    const built = makeHandlerContext(tmp.dir);
    catalog = built.catalog;
    logger = built.logger;
    registration = registerRoutingMethods({ ...built.ctx, hasProfile: (id) => id === 'work' });
  });

  afterEach(async () => {
    await registration.close().catch(() => {});
    tmp.cleanup();
  });

  test('a surface the daemon does not route is refused with a 400 naming the choices', async () => {
    await expect(catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slak', profileId: 'work' })))
      .rejects.toMatchObject({ status: 400, code: 'ROUTING_INVALID_SURFACE_KIND' });
    const listed = (await catalog.invoke(LIST, makeInvocation({}))) as { total: number };
    expect(listed.total).toBe(0);
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'email', profileId: 'work' }));
    expect(registration.resolver.getProfileForChannel('email')).toBe('work');
  });

  test('a surface whose messages never consult an assignment is refused, naming the ones that do', async () => {
    await expect(catalog.invoke(ASSIGN, confirmed({ channelId: 'telegram:12345', profileId: 'work' })))
      .rejects.toMatchObject({ status: 400, code: 'ROUTING_SURFACE_NOT_ROUTED' });
    const listed = (await catalog.invoke(LIST, makeInvocation({}))) as { total: number };
    expect(listed.total).toBe(0);
  });

  test('an assignment naming a profile this host does not hold is kept but flagged in the log', async () => {
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slack', profileId: 'wrok' }));
    expect(registration.resolver.getProfileForChannel('slack')).toBe('wrok');
    const warned = logger.entries.filter((entry) => entry.level === 'warn');
    expect(warned).toHaveLength(1);
    expect(warned[0]!.meta).toMatchObject({ profileId: 'wrok' });
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'discord', profileId: 'work' }));
    expect(logger.entries.filter((entry) => entry.level === 'warn')).toHaveLength(1);
  });

  test('missing fields are client errors, not server errors', async () => {
    await expect(catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slack' }))).rejects.toMatchObject({ status: 400 });
    await expect(catalog.invoke(ASSIGN, confirmed({ profileId: 'work' }))).rejects.toMatchObject({ status: 400 });
  });

  test('a surfaceKind that disagrees with the channelId is refused, not silently ignored', async () => {
    await expect(catalog.invoke(ASSIGN, confirmed({ channelId: 'slack:C1', surfaceKind: 'discord', profileId: 'work' })))
      .rejects.toMatchObject({ status: 400, code: 'ROUTING_INVALID_CHANNEL_ID' });
    const same = (await catalog.invoke(ASSIGN, confirmed({ channelId: 'slack:C1', surfaceKind: 'slack', routeId: 'C1', profileId: 'work' }))) as { channelId: string };
    expect(same.channelId).toBe('slack:C1');
  });

  test('a routeId beside a channelId that names no route is refused, not dropped into a surface-wide assignment', async () => {
    await expect(catalog.invoke(ASSIGN, confirmed({ channelId: 'slack', routeId: 'C1', profileId: 'work' })))
      .rejects.toMatchObject({ status: 400, code: 'ROUTING_INVALID_CHANNEL_ID' });
    const listed = (await catalog.invoke(LIST, makeInvocation({}))) as { total: number };
    expect(listed.total).toBe(0);
  });

  test("'any' cannot be narrowed to a route, because no resolver would honour that", async () => {
    await expect(catalog.invoke(ASSIGN, confirmed({ channelId: 'any:room1', profileId: 'work' })))
      .rejects.toMatchObject({ status: 400, code: 'ROUTING_INVALID_CHANNEL_ID' });
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'any', profileId: 'work' }));
    expect(registration.resolver.getProfileForChannel('slack', 'x')).toBe('work');
  });

  test('a limited list reports how many assignments exist', async () => {
    for (const routeId of ['C1', 'C2', 'C3']) {
      await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slack', routeId, profileId: 'work' }));
    }
    const page = (await catalog.invoke(LIST, makeInvocation({ limit: 1 }))) as { routes: unknown[]; total: number };
    expect(page.routes).toHaveLength(1);
    expect(page.total).toBe(3);
  });

  test("a surface filter includes the 'any' assignment that applies to it", async () => {
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'any', profileId: 'fallback' }));
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'discord', profileId: 'play' }));
    const slack = (await catalog.invoke(LIST, makeInvocation({ surfaceKind: 'slack' }))) as { routes: Array<{ surfaceKind: string }> };
    expect(slack.routes.map((route) => route.surfaceKind)).toEqual(['any']);
  });

  test('an assignment that cannot be saved is not left active in the table the resolver reads', async () => {
    await registration.initialize();
    await catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slack', routeId: 'C1', profileId: 'work' }));
    // The database file's path becomes a non-empty directory, so publishing the next write fails.
    rmSync(registration.store.dbPath, { force: true });
    mkdirSync(registration.store.dbPath);
    writeFileSync(join(registration.store.dbPath, 'occupied'), '');
    await expect(catalog.invoke(ASSIGN, confirmed({ surfaceKind: 'slack', routeId: 'C2', profileId: 'play' }))).rejects.toThrow();
    expect(registration.store.findByChannelId('slack:C2')).toBeNull();
    expect(registration.resolver.getProfileForChannel('slack', 'C2')).toBeNull();
    expect(registration.resolver.getProfileForChannel('slack', 'C1')).toBe('work');
  });
});
