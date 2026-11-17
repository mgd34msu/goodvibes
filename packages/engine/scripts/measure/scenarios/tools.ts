/**
 * Tool calls, turns and permission decisions over the real client floor and a
 * real hosted session (hosted-sessions/session-runtime.ts), which registers the
 * full tool set through registerAllTools.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHostedSessionRuntime, type HostedSessionRuntime } from '../../../platform/src/platform/hosted-sessions/session-runtime.ts';
import { executeToolCalls } from '../../../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { createEmitterContext } from '../../../platform/src/platform/core/orchestrator-runtime.ts';
import { withExecutionMode, withExecutionModeOwner } from '../../../platform/src/platform/gate/execution-context.ts';
import { buildDurableRuleForDecision } from '../../../platform/src/platform/permissions/approval-rules.ts';
import { projectIdentity } from '../../../platform/src/platform/permissions/user-rule-store.ts';
import type { ToolCall, ToolResult } from '../../../platform/src/platform/types/tools.ts';
import { ConfigManager } from '../../../platform/src/platform/config/manager.ts';
import { createFloor, seedWorkspace, SURFACE, type Floor } from '../compose.ts';
import { providerCounts, textAnswer, toolCallAnswer } from '../fakes.ts';
import { assertOutcome, type Instance, type MeasureEnv, type Scenario } from '../harness.ts';
import { setSlowReads } from '../instrument.ts';

const P = 'packages/engine/platform/src/platform';

/** Write `count` remembered rules (one of them allows `echo`) where the floor's rule store reads them. */
function seedRules(floorConfigDir: string, count: number, workspace: string): void {
  const now = Date.now();
  const rules = [];
  for (let i = 0; i < count; i++) {
    const allowEcho = i === count - 1;
    const command = allowEcho ? 'echo measure' : `tool-${i} --flag`;
    const rule = buildDurableRuleForDecision({ toolName: 'exec', args: { commands: [{ cmd: command }] }, tier: 'command-class', effect: 'allow', now: now - i })!;
    // Every other rule was remembered in this project: the store keeps it in the one list, keyed by the project root.
    rules.push({ rule, createdAt: now - i, tier: 'command-class', tool: 'exec', ...(i % 2 === 0 ? { project: projectIdentity(workspace) } : {}) });
  }
  const path = join(floorConfigDir, 'permission-rules.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, rules }, null, 2));
}

interface Session { readonly floor: Floor; readonly session: HostedSessionRuntime }

async function openSession(env: MeasureEnv, rules: number): Promise<Session> {
  seedWorkspace(env.workspace);
  // The floor's rule store reads <control-plane config dir>/permission-rules.json.
  const dir = new ConfigManager({ surfaceRoot: SURFACE, homeDir: env.home, workingDir: env.workspace }).getControlPlaneConfigDir();
  if (rules > 0) seedRules(dir, rules, env.workspace);
  const floor = await createFloor(env);
  await floor.services.permissionManager.prepareAutonomousOwner?.();
  const session = createHostedSessionRuntime({
    sessionId: 'measure-session', workspaceRoot: env.workspace,
    floor: { services: floor.services, contractRunner: floor.services.contractRunner, dispose: () => {} },
    systemPrompt: 'measurement session', execPosture: 'workstream',
  });
  return { floor, session };
}

async function closeSession({ floor, session }: Session): Promise<void> {
  session.dispose();
  await floor.dispose();
}

/** One tool call through the orchestrator's own tool-execution chain (orchestrator.ts executeToolCalls). */
async function runToolCall(s: Session, call: ToolCall): Promise<ToolResult[]> {
  const mode = s.session.liveTurnControls.getPermissionMode();
  const owner = { getMode: () => mode, getRevision: () => 0 };
  return withExecutionModeOwner(owner, () => executeToolCalls({
    autonomousSource: () => ({ goal: 'Measure one tool call', criteria: ['Run the call once'] }),
    toolRegistry: s.session.toolRegistry,
    permissionManager: s.floor.services.permissionManager,
    hookDispatcher: s.floor.services.hookDispatcher,
    runtimeBus: s.floor.runtimeBus,
    sessionId: 'measure-session',
    emitterContext: (id) => createEmitterContext('measure-session', id),
  }, `measure-turn-${call.id}`, [call]));
}

function toolScenario(name: string, drives: string, call: (run: number) => ToolCall, expected: RegExp, rules = 0): Scenario {
  return {
    name, drives,
    entries: [
      `${P}/core/orchestrator-tool-runtime.ts:260 executeToolCalls`,
      `${P}/core/orchestrator.ts:1425 Orchestrator.executeToolCalls (the deps it passes are rebuilt here)`,
      `${P}/hosted-sessions/session-runtime.ts:163 createHostedSessionRuntime (registerAllTools)`,
      `${P}/runtime/client-services.ts:431 createClientRuntimeServices`,
    ],
    async setup(env: MeasureEnv): Promise<Instance> {
      const s = await openSession(env, rules);
      return {
        async op(run) {
          const results = await runToolCall(s, call(run));
          const failed = results.filter((result) => !result.success);
          assertOutcome(results.length === 1 && failed.length === 0, `the tool call did not succeed: ${failed.map((r) => String(r.error ?? r.output ?? '(no text)')).join(' | ') || `${results.length} results`}`);
          assertOutcome(expected.test(String(results[0]!.output ?? '')), `the tool succeeded but its output does not show ${expected}: ${String(results[0]!.output ?? '').slice(0, 300)}`);
          return { toolSucceeded: results.every((result) => result.success) ? 1 : 0, outputChars: results.reduce((n, r) => n + String(r.output ?? r.error ?? '').length, 0), ...s.floor.latency() };
        },
        dispose: () => closeSession(s),
      };
    },
  };
}

/** A call the fake model makes, with what its result must show for the turn to count as a success. */
type CheckedCall = ToolCall & { readonly expect: RegExp };

/** Runs are -1 (warm-up), 0, 1, ...: the warm-up turns beta into BETA, and each run after flips it back. */
const upperAfter = (run: number): boolean => (run + 1) % 2 === 0;

const eightReads = (run: number): CheckedCall[] => Array.from({ length: 8 }, (_, i) => (
  { id: `r${run}-read-${i}`, name: 'read', arguments: { files: [{ path: `src/module-${i}.ts` }] }, expect: new RegExp(`export const value${i} = ${i};`) }));

/** The delay each of the eight module reads takes in turn-8-slow-reads. */
const SLOW_READS_MS = [40, 50, 60, 70, 80, 90, 100, 110];

const twelveCalls = (run: number): CheckedCall[] => [
  ...eightReads(run),
  { id: `r${run}-find-files`, name: 'find', arguments: { queries: [{ id: 'files', mode: 'files', patterns: ['src/**/*.ts'] }] }, expect: /helper-3\.ts/ },
  { id: `r${run}-find-content`, name: 'find', arguments: { queries: [{ id: 'grep', mode: 'content', pattern: 'helper' }] }, expect: /helper2/ },
  { id: `r${run}-edit`, name: 'edit', arguments: { edits: [{ path: 'edit-target.txt', find: upperAfter(run) ? 'beta' : 'BETA', replace: upperAfter(run) ? 'BETA' : 'beta' }] }, expect: /edit-target\.txt/ },
  { id: `r${run}-exec`, name: 'exec', arguments: { commands: [{ cmd: 'echo measure' }] }, expect: /measure/ },
];

interface TurnOptions {
  /** Called before each run (warm-up included) and cleared after the scenario. */
  readonly slowReads?: (path: string) => number;
  /** Checks after the turn that read the workspace (not counted), beyond every call succeeding with its expected output. */
  readonly after?: (env: MeasureEnv, run: number) => void;
  /** Extra numbers for the report, from the measured wall time of the turn. */
  readonly extra?: (wallMs: number) => Record<string, number>;
}

function turnScenario(name: string, drives: string, calls: (run: number) => CheckedCall[], options: TurnOptions = {}): Scenario {
  return {
    name, drives, runs: 3,
    entries: [
      `${P}/core/orchestrator.ts:688 Orchestrator.handleUserInput, called as products/tui/src/interactive.ts:544 calls it (turn loop, tool execution, completion check)`,
      `${P}/hosted-sessions/session-runtime.ts:163 createHostedSessionRuntime (composes the orchestrator and registerAllTools)`,
      `${P}/runtime/client-services.ts:431 createClientRuntimeServices`,
    ],
    async setup(env: MeasureEnv): Promise<Instance> {
      // A remembered rule allows the exec so the turn never waits on an owner.
      const s = await openSession(env, 1);
      let executed = 0;
      let before = 0;
      let batch: CheckedCall[] = [];
      s.floor.runtimeBus.on('TOOL_EXECUTING', () => { executed++; });
      return {
        prepare(run) {
          batch = calls(run);
          s.floor.script.length = 0;
          if (batch.length > 0) s.floor.script.push(toolCallAnswer(batch.map(({ expect: _expect, ...call }) => call)));
          s.floor.script.push(textAnswer('Every step is done.'));
          executed = 0;
          before = s.session.conversation.getMessageSnapshot().length;
          setSlowReads(options.slowReads);
        },
        async op(run) {
          // As the TUI submits (products/tui/src/interactive.ts:544): no origin, so no
          // hosted-service surface restriction on edit/exec.
          const t0 = performance.now();
          await s.session.orchestrator.handleUserInput(`measurement turn ${run}`);
          const wallMs = performance.now() - t0;
          setSlowReads(undefined);
          const messages = s.session.conversation.getMessageSnapshot().slice(before);
          const results = new Map(messages.flatMap((m) => m.role === 'tool' ? [[(m as { callId: string }).callId, String(m.content)] as const] : []));
          const wrong = batch.flatMap((call) => {
            const content = results.get(call.id);
            if (content === undefined) return [`${call.name} ${call.id}: no result in the transcript`];
            if (content.startsWith('Error:')) return [`${call.name} ${call.id}: ${content.slice(0, 300)}`];
            return call.expect.test(content) ? [] : [`${call.name} ${call.id}: result does not show ${call.expect}: ${content.slice(0, 200)}`];
          });
          assertOutcome(wrong.length === 0, `${wrong.length} of ${batch.length} tool calls did not succeed: ${wrong.join(' | ')}`);
          assertOutcome(executed === batch.length, `${batch.length} calls were asked for but ${executed} ran`);
          const final = messages.at(-1);
          assertOutcome(final?.role === 'assistant' && String(final.content).includes('Every step is done.'), `the turn did not end with the model's final answer (last message: ${final?.role ?? 'none'})`);
          return {
            toolsExecuted: executed, toolErrorsInTranscript: 0, transcriptMessages: before + messages.length,
            // Summed over the turn's model requests.
            toolDefinitionsSent: providerCounts.tools, toolDefinitionBytesSent: providerCounts.toolBytes,
            ...options.extra?.(wallMs), ...s.floor.latency(),
          };
        },
        verify: (run) => options.after?.(env, run),
        dispose: () => { setSlowReads(undefined); return closeSession(s); },
      };
    },
  };
}

function permissionScenario(rules: number): Scenario {
  return {
    name: `permission-decision-${rules}-rules`,
    drives: `One autonomous admission (PermissionManager.admitAutonomous) of a prepared exec call (echo) with ${rules} remembered rules in permission-rules.json; the last rule is the one that allows it. The call runs under the mode in force, captured as executeToolCalls captures it (core/orchestrator-tool-runtime.ts). The timing includes ToolRegistry.prepareCall, as the tool path does.`,
    entries: [
      `${P}/core/orchestrator-tool-runtime.ts:363 executeToolCalls (captureExecutionMode, withExecutionMode)`,
      `${P}/permissions/manager.ts:896 PermissionManager.admitAutonomous`,
      `${P}/permissions/user-rule-store.ts:238 UserPermissionRuleStore.rules`,
      `${P}/tools/registry.ts:812 ToolRegistry.prepareCall`,
    ],
    async setup(env: MeasureEnv): Promise<Instance> {
      const s = await openSession(env, rules);
      return {
        async op(run) {
          const id = `admit-${run}`;
          const mode = s.session.liveTurnControls.getPermissionMode();
          const manager = s.floor.services.permissionManager;
          return withExecutionModeOwner({ getMode: () => mode, getRevision: () => 0 }, () => {
            // The mode in force for the call, captured as executeToolCalls captures it before admitting a call.
            const selection = manager.captureExecutionMode();
            return withExecutionMode(selection.mode, async () => {
              const call = await s.session.toolRegistry.prepareCall(id, 'exec', { commands: [{ cmd: 'echo measure' }] });
              const admission = await manager.admitAutonomous(id, call.name, call.args, {
                sourceOf: () => ({ goal: 'Measure one permission decision', criteria: ['Decide once'] }),
                schemaRevision: call.schemaRevision, preparedCall: { registry: s.session.toolRegistry, call },
              });
              assertOutcome(admission.result.approved, `the remembered rule did not allow the call: ${admission.result.reasonCode ?? 'no reason'}`);
              return { allowed: 1 };
            }, selection.assertCurrent);
          });
        },
        dispose: () => closeSession(s),
      };
    },
  };
}

export const scenarios: Scenario[] = [
  toolScenario('tool-read', 'One model `read` call of a small file (note.txt) through executeToolCalls: prepare in the ToolRegistry, autonomous permission admission (gate), execution, output shaping. Default permission mode of a fresh config.',
    (run) => ({ id: `read-${run}`, name: 'read', arguments: { files: [{ path: 'note.txt' }] } }), /the file this measurement reads/),
  toolScenario('tool-exec-remembered', 'One `exec` of `echo measure` that a remembered command-class rule (permission-rules.json) allows, through executeToolCalls as tool-read. Hosted exec posture `workstream`.',
    (run) => ({ id: `exec-${run}`, name: 'exec', arguments: { commands: [{ cmd: 'echo measure' }] } }), /measure/, 1),
  turnScenario('turn-0-tools', 'Baseline turn: the fake model answers at once with no tool call (submit -> answer -> completion check).', () => []),
  turnScenario('turn-12-tools', 'One turn: the fake model asks for 12 tool calls in one response (8 read, 2 find, 1 edit, 1 exec of echo allowed by a remembered rule), then gives a final answer; through the real turn loop including the completion check.', twelveCalls, {
    after(env, run) {
      const text = readFileSync(join(env.workspace, 'edit-target.txt'), 'utf8');
      assertOutcome(text.includes(upperAfter(run) ? 'BETA' : 'beta'), `the edit reported success but edit-target.txt reads ${JSON.stringify(text)}`);
    },
  }),
  turnScenario('turn-8-reads', 'The turn of turn-8-slow-reads with no read delay: the fixed cost of the turn and of eight calls around the reads, to read the slow-read ratio against.', eightReads),
  turnScenario('turn-8-slow-reads', `One turn: the fake model asks for 8 independent reads in one response, each of a file whose read the harness slows by ${SLOW_READS_MS.join(', ')} ms (instrument.ts setSlowReads; a synchronous read blocks for the delay, an asynchronous one waits). The owner's target: the turn takes about as long as the slowest read (${Math.max(...SLOW_READS_MS)} ms), not the sum (${SLOW_READS_MS.reduce((a, b) => a + b, 0)} ms).`, eightReads, {
    slowReads: (path) => { const match = /[\\/]src[\\/]module-(\d)\.ts$/.exec(path); return match ? SLOW_READS_MS[Number(match[1])] ?? 0 : 0; },
    extra: (wallMs) => ({
      slowestReadMs: Math.max(...SLOW_READS_MS), sumOfReadsMs: SLOW_READS_MS.reduce((a, b) => a + b, 0),
      ratioToSlowest: Math.round((wallMs / Math.max(...SLOW_READS_MS)) * 100) / 100,
    }),
  }),
  permissionScenario(10),
  permissionScenario(100),
];
