import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createShellPathService } from '@/runtime/index.ts';
import { ConfigManager } from '../../config/index.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createAgentOperatorBriefingTool } from '../../tools/agent-operator-briefing-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { mockFetch } from '../helpers/typed-fetch-mock.ts';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe('operator briefing does not print zeros for an answer that is not data', () => {
  test('a 200 HTML page is reported per route as unavailable and the footer counts it', async () => {
    const root = makeProjectTempDir('goodvibes-agent-briefing-shape');
    mkdirSync(join(root, '.goodvibes', 'daemon'), { recursive: true });
    writeFileSync(join(root, '.goodvibes', 'daemon', 'operator-tokens.json'), JSON.stringify({ token: 'briefing-shape-token' }));
    const paths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const config = new ConfigManager({ surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT, configDir: paths.resolveUserPath(GOODVIBES_AGENT_SURFACE_ROOT), workingDir: root, homeDir: root });
    globalThis.fetch = mockFetch(async () => new Response('<html>proxy login</html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    const result = await createAgentOperatorBriefingTool(paths, config).execute({});
    expect(result.success).toBe(true);
    const output = result.output ?? '';
    expect(output).toContain('approvals.list: unavailable (connected_host_error; unexpected response shape)');
    expect(output).toContain('scheduler.capacity: unavailable');
    expect(output).not.toContain('approvals: pending 0');
    expect(output).not.toContain('scheduler: slots 0/0');
    expect(output).not.toContain('warnings: none');
  });
});
