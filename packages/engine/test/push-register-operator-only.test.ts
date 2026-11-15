import { describe, expect, test } from 'bun:test';
import { registerPushGatewayMethods, type PushGatewayService } from '../platform/src/platform/control-plane/routes/push.ts';
import type { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import type { GatewayMethodHandler, GatewayMethodInvocation } from '../platform/src/platform/control-plane/method-catalog-shared.ts';

const KEYS = { p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' };

function setup(): { handlers: Map<string, GatewayMethodHandler>; registered: string[] } {
  const handlers = new Map<string, GatewayMethodHandler>();
  const registered: string[] = [];
  const catalog = {
    get: (id: string) => ({ id }),
    register: (descriptor: { id: string }, handler: GatewayMethodHandler) => { handlers.set(descriptor.id, handler); },
  } as unknown as GatewayMethodCatalog;
  const service = {
    subscribe: async (input: { principalId: string }) => { registered.push(input.principalId); return { id: 's1' }; },
    reconcile: async (input: { principalId: string }) => { registered.push(input.principalId); return { subscription: { id: 's1' }, drift: 'created' }; },
  } as unknown as PushGatewayService;
  registerPushGatewayMethods(catalog, service);
  return { handlers, registered };
}

function call(admin: boolean | undefined): GatewayMethodInvocation {
  return {
    body: { endpoint: 'https://push.example.test/abc', keys: KEYS, deviceId: 'dev-1' },
    context: { principalId: 'someone', principalKind: 'user', clientKind: 'web', ...(admin === undefined ? {} : { admin }) },
  } as GatewayMethodInvocation;
}

describe('push device registration needs operator authority', () => {
  for (const id of ['push.subscriptions.create', 'push.subscriptions.reconcile']) {
    test(`${id} refuses a non-admin principal and registers nothing`, async () => {
      const { handlers, registered } = setup();
      for (const admin of [false, undefined]) {
        await expect(Promise.resolve(handlers.get(id)!(call(admin)))).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      }
      expect(registered).toEqual([]);
    });

    test(`${id} registers for an admin principal`, async () => {
      const { handlers, registered } = setup();
      await handlers.get(id)!(call(true));
      expect(registered).toEqual(['someone']);
    });
  }
});
