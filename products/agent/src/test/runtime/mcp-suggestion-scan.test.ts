import { expect, test } from 'bun:test';
import { scheduleMcpSuggestionScanOnFirstUse } from '../../runtime/mcp-suggestion-scan.ts';

function scanOptions(disconnectAll: () => Promise<void>) {
  return {
    mcpRegistry: { serverNames: [] as string[], disconnectAll },
    systemMessageRouter: { low: () => {} },
    requestRender: () => {},
    shellPaths: {} as never,
    surfaceRoot: 'agent',
  };
}

test('stopping the suggestion scan releases the servers that were started on first use', async () => {
  let disconnects = 0;
  const handle = scheduleMcpSuggestionScanOnFirstUse(scanOptions(async () => { disconnects += 1; }));
  await handle.stop();
  expect(disconnects).toBe(1);
});

test('a failed disconnect at shutdown does not reject the shutdown', async () => {
  const handle = scheduleMcpSuggestionScanOnFirstUse(scanOptions(async () => { throw new Error('child would not exit'); }));
  await expect(handle.stop()).resolves.toBeUndefined();
});
