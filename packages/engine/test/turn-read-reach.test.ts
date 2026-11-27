// Proves: Under Just YOLO a turn on someone else's input (a member's or a device's chat, a channel message, an outside agent) reads another project's files or GoodVibes' own home through the read and find tools.
// Red when: The registry's outside-the-project switch (tools/index.ts allowOutsideProject) follows the mode alone again, or the path check (utils/path-safety.ts refuseProductHome) stops keeping the product's homes out of a widened read, so the member's turn reads the sibling folder's secret or the owner's turn reads a file in the GoodVibes home.
/**
 * The registry every app composes (composeRuntimeServices, registerAllTools, the one turn loop and executor), under Just
 * YOLO. One turn reads as the owner's own (withOwnerInput), one as someone else's (withOtherPartyInput, as the web chat
 * marks a member's message). Only the model's responses are scripted; the owner is a recorder that refuses.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import type { ConfigKey } from '../platform/src/platform/config/schema.js';
import { prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/project-planning/configured-project.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { composeRuntimeServices } from '../platform/src/platform/runtime/services.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import { registerAllTools } from '../platform/src/platform/tools/index.js';
import { executeToolCalls } from '../platform/src/platform/core/orchestrator-tool-runtime.js';
import { createEmitterContext } from '../platform/src/platform/core/orchestrator-runtime.js';
import { runTurn, type TurnModelResponse } from '../platform/src/platform/core/turn-loop.js';
import { withOtherPartyInput, withOwnerInput } from '../platform/src/platform/security/turn-input-party.js';
import type { ToolCall, ToolResult } from '../platform/src/platform/types/tools.js';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const SURFACE = 'goodvibes';
const SESSION = 'read-reach-session';
const disposables = trackDisposables();
let root: string;
let homeProbe: string;
let retirePolicy: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gv-turn-read-reach-'));
  retirePolicy = configureDecisionModelPolicy(() => 'Hybrid', () => false);
});
afterEach(async () => {
  await disposables.flush();
  retirePolicy();
  rmSync(root, { recursive: true, force: true });
  rmSync(homeProbe, { force: true });
});

test("under Just YOLO someone else's turn reads only its project; the owner's reads beside it but never the product's home", async () => {
  const workingDir = join(root, 'alpha');
  const homeDirectory = join(root, 'home');
  const beside = join(root, 'beta');
  for (const folder of [workingDir, homeDirectory, beside, join(homedir(), '.goodvibes')]) mkdirSync(folder, { recursive: true });
  writeFileSync(join(workingDir, 'note.txt'), 'ALPHA_NOTE\n');
  writeFileSync(join(beside, 'secret.txt'), 'BETA_SECRET\n');
  homeProbe = join(homedir(), '.goodvibes', `read-reach-${process.pid}.json`);
  writeFileSync(homeProbe, '{"HOME_SECRET":true}\n');
  seedBenchmarkCache(homeDirectory, SURFACE);
  // The owner's own settings say Just YOLO (no daemon beside this program).
  mkdirSync(join(homeDirectory, '.goodvibes', SURFACE), { recursive: true });
  writeFileSync(join(homeDirectory, '.goodvibes', SURFACE, 'settings.json'), JSON.stringify({ permissions: { mode: 'yolo' } }));
  const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: SURFACE });
  expect(configManager.get('permissions.mode' as ConfigKey)).toBe('yolo');
  await prepareConfiguredProjectContext(configManager, workingDir, undefined, { activate: true });
  const runtimeBus = new RuntimeEventBus();
  const options = { configManager, runtimeBus, runtimeStore: createRuntimeStore(), surfaceRoot: SURFACE, workingDir, homeDirectory };
  const services = disposables.add(composeRuntimeServices({
    surface: 'tui', roots: options, hostSeams: options, memoryStore: 'home',
    workspaceTrust: { kind: 'surface', requestTrustDecision: async () => 'trusted' },
    permissionHost: { raiseApproval: () => async () => ({ approved: false }) },
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
    workingDirectory: workingDir, projectRoot: workingDir, surfaceRoot: SURFACE, resolveSessionId: () => SESSION,
  });
  disposables.defer(() => tools.dispose());
  await services.permissionManager.prepareAutonomousOwner();

  /** One turn whose one call is `call`: what came back, as text. */
  let turns = 0;
  const run = async (call: ToolCall): Promise<string> => {
    const turnId = `turn-${++turns}`;
    const responses: TurnModelResponse[] = [{ content: '', toolCalls: [{ ...call, id: `${call.id}-${turns}` }] }, { content: 'Done.', toolCalls: [] }];
    const results: ToolResult[] = [];
    await runTurn({
      signal: new AbortController().signal,
      async request() { return responses.shift()!; },
      conversation: { addAssistantMessage: () => {}, addToolResults: (landed) => { results.push(...landed); } },
      executeTools: (batch, { signal, onSettled }) => executeToolCalls({
        autonomousSource: () => ({ goal: 'Read the files', criteria: [] }), turnSignal: signal, toolRegistry,
        permissionManager: services.permissionManager, hookDispatcher: services.hookDispatcher, runtimeBus, sessionId: SESSION,
        emitterContext: (id) => createEmitterContext(SESSION, id), workingDirectory: workingDir, onToolSettled: onSettled,
      }, turnId, batch),
    }, { speaker: 'owner', budget: {}, completion: { maxRejectedDrafts: 0 }, delegates: 'return', sink: { delta: () => {} } });
    return results.map((result) => `${result.output ?? ''}${result.error ?? ''}`).join('');
  };
  const read = (path: string): ToolCall => ({ id: 'read-1', name: 'read', arguments: { files: [{ path }] } });
  const find = (path: string): ToolCall => ({ id: 'find-1', name: 'find', arguments: { queries: [{ id: 'q1', mode: 'files', patterns: ['**/*'], path }] } });
  const member = (call: ToolCall): Promise<string> => withOtherPartyInput('a member of this daemon', () => run(call));
  const owner = (call: ToolCall): Promise<string> => withOwnerInput(() => run(call));
  const shows = (text: string, words: string): string => (text.includes(words) ? 'reads' : 'refused');

  // Rows: the member beside her project, by read and by find; the owner beside his; the owner in the product's home;
  // the control, the member inside her project.
  expect([
    `member read beside: ${shows(await member(read(join(beside, 'secret.txt'))), 'BETA_SECRET')}`,
    `member find beside: ${shows(await member(find(beside)), 'secret.txt')}`,
    `owner read beside: ${shows(await owner(read(join(beside, 'secret.txt'))), 'BETA_SECRET')}`,
    `owner read the product's home: ${shows(await owner(read(homeProbe)), 'HOME_SECRET')}`,
    `member read inside: ${shows(await member(read('note.txt')), 'ALPHA_NOTE')}`,
  ]).toEqual([
    'member read beside: refused',
    'member find beside: refused',
    'owner read beside: reads',
    'owner read the product\'s home: refused',
    'member read inside: reads',
  ]);
});
