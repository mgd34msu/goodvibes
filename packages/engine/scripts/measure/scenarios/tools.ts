/**
 * Tool calls, turns and permission decisions over the real client floor and a
 * real hosted session (hosted-sessions/session-runtime.ts), which registers the
 * full tool set through registerAllTools.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHostedSessionRuntime, type HostedSessionRuntime } from '../../../platform/src/platform/hosted-sessions/session-runtime.ts';
import { executeToolCalls } from '../../../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { createEmitterContext } from '../../../platform/src/platform/core/orchestrator-runtime.ts';
import { withExecutionModeOwner } from '../../../platform/src/platform/gate/execution-context.ts';
import { buildDurableRuleForDecision } from '../../../platform/src/platform/permissions/approval-rules.ts';
import type { ToolCall, ToolResult } from '../../../platform/src/platform/types/tools.ts';
import { ConfigManager } from '../../../platform/src/platform/config/manager.ts';
import { createFloor, seedWorkspace, SURFACE, type Floor } from '../compose.ts';
import { textAnswer, toolCallAnswer } from '../fakes.ts';
import type { Instance, MeasureEnv, Scenario } from '../harness.ts';

const P = 'packages/engine/platform/src/platform';

/** Write `count` remembered rules (one of them allows `echo`) where the floor's rule store reads them. */
function seedRules(floorConfigDir: string, count: number, workspace: string): void {
  const now = Date.now();
  const rules = [];
  for (let i = 0; i < count; i++) {
    const allowEcho = i === count - 1;
    const command = allowEcho ? 'echo measure' : `tool-${i} --flag`;
    const rule = buildDurableRuleForDecision({ toolName: 'exec', args: { commands: [{ cmd: command }] }, tier: 'command-class', effect: 'allow', now: now - i })!;
    rules.push({ rule, createdAt: now - i, tier: 'command-class', tool: 'exec', ...(i % 2 === 0 ? { project: workspace } : {}) });
  }
  const path = join(floorConfigDir, 'permission-rules.json');
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ version: 1, rules: rules.filter((r) => !('project' in r)), projectRules: rules.filter((r) => 'project' in r) }, null, 2));
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

function toolScenario(name: string, drives: string, call: (run: number) => ToolCall, rules = 0): Scenario {
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
          return { toolSucceeded: results.every((result) => result.success) ? 1 : 0, outputChars: results.reduce((n, r) => n + String(r.output ?? r.error ?? '').length, 0) };
        },
        dispose: () => closeSession(s),
      };
    },
  };
}

const twelveCalls = (run: number): ToolCall[] => [
  ...Array.from({ length: 8 }, (_, i) => ({ id: `r${run}-read-${i}`, name: 'read', arguments: { files: [{ path: `src/module-${i}.ts` }] } })),
  { id: `r${run}-find-files`, name: 'find', arguments: { queries: [{ id: 'files', mode: 'files', patterns: ['src/**/*.ts'] }] } },
  { id: `r${run}-find-content`, name: 'find', arguments: { queries: [{ id: 'grep', mode: 'content', pattern: 'helper' }] } },
  { id: `r${run}-edit`, name: 'edit', arguments: { edits: [{ path: 'edit-target.txt', find: run % 2 === 0 ? 'beta' : 'BETA', replace: run % 2 === 0 ? 'BETA' : 'beta' }] } },
  { id: `r${run}-exec`, name: 'exec', arguments: { commands: [{ cmd: 'echo measure' }] } },
];

function turnScenario(name: string, drives: string, calls: (run: number) => ToolCall[]): Scenario {
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
      s.floor.runtimeBus.on('TOOL_EXECUTING', () => { executed++; });
      return {
        prepare(run) {
          const batch = calls(run);
          s.floor.script.length = 0;
          if (batch.length > 0) s.floor.script.push(toolCallAnswer(batch));
          s.floor.script.push(textAnswer('All twelve steps are done: the modules were read, the files found, the edit made and the command run.'));
          executed = 0;
          before = s.session.conversation.getMessageSnapshot().length;
        },
        async op(run) {
          // As the TUI submits (products/tui/src/interactive.ts:544): no origin, so no
          // hosted-service surface restriction on edit/exec.
          await s.session.orchestrator.handleUserInput(`measurement turn ${run}`);
          const messages = s.session.conversation.getMessageSnapshot();
          const refused = messages.slice(before).filter((m) => m.role === 'tool' && typeof m.content === 'string' && m.content.startsWith('Error:')).length;
          return { toolsExecuted: executed, toolErrorsInTranscript: refused, transcriptMessages: messages.length };
        },
        dispose: () => closeSession(s),
      };
    },
  };
}

function permissionScenario(rules: number): Scenario {
  return {
    name: `permission-decision-${rules}-rules`,
    drives: `One autonomous admission (PermissionManager.admitAutonomous) of a prepared exec call (echo) with ${rules} remembered rules in permission-rules.json; the last rule is the one that allows it. The timing includes ToolRegistry.prepareCall, as the tool path does.`,
    entries: [
      `${P}/permissions/manager.ts:609 PermissionManager.admitAutonomous`,
      `${P}/permissions/user-rule-store.ts:238 UserPermissionRuleStore.rules`,
      `${P}/tools/registry.ts:812 ToolRegistry.prepareCall`,
    ],
    async setup(env: MeasureEnv): Promise<Instance> {
      const s = await openSession(env, rules);
      return {
        async op(run) {
          const id = `admit-${run}`;
          const mode = s.session.liveTurnControls.getPermissionMode();
          return withExecutionModeOwner({ getMode: () => mode, getRevision: () => 0 }, async () => {
            const call = await s.session.toolRegistry.prepareCall(id, 'exec', { commands: [{ cmd: 'echo measure' }] });
            const admission = await s.floor.services.permissionManager.admitAutonomous(id, call.name, call.args, {
              sourceOf: () => ({ goal: 'Measure one permission decision', criteria: ['Decide once'] }),
              schemaRevision: call.schemaRevision, preparedCall: { registry: s.session.toolRegistry, call },
            });
            return { allowed: admission.result.approved ? 1 : 0 };
          });
        },
        dispose: () => closeSession(s),
      };
    },
  };
}

export const scenarios: Scenario[] = [
  toolScenario('tool-read', 'One model `read` call of a small file (note.txt) through executeToolCalls: prepare in the ToolRegistry, autonomous permission admission (gate), execution, output shaping. Default permission mode of a fresh config.',
    (run) => ({ id: `read-${run}`, name: 'read', arguments: { files: [{ path: 'note.txt' }] } })),
  toolScenario('tool-exec-remembered', 'One `exec` of `echo measure` that a remembered command-class rule (permission-rules.json) allows, through executeToolCalls as tool-read. Hosted exec posture `workstream`.',
    (run) => ({ id: `exec-${run}`, name: 'exec', arguments: { commands: [{ cmd: 'echo measure' }] } }), 1),
  turnScenario('turn-0-tools', 'Baseline turn: the fake model answers at once with no tool call (submit -> answer -> completion check).', () => []),
  turnScenario('turn-12-tools', 'One turn: the fake model asks for 12 tool calls in one response (8 read, 2 find, 1 edit, 1 exec of echo allowed by a remembered rule), then gives a final answer; through the real turn loop including the completion check.', twelveCalls),
  permissionScenario(10),
  permissionScenario(100),
];
