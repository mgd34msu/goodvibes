// Proves: The product's core contract with the model: a read, an edit and a remembered command actually run and return real output through the services, registry, gate and executor every app composes.
// Red when: Any link between composeRuntimeServices, the registry bound to the graph's permission manager, autonomous admission and executePrepared stops a real call from running, or if a remembered rule no longer settles the command without asking.
/**
 * A tool call the model makes actually runs and returns real output through
 * the path every app uses: services composed by composeRuntimeServices with a
 * product's shipped choices, a strict tool registry bound to the graph's own
 * permission manager with every built-in tool registered, the one turn loop,
 * the one tool-batch executor, autonomous admission and
 * ToolRegistry.executePrepared.
 *
 * Only the model is scripted (its responses), and no decision model is set,
 * so the gate decides by code and remembered rules. The
 * owner is a recorder that refuses, so an ask shows up as a refusal.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/project-planning/configured-project.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { composeRuntimeServices } from '../platform/src/platform/runtime/services.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { buildDurableRuleForDecision } from '../platform/src/platform/permissions/approval-rules.js';
import { ownerPermissionRulesPath } from '../platform/src/platform/permissions/user-rule-store.js';
import type { PermissionPromptRequest } from '../platform/src/platform/permissions/prompt.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import { registerAllTools } from '../platform/src/platform/tools/index.js';
import { executeToolCalls } from '../platform/src/platform/core/orchestrator-tool-runtime.js';
import { createEmitterContext } from '../platform/src/platform/core/orchestrator-runtime.js';
import { runTurn, type TurnModelResponse } from '../platform/src/platform/core/turn-loop.js';
import type { ToolCall, ToolResult } from '../platform/src/platform/types/tools.js';
import { withOwnerInput } from '../platform/src/platform/security/turn-input-party.ts';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const SURFACE = 'goodvibes';
const SESSION = 'end-to-end-session';
const disposables = trackDisposables();
let root: string;
let retirePolicy: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gv-tool-call-e2e-'));
  retirePolicy = configureDecisionModelPolicy(() => 'Hybrid', () => false);
});
afterEach(async () => {
  await disposables.flush();
  retirePolicy();
  rmSync(root, { recursive: true, force: true });
});

/** A workspace with a note to read and a file to edit, and one remembered rule allowing `echo remembered`. */
async function composeApp() {
  const workingDir = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  writeFileSync(join(workingDir, 'note.txt'), 'the note the model reads\n');
  writeFileSync(join(workingDir, 'edit-target.txt'), 'alpha\nbeta\ngamma\n');
  seedBenchmarkCache(homeDirectory, SURFACE);
  const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: SURFACE });
  // A rule the owner saved earlier ("always allow this command"), where the rule store reads it.
  const rule = buildDurableRuleForDecision({ toolName: 'exec', args: { commands: [{ cmd: 'echo remembered' }] }, tier: 'command-class', effect: 'allow', now: Date.now() })!;
  const rulesPath = ownerPermissionRulesPath(configManager);
  mkdirSync(dirname(rulesPath), { recursive: true });
  writeFileSync(rulesPath, JSON.stringify({ version: 1, rules: [{ rule, createdAt: Date.now(), tier: 'command-class', tool: 'exec' }], projectRules: [] }));
  await prepareConfiguredProjectContext(configManager, workingDir, undefined, { activate: true });

  const runtimeBus = new RuntimeEventBus();
  const options = { configManager, runtimeBus, runtimeStore: createRuntimeStore(), surfaceRoot: SURFACE, workingDir, homeDirectory };
  const asked: PermissionPromptRequest[] = [];
  // The terminal products' shipped choices; the owner, reached through the graph's raiser, refuses.
  const services = disposables.add(composeRuntimeServices({
    surface: 'tui',
    roots: options,
    hostSeams: options,
    memoryStore: 'home',
    workspaceTrust: { kind: 'surface', requestTrustDecision: async () => 'trusted' },
    permissionHost: { raiseApproval: () => async ({ request }) => { asked.push(request); return { approved: false }; } },
  }));
  const toolRegistry = new ToolRegistry(services.permissionManager);
  const tools = registerAllTools(toolRegistry, {
    fileCache: services.fileCache, projectIndex: services.projectIndex, fileUndoManager: services.fileUndoManager,
    modeManager: services.modeManager, processManager: services.processManager, agentManager: services.agentManager,
    agentMessageBus: services.agentMessageBus, workflowServices: services.workflow, archetypeLoader: services.archetypeLoader,
    sessionOrchestration: services.sessionOrchestration, contractRunner: services.contractRunner,
    configManager, providerRegistry: services.providerRegistry, toolLLM: services.toolLLM, featureFlags: services.featureFlags,
    serviceRegistry: services.serviceRegistry, secretsManager: services.secretsManager, overflowHandler: services.overflowHandler,
    webSearchService: services.webSearchService, mcpRegistry: services.mcpRegistry, sandboxSessionRegistry: services.sandboxSessionRegistry,
    hookDispatcher: services.hookDispatcher, runtimeBus,
    execPromptAnswerHandler: services.execPromptAnswerHandler, sandboxEscalationHandler: services.sandboxEscalationHandler,
    localhostFetchApproval: services.localhostFetchApproval,
    readAccessFilter: async (path: string) => (await services.permissionManager.readAccess(path, SESSION)) === 'allow',
    workingDirectory: workingDir, projectRoot: workingDir, surfaceRoot: SURFACE, resolveSessionId: () => SESSION,
  });
  disposables.defer(() => tools.dispose());
  await services.permissionManager.prepareAutonomousOwner();
  return { workingDir, services, toolRegistry, runtimeBus, asked };
}

