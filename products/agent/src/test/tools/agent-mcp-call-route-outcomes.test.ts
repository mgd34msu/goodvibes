import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import type { Tool } from '@goodvibes-jev/engine/platform/platform/types';
import type { McpApi, McpServerSecurityRecord, McpToolCallOptions, McpToolSchema } from '@goodvibes-jev/engine/platform/platform/mcp';
import { DEFAULT_CONFIG, type PermissionMode } from '@goodvibes-jev/engine/platform/platform/config';
import { PermissionManager, type PermissionConfigReader } from '@goodvibes-jev/engine/platform/platform/permissions';
import { PolicyRuntimeState } from '@goodvibes-jev/engine/platform/platform/runtime/security';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { SqliteDecisionLog, withDecisionLog } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installAgentMcpCallRoute, isAgentMcpCallRouteInstalled, resetAgentMcpCallRouteForTests } from '../../tools/agent-mcp-call-route.ts';

let previous: ReturnType<typeof installJudgmentPort>;
let log: SqliteDecisionLog;
beforeEach(() => {
  resetAgentMcpCallRouteForTests(); log = new SqliteDecisionLog(':memory:');
  const readings = fakePort((wireName, question) => {
    const name = wireName.replace(/^(effect|risk|edge)__/, '');
    if (question.type === 'choice') {
      const label = name === 'disposition' ? Object.hasOwn(question.criteria, 'act') ? 'act' : 'reject'
        : name === 'kind' ? 'read' : name === 'family' || name === 'capability' ? 'generic' : undefined;
      if (!label) throw new Error(`Unexpected synthetic MCP choice ${name}`);
      return choiceAnswer(question, label, 0.999);
    }
    if (question.type === 'noul') return noulAnswer(0.001);
    throw new Error(`Unexpected synthetic MCP question ${name}`);
  });
  previous = installJudgmentPort(withDecisionLog(readings.port, log));
});
afterEach(() => { installJudgmentPort(previous); log[Symbol.dispose](); });

const initialServer = (): McpServerSecurityRecord => ({ name: 'browserpilot', connected: true, trustMode: 'constrained',
  role: 'browser', schemaFreshness: 'fresh', allowedHosts: [], allowedPaths: [] });
const initialSchema = (): McpToolSchema => ({ name: 'browser_navigate', description: 'Navigate the synthetic browser.',
  inputSchema: { type: 'object', properties: { url: { type: 'string' } }, additionalProperties: false } });
