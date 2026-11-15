import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installJudgmentPort, bindJudgmentPortAuthority } from '@goodvibes-jev/engine/errors';
import { fakePort, choiceAnswer } from '@goodvibes-jev/judgment/testing';
import { ExecutionPlanManager, type PlanItemStatus } from '../platform/src/platform/core/execution-plan.js';
import { handleFinalResponseOutcome } from '../platform/src/platform/core/orchestrator-turn-helpers.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { registry } from '../platform/src/platform/core/judgment-registry.js';
import { JudgmentInputError } from '../platform/src/platform/gate/judgment-input.js';

const roots: string[] = [];
let previous: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previous = installJudgmentPort(undefined); });
afterEach(() => { installJudgmentPort(previous); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function manager() { const root = mkdtempSync(join(tmpdir(), 'plan-status-')); roots.push(root); return new ExecutionPlanManager(root); }
function reading(status: PlanItemStatus = 'complete', confidence = .99) { return fakePort((_name, question) => choiceAnswer(question, status, confidence)); }
function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function caller(content = '# Plan\n## Phase 1\n- [ ] Build -- All done') {
  const planManager = manager();
  const plan = planManager.create('Plan', [], 'session'); plan.awaitingPlan = true; planManager.save(plan);
  const messages: string[] = [];
  let enabled = true, terminal = false;
  const controller = new AbortController();
  const args: Parameters<typeof handleFinalResponseOutcome>[0] = {
    signal: controller.signal,
    conversation: { addAssistantMessage() {}, addSystemMessage: (text: string) => { messages.push(text); }, addNotice: (text: string) => { messages.push(text); } } as never,
    agentManager: { list: () => [], spawn: () => { throw new Error('final-response handling must not spawn agents'); } } as never,
    planManager, preTurnPlan: plan,
    configManager: { get: (key: string) => key === 'orchestration.recursionEnabled' ? enabled : 10 } as never,
    providerRegistry: { getCurrentModel: () => ({ displayName: 'test', registryKey: 'test', provider: 'test' }) } as never,
    runtimeBus: null, emitterContext: () => ({ sessionId: 'session', source: 'test', traceId: 'test' }), turnId: 'turn',
    response: { content, toolCalls: [], stopReason: 'completed' } as never,
    requestRender() {}, sessionId: 'session',
    onTurnTerminal: publish => { terminal = true; publish(); },
  };
  return { args, planManager, plan, controller, messages, disable: () => { enabled = false; }, get terminal() { return terminal; } };
}
function delayed(status: PlanItemStatus = 'complete') {
  const start = deferred(), release = deferred(), fake = reading(status);
  installJudgmentPort({ model: fake.port.model, ask: async request => { start.resolve(); await release.promise; return fake.port.ask(request); } });
  return { start, release, fake };
}

describe('canonical plan status boundary', () => {
  test('registers the semantic status battery', () => { expect(registry.get('engine.core.plan-item-status')).toBeDefined(); });
  test('canonical enum and checkbox grammar need no reader; pending overrides a checked box', async () => {
    installJudgmentPort(undefined);
    const parsed = await manager().parseFromMarkdown('# Plan\n## Phase 1\n- [x] A -- PENDING\n- [ ] B -- COMPLETE (agent-1) (depends: A)\n- [~] C\n- [!] D\n- [-] E\n- malformed');
    expect(parsed.items?.map(item => item.status)).toEqual(['pending', 'complete', 'in_progress', 'failed', 'skipped', 'pending']);
    expect(parsed.items?.[1]?.dependencies).toEqual(['A']); expect(parsed.items?.[1]?.agentId).toBe('agent-1');
    expect(parsed.parseIssues).toHaveLength(1);
  });
  test('loose labels use the five-state reading, never a lexical synonym override', async () => {
    const fake = reading('failed'); installJudgmentPort(fake.port);
    const result = await manager().parseFromMarkdown('# Plan\n## Phase 1\n- [x] A -- DONE');
    expect(result.items?.[0]?.status).toBe('failed'); expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.context?.battery).toBe('engine.core.plan-item-status');
  });
  test('decision-model requests per parse: one per distinct label, not one per item', async () => {
    const fake = reading('complete'); installJudgmentPort(fake.port);
    const items = Array.from({ length: 30 }, (_, index) => `- [x] Step ${index} -- All done`).join('\n');
    const result = await manager().parseFromMarkdown(`# Plan\n## Phase 1\n${items}\n- [ ] Last -- in progress`);
    expect(result.items?.map(item => item.status)).toEqual([...Array(30).fill('complete'), 'in_progress']);
    expect(fake.requests).toHaveLength(1);
  });
  test('complete source is screened before any request, including late ignored lines', async () => {
    const fake = reading(); installJudgmentPort(fake.port);
    await expect(manager().parseFromMarkdown('# Plan\n## Phase 1\n- [ ] A -- DONE\npassword=private-value')).rejects.toBeInstanceOf(JudgmentInputError);
    expect(fake.requests).toHaveLength(0);
  });
  test('unavailable and unsettled readings preserve the shell', async () => {
    for (const port of [undefined, reading('complete', .21).port]) {
      installJudgmentPort(port); const f = caller(); await handleFinalResponseOutcome(f.args);
      expect(f.planManager.getActive('session')).toEqual(f.plan);
      expect(f.messages.join(' ')).toContain('unavailable');
    }
  });
  test('real caller preserves complete, failed, skipped and dependency gates; proposals remain pending', async () => {
    const f = caller('# Plan\n## Phase 1\n- [ ] A -- COMPLETE\n- [ ] B -- FAILED\n- [ ] C -- SKIPPED\n- [ ] D -- PENDING (depends: B)\n- [ ] E -- PENDING (depends: A)');
    await handleFinalResponseOutcome(f.args);
   
    expect(f.planManager.getActive('session')?.items.map(item => item.status)).toEqual(['complete', 'failed', 'skipped', 'pending', 'pending']);
    f.planManager.replaceItems(f.plan.id, [{ description: 'Proposal', phase: 'Phase 1', status: 'complete' }]);
    expect(f.planManager.load(f.plan.id)?.items[0]?.status).toBe('pending');
  });
  test('the real caller reads a supported section name without requiring the word Phase', async () => {
    const fake = reading('failed'); installJudgmentPort(fake.port);
    const f = caller('# Plan\n## Build\n- [x] Compile -- All done');
    await handleFinalResponseOutcome(f.args);
    const saved = f.planManager.getActive('session');
    expect(saved?.awaitingPlan).toBe(false);
    expect(saved?.items.map(item => ({ phase: item.phase, description: item.description, status: item.status })))
      .toEqual([{ phase: 'Build', description: 'Compile', status: 'failed' }]);
    expect(fake.requests).toHaveLength(1);
   
  });
  test('plan save ABA and replacement cannot be overwritten by a late reading', async () => {
    for (const mutation of ['aba', 'replace', 'dismiss'] as const) {
      const read = delayed(), f = caller(), pending = handleFinalResponseOutcome(f.args); await read.start.promise;
      if (mutation === 'replace') f.planManager.create('New plan', [], 'session');
      else if (mutation === 'dismiss') f.planManager.dismiss('session');
      else { f.planManager.save({ ...f.plan, title: 'Changed' }); f.planManager.save(f.plan); }
      const expected = f.planManager.getActive('session'); read.release.resolve(); await pending;
      expect(f.planManager.getActive('session')).toEqual(expected);
    }
  });
  test('cancellation interrupts a noncooperating reader; late completion cannot write or spawn', async () => {
    const read = delayed(), f = caller(), pending = handleFinalResponseOutcome(f.args); await read.start.promise;
    f.controller.abort(); await expect(pending).rejects.toBeDefined(); read.release.resolve(); await Promise.resolve();
    expect(f.planManager.getActive('session')).toEqual(f.plan);
  });
  test('reader installation ABA invalidates an in-flight answer', async () => {
    const read = delayed(), f = caller(), pending = handleFinalResponseOutcome(f.args); await read.start.promise;
    const old = installJudgmentPort(reading('pending').port); installJudgmentPort(old); read.release.resolve(); await pending;
    expect(f.planManager.getActive('session')).toEqual(f.plan);
  });
  test('source owner mutation invalidates an in-flight answer', async () => {
    let current = true; const read = delayed();
    const port = installJudgmentPort(undefined)!; installJudgmentPort(port);
    bindJudgmentPortAuthority(port, () => ({ identity: port, assertCurrent: () => { if (!current) throw new Error('private details'); } }));
    const f = caller(), pending = handleFinalResponseOutcome(f.args); await read.start.promise; current = false; read.release.resolve(); await pending;
    expect(f.planManager.getActive('session')).toEqual(f.plan); expect(f.messages.join(' ')).not.toContain('private details');
  });
  test('source/session changes cannot apply the old reading', async () => {
    for (const mutation of ['session', 'content'] as const) {
      const read = delayed(), f = caller(), pending = handleFinalResponseOutcome(f.args); await read.start.promise;
      if (mutation === 'session') f.args.sessionId = 'other'; else f.args.response.content = '# Different plan';
      read.release.resolve(); await pending; expect(f.planManager.getActive('session')).toEqual(f.plan);
    }
  });
  test('live policy disabling spawn while awaiting a reading is respected', async () => {
    const read = delayed('pending'), f = caller(), pending = handleFinalResponseOutcome(f.args); await read.start.promise;
    f.disable(); read.release.resolve(); await pending;
    expect(f.planManager.getActive('session')?.awaitingPlan).toBe(false);
  });
  test('terminal publication waits for plan settlement and happens once on recoverable failure', async () => {
    const read = delayed(), f = caller();
    f.args.runtimeBus = new RuntimeEventBus();
    let completions = 0;
    f.args.runtimeBus.on('TURN_COMPLETED', () => { completions++; });
    const pending = handleFinalResponseOutcome(f.args); await read.start.promise;
    expect(f.terminal).toBe(false); expect(completions).toBe(0);
    installJudgmentPort(undefined); await pending; read.release.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(f.terminal).toBe(true); expect(completions).toBe(1);
    expect(f.planManager.getActive('session')).toEqual(f.plan);
  });

});
