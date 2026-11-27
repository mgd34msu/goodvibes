// Proves: Under Just YOLO a turn on a channel guest's or stranger's input (a channel message, a webhook) sends the user's stored service credential with a fetch.
// Red when: The fetch tool attaches a registered service's stored credential without asking whose turn it is (tools/fetch/runtime.ts prepareFetchRequest stops calling security/stored-credentials.ts storedCredentialRefusal), so the guest's fetch reaches the loopback server with the user's credential.
// Proves: Under Just YOLO a turn on a channel guest's or stranger's input changes files through a command: deletes its project's files or writes into the user's writable extra folder.
// Red when: The exec runtime builds that turn's sandbox plan writable again (tools/exec/runtime.ts stops passing turnWritesNoFile() to resolveRuntimeSandboxPlan, or sandbox.ts binds the workspace or the user's sandbox.workspaceWritable extras writable for it), so the guest's `rm` deletes the project's file or its `echo` lands in the extra folder.
/**
 * The registry every app composes (composeRuntimeServices, registerAllTools, the one turn loop and executor), under Just
 * YOLO. One turn is the user's own (withOwnerInput), one a channel guest's (withOtherPartyInput, as a channel message
 * from a stranger is marked). Only the model's responses are scripted; the owner is a recorder that refuses; the service is
 * a loopback server that records the credential each request carried.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
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
const SESSION = 'foreign-input-session';
/** The owner's stored credential: plain words in the environment the secret store reads first, never key-shaped. */
const CREDENTIAL_ENV = 'GV_FOREIGN_INPUT_SERVICE_WORDS';
const CREDENTIAL = 'owner-service-words';
const disposables = trackDisposables();
let root: string;
let retirePolicy: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gv-foreign-input-'));
  retirePolicy = configureDecisionModelPolicy(() => 'Hybrid', () => false);
  process.env[CREDENTIAL_ENV] = CREDENTIAL;
});
afterEach(async () => {
  await disposables.flush();
  retirePolicy();
  delete process.env[CREDENTIAL_ENV];
  rmSync(root, { recursive: true, force: true });
});

/** The registry under Just YOLO in `workingDir`, with `settings` for the owner, and one turn per call. */
async function registry(settings: Record<string, unknown>, services?: Record<string, unknown>): Promise<{ readonly guest: (call: ToolCall) => Promise<string>; readonly owner: (call: ToolCall) => Promise<string>; readonly workingDir: string }> {
  const workingDir = join(root, 'alpha');
  const homeDirectory = join(root, 'home');
  for (const folder of [workingDir, homeDirectory]) mkdirSync(folder, { recursive: true });
  seedBenchmarkCache(homeDirectory, SURFACE);
  mkdirSync(join(homeDirectory, '.goodvibes', SURFACE), { recursive: true });
  writeFileSync(join(homeDirectory, '.goodvibes', SURFACE, 'settings.json'), JSON.stringify({ permissions: { mode: 'yolo' }, ...settings }));
  if (services) writeFileSync(join(homeDirectory, '.goodvibes', SURFACE, 'services.json'), JSON.stringify(services));
  const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: SURFACE });
  await prepareConfiguredProjectContext(configManager, workingDir, undefined, { activate: true });
  const runtimeBus = new RuntimeEventBus();
  const options = { configManager, runtimeBus, runtimeStore: createRuntimeStore(), surfaceRoot: SURFACE, workingDir, homeDirectory };
  const built = disposables.add(composeRuntimeServices({
    surface: 'tui', roots: options, hostSeams: options, memoryStore: 'home',
    workspaceTrust: { kind: 'surface', requestTrustDecision: async () => 'trusted' },
    permissionHost: { raiseApproval: () => async () => ({ approved: false }) },
  }));
  const toolRegistry = new ToolRegistry(built.permissionManager);
  const tools = registerAllTools(toolRegistry, {
    fileCache: built.fileCache, projectIndex: built.projectIndex, fileUndoManager: built.fileUndoManager,
    modeManager: built.modeManager, processManager: built.processManager, agentManager: built.agentManager,
    agentMessageBus: built.agentMessageBus, workflowServices: built.workflow, archetypeLoader: built.archetypeLoader,
    sessionOrchestration: built.sessionOrchestration, contractRunner: built.contractRunner,
    configManager, providerRegistry: built.providerRegistry, toolLLM: built.toolLLM, featureFlags: built.featureFlags,
    serviceRegistry: built.serviceRegistry, secretsManager: built.secretsManager, overflowHandler: built.overflowHandler,
    webSearchService: built.webSearchService, mcpRegistry: built.mcpRegistry, sandboxSessionRegistry: built.sandboxSessionRegistry,
    hookDispatcher: built.hookDispatcher, runtimeBus,
    execPromptAnswerHandler: built.execPromptAnswerHandler, sandboxEscalationHandler: built.sandboxEscalationHandler,
    localhostFetchApproval: built.localhostFetchApproval,
    workingDirectory: workingDir, projectRoot: workingDir, surfaceRoot: SURFACE, resolveSessionId: () => SESSION,
  });
  disposables.defer(() => tools.dispose());
  await built.permissionManager.prepareAutonomousOwner();
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
        autonomousSource: () => ({ goal: 'Do the task', criteria: [] }), turnSignal: signal, toolRegistry,
        permissionManager: built.permissionManager, hookDispatcher: built.hookDispatcher, runtimeBus, sessionId: SESSION,
        emitterContext: (id) => createEmitterContext(SESSION, id), workingDirectory: workingDir, onToolSettled: onSettled,
      }, turnId, batch),
    }, { speaker: 'owner', budget: {}, completion: { maxRejectedDrafts: 0 }, delegates: 'return', sink: { delta: () => {} } });
    return results.map((result) => `${result.output ?? ''}${result.error ?? ''}`).join('');
  };
  return {
    guest: (call) => withOtherPartyInput('a message on a channel', () => run(call)),
    owner: (call) => withOwnerInput(() => run(call)),
    workingDir,
  };
}

