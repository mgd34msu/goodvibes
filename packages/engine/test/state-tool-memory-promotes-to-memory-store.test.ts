/**
 * The state tool's `mode=memory` keeps one store: a key is one row in the
 * project memory store, the row prompt retrieval reads. A saved memory is
 * retrievable, a rewrite keeps one row, delete removes it, and a store that
 * does not take the write fails the call instead of reporting it saved.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryClassificationsSettled } from '../platform/src/platform/tools/state/memory-mirror.js';
import { createStateTool } from '../platform/src/platform/tools/state/index.js';
import { KVState } from '../platform/src/platform/state/kv-state.js';
import { ProjectIndex } from '../platform/src/platform/state/project-index.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '../platform/src/platform/state/index.js';
import { createLocalMemoryAccess } from '../platform/src/platform/runtime/memory-spine/client.js';
import {
  buildPerTurnKnowledgeInjection,
  DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
} from '../platform/src/platform/agents/turn-knowledge-injection.js';
import { memoryReadingsPort } from './_helpers/memory-readings.ts';
import { toolReadingsPort, type ToolReadingTable } from './_helpers/tool-readings.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { JudgmentPort } from '@goodvibes-jev/judgment';

const CLASS_READINGS: ToolReadingTable = [['dark dashboard theme', { memoryClass: 'constraint' }]];

function statePort(): JudgmentPort {
  const memory = memoryReadingsPort().port;
  const classPort = toolReadingsPort(CLASS_READINGS).port;
  return {
    model: memory.model,
    ask: (request) => ('memory_class' in request.questions ? classPort.ask(request) : memory.ask(request)),
  };
}

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => { previousPort = installJudgmentPort(statePort()); });
afterEach(() => { installJudgmentPort(previousPort); });

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness() {
  const root = mkdtempSync(join(tmpdir(), 'gv-state-memory-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    enableVectorIndex: false,
  });
  await memoryStore.init();
  cleanups.push(() => memoryStore.close());
  const memoryRegistry = new MemoryRegistry(memoryStore);
  const kvState = new KVState({ stateDir: join(root, 'state') });
  cleanups.push(() => kvState.dispose());
  const tool = createStateTool(kvState, new ProjectIndex(root), { workingDir: root, memory: createLocalMemoryAccess(memoryRegistry) });
  return { tool, memoryRegistry };
}

const forKey = (registry: MemoryRegistry, key: string) => registry.getAll().filter((r) => r.tags.includes(`state-memory:${key}`));

describe('state tool: a memory is the retrievable record', () => {
  test('set saves one record that get, list and passive injection all read', async () => {
    const { tool, memoryRegistry } = await harness();
    const value = 'The user prefers a dark dashboard theme and compact spacing.';
    const saved = await tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'dashboard_prefs', memoryValue: value });
    expect(saved.success).toBe(true);

    const got = JSON.parse((await tool.execute({ mode: 'memory', memoryAction: 'get', memoryKey: 'dashboard_prefs' })).output!);
    expect(got.value).toBe(value);
    const listed = JSON.parse((await tool.execute({ mode: 'memory', memoryAction: 'list' })).output!);
    expect(listed.keys).toEqual(['dashboard_prefs']);

    await memoryClassificationsSettled();
    const [record] = forKey(memoryRegistry, 'dashboard_prefs');
    expect(forKey(memoryRegistry, 'dashboard_prefs')).toHaveLength(1);
    expect(record!.cls).toBe('constraint');
    expect(record!.tags).not.toContain('classification-pending');

    const { block } = await buildPerTurnKnowledgeInjection({
      memoryRegistry,
      task: 'Assist the user with the dashboard.',
      conversationTail: [{ role: 'user', content: 'What dashboard theme and spacing should I use?' }],
      budgetTokens: 800,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(block).toContain('dark dashboard theme');
  });

  test('rewriting a key keeps one record holding the latest value; delete removes it', async () => {
    const { tool, memoryRegistry } = await harness();
    await tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'k', memoryValue: 'first value' });
    await tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'k', memoryValue: 'second value' });
    await memoryClassificationsSettled();
    expect(forKey(memoryRegistry, 'k').map((r) => r.detail)).toEqual(['second value']);

    expect((await tool.execute({ mode: 'memory', memoryAction: 'delete', memoryKey: 'k' })).success).toBe(true);
    expect(forKey(memoryRegistry, 'k')).toHaveLength(0);
    expect((await tool.execute({ mode: 'memory', memoryAction: 'delete', memoryKey: 'k' })).success).toBe(false);
  });

  test('a store that does not take the write fails the call', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gv-state-memory-down-'));
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    const kvState = new KVState({ stateDir: join(root, 'state') });
    cleanups.push(() => kvState.dispose());
    const down = new Error('host unreachable');
    const tool = createStateTool(kvState, new ProjectIndex(root), {
      memory: {
        add: async () => { throw down; },
        list: async () => [],
        update: async () => { throw down; },
        delete: async () => { throw down; },
        get: async () => null,
      },
    });
    const result = await tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'k', memoryValue: 'v' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('host unreachable');
  });
});
