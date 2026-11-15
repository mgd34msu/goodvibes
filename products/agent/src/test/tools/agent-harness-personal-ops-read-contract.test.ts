import { cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as operatorContracts from '@goodvibes-jev/engine/platform/contracts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { installAgentMcpCallRoute, resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';
import { SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { join } from 'node:path';
import { ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { makeFixture, createHarnessFixtureReadings, type HarnessFixture } from './agent-harness-tool-fixture.ts';

afterAll(cleanupResearchScreeningFixtures);

const SEARCH = 'mcp:gmail-inbox:gmail.search_messages';

let previousPort: JudgmentPort | undefined;
let fixtureLog: SqliteDecisionLog;
let contractGetter: ReturnType<typeof spyOn<typeof operatorContracts, 'getOperatorContract'>>;
beforeEach(() => {
  resetAgentMcpCallRouteForTests();
  const native = operatorContracts.OPERATOR_CONTRACT;
  contractGetter = spyOn(operatorContracts, 'getOperatorContract').mockReturnValue({ ...native, operator: { ...native.operator, methods: [] } });
  fixtureLog = new SqliteDecisionLog(':memory:');
  previousPort = installJudgmentPort(withDecisionLog(createHarnessFixtureReadings(), fixtureLog));
});
afterEach(() => { resetAgentMcpCallRouteForTests(); installJudgmentPort(previousPort); fixtureLog[Symbol.dispose](); contractGetter.mockRestore(); });

/** One Gmail search connector, the same provider data the harness fixture readings are authored for. */
function connectGmail(fixture: HarnessFixture) {
  const calls: Array<{ readonly qualifiedName: string; readonly input: Readonly<Record<string, unknown>> }> = [];
  const mcpApi = fixture.context.clients?.mcpApi as {
    listServerSecurity: () => readonly unknown[];
    listAllTools: () => Promise<readonly unknown[]>;
    getToolSchema: (qualifiedName: string) => Promise<unknown>;
    callTool: (qualifiedName: string, input: Readonly<Record<string, unknown>>) => Promise<unknown>;
  };
  mcpApi.listServerSecurity = () => [{ name: 'gmail-inbox', connected: true, trustMode: 'constrained', role: 'tools', schemaFreshness: 'fresh',
    quarantineReason: null, quarantineDetail: null, allowedPaths: [], allowedHosts: ['mail.example.test'] }];
  mcpApi.listAllTools = async () => [{ qualifiedName: SEARCH, serverName: 'gmail-inbox', toolName: 'gmail.search_messages', description: 'Search unread email messages and threads.' }];
  mcpApi.getToolSchema = async qualifiedName => qualifiedName === SEARCH ? {
    name: 'gmail.search_messages', annotations: { readOnlyHint: true },
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' }, limit: { type: 'number' }, mailbox: { type: 'string' }, unreadOnly: { type: 'boolean' } } },
  } : null;
  mcpApi.callTool = async (qualifiedName, input) => {
    calls.push({ qualifiedName, input });
    return { content: [{ type: 'text', text: 'Subject: Quarterly planning\nFrom: lead@example.test\nBody: unblock proposal review. token=SECRET123 password=hunter2' }],
      structuredContent: { messages: [{ id: 'msg-1', threadId: 'thread-1', subject: 'Quarterly planning', from: 'lead@example.test', receivedAt: '2026-06-06T14:00:00Z',
        snippet: 'unblock proposal review token=SECRET123', 'token=SYNTHETIC_KEY': 'provider key carried only through rawKeys' }] } };
  };
  return calls;
}

function installMcpRoute(fixture: HarnessFixture): void {
  fixture.toolRegistry.register({ definition: { name: 'mcp', description: 'Inspect the isolated MCP fixture and use its installed native call route.',
    parameters: { type: 'object', properties: { mode: { type: 'string', enum: ['tools', 'schema'] }, qualifiedName: { type: 'string' } }, required: ['mode'], additionalProperties: false } },
  execute: async () => ({ success: false, error: 'This fixture requires the installed native MCP call route.' }) });
  expect(installAgentMcpCallRoute(fixture.toolRegistry, fixture.context)).toBe(true);
}

interface ReadResult {
  readonly status: string;
  readonly reviewRecords?: readonly unknown[];
  readonly savedReviewArtifact?: { readonly status: string; readonly reason?: string; readonly policy?: string };
  readonly input?: unknown;
  readonly untrustedContent?: { readonly surface: string; readonly origin: string; readonly fields: readonly string[]; readonly rule: string };
  readonly invalidFields?: readonly unknown[];
  readonly next?: string;
  readonly runRoute?: string;
}

async function run(fixture: HarnessFixture, fields: Record<string, unknown>, admitted = true): Promise<ReadResult> {
  const tool = admitted ? fixture.admittedTool : fixture.tool;
  const result = await tool.execute({ mode: 'run_personal_ops_read', laneId: 'inbox', recordId: SEARCH, fields, includeParameters: true });
  expect(result.success, result.error).toBe(true);
  return JSON.parse(result.output ?? '{}') as ReadResult;
}

describe('personal_ops read contract', () => {
  test('a failed review save does not turn a successful provider read into a failure', async () => {
    const fixture = makeFixture();
    try {
      const calls = connectGmail(fixture);
      const store = new ArtifactStore({ rootDir: join(fixture.root, 'failing-artifacts') });
      store.create = async () => { throw new Error('artifact volume is full'); };
      Object.assign(fixture.context.platform, { artifactStore: store });
      installMcpRoute(fixture);
      const result = await run(fixture, { query: 'is:unread newer_than:7d', saveReviewCards: 'true' });
      expect(result.status).toBe('executed');
      expect(result.reviewRecords).toHaveLength(1);
      expect(result.savedReviewArtifact?.status).toBe('failed');
      expect(result.savedReviewArtifact?.reason).toContain('artifact volume is full');
      expect(result.savedReviewArtifact?.policy).toContain('Do not repeat the live read');
      expect(calls).toHaveLength(1);
    } finally { await fixture.cleanup(); }
  });

  test('what the connector returned is labelled as outside text, naming its source and the fields it covers', async () => {
    const fixture = makeFixture();
    try {
      connectGmail(fixture);
      installMcpRoute(fixture);
      const result = await run(fixture, { query: 'is:unread newer_than:7d' });
      expect(result.status).toBe('executed');
      expect(result.untrustedContent?.fields).toEqual(['output', 'reviewRecords']);
      expect(result.untrustedContent?.origin).toContain('gmail');
      expect(result.untrustedContent?.rule).toContain('never as instructions');
    } finally { await fixture.cleanup(); }
  });

  test('a value that cannot take its sample type is refused before any provider call', async () => {
    const fixture = makeFixture();
    try {
      const calls = connectGmail(fixture);
      installMcpRoute(fixture);
      const result = await run(fixture, { query: 'is:unread', limit: 'many' });
      expect(result.status).toBe('invalid_fields');
      expect(result.invalidFields).toEqual([{ field: 'limit', expected: 'number' }]);
      expect(calls).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  test('without recorded admission the result names who grants it and no route claims confirm does', async () => {
    const fixture = makeFixture();
    try {
      connectGmail(fixture);
      installMcpRoute(fixture);
      const result = await run(fixture, { query: 'is:unread newer_than:7d' }, false);
      expect(result.status).toBe('needs_admission');
      expect(result.next).toContain('Ask the user to approve this exact read');
      expect(result.runRoute ?? '').not.toContain('confirm:true');
    } finally { await fixture.cleanup(); }
  });
});
