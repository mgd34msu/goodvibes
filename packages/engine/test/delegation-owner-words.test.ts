// Proves: Whether agents start is decided by what the owner said in the conversation: agents they asked for earlier start though a later message speaks of something else, and agents they forbade earlier do not start though a later message speaks of something else.
// Red when: The agent tool reads only the owner's latest message (or lets a later message that says nothing about agents replace an earlier one that did), so the agents the owner asked for are refused or the agents they forbade start, whatever the decision model then answers.
/**
 * The real composition (services, permission manager, every built-in tool in a
 * strict registry, the one tool-batch executor), a real ConversationManager and
 * the orchestrator's tool round (handleToolResponseOutcome). The decision model
 * is a loopback server on the System One wire that answers the delegation
 * question against the owner's words: told the owner forbade agents where the
 * owner asked for them, told to go where the owner forbade them. Only the owner's own words,
 * read by the product, can make each row come out right.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSharedContext } from '@goodvibes/judgment';
import { choiceAnswer } from '@goodvibes/judgment/testing';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { ConversationManager } from '../platform/src/platform/core/conversation.ts';
import { createEmitterContext } from '../platform/src/platform/core/orchestrator-runtime.ts';
import { executeToolCalls } from '../platform/src/platform/core/orchestrator-tool-runtime.ts';
import { handleToolResponseOutcome } from '../platform/src/platform/core/orchestrator-turn-helpers.ts';
import { prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/project-planning/configured-project.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { composeRuntimeServices } from '../platform/src/platform/runtime/services.ts';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.ts';
import { registerAllTools } from '../platform/src/platform/tools/index.ts';
import { ToolRegistry } from '../platform/src/platform/tools/registry.ts';
import type { ToolCall } from '../platform/src/platform/types/tools.ts';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { planningPort } from './contract/plan-support.ts';
import { withOwnerInput } from '../platform/src/platform/security/turn-input-party.ts';

const SESSION = 'owner-session';
/** What the decision model stand-in answers the delegation question: the opposite of what the owner said. */
let wrongAnswer: { readonly verdict: string; readonly source: string } = { verdict: 'go', source: 'none' };
const answerer = planningPort((context) => {
  if (context.name === 'verdict' && context.question.type === 'choice' && 'do_it_yourself' in context.question.criteria) return choiceAnswer(context.question, wrongAnswer.verdict, 0.97);
  if (context.name === 'source' && context.question.type === 'choice' && 'none' in context.question.criteria) return choiceAnswer(context.question, wrongAnswer.source, 0.97);
  return undefined;
});

async function compose(root: string, decisionEndpoint: string) {
  const workingDir = join(root, 'workspace'), homeDirectory = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: 'goodvibes', ownsDaemonTier: true });
  const saved = configManager.setMany([
    { key: 'permissions.mode' as never, value: 'yolo' },
    { key: 'judgment.policy' as never, value: 'Hybrid' },
    { key: 'judgment.endpoint' as never, value: decisionEndpoint },
    { key: 'judgment.model' as never, value: 'stand-in-model' },
    { key: 'judgment.keySource' as never, value: 'none' },
  ], localOwnerActor());
  if (!saved.ok) throw new Error(`settings not saved: ${JSON.stringify(saved)}`);
  seedBenchmarkCache(homeDirectory, 'goodvibes');
  await prepareConfiguredProjectContext(configManager, workingDir, undefined, { activate: true });
  const runtimeBus = new RuntimeEventBus();
  const options = { configManager, runtimeBus, runtimeStore: createRuntimeStore(), surfaceRoot: 'goodvibes', workingDir, homeDirectory };
  const services = composeRuntimeServices({
    surface: 'tui', roots: options, hostSeams: options, memoryStore: 'home',
    workspaceTrust: { kind: 'surface', requestTrustDecision: async () => 'trusted' },
    // The owner is never asked in these rows; an ask would be the product leaving the owner's words unread.
    permissionHost: { raiseApproval: () => async () => ({ approved: false }) },
  } as never);
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
    workingDirectory: workingDir, projectRoot: workingDir, surfaceRoot: 'goodvibes', resolveSessionId: () => SESSION,
    delegationAsk: (question, { signal }) => services.permissionManager.askDelegation(question, { signal }),
  });
  await services.permissionManager.prepareAutonomousOwner();
  const dispose = async () => {
    for (const agent of services.agentManager.list()) { try { services.agentManager.cancel(agent.id); } catch { /* already ended */ } }
    await tools.dispose();
    await (services as unknown as { dispose?: () => Promise<void> }).dispose?.();
  };
  return { services, toolRegistry, runtimeBus, workingDir, dispose };
}

