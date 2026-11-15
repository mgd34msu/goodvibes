/** Exercises advertised capabilities against the real daemon dispatch chain. */

import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { GATEWAY_REST_ROUTES } from '../daemon-api/src/gateway-rest-routes.ts';
import {
  createDaemonApiRouteProbe,
  findUnreconciledAdvertisements,
  findUnservedGatewayMethods,
  markUnservedGatewayMethods,
  reconcileCatalogRoutes,
  reconcileHttpDescriptor,
  UNSERVED_METHOD_REASON_KEY,
} from '../platform/src/platform/control-plane/method-catalog-route-reconcile.ts';

function liveCatalogDescriptors() {
  return new GatewayMethodCatalog().list();
}

describe('capability-advertisement honesty: route reconcile', () => {
  test('email.inbox.list: the dogfood finding is fixed, and the path it always advertised is the one now served', async () => {
    const probe = createDaemonApiRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const emailInboxList = descriptors.find((d) => d.id === 'email.inbox.list');
    expect(emailInboxList).toBeDefined();
    // The advertised path is UNCHANGED from when it was unreachable. That is
    // the point: the ad was always honest about where this lives, and the fix
    // was to serve it rather than to quietly move the goalposts to a path that
    // happened to already have a route.
    expect(emailInboxList!.http).toEqual({ method: 'GET', path: '/api/email/inbox' });

    const result = await reconcileHttpDescriptor(emailInboxList!, probe);
    expect(result.status).toBe('live');

    // And the ad no longer says "don't call this".
    expect(emailInboxList!.invokable).not.toBe(false);
  });

  test('every email.* method that advertises a route resolves to one, and none is marked unavailable', async () => {
    const probe = createDaemonApiRouteProbe();
    const descriptors = liveCatalogDescriptors().filter((d) => d.category === 'email');
    const advertised = descriptors.filter((d) => d.http);
    // The four mail verbs promise /api/email/* paths. The expectation verbs
    // advertise none: their callers are inside the daemon, reaching them over
    // the control plane, and a descriptor promising a path no route serves is
    // precisely what this gate exists to redden.
    //
    // Counted as two groups rather than one total, deliberately. A single
    // `toHaveLength(descriptors.length)` would keep passing if someone gave a
    // mail verb an http binding and no route, so long as they also added a
    // REST-less verb, the check would move with the thing it is checking.
    expect(advertised).toHaveLength(4);

    for (const descriptor of advertised) {
      const result = await reconcileHttpDescriptor(descriptor, probe);
      expect(result.status, `${descriptor.id} advertises ${descriptor.http?.method ?? '?'} ${descriptor.http?.path ?? '?'} but no route resolves it`).toBe('live');
      expect(descriptor.invokable).not.toBe(false);
    }

    for (const descriptor of descriptors.filter((d) => !d.http)) {
      const result = await reconcileHttpDescriptor(descriptor, probe);
      expect(result.status, `${descriptor.id} has no http binding, so there is nothing to reconcile`).toBe('unchecked');
      expect(descriptor.invokable).not.toBe(false);
    }
  });

  test('all five calendar.* methods resolve to a route and none is marked unavailable', async () => {
    const probe = createDaemonApiRouteProbe();
    const descriptors = liveCatalogDescriptors().filter((d) => d.category === 'calendar');
    expect(descriptors).toHaveLength(5);

    for (const descriptor of descriptors) {
      const result = await reconcileHttpDescriptor(descriptor, probe);
      expect(result.status, `${descriptor.id} advertises ${descriptor.http?.method ?? '?'} ${descriptor.http?.path ?? '?'} but no route resolves it`).toBe('live');
      expect(descriptor.invokable).not.toBe(false);
    }
  });

  test('every browser.* method resolves to a route and none is marked unavailable', async () => {
    // The browser engine was hoisted into the platform and the daemon could link
    // it, but no verb and no path existed, so nothing the daemon did on its
    // own could open a page. Serving the WHOLE surface is the point: a count
    // check here fails if a later change quietly drops one back out of the
    // route table while leaving its advertisement standing.
    const probe = createDaemonApiRouteProbe();
    const descriptors = liveCatalogDescriptors().filter((d) => d.category === 'browser');
    expect(descriptors.length).toBeGreaterThan(0);

    for (const descriptor of descriptors) {
      const result = await reconcileHttpDescriptor(descriptor, probe);
      expect(result.status, `${descriptor.id} advertises ${descriptor.http?.method ?? '?'} ${descriptor.http?.path ?? '?'} but no route resolves it`).toBe('live');
      expect(descriptor.invokable).not.toBe(false);
    }
  });

  test('every advertised unavailable route is marked unavailable', async () => {
    const probe = createDaemonApiRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const results = await reconcileCatalogRoutes(descriptors, probe);

    const violations = findUnreconciledAdvertisements(descriptors, results).sort();
    // Any advertised route without a live handler must disclose its unavailability.
    expect(violations).toEqual([]);
  });

  test('a genuinely-served method still reconciles as live (no false-unavailable)', async () => {
    const probe = createDaemonApiRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const controlAuthCurrent = descriptors.find((d) => d.id === 'control.auth.current');
    expect(controlAuthCurrent).toBeDefined();
    expect(controlAuthCurrent!.http).toEqual({ method: 'GET', path: '/api/control-plane/auth' });

    const result = await reconcileHttpDescriptor(controlAuthCurrent!, probe);
    expect(result.status).toBe('live');
  });

  test('a method with no http binding is left unchecked, not flagged', async () => {
    const probe = createDaemonApiRouteProbe();
    const descriptors = liveCatalogDescriptors();
    // fleet.snapshot is handler-registered with no http binding at
    // catalog-construction time (registered later, at RuntimeServices
    // construction), reconcile must not treat "no binding yet" as a
    // violation.
    const noHttpDescriptor = descriptors.find((d) => !d.http);
    expect(noHttpDescriptor).toBeDefined();
    const result = await reconcileHttpDescriptor(noHttpDescriptor!, probe);
    expect(result.status).toBe('unchecked');
  });

  test('a path served by a sub-router that declares its routes is checked against them and resolves live', async () => {
    const probe = createDaemonApiRouteProbe();
    const descriptors = liveCatalogDescriptors();
    const mcpDescriptor = descriptors.find((d) => d.http?.path.startsWith('/api/mcp'));
    expect(mcpDescriptor).toBeDefined();
    const result = await reconcileHttpDescriptor(mcpDescriptor!, probe);
    expect(result.status).toBe('live');
  });
});

