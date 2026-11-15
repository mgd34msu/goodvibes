/**
 * The cost ingest that the gateway verb composition binds to the runtime bus
 * is owned by the disposal registry it is given: tearing the graph down stops
 * later bus events from reaching the cost ledger.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GatewayMethodCatalog } from '../platform/src/platform/control-plane/method-catalog.ts';
import {
  registerGatewayVerbGroups,
  type GatewayVerbGroupDeps,
} from '../platform/src/platform/control-plane/routes/register-gateway-verb-groups.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { emitLlmResponseReceived } from '../platform/src/platform/runtime/emitters/turn.ts';

let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cost-ingest-disposal-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function emitTurn(bus: RuntimeEventBus): void {
  emitLlmResponseReceived(bus, { sessionId: 'session-1', source: 'turn-loop', traceId: 't1', turnId: 'turn-1' }, {
    turnId: 'turn-1', provider: 'p', model: 'm', contentSummary: 'x',
    toolCallCount: 0, inputTokens: 1000, outputTokens: 50,
  });
}

async function sessionRows(catalog: GatewayMethodCatalog): Promise<number> {
  // The bus delivers on microtasks.
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
  const result = await catalog.invoke('cost.attribution.get', {
    context: { principalId: 'op-1', admin: true },
    body: { window: '24h', dimension: 'session' },
  } as never) as { rows?: readonly unknown[] };
  return result.rows?.length ?? -1;
}

describe('cost attribution ingest ownership', () => {
  test('disposing the composition unbinds the ingest, so later turns are not recorded', async () => {
    const bus = new RuntimeEventBus();
    const disposals: Array<{ label: string; dispose: () => void | Promise<void> }> = [];
    const catalog = new GatewayMethodCatalog();
    registerGatewayVerbGroups(catalog, {
      secretsManager: { get: async () => null, set: async () => undefined },
      approvalBroker: { subscribe: () => () => undefined },
      shellPaths: { resolveUserPath: (...segments: string[]) => join(root, ...segments) },
      surfaceRoot: 'daemon',
      runtimeBus: bus,
      processRegistry: { query: () => ({ nodes: [] }) },
      disposal: { add: (label: string, dispose: () => void | Promise<void>) => { disposals.push({ label, dispose }); } },
    } as unknown as GatewayVerbGroupDeps);
    try {
      emitTurn(bus);
      expect(await sessionRows(catalog)).toBe(1);

      const ingest = disposals.find((entry) => entry.label === 'cost attribution ingest');
      expect(ingest).toBeDefined();
      await ingest!.dispose();

      emitLlmResponseReceived(bus, { sessionId: 'session-2', source: 'turn-loop', traceId: 't2', turnId: 'turn-2' }, {
        turnId: 'turn-2', provider: 'p', model: 'm', contentSummary: 'x',
        toolCallCount: 0, inputTokens: 1000, outputTokens: 50,
      });
      expect(await sessionRows(catalog)).toBe(1);
    } finally {
      for (const entry of disposals.reverse()) await entry.dispose();
    }
  });
});
