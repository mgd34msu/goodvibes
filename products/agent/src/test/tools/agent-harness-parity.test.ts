/** Actual harness admission, effect refusal, and complete command output. */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { choiceAnswer, fakePort, noulAnswer, scoreAnswer } from '@goodvibes-jev/judgment/testing';
import { JudgmentError, SqliteDecisionLog, withDecisionLog, type JudgmentPort } from '@goodvibes-jev/judgment';
import { gateJudgmentRegistry, readingState } from '@goodvibes-jev/engine/platform/platform/gate';
import { getOperatorContract } from '@goodvibes-jev/engine/platform/contracts';
import { personalOpsLaneMember } from '@goodvibes-jev/engine/platform/platform/routing';
import { isDeepStrictEqual } from 'node:util';
import { rmSync } from 'node:fs';
import { ToolInputProjectionError } from '@goodvibes-jev/engine/platform/platform/tools';
import { AGENT_HARNESS_MODES } from '../../tools/agent-harness-tool-schema.ts';
import { HARNESS_MODE_DESCRIPTORS } from '../../tools/agent-harness-mode-catalog.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { makeHandoffFixture } from './agent-harness-handoff-fixture.ts';
import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { CALENDAR_VERBS } from '../../input/commands/calendar-runtime.ts';
import { withCommandVerbs } from '../../input/commands/command-verbs.ts';

let previousPort: ReturnType<typeof installJudgmentPort>;
let readings: ReturnType<typeof fakePort>;
let laneUnavailable: JudgmentError;
type ParityJudgmentRequest = Parameters<JudgmentPort['ask']>[0];
let unavailableLaneRequests: ParityJudgmentRequest[];
const SEMANTIC_CATALOG_MODES = new Set(['personal_ops_queue', 'personal_ops_lane', 'personal_ops_intake', 'run_personal_ops_read',
  'personal_ops_briefing', 'personal_ops', 'autonomy_queue', 'autonomy_queue_item']);
beforeEach(async () => {
  laneUnavailable = new JudgmentError('unavailable', 'This parity fixture has no lane membership answer.');
  unavailableLaneRequests = [];
  let laneQuestions: ParityJudgmentRequest['questions'] | undefined;
  const captureSchema = new Error('Capture only the canonical lane question schema.');
  await expect(personalOpsLaneMember.rerank({ model: 'parity-schema-capture', ask(request) {
    laneQuestions = request.questions;
    throw captureSchema;
  } }, 'inbox', [{ id: 'schema-only', content: {} }])).rejects.toBe(captureSchema);
  if (!laneQuestions) throw new Error('Canonical lane question schema is unavailable.');
  const expectedLaneQuestions = laneQuestions;
  const heldCandidates = getOperatorContract().operator.methods.filter(method => [
    'accounts.snapshot', 'acp.agents.list', 'acp.sessions.create', 'approvals.approve', 'approvals.cancel', 'approvals.claim', 'approvals.deny', 'approvals.list',
  ].includes(method.id)).map(method => ({ type: 'tool', name: method.id, description: method.description ?? method.title ?? '', evidenceJson: JSON.stringify(method) }));
  // Dispatch parity supplies the real read boundary's offline prerequisites.
  // Unexpected decisions fail rather than receiving a blanket positive answer.
  readings = fakePort((wireQuestionName, question) => {
    const name = wireQuestionName.replace(/^(effect|risk|edge)__/, '');
    if (question.type === 'score' && ['fit', 'memoryAdequacy', 'latency', 'contextWindow', 'toolSupport', 'vision', 'cost', 'privacy'].includes(name)) {
      return scoreAnswer(question, name === 'memoryAdequacy' ? 2 : 3, 0.99);
    }
    if (question.type === 'noul' && ['cloudTransfer', 'exampleVision'].includes(name)) return noulAnswer(0.99);
    throw new Error(`Unscripted parity question: ${name}`);
  });
  previousPort = installJudgmentPort({ model: readings.port.model, ask(request) {
    if (request.context?.battery === 'agent.personal-ops.lane-member') {
      if (!isDeepStrictEqual(request.questions, expectedLaneQuestions)
        || !heldCandidates.some(candidate => ['inbox', 'approvals'].some(query => isDeepStrictEqual(request.state, { query, candidate }))))
        throw new Error('Unexpected complete parity lane subject or schema.');
      unavailableLaneRequests.push(request);
      throw laneUnavailable;
    }
    if (!['agent.models.route-readiness', 'agent.models.local-recipe-fit'].includes(request.context?.battery ?? '')) {
      throw new Error(`Unscripted parity battery: ${request.context?.battery}`);
    }
    return readings.port.ask(request);
  } });
});
afterEach(() => { installJudgmentPort(previousPort); });
afterAll(cleanupResearchScreeningFixtures);

