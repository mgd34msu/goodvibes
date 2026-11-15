import { afterAll, expect, spyOn, test } from 'bun:test';
import { describeEndpoint, exportDecisions } from '../platform/src/platform/runtime/permissions/decision-otlp.ts';
import { DecisionLog } from '../platform/src/platform/runtime/permissions/decision-log.ts';
import { logger } from '../platform/src/platform/utils/logger.ts';
import type { DecisionLogEntry } from '../platform/src/platform/runtime/permissions/decision-log.ts';
import type { PermissionDecision } from '../platform/src/platform/runtime/permissions/types.ts';

const decision = {
  allowed: true, reason: 'MODE_ALLOW_ALL', sourceLayer: 'mode', toolName: 'read', args: {},
  classification: 'read', timestamp: 1, evaluationTrace: [],
} as unknown as PermissionDecision;
const entries: DecisionLogEntry[] = [{ seq: 1, decision }];

const server = Bun.serve({
  port: 0,
  fetch: (req) => new Response('{}', { status: new URL(req.url).pathname === '/v1/logs' ? 500 : 200 }),
});
afterAll(() => { server.stop(true); });

test('a partial export names the signal that failed', async () => {
  const warn = spyOn(logger, 'warn').mockImplementation(() => {});
  try {
    const result = await exportDecisions(entries, { enabled: true, endpoint: `http://localhost:${server.port}`, signal: 'both' });
    expect(result.exported).toBe(true);
    expect(result.signals).toEqual(['span']);
    expect(result.failedSignals).toEqual(['log']);
    expect(JSON.stringify(warn.mock.calls)).toContain('/v1/logs');
  } finally {
    warn.mockRestore();
  }
});

test('a collector url is described without userinfo or query', () => {
  const described = describeEndpoint('http://user:s3cret@collector.example:4318/v1/logs?key=abc');
  expect(described).toBe('http://collector.example:4318/v1/logs');
});

test('a decision log sized 0 still records the latest decision', () => {
  const log = new DecisionLog(0);
  log.append(decision);
  log.append(decision);
  expect(log.query({}).length).toBe(1);
});