/** One turn: the model asks for `calls` in one response, then answers. The executor gets the deps Orchestrator.executeToolCalls passes. */
async function turn(app: Awaited<ReturnType<typeof composeApp>>, calls: ToolCall[]) {
  const responses: TurnModelResponse[] = [{ content: '', toolCalls: calls }, { content: 'Done.', toolCalls: [] }];
  const results: ToolResult[] = [];
  // The owner's own turn, marked the way the product marks one (companion-chat-manager.ts runs the owner's turn in withOwnerInput):
  // a turn not marked as theirs is someone else's input, whose calls change nothing.
  const outcome = await withOwnerInput(() => runTurn({
    signal: new AbortController().signal,
    async request() { return responses.shift()!; },
    conversation: { addAssistantMessage: () => {}, addToolResults: (landed) => { results.push(...landed); } },
    executeTools: (batch, { signal, onSettled }) => executeToolCalls({
      autonomousSource: () => ({ goal: 'Read the note, fix the file and run the remembered command', criteria: [] }),
      turnSignal: signal,
      toolRegistry: app.toolRegistry,
      permissionManager: app.services.permissionManager,
      hookDispatcher: app.services.hookDispatcher,
      runtimeBus: app.runtimeBus,
      sessionId: SESSION,
      emitterContext: (id) => createEmitterContext(SESSION, id),
      workingDirectory: app.workingDir,
      onToolSettled: onSettled,
    }, 'turn-1', batch),
  }, { speaker: 'owner', budget: {}, completion: { maxRejectedDrafts: 0 }, delegates: 'return', sink: { delta: () => {} } }));
  return { outcome, results: new Map(results.map((result) => [result.callId, result])) };
}

test('a read, an edit and a remembered command each run and return their real output; the owner is not asked', async () => {
  const app = await composeApp();
  const { outcome, results } = await turn(app, [
    // The edit's file is read first: an existing file never read is refused (tools/edit/core.ts staleWrite).
    { id: 'read-1', name: 'read', arguments: { files: [{ path: 'note.txt' }, { path: 'edit-target.txt' }] } },
    { id: 'edit-1', name: 'edit', arguments: { edits: [{ path: 'edit-target.txt', find: 'beta', replace: 'BETA' }] } },
    { id: 'exec-1', name: 'exec', arguments: { commands: [{ cmd: 'echo remembered' }] } },
  ]);
  expect(outcome.status).toBe('answered');
  const failures = [...results.values()].filter((result) => !result.success).map((result) => `${result.callId}: ${result.error}`);
  expect(failures).toEqual([]);
  expect(results.get('read-1')!.output).toContain('the note the model reads');
  expect(readFileSync(join(app.workingDir, 'edit-target.txt'), 'utf8')).toBe('alpha\nBETA\ngamma\n');
  expect(JSON.parse(results.get('exec-1')!.output!)).toMatchObject({ exit_code: 0, stdout: 'remembered' });
  expect(app.asked).toEqual([]);
});