function makeParityFixture(options: { sourceOwner?: boolean } = {}) {
  const base = makeHandoffFixture({ label: 'gv-parity', prepare: ({ toolRegistry }) => {
    if (options.sourceOwner !== false) bindAgentResearchSourceOwner(toolRegistry, ordinaryResearchOwner());
  } });
  const { root, tool, toolRegistry, commandRegistry } = base;
  const spawn = spyOn(base.processManager, 'spawn').mockImplementation(async () => { throw new Error('Parity must never spawn a process.'); });

  async function admitPrintingCommand() {
    const args = { mode: 'run_command', command: '/print-long-output' };
    const source = { goal: 'Verify the synthetic printing command output cap', criteria: ['Run only the registered in-memory printing handler', 'Preserve the 6000 character cap and original truncation marker', 'Do not spawn a process or perform external effects'] };
    const expectedState = readingState('agent_harness', args, root);
    const canonical = new Map(gateJudgmentRegistry.list().filter(battery =>
      ['engine.gate.side-effect', 'engine.gate.risk-family', 'engine.gate.boundary'].includes(battery.name)).map(battery => {
      if (!('items' in battery) || !battery.items || typeof battery.items !== 'object') throw new Error('Missing canonical parity admission schema.');
      const questions = Object.fromEntries(Object.entries(battery.items).map(([name, item]) => {
        if (!item || typeof item !== 'object' || !('question' in item)) throw new Error('Invalid canonical parity admission item.');
        return [name, item.question];
      }));
      return [battery.name, questions] satisfies readonly [string, Record<string, unknown>];
    }));
    const answers = fakePort((wireName, question) => {
    const name = wireName.replace(/^(effect|risk|edge)__/, '');
      const label = name === 'disposition' ? 'act' : name === 'kind' ? 'read' : name === 'family' ? 'generic' : undefined;
      if (question.type === 'choice' && label) return choiceAnswer(question, label, 0.999);
      if (question.type === 'noul' && ['mutates', 'outward', 'secrets', 'obfuscated', 'irreversible', 'beyondProject', 'weakensSecurity', 'catastrophic', 'cardDetails'].includes(name)) return noulAnswer(0.001);
      throw new Error(`Unscripted printing admission answer ${name}`);
    });
    const port: JudgmentPort = { model: answers.port.model, ask(request) {
      const name = request.context?.battery ?? '';
      if (name === 'engine.gate.autonomous-disposition') {
        // This fixture selects the native safe-owner path below; it explicitly
        // requires no autonomousDecision. Unexpected paid disposition is an
        // error, not a reason to reconstruct an unused earlier binding/prompt.
        throw new Error('Printing parity owner path must not request semantic disposition');
      }
      if (name === 'engine.gate.side-effect+engine.gate.risk-family+engine.gate.boundary') {
        const selected = { effect: ['mutates', 'outward', 'secrets', 'kind', 'obfuscated'], risk: ['family', 'irreversible', 'beyondProject', 'weakensSecurity'], edge: ['catastrophic', 'cardDetails'] };
        const batteries = { effect: 'engine.gate.side-effect', risk: 'engine.gate.risk-family', edge: 'engine.gate.boundary' };
        const questions = Object.fromEntries(Object.entries(selected).flatMap(([prefix, keys]) => keys.map(key => [`${prefix}__${key}`, canonical.get(batteries[prefix as keyof typeof batteries])![key]])));
        if (!isDeepStrictEqual(request.questions, questions) || !isDeepStrictEqual(request.state, expectedState)) throw new Error('Unexpected complete composite printing admission subject or schema.');
        return answers.port.ask(request);
      }
      const allQuestions = canonical.get(name);
      if (!allQuestions) {
        throw new Error(`Unscripted printing admission battery ${name}`);
      }
      const selected = name === 'engine.gate.side-effect' ? ['mutates', 'outward', 'secrets', 'kind', 'obfuscated']
        : name === 'engine.gate.boundary' ? ['catastrophic', 'cardDetails'] : ['family', 'irreversible', 'beyondProject', 'weakensSecurity'];
      const questions = Object.fromEntries(selected.map(key => [key, allQuestions[key]]));
      if (!isDeepStrictEqual(request.questions, questions) || !isDeepStrictEqual(request.state, expectedState)) throw new Error('Unexpected complete printing admission subject or schema.');
      return answers.port.ask(request);
    } };
    const log = new SqliteDecisionLog(':memory:');
    const previous = installJudgmentPort(withDecisionLog(port, log));
    try {
      const { call, admission } = await base.admit(source, args);
      return await toolRegistry.executePrepared(call, admission);
    } finally { installJudgmentPort(previous); log[Symbol.dispose](); }
  }

  return {
    tool,
    commandRegistry,
    spawn,
    admitPrintingCommand,
    cleanup: () => { spawn.mockRestore(); rmSync(root, { recursive: true, force: true }); },
  };
}