/** One owner turn: the owner's message joins the conversation and the model's one tool call runs through the orchestrator's tool round. */
async function ownerTurn(app: Awaited<ReturnType<typeof compose>>, conversation: ConversationManager, ownerText: string, call: ToolCall) {
  conversation.addUserMessage(ownerText);
  // The owner's own turn, as the product marks an owner's turn: a call outside any turn is someone else's and only reads.
  const round = await withOwnerInput(() => handleToolResponseOutcome({
    toolRegistry: app.toolRegistry, conversation, agentManager: app.services.agentManager, planManager: null,
    configManager: app.services.configManager, runtimeBus: app.runtimeBus,
    providerRegistry: { getCurrentModel: () => ({ displayName: 'loopback', provider: 'loopback', capabilities: { multimodal: false } }) } as never,
    emitterContext: (id) => createEmitterContext(SESSION, id), turnId: `turn-${call.id}`,
    response: { content: '', toolCalls: [call] } as never, answeredBy: { model: 'loopback', provider: 'loopback' }, userText: ownerText,
    executeToolCalls: (id, calls) => executeToolCalls({
      autonomousSource: () => ({ goal: ownerText, criteria: [] }), turnSignal: new AbortController().signal,
      toolRegistry: app.toolRegistry, permissionManager: app.services.permissionManager, hookDispatcher: app.services.hookDispatcher,
      runtimeBus: app.runtimeBus, sessionId: SESSION, emitterContext: (eid) => createEmitterContext(SESSION, eid), workingDirectory: app.workingDir,
    }, id, calls),
    setPendingToolCalls: () => {}, messageQueueLength: 0, requestRender: () => {}, sessionId: SESSION,
  }));
  return round.results.find((result) => result.callId === call.id);
}

const batch = (id: string, tasks: readonly string[]): ToolCall => ({ id, name: 'agent', arguments: { mode: 'batch-spawn', tasks: tasks.map((task) => ({ task, outsideContract: true })) } });

describe('the owner\'s words about agents stand until they speak about agents again', () => {
  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => { for (const step of cleanup.splice(0).reverse()) await step(); });

  test('agents asked for earlier start after unrelated messages, and agents forbidden earlier do not', async () => {
    const decision = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
      const body = await request.json() as { model: string; state: unknown; questions: Record<string, unknown> };
      const { state, questions } = readSharedContext(body.state as never, body.questions as never);
      const answered = await answerer.port.ask({ state, questions } as never);
      return Response.json({ model: body.model, answers: answered.answers, usage: { input_tokens: 1, output_tokens: 1 } });
    } });
    cleanup.push(() => decision.stop(true));

    const rows = [
      {
        name: 'asked for, then unrelated messages',
        earlier: [
          'Do a ten-category audit of this repository. Fan out individual agents. All areas must be fully assessed.',
          'ok, so let\'s assign those files to a set of agents to run through looking for the 10 items i asked for earlier in the audit. got it?',
          'did it run???? what the fuck happened?',
        ],
        latest: 'no, you should have led with - i\'m picking this back up so it can finish...',
        tasks: ['Review client files 1-3', 'Review client files 4-6', 'Review server files 1-2', 'Review server files 3-4', 'Review shared files', 'Merge the findings'],
        wrongAnswer: { verdict: 'do_it_yourself', source: 'm1' },
        starts: true,
      },
      {
        name: 'forbidden, then an unrelated message',
        earlier: ['Review the parser and lexer modules for error-handling bugs. Do not use agents for this; do it yourself and keep the notes in REVIEW.md.'],
        latest: 'also the printer, thanks',
        tasks: ['Review src/parser.ts', 'Review src/lexer.ts'],
        wrongAnswer: { verdict: 'go', source: 'none' },
        starts: false,
      },
    ];
    for (const [index, row] of rows.entries()) {
      wrongAnswer = row.wrongAnswer;
      const root = mkdtempSync(join(tmpdir(), 'gv-delegation-words-'));
      cleanup.push(() => rmSync(root, { recursive: true, force: true }));
      const app = await compose(root, `http://127.0.0.1:${decision.port}/v1`);
      cleanup.push(app.dispose);
      const conversation = new ConversationManager();
      for (const said of row.earlier) {
        conversation.addUserMessage(said);
        conversation.addAssistantMessage('Working on it.');
      }
      const result = await ownerTurn(app, conversation, row.latest, batch(`call-${index}`, row.tasks));
      const started = app.services.agentManager.list({ sessionId: SESSION }).map((agent) => agent.task).sort();
      expect({ row: row.name, success: result?.success, started }).toEqual({ row: row.name, success: row.starts, started: row.starts ? [...row.tasks].sort() : [] });
      if (!row.starts) expect(result?.error).toContain('Do not use agents for this; do it yourself');
    }
  });
});
