import { expect, test } from 'bun:test';
import { createDiagnosticsProvider } from '../platform/src/platform/runtime/diagnostics/index.ts';
import type { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import type { RuntimeHealthAggregator } from '../platform/src/platform/runtime/health/aggregator.ts';
import type { SloCollector } from '../platform/src/platform/runtime/perf/slo-collector.ts';

test('the provider hands its SLO collector to the health dashboard', () => {
  const bus = { onDomain: () => () => undefined } as unknown as RuntimeEventBus;
  const aggregator = {
    getCompositeHealth: () => ({ overall: 'healthy', domains: new Map(), capturedAt: 1 }),
    subscribe: () => () => undefined,
  } as unknown as RuntimeHealthAggregator;
  const sloCollector = { getMetrics: () => [], getSampleCounts: () => ({}) } as unknown as SloCollector;
  const provider = createDiagnosticsProvider({ eventBus: bus, healthAggregator: aggregator, sloCollector });
  try {
    const dashboard = provider.getHealthDashboard();
    expect(dashboard.sloRows?.length ?? 0).toBeGreaterThan(0);
  } finally { provider.dispose(); }
});
