// Proves: A model's first call of a tool whose parameters load on first use does not end the turn: the call is held once, the identical retry runs and returns its real answer, and the turn ends normally.
// Red when: The turn loop keeps a call held only to load its parameters as a refused call (`recordRefusals` in core/turn-loop.ts stops skipping `heldToLoad`), so the identical retry is blocked as already refused and the turn never gets the tool's answer.
/**
 * Clients that drive GoodVibes headless depend on tool calls working, and most tools reach the model in one line
 * until a call loads their parameters. Here the real pieces run: the services every app composes, the tool registry
 * bound to the graph's permission manager (which lists a tool in one line and holds a call that does not fit), the
 * one tool-batch executor and the one turn loop. Only the model is scripted: it calls a one-line tool with a
 * parameter the tool does not take, then sends the same call again unchanged, then answers.
 */
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/project-planning/configured-project.js';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.js';
import { composeRuntimeServices } from '../platform/src/platform/runtime/services.js';
import { createRuntimeStore } from '../platform/src/platform/runtime/store/index.js';
import { configureDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { ToolRegistry } from '../platform/src/platform/tools/registry.js';
import { executeToolCalls } from '../platform/src/platform/core/orchestrator-tool-runtime.js';
import { createEmitterContext } from '../platform/src/platform/core/orchestrator-runtime.js';
import { runTurn, type TurnModelResponse } from '../platform/src/platform/core/turn-loop.js';
import type { Tool, ToolCall, ToolResult } from '../platform/src/platform/types/tools.js';
import { seedBenchmarkCache } from './_helpers/benchmark-cache.ts';
import { trackDisposables } from './_helpers/disposables.ts';

const SURFACE = 'goodvibes';
const SESSION = 'deferred-retry-session';
const disposables = trackDisposables();
let root: string;
let retirePolicy: () => void;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gv-deferred-retry-'));
  retirePolicy = configureDecisionModelPolicy(() => 'Hybrid', () => false);
});
afterEach(async () => {
  await disposables.flush();
  retirePolicy();
  rmSync(root, { recursive: true, force: true });
});

/** A read-only tool that is not core, so a request lists it in one line until a call loads it. */
const lookup: Tool = {
  definition: {
    name: 'garden_lookup',
    description: 'Look up a plant in the garden notes.',
    parameters: { type: 'object', properties: { need: { type: 'string', description: 'What to look up' } }, required: ['need'], additionalProperties: false },
    sideEffects: ['read_fs'],
    category: 'read',
    concurrency: 'parallel',
  },
  async execute(args) {
    return { success: true, output: `found: ${String(args.need)}` };
  },
};

async function composeApp() {
  const workingDir = join(root, 'workspace');
  const homeDirectory = join(root, 'home');
  mkdirSync(workingDir, { recursive: true });
  mkdirSync(homeDirectory, { recursive: true });
  seedBenchmarkCache(homeDirectory, SURFACE);
  const configManager = new ConfigManager({ homeDir: homeDirectory, workingDir, surfaceRoot: SURFACE });
  await prepareConfiguredProjectContext(configManager, workingDir, undefined, { activate: true });
  const runtimeBus = new RuntimeEventBus();
  const options = { configManager, runtimeBus, runtimeStore: createRuntimeStore(), surfaceRoot: SURFACE, workingDir, homeDirectory };
  const services = disposables.add(composeRuntimeServices({
    surface: 'tui', roots: options, hostSeams: options, memoryStore: 'home',
    workspaceTrust: { kind: 'surface', requestTrustDecision: async () => 'trusted' },
    permissionHost: { raiseApproval: () => async () => ({ approved: false }) },
  }));
  const toolRegistry = new ToolRegistry(services.permissionManager);
  toolRegistry.register(lookup);
  await services.permissionManager.prepareAutonomousOwner();
  return { workingDir, services, toolRegistry, runtimeBus };
}

/** One turn of the scripted model's rounds; every result the turn records, in order. */
async function turn(app: Awaited<ReturnType<typeof composeApp>>, rounds: ToolCall[][]) {
  const responses: TurnModelResponse[] = [...rounds.map((calls) => ({ content: '', toolCalls: calls })), { content: 'Done.', toolCalls: [] }];
  const results: ToolResult[] = [];
  const outcome = await runTurn({
    signal: new AbortController().signal,
    async request() { return responses.shift() ?? { content: 'Done.', toolCalls: [] }; },
    conversation: { addAssistantMessage: () => {}, addToolResults: (landed) => { results.push(...landed); } },
    executeTools: (batch, { signal, onSettled }) => executeToolCalls({
      autonomousSource: () => ({ goal: 'Look up a plant', criteria: [] }),
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
  }, { speaker: 'owner', budget: {}, completion: { maxRejectedDrafts: 0 }, delegates: 'return', sink: { delta: () => {} } });
  return { outcome, results };
}

test('a misfit first call of a one-line tool is held once, the identical retry runs and answers, and the turn ends; a call that fits runs at once', async () => {
  // A call that fits the tool's parameters runs at once, with no hold.
  const fits = await turn(await composeApp(), [[{ id: 'fit-1', name: 'garden_lookup', arguments: { need: 'tomato' } }]]);
  expect(fits.outcome.status).toBe('answered');
  expect(fits.results.map((result) => [result.callId, result.success, result.output])).toEqual([['fit-1', true, 'found: tomato']]);

  // A call with a parameter the tool does not take is held to load; the same call sent again runs and its real answer (the schema's) comes back.
  const call = (id: string): ToolCall => ({ id, name: 'garden_lookup', arguments: { query: 'tomato' } });
  const misfit = await turn(await composeApp(), [[call('first')], [call('again')]]);
  expect(misfit.outcome.status).toBe('answered');
  const [first, again] = misfit.results;
  expect(first?.heldToLoad).toBe(true);
  expect(again?.callId).toBe('again');
  expect(again?.heldToLoad).not.toBe(true);
  expect(again?.error ?? '').toContain('need');
  expect(again?.error ?? '').not.toContain('already');
});