/**
 * A method that only `catalog.invoke` can answer (no HTTP binding, or a path in
 * the gateway REST table) and has no handler gets a 501 on every call. The
 * daemon marks each one uncallable at start so its catalog tells the truth.
 */
describe('methods that need a catalog handler and have none', () => {
  const SERVED_BY_GATEWAY_REST = 'email.inbox.list';

  function catalogWithHandlers(): GatewayMethodCatalog {
    const catalog = new GatewayMethodCatalog();
    for (const descriptor of catalog.list()) {
      if (descriptor.invokable !== false) catalog.register(descriptor, async () => ({}), { replace: true });
    }
    return catalog;
  }

  test('a gateway-REST or WebSocket method without a handler is named; one served by its own route module is not', () => {
    const catalog = catalogWithHandlers();
    expect(findUnservedGatewayMethods(catalog)).toEqual([]);

    const restDescriptor = catalog.get(SERVED_BY_GATEWAY_REST)!;
    const wsDescriptor = catalog.list().find((d) => !d.http && d.invokable !== false)!;
    const ownRoute = catalog.list().find((d) => d.http && d.invokable !== false && !GATEWAY_REST_ROUTES.some((r) => r.methodId === d.id))!;
    for (const descriptor of [restDescriptor, wsDescriptor, ownRoute]) catalog.register(descriptor, undefined, { replace: true });

    expect(findUnservedGatewayMethods(catalog)).toEqual([restDescriptor.id, wsDescriptor.id].sort());
  });

  test('marking turns each unserved method uncallable in the catalog, and the next sweep is empty', () => {
    const catalog = catalogWithHandlers();
    catalog.register(catalog.get(SERVED_BY_GATEWAY_REST)!, undefined, { replace: true });

    expect(markUnservedGatewayMethods(catalog)).toEqual([SERVED_BY_GATEWAY_REST]);
    expect(catalog.get(SERVED_BY_GATEWAY_REST)?.invokable).toBe(false);
    expect(catalog.get(SERVED_BY_GATEWAY_REST)?.metadata?.[UNSERVED_METHOD_REASON_KEY]).toBeString();
    expect(findUnservedGatewayMethods(catalog)).toEqual([]);
  });
});

describe('route reconcile over the whole catalog', () => {
  test('every descriptor with an http binding is checked, none is skipped for living in a sub-router', async () => {
    const descriptors = liveCatalogDescriptors().filter((d) => d.http);
    const results = await reconcileCatalogRoutes(descriptors, createDaemonApiRouteProbe());
    const skipped = results.filter((r) => r.status === 'unchecked').map((r) => `${r.methodId} ${r.http?.method} ${r.http?.path}`);
    expect(skipped).toEqual([]);
    expect(findUnreconciledAdvertisements(descriptors, results)).toEqual([]);
  });

  test('a templated sub-router path that no declared route serves is reported unavailable', async () => {
    const descriptor = {
      ...liveCatalogDescriptors().find((d) => d.http?.path === '/api/mcp/config/servers/{serverName}')!,
      id: 'mcp.config.servers.bogus',
      http: { method: 'PATCH' as const, path: '/api/mcp/config/servers/{serverName}' },
    };
    const result = await reconcileHttpDescriptor(descriptor, createDaemonApiRouteProbe());
    expect(result.status).toBe('unavailable');
  });
});
