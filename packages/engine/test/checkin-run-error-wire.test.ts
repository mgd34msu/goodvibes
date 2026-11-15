import { describe, expect, test } from 'bun:test';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import { CHECKIN_RUN_OUTPUT_SCHEMA } from '../platform/src/platform/control-plane/method-catalog-checkin.ts';
import { registerCheckinGatewayMethods, type CheckinGatewayService } from '../platform/src/platform/control-plane/routes/checkin.ts';
import { firstJsonSchemaFailure } from '../transport-http/src/index.js';

describe('checkin.run error outcome', () => {
  test('a failed evaluation returns its reason and the result validates against the published schema', async () => {
    const service = {
      evaluate: async () => ({ outcome: 'error', summary: 'check-in evaluation failed', error: 'delivery channel is not connected' }),
    } as unknown as CheckinGatewayService;
    const catalog = new GatewayMethodCatalog();
    registerCheckinGatewayMethods(catalog, service);
    const result = await catalog.invoke('checkin.run', { context: { admin: true }, body: {} }) as Record<string, unknown>;
    expect(result.error).toBe('delivery channel is not connected');
    expect(firstJsonSchemaFailure(CHECKIN_RUN_OUTPUT_SCHEMA, result)).toBeUndefined();
  });
});