test("under Just YOLO a channel guest's turn sends no stored service credential; the user's turn does", async () => {
  const arrived: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => { arrived.push(request.headers.get('authorization') ?? ''); return new Response('a private page\n'); } });
  disposables.defer(() => server.stop(true));
  const origin = `http://127.0.0.1:${server.port}`;
  const { guest, owner } = await registry({ fetch: { allowLocalhost: true } }, { vault: { name: 'vault', baseUrl: origin, authType: 'bearer', tokenKey: CREDENTIAL_ENV } });
  const fetchWithService = (): ToolCall => ({ id: 'fetch-1', name: 'fetch', arguments: { urls: [{ url: `${origin}/private`, service: 'vault' }] } });
  const sent = (headers: readonly string[]): string => (headers.some((header) => header.includes(CREDENTIAL)) ? 'credential sent' : 'no credential sent');
  // Rows: the guest's turn; the control, the user's own turn with the same call.
  await guest(fetchWithService());
  const byGuest = arrived.splice(0);
  await owner(fetchWithService());
  const byOwner = arrived.splice(0);
  expect([`guest: ${sent(byGuest)}`, `owner: ${sent(byOwner)}`]).toEqual(['guest: no credential sent', 'owner: credential sent']);
});

test("under Just YOLO a channel guest's turn changes no file by a command; the user's command writes", async () => {
  const extra = join(root, 'shared-lib');
  mkdirSync(extra, { recursive: true });
  const { guest, owner, workingDir } = await registry({ sandbox: { enabled: true, workspaceWritable: [extra] } });
  // On a host with no working boundary such a turn runs no command at all (the same rows hold).
  mkdirSync(join(workingDir, 'src'), { recursive: true });
  writeFileSync(join(workingDir, 'src', 'main.ts'), 'export {};\n');
  const exec = (cmd: string): ToolCall => ({ id: 'exec-1', name: 'exec', arguments: { commands: [{ cmd }] } });
  await guest(exec('rm -rf src'));
  await guest(exec(`echo guest > ${join(extra, 'from-guest.txt')}`));
  await owner(exec(`echo owner > ${join(extra, 'from-owner.txt')}`));
  expect([
    `guest rm: ${existsSync(join(workingDir, 'src', 'main.ts')) ? 'kept' : 'deleted'}`,
    `guest into the extra: ${existsSync(join(extra, 'from-guest.txt')) ? 'written' : 'not written'}`,
    `owner into the extra: ${existsSync(join(extra, 'from-owner.txt')) ? 'written' : 'not written'}`,
  ]).toEqual(['guest rm: kept', 'guest into the extra: not written', 'owner into the extra: written']);
});
