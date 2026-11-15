/** Actual product graph; only external discovery/model boundaries are synthetic. */
import { spyOn } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { withDecisionLog, type JudgmentRequest, type Questions } from '@goodvibes-jev/judgment';
import { choiceAnswer, fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { BenchmarkStore, ProviderRegistry } from '@goodvibes-jev/engine/platform/platform/providers';
import { registerInboxSurface } from '@goodvibes-jev/engine/platform/platform/intake';
import { AcpHostService, type HostedAcpAgent } from '@goodvibes-jev/engine/platform/platform/acp';
import { gateReadingsPort } from './synthetic-gate-readings.js';
import { executeToolCalls } from '@goodvibes-jev/engine/platform/platform/core';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { startDaemonFixture } from '../../testing/daemon-fixture.js';
import { makeOwnedTempDir } from './owned-temp.js';

export type Reading = JudgmentRequest<Questions>;
export function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
export { until } from './wait.js';
export async function externalProtocolFixture(options: { watchIntervalMs?: number } = {}) {
  const restores: Array<() => void> = [];
  const keep = <T extends { mockRestore(): void }>(spy: T): T => { restores.push(() => spy.mockRestore()); return spy; };
  keep(spyOn(ProviderRegistry.prototype, 'refreshLiveModelDiscovery').mockResolvedValue([]));
  keep(spyOn(BenchmarkStore.prototype, 'refreshBenchmarks').mockResolvedValue(undefined));
  keep(spyOn(BenchmarkStore.prototype, 'readBenchmarks').mockResolvedValue(undefined));
  const root = makeOwnedTempDir('daemon-external-protocols');
  let daemon: Awaited<ReturnType<typeof startDaemonFixture>>;
  try {
    daemon = await startDaemonFixture({ root, hostSessions: false,
      configure(config) {
        config.set('judgment.keySource', 'secret');
        if (options.watchIntervalMs !== undefined) {
          const intervalMs = options.watchIntervalMs;
          const watch = config.watchConfigFiles.bind(config);
          keep(spyOn(config, 'watchConfigFiles').mockImplementation(() => watch({ intervalMs })));
        }
      },
      inboxFactory: (context, _routing, options) => registerInboxSurface(context, { ...options, adapters: new Map() }),
    });
  } catch (error) { for (const restore of restores.reverse()) restore(); throw error; }
  const readings: Reading[] = [];
  let selection = 'act';
  let hook: ((request: Reading) => void | Promise<void>) | undefined;
  const semantic = fakePort((_name, question) => {
    if (question.type === 'noul') return noulAnswer(0.99);
    const uncertainAct = selection === 'uncertain' && question.type === 'choice' && 'act' in question.criteria;
    const wanted = uncertainAct ? 'act' : selection === 'uncertain' ? 'reject' : selection;
    return choiceAnswer(question, question.type === 'choice' && wanted in question.criteria ? wanted : 'reject', uncertainAct ? 0.6 : 0.99);
  });
  const gate = gateReadingsPort([['', { outward: true, capability: 'write_fs', names_path: false, names_host: false }]]);
  const recorded = withDecisionLog({ model: 'synthetic/daemon-external', async ask(request) {
    readings.push(request as Reading); request.beforeAttempt?.();
    await hook?.(request as Reading); request.signal?.throwIfAborted(); request.beforeAttempt?.();
    return 'disposition' in request.questions || 'refuse' in request.questions ? semantic.port.ask(request) : gate.port.ask(request);
  } }, daemon.services.judgment.decisionLog);
  keep(spyOn(daemon.services.judgment.port, 'ask').mockImplementation(request => recorded.ask(request)));
  const human = keep(spyOn(daemon.services.approvalBroker, 'requestApproval').mockImplementation(async () => { throw new Error('Human fallback must not run'); }));
  type AdmissionArgs = Parameters<typeof daemon.services.permissionManager.admitAutonomous>;
  let admissionHook: ((args: AdmissionArgs) => void | Promise<void>) | undefined;
  const admissionSources: unknown[] = [];
  const admit = daemon.services.permissionManager.admitAutonomous.bind(daemon.services.permissionManager);
  const admissions = keep(spyOn(daemon.services.permissionManager, 'admitAutonomous').mockImplementation(async (...args) => {
    const result = await admit(...args);
    admissionSources.push(args[3]?.sourceOf?.());
    const signal = args[3]?.signal;
    let abort: (() => void) | undefined;
    try {
      await Promise.race([Promise.resolve(admissionHook?.(args)), new Promise<never>((_, reject) => {
        if (!signal) return;
        abort = () => reject(signal.reason);
        if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
      })]);
      signal?.throwIfAborted(); return result;
    } finally { if (abort) signal?.removeEventListener('abort', abort); }
  }));
  let acp: AcpHostService | undefined;
  const acpRefusals: string[] = [];
  const spawn = AcpHostService.prototype.spawnAgent;
  keep(spyOn(AcpHostService.prototype, 'spawnAgent').mockImplementation(function (this: AcpHostService, input) {
    acp = this;
    // The gateway redacts the failure body, so the refusal text is recorded here.
    return spawn.call(this, input).catch((error: unknown) => { acpRefusals.push(error instanceof Error ? error.message : String(error)); throw error; });
  }));
  const bin = join(root, 'bin');
  const fakeAgent = resolve(import.meta.dir, '../../../../../packages/engine/test/fixtures/fake-acp-agent.ts');
  const calls: Array<Record<string, unknown>> = [];
  let elicit = false;
  let formField = 'name';
  const operationLifetime = new AbortController();
  let server: ReturnType<typeof Bun.serve> | undefined;
  // Each step runs even when an earlier one throws, so a failing test leaves
  // no listener, PATH prefix, spy or daemon behind; the first failure is rethrown.
  const teardown = async (steps: ReadonlyArray<() => unknown>): Promise<void> => {
    const failures: unknown[] = [];
    for (const step of steps) { try { await step(); } catch (error) { failures.push(error); } }
    if (failures.length > 0) throw failures[0];
  };
  const unwind = (extra: ReadonlyArray<() => unknown> = []) => teardown([
    ...extra,
    () => daemon.stop(),
    () => server?.stop(true),
    () => { for (const restore of restores.reverse()) restore(); },
  ]);
  try {
    mkdirSync(bin);
    writeFileSync(join(bin, 'claude-code-acp'), `#!/bin/sh\nexec '${process.execPath}' run '${fakeAgent}' permission-reject-first\n`, { mode: 0o700 });
    const priorPath = process.env.PATH; process.env.PATH = `${bin}:${priorPath ?? ''}`;
    restores.push(() => { if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath; });
    server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      if (request.method !== 'POST') return new Response(null, { status: 405 });
      const body = await request.json() as Record<string, unknown>;
      const params = (body.params ?? {}) as Record<string, unknown>;
      let result: unknown;
      if (body.method === 'server/discover') result = { resultType: 'complete', supportedVersions: ['2026-07-28'], capabilities: { tools: {} }, serverInfo: { name: 'owned-protocol', version: '1' } };
      else if (body.method === 'tools/list') result = { resultType: 'complete', tools: [{ name: 'write', description: 'Synthetic write', inputSchema: { type: 'object' } }] };
      else if (body.method === 'tools/call') {
        calls.push(params);
        result = elicit && !params.inputResponses ? { resultType: 'input_required', inputRequests: { form: { method: 'elicitation/create', params: {
          message: 'Untrusted remote asks for a name', requestedSchema: { type: 'object', properties: { [formField]: { type: 'string' } }, required: [formField] },
        } } } } : { resultType: 'complete', done: true, received: params };
      } else return Response.json({ jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'Unknown fixture method' } });
      return Response.json({ jsonrpc: '2.0', id: body.id, result });
    } });
    await daemon.daemon.registerMcpServer({ name: 'owned-protocol', url: `http://127.0.0.1:${server.port}/mcp` });
  } catch (error) { await unwind().catch(() => {}); throw error; }
  const registry = daemon.services.mcpRegistry;
  let goal = 'Original caller: write the synthetic record using the supplied name Alice.';
  return { daemon, registry, calls, readings, human, admissions, admissionSources, operationLifetime,
    get acp() { if (!acp) throw new Error('ACP host not reached'); return acp; },
    answer(value: string) { selection = value; },
    onReading(value: typeof hook) { hook = value; },
    onAdmission(value: typeof admissionHook) { admissionHook = value; },
    elicit(field = 'name') { elicit = true; formField = field; },
    changeGoal(value: string) { goal = value; },
    async call(args: Record<string, unknown> = { name: 'Alice' }, signal?: AbortSignal) {
      const callSignal = signal ? AbortSignal.any([operationLifetime.signal, signal]) : operationLifetime.signal;
      const tools = new ToolRegistry(daemon.services.permissionManager);
      let value: unknown, failure: unknown;
      tools.register({ definition: { name: 'mcp:owned-protocol:write', description: 'Invoke the configured synthetic MCP write.',
        parameters: { type: 'object', properties: {}, additionalProperties: true }, sideEffects: ['state'] },
        async execute(preparedArgs, executionOptions) {
          try {
            value = await registry.callTool('mcp:owned-protocol:write', preparedArgs, { signal: executionOptions?.signal });
            return { success: true, output: JSON.stringify(value) };
          } catch (error) { failure = error; throw error; }
        },
      });
      // The public core producer establishes scope only after a genuine native
      // admission. Protocol judgments retain their separate synthetic controls.
      const nativeChoices = fakePort((_name, question) => question.type === 'noul' ? noulAnswer(0.99) : choiceAnswer(question, question.type === 'choice' && 'act' in question.criteria ? 'act' : 'reject', 0.99));
      const nativePort = withDecisionLog({ model: 'synthetic/daemon-native-protocol-owner', ask(request) {
        request.signal?.throwIfAborted(); request.beforeAttempt?.();
        return 'disposition' in request.questions || 'refuse' in request.questions ? nativeChoices.port.ask(request) : gate.port.ask(request);
      } }, daemon.services.judgment.decisionLog);
      const results = await executeToolCalls({ autonomousSource: () => ({ goal, criteria: ['Only the explicitly owned synthetic record'] }),
        autonomousPort: () => nativePort, turnSignal: callSignal, toolRegistry: tools, permissionManager: daemon.services.permissionManager,
        hookDispatcher: null, runtimeBus: null, sessionId: 'external-protocol-fixture',
        emitterContext: () => ({ sessionId: 'external-protocol-fixture', traceId: 'fixture', source: 'orchestrator' }),
      }, crypto.randomUUID(), [{ id: crypto.randomUUID(), name: 'mcp:owned-protocol:write', arguments: args }]);
      if (!results[0]?.success) throw failure ?? new Error(`MCP source admission did not act: ${results[0]?.error ?? 'no result'}`);
      return value;
    },
    acpRefusals,
    async spawn(prompt?: string, mode = 'permission-reject-first', cwd = daemon.workingDirectory) {
      writeFileSync(join(bin, 'claude-code-acp'), `#!/bin/sh\nexec '${process.execPath}' run '${fakeAgent}' '${mode}'\n`, { mode: 0o700 });
      const response = await daemon.fetch('/api/control-plane/methods/acp.sessions.create/invoke', { method: 'POST', body: JSON.stringify({ body: {
        agentId: 'claude-code', cwd, ...(prompt === undefined ? {} : { prompt }),
      } }) });
      const body = await response.json() as { hosted: HostedAcpAgent; result?: { hosted: HostedAcpAgent }; error?: unknown };
      if (!response.ok) throw new Error(`ACP gateway ${response.status}: ${JSON.stringify(body)}`);
      return body.hosted ?? body.result!.hosted;
    },
    async close() {
      operationLifetime.abort();
      await unwind([
        () => acp ? Promise.all(acp.list().map(row => acp!.stop(row.id))) : undefined,
        () => registry.disconnectAll(),
      ]);
    },
  };
}
