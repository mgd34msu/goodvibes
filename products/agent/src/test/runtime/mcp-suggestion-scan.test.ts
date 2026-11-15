import { expect, test } from 'bun:test';
import { scheduleMcpSuggestionScan } from '../../runtime/mcp-suggestion-scan.ts';

test('stopping before the scan runs cancels it and starts no server', async () => {
  let reads = 0;
  const handle = scheduleMcpSuggestionScan({
    mcpRegistry: { get serverNames() { reads += 1; return []; } },
    systemMessageRouter: { low: () => {} },
    requestRender: () => {},
    shellPaths: {} as never,
    surfaceRoot: 'agent',
  });
  handle.stop();
  expect(reads).toBe(0);
});
