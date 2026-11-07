import { expect, test } from 'bun:test';
import { workspaceProductUpdatePolicy } from '../sdk/src/platform/utils/product-identity.ts';
test('private monorepo manifests do not disable standalone compiled product updates', () => {
  const saved = process.execPath;
  try {
    const manifest = {private:true,dependencies:{'@goodvibes-jev/engine':'workspace:*'}};
    process.execPath = '/owned/bin/goodvibes';
    expect(workspaceProductUpdatePolicy(manifest, '@goodvibes-jev/tui', 'TUI').isWorkspaceDistribution).toBe(false);
    process.execPath = '/owned/bin/goodvibes-agent';
    expect(workspaceProductUpdatePolicy(manifest, '@goodvibes-jev/agent', 'Agent').isWorkspaceDistribution).toBe(false);
    process.execPath = '/owned/runtime/bun';
    expect(workspaceProductUpdatePolicy(manifest, '@goodvibes-jev/agent', 'Agent').isWorkspaceDistribution).toBe(true);
  } finally { process.execPath = saved; }
});
