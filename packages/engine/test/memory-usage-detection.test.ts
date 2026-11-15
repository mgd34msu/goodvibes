import { describe, expect, test } from 'bun:test';
import { installJudgmentPort, JudgmentPortMissingError } from '@goodvibes-jev/engine/errors';
import { detectReferencedMemoryIds } from '../platform/src/platform/state/index.js';
import { useMemoryReadings } from './_helpers/memory-readings.ts';

/**
 * Two-tier reference detection: every memory injected into a turn is read by
 * the `engine.state.memory-usage` battery against the response in ONE request.
 * 'referenced' only when the reading says yes; an uncertain or no reading is
 * 'present'.
 */
describe('detectReferencedMemoryIds', () => {
  const readings = useMemoryReadings();

  test('one request per turn, however many memories: the response is sent once with every memory', async () => {
    readings.use({ usage: (memory) => (memory.summary.includes('rollout') ? 0.95 : 0.05) });
    const result = await detectReferencedMemoryIds('I ran deploy/rollout.sh as configured.', [
      { id: 'm1', summary: 'Kubernetes rollout script', detail: 'deploy/rollout.sh' },
      { id: 'm2', summary: 'Release checklist' },
    ]);
    expect(result.referenced).toEqual(['m1']);
    expect(result.present).toEqual(['m2']);
    expect(result.perId.get('m1')).toBe('referenced');
    expect(result.perId.get('m2')).toBe('present');
    expect(result.assessed).toEqual(['m1', 'm2']);
    expect(readings.requests).toHaveLength(1);
    expect(readings.requests[0]!.state).toEqual({
      query: 'I ran deploy/rollout.sh as configured.',
      candidates: [
        { id: 'm1', content: { summary: 'Kubernetes rollout script', detail: 'deploy/rollout.sh' } },
        { id: 'm2', content: { summary: 'Release checklist' } },
      ],
    });
  });

  test('eight injected memories cost one decision-model request', async () => {
    readings.use({ usage: () => 0.05 });
    const records = Array.from({ length: 8 }, (_, index) => ({ id: `m${index}`, summary: `memory ${index}` }));
    const result = await detectReferencedMemoryIds('an unrelated answer', records);
    expect(readings.requests).toHaveLength(1);
    expect(result.present).toHaveLength(8);
  });

  test('an uncertain reading stays present: the tier claims use only on a yes', async () => {
    readings.use({ usage: () => 0.5 });
    const result = await detectReferencedMemoryIds('maybe related text', [{ id: 'u', summary: 'something' }]);
    expect(result.perId.get('u')).toBe('present');
    expect(result.referenced).toEqual([]);
  });

  test('a tentative yes does not claim a reference', async () => {
    readings.use({ usage: () => 0.57 });
    const result = await detectReferencedMemoryIds('maybe used', [{ id: 'u', summary: 'something' }]);
    expect(result.referenced).toEqual([]);
    expect(result.present).toEqual(['u']);
  });

  test('all inputs are screened before any memory request', async () => {
    await expect(detectReferencedMemoryIds('response', [
      { id: 'clean', summary: 'Ordinary memory' },
      { id: 'protected', summary: 'password=synthetic-fixture' },
    ])).rejects.toThrow();
    expect(readings.requests).toHaveLength(0);
  });

  test('no records means no requests', async () => {
    const result = await detectReferencedMemoryIds('anything', []);
    expect(result.referenced).toEqual([]);
    expect(readings.requests).toHaveLength(0);
  });

  test('a read with no judgment port installed throws', async () => {
    const previous = installJudgmentPort(undefined);
    try {
      await expect(detectReferencedMemoryIds('text', [{ id: 'x', summary: 'y' }])).rejects.toBeInstanceOf(JudgmentPortMissingError);
    } finally {
      installJudgmentPort(previous);
    }
  });
});