function mcpTool(): Tool {
  return { definition: { name: 'mcp', description: 'Inspect the synthetic MCP fixture.', parameters: {
    type: 'object', properties: { mode: { type: 'string', enum: ['servers', 'tools', 'schema'] }, qualifiedName: { type: 'string' } },
    required: ['mode'], additionalProperties: false,
  } }, execute: async args => ({ success: true, output: JSON.stringify({ passthrough: args.mode }) }) };
}
function fixture(options: { readonly caller?: boolean; readonly schemaReader?: boolean; readonly mode?: PermissionMode; readonly applicationError?: boolean } = {}) {
  let mode = options.mode ?? 'prompt', sequence = 0;
  const source = { goal: 'Exercise the isolated synthetic MCP call fixture', criteria: ['Do not contact an external server'] };
  const reader: PermissionConfigReader = {
    getAutonomousSnapshot: () => ({ permissions: { ...DEFAULT_CONFIG.permissions, mode, tools: mode === 'custom' ? { write: 'deny' } : {} }, autoApprove: false, directory: '/synthetic/mcp-fixture' }),
    getSnapshot: () => ({ permissions: { ...DEFAULT_CONFIG.permissions, mode, tools: mode === 'custom' ? { write: 'deny' } : {} } }), isAutoApproveEnabled: () => false,
    getWorkingDirectory: () => '/synthetic/mcp-fixture',
  };
  const manager = new PermissionManager(undefined, reader, new PolicyRuntimeState());
  const registry = new ToolRegistry(manager); const tool = mcpTool(); registry.register(tool);
  let servers = [initialServer()]; let schema: McpToolSchema | null = initialSchema();
  let beforeSchema: (() => void | Promise<void>) | undefined;
  let beforeCall: (() => void | Promise<void>) | undefined;
  const calls: { name: string; input: Readonly<Record<string, unknown>>; options?: McpToolCallOptions }[] = [];
  let onCall: (() => void) | undefined;
  const api: Pick<McpApi, 'listServerSecurity' | 'getToolSchema' | 'callTool'> = {
    listServerSecurity: () => servers,
    ...(options.schemaReader === false ? {} : { async getToolSchema(_name: string, opts?: McpToolCallOptions) {
      opts?.assertCurrent?.(); await beforeSchema?.(); opts?.assertCurrent?.(); return schema;
    } }),
    ...(options.caller === false ? {} : { async callTool(name: string, input: Readonly<Record<string, unknown>>, opts?: McpToolCallOptions) {
      await beforeCall?.(); opts?.signal?.throwIfAborted(); opts?.assertCurrent?.(); calls.push({ name, input, options: opts }); onCall?.();
      return { isError: options.applicationError === true, content: [{ type: 'text', text: options.applicationError ? 'synthetic application failure' : 'navigated' }] };
    } }),
  };
  const context = { clients: { mcpApi: api } };
  const installed = installAgentMcpCallRoute(registry, context);
  return { registry, tool, api, context, installed, calls, source,
    setMode(next: PermissionMode) { mode = next; }, setServers(next: McpServerSecurityRecord[]) { servers = next; },
    setSchema(next: McpToolSchema | null) { schema = next; }, schema: () => schema,
    beforeSchema(callback: () => void | Promise<void>) { beforeSchema = callback; },
    beforeCall(callback: () => void | Promise<void>) { beforeCall = callback; },
    afterDispatch(callback: () => void) { onCall = callback; },
    async run(args: Record<string, unknown>, signal?: AbortSignal, name = 'mcp') {
      const id = `synthetic-mcp-${++sequence}`;
      const call = await registry.prepareCall(id, name, args, { signal });
      const admission = await manager.admitAutonomous(id, name, call.args, { sourceOf: () => source,
        signal, schemaRevision: call.schemaRevision, preparedCall: { registry, call } });
      if (!admission.result.approved) return { success: false, error: admission.result.detail ?? admission.result.reasonCode, output: undefined };
      return registry.executePrepared(call, admission, { signal });
    },
  };
}
const call = (input?: Record<string, unknown>) => ({ mode: 'call', qualifiedName: 'mcp:browserpilot:browser_navigate', ...(input ? { input } : {}) });

describe('MCP call route outcomes after dispatch', () => {
  test('a cancellation after the call was sent says it may already have run', async () => {
    const f = fixture(); const controller = new AbortController();
    f.afterDispatch(() => controller.abort());
    const result = await f.run(call(), controller.signal).catch(() => undefined);
    expect(f.calls).toHaveLength(1);
    expect(result?.success).toBe(false);
    expect(result?.error).toContain('may already have been sent');
  });

  test('a policy change after the call completed still returns its result, with a note', async () => {
    const f = fixture();
    f.afterDispatch(() => f.setServers([{ ...initialServer(), allowedHosts: ['changed.example'] }]));
    const result = await f.run(call());
    expect(f.calls).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(result.output).toContain('navigated');
    expect(result.output).toContain('the call ran');
  });

  test('a tool whose own name contains a colon can be called', async () => {
    const f = fixture(); f.setSchema({ ...initialSchema(), name: 'ns:create' });
    const result = await f.run({ mode: 'call', qualifiedName: 'mcp:browserpilot:ns:create' });
    expect(result.success, result.error).toBe(true);
    expect(f.calls[0]?.name).toBe('mcp:browserpilot:ns:create');
  });

  test('the connected-server list leaves out servers that are not connected', async () => {
    const f = fixture(); f.setServers([initialServer(), { ...initialServer(), name: 'asleep', connected: false }]);
    const result = await f.run({ mode: 'call', qualifiedName: 'mcp:missing:anything' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Connected servers: browserpilot');
    expect(result.error).not.toContain('asleep');
  });
});
