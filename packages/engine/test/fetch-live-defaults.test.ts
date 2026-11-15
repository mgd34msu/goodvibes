// Fetch defaults given as functions are read on every call, so a changed
// setting applies to the next fetch without rebuilding the tool.
import { describe, expect, test } from 'bun:test';
import { executeFetchInput } from '../platform/src/platform/tools/fetch/index.js';

const errorOf = async (deps: Parameters<typeof executeFetchInput>[1]): Promise<string> => {
  const output = await executeFetchInput({ urls: [{ url: 'http://localhost:9/x' }] } as never, deps);
  const first = (output as { results: Array<{ error?: string }> }).results[0];
  return first?.error ?? '';
};

describe('fetch defaults read live', () => {
  test('a host added to the blocked list after the tool was built is refused on the next call', async () => {
    let blocked: string[] = [];
    const deps = { defaultBlockedHosts: () => blocked, isLocalhostAllowed: () => false };
    expect(await errorOf(deps)).toContain('not approved for this project');
    blocked = ['localhost'];
    expect(await errorOf(deps)).toMatch(/^Request blocked: /);
    expect(await errorOf(deps)).not.toContain('not approved for this project');
  });
});
