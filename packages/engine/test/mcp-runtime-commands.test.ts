import { expect, test } from 'bun:test';
import type { McpApi, McpServerConfig } from '../platform/src/platform/mcp/index.ts';
import { createMcpRuntimeCommands, type McpCommandContext } from '../terminal-shell/src/mcp-runtime-commands.ts';

type Handler = (args: string[], ctx: McpCommandContext) => Promise<void> | void;

function harness(policy: { confirmMutations: boolean; wording?: { authReviewCommand: string } }, freshness: Record<string, string> = {}) {
  const printed: string[] = [];
  const approvals: Array<[string, string]> = [];
  const upserts: McpServerConfig[] = [];
  const api = {
    listServerSecurity: () => Object.entries(freshness).map(([name, schemaFreshness]) => ({ name, connected: true, role: 'general', trustMode: 'constrained', allowedPaths: [], allowedHosts: [], schemaFreshness })),
    approveSchemaQuarantine: (name: string, operator: string) => { approvals.push([name, operator]); },
    upsertServerConfig: async (_roots: unknown, _scope: string, config: McpServerConfig) => { upserts.push(config); return { path: '/cfg', reload: { added: [], removed: [], changed: [], unchanged: [] } }; },
    reload: async () => ({}),
    setServerTrustMode: () => {},
    setServerRole: () => {},
  } as unknown as McpApi;
  let command: { handler: Handler; argsHint: string } | undefined;
  const { registerMcpRuntimeCommands } = createMcpRuntimeCommands<McpCommandContext>(
    () => api,
    () => ({ projectRoot: '/p', homeDirectory: '/h' } as never),
    { hidden: false, allowAllOnAdd: true, confirmMutations: policy.confirmMutations, ...(policy.wording ? { wording: policy.wording } : {}) },
  );
  registerMcpRuntimeCommands({ register: (def: never) => { command = def; } } as never);
  const ctx = { print: (m: string) => printed.push(m), renderRequest: () => {} } as McpCommandContext;
  return { printed, approvals, upserts, run: (...args: string[]) => command!.handler(args, ctx), argsHint: () => command!.argsHint };
}

test('approving the override of an unknown or healthy server reports it and approves nothing', async () => {
  const h = harness({ confirmMutations: true }, { healthy: 'fresh', held: 'quarantined' });
  await h.run('quarantine', 'typo', 'approve', '--yes');
  await h.run('quarantine', 'healthy', 'approve', '--yes');
  expect(h.approvals).toEqual([]);
  expect(h.printed[0]).toContain('No MCP server named typo');
  expect(h.printed[1]).toContain('is not quarantined');
  await h.run('quarantine', 'held', 'approve', 'ops', '--yes');
  expect(h.approvals).toEqual([['held', 'ops']]);
  expect(h.printed[2]).toContain('Approved MCP tool-definition quarantine override for held as ops');
});

test('trust and role changes say they last for this session only', async () => {
  const h = harness({ confirmMutations: false });
  await h.run('trust', 'files', 'blocked');
  await h.run('role', 'files', 'docs');
  expect(h.printed[0]).toContain('for this session only');
  expect(h.printed[1]).toContain('for this session only');
});

test('a trailing --yes on add is never saved as a server argument, with or without confirmation', async () => {
  for (const confirmMutations of [false, true]) {
    const h = harness({ confirmMutations });
    await h.run('add', 'files', 'npx', '-y', 'server-fs', '/tmp', '--yes');
    expect(h.upserts[0]?.args).toEqual(['-y', 'server-fs', '/tmp']);
  }
  const passthrough = harness({ confirmMutations: false });
  await passthrough.run('add', 'files', 'npx', '--', 'tool', '--yes');
  expect(passthrough.upserts[0]?.args).toEqual(['tool', '--yes']);
});

test('the argument hint drops --yes where the command does not ask for it', () => {
  const h = harness({ confirmMutations: false });
  expect(h.argsHint()).not.toContain('--yes');
});

test('the product wording replaces the default command names', async () => {
  const h = harness({ confirmMutations: false, wording: { authReviewCommand: '/services auth-review' } }, { held: 'quarantined' });
  await h.run('auth-review');
  expect(h.printed.join('\n')).toContain('next: /services auth-review');
  expect(h.printed.join('\n')).not.toContain('next: /auth review');
});

test('the add receipt prints a secret launch flag value masked while the saved config keeps it', async () => {
  const h = harness({ confirmMutations: false });
  await h.run('add', 'files', 'npx', '--', 'tool', '--token', 'abc123');
  expect(h.upserts[0]?.args).toEqual(['tool', '--token', 'abc123']);
  const receipt = h.printed.join('\n');
  expect(receipt).toContain('--token ••••');
  expect(receipt).not.toContain('abc123');
});
