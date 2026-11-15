import { describe, expect, test } from 'bun:test';
import { remoteReceiptArtifacts } from '../../tools/agent-harness-agent-orchestration.ts';
import type { CommandContext } from '../../input/command-registry.ts';

/** Like ArtifactStore.list: the newest `limit` artifacts of any kind. */
function storeOf(artifacts: readonly Record<string, unknown>[]) {
  return { list: (limit?: number) => [...artifacts].sort((a, b) => Number(b.createdAt) - Number(a.createdAt)).slice(0, limit) };
}

describe('remote closeout receipts', () => {
  test('a receipt older than the newest hundred artifacts is still found', () => {
    const receipt = { id: 'receipt-old', createdAt: 1, metadata: { purpose: 'remote-runner-closeout-receipt', runnerId: 'agent-alpha' } };
    const newer = Array.from({ length: 150 }, (_, index) => ({ id: `doc-${index}`, createdAt: 1_000 + index, metadata: { purpose: 'export' } }));
    const context = { platform: { artifactStore: storeOf([receipt, ...newer]) } } as unknown as CommandContext;
    expect(remoteReceiptArtifacts(context).map(artifact => artifact.id)).toEqual(['receipt-old']);
  });
});