/** Minimal arguments that satisfy each mode's own input checks, so the admission gate is the only thing left to refuse. */
function parityArgs(mode: typeof AGENT_HARNESS_MODES[number]): Record<string, unknown> {
  switch (mode) {
    case 'run_background_process': return { mode, processAction: 'start', command: 'printf parity' };
    case 'run_command': return { mode, command: '/print-long-output' };
    case 'run_workspace_action': return { mode, actionId: 'import-goodvibes-tui-settings' };
    case 'remote_pair_approve': case 'remote_pair_reject': return { mode, requestId: 'pair-request-1' };
    case 'remote_peers_invoke': return { mode, peerId: 'peer-1', command: 'inspect-fixture' };
    case 'remote_work_cancel': return { mode, workId: 'work-1' };
    default: return { mode };
  }
}

async function expectEffectHeld(pending: Promise<unknown>): Promise<void> {
  await expect(pending).rejects.toBeInstanceOf(ToolInputProjectionError);
  await expect(pending).rejects.toMatchObject({ problem: 'held' });
}

describe('agent_harness parity', () => {
  test('every effect-kind descriptor refuses execution without recorded admission', async () => {
    const fixture = makeParityFixture();
    try {
      const effectDescriptors = HARNESS_MODE_DESCRIPTORS.filter(
        (descriptor) => descriptor.kind === 'effect',
      );

      // Sanity: there must be at least one effect mode or the test is vacuous.
      expect(effectDescriptors.length).toBeGreaterThan(0);
      let commandCalls = 0;
      fixture.commandRegistry.register({ name: 'print-long-output', description: 'parity fixture command', handler: () => { commandCalls++; } });

      const failures: string[] = [];
      for (const descriptor of effectDescriptors) {
        // These read through a lane-membership judgment that this fixture
        // deliberately cannot answer, so they never reach the admission gate here.
        if (SEMANTIC_CATALOG_MODES.has(descriptor.id)) continue;
        let outcome: string;
        try {
          const result = await fixture.tool.execute(parityArgs(descriptor.id));
          // A workspace action answers an unadmitted call with its own preview and runs nothing.
          const previewOnly = descriptor.id === 'run_workspace_action' && result.success
            && (JSON.parse(result.output ?? '{}') as { status?: unknown }).status === 'confirmation_required';
          outcome = previewOnly ? 'refused' : result.success
            ? `executed (success:true) ${(result.output ?? '').slice(0, 80)}`
            : /recorded effect admission/.test(result.error ?? '') ? 'refused' : `refused for another reason: ${(result.error ?? '').slice(0, 120)}`;
        } catch (error) {
          outcome = error instanceof ToolInputProjectionError && error.problem === 'held' ? 'refused' : `threw ${String(error).slice(0, 120)}`;
        }
        if (outcome !== 'refused') failures.push(`mode '${descriptor.id}': ${outcome}`);
      }

      expect(failures).toEqual([]);
      expect(commandCalls).toBe(0);
      expect(fixture.spawn).not.toHaveBeenCalled();
    } finally {
      await fixture.cleanup();
    }
  });

  test.each(['model_routing', 'model_route'] as const)('%s still refuses a missing protected-source owner before judgment', async mode => {
    const fixture = makeParityFixture({ sourceOwner: false });
    try {
      await expect(fixture.tool.execute({ mode })).rejects.toBeInstanceOf(ToolInputProjectionError);
      expect(readings.requests).toHaveLength(0);
      expect(fixture.spawn).not.toHaveBeenCalled();
    } finally { await fixture.cleanup(); }
  });

  test('background process dispatch still rejects a missing action without spawning', async () => {
    const fixture = makeParityFixture();
    try {
      await expect(fixture.tool.execute({ mode: 'run_background_process' })).rejects.toThrow('run_background_process requires processAction');
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(readings.requests).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  test.each([{ confirm: true }, { explicitUserRequest: 'Run the parity fixture command.' }])('background start refuses caller confirmation fields without recorded admission: %j', async partial => {
    const fixture = makeParityFixture();
    try {
      await expectEffectHeld(fixture.tool.execute({ ...parityArgs('run_background_process'), ...partial }));
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(readings.requests).toHaveLength(0);
    } finally { await fixture.cleanup(); }
  });

  test('/calendar read verbs run without admission, subscribe is held and connect is the owner\'s', async () => {
    const fixture = makeParityFixture();
    try {
      const ran: string[][] = [];
      fixture.commandRegistry.register(withCommandVerbs({ name: 'calendar', aliases: ['cal'], description: 'calendar', handler: (args, ctx) => { ran.push([...args]); ctx.print('ok'); } }, CALENDAR_VERBS));
      const list = await fixture.tool.execute({ mode: 'run_command', command: '/calendar list' });
      expect(list.success).toBe(true);
      await fixture.tool.execute({ mode: 'run_command', command: '/calendar' });
      await fixture.tool.execute({ mode: 'run_command', command: '/cal subscriptions' });
      expect(ran).toEqual([['list'], [], ['subscriptions']]);
      await expectEffectHeld(fixture.tool.execute({ mode: 'run_command', command: '/calendar subscribe https://example.com/a.ics' }));
      expect((await fixture.tool.execute({ mode: 'run_command', command: '/calendar connect google' })).success).toBe(false);
      expect(ran).toHaveLength(3);
    } finally { await fixture.cleanup(); }
  });

  test('/tasks and /approval show verbs run without admission while task changes are held', async () => {
    const fixture = makeParityFixture();
    try {
      const ran: string[][] = [];
      for (const name of ['tasks', 'approval']) {
        fixture.commandRegistry.register({ name, description: name, handler: (args, ctx) => { ran.push([name, ...args]); ctx.print('ok'); } });
      }
      expect((await fixture.tool.execute({ mode: 'run_command', command: '/tasks show t1' })).success).toBe(true);
      await fixture.tool.execute({ mode: 'run_command', command: '/tasks output t1' });
      await fixture.tool.execute({ mode: 'run_command', command: '/approval matrix' });
      expect(ran).toEqual([['tasks', 'show', 't1'], ['tasks', 'output', 't1'], ['approval', 'matrix']]);
      await expectEffectHeld(fixture.tool.execute({ mode: 'run_command', command: '/tasks cancel t1' }));
      await expectEffectHeld(fixture.tool.execute({ mode: 'run_command', command: '/approval open' }));
      expect(ran).toHaveLength(3);
    } finally { await fixture.cleanup(); }
  });

  test('command runner preserves the complete printed output', async () => {
    const fixture = makeParityFixture();
    try {
      // Preserve all 80 lines from the actual admitted command.
      const longLine = 'x'.repeat(100);
      let commandCalls = 0;
      fixture.commandRegistry.register({
        name: 'print-long-output',
        description: 'Emit the complete long stream of fixture output',
        handler: (_args, ctx) => {
          commandCalls++;
          for (let i = 0; i < 80; i++) ctx.print(longLine);
        },
      });

      await expectEffectHeld(fixture.tool.execute({ mode: 'run_command', command: '/print-long-output', confirm: true, explicitUserRequest: 'Test output truncation.' }));
      expect(commandCalls).toBe(0);
      const result = await fixture.admitPrintingCommand();
      expect(result.success).toBe(true);
      expect(commandCalls).toBe(1);
      expect(fixture.spawn).not.toHaveBeenCalled();
      expect(result.output).toContain(Array.from({ length: 80 }, () => longLine).join('\n'));
      expect(result.output).not.toContain('... output truncated');
    } finally {
      await fixture.cleanup();
    }
  });
});
