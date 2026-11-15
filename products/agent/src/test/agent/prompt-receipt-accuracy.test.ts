import { useMemoryReadings } from '../helpers/memory-readings.ts';
import { describe, expect, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { MemoryEmbeddingProviderRegistry, MemoryRegistry, MemoryStore } from '@goodvibes-jev/engine/platform/platform/state';
import { AgentPromptContextReceiptStore, composeRuntimePromptWithReceipt, type PromptContextReceiptDraft } from '../../agent/prompt-context-receipts.ts';
import { AgentRoutineRegistry, ENABLED_ROUTINES_PROMPT_LIMIT } from '../../agent/routine-registry.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../config/surface.ts';
import { createShellPathService } from '@/runtime/index.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

useMemoryReadings();

describe('the receipt describes the prompt that was built', () => {
  test('routines beyond the prompt limit are counted as suppressed, not as applied', async () => {
    const root = makeProjectTempDir('goodvibes-agent-receipt-routines');
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const shellPaths = createShellPathService({ workingDirectory: workspace, homeDirectory: home });
    const configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      configDir: join(home, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT),
      workingDir: workspace,
    });
    const store = new MemoryStore(join(root, 'memory.sqlite'), { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }) });
    await store.init();
    try {
      const routines = AgentRoutineRegistry.fromShellPaths(shellPaths);
      const total = ENABLED_ROUTINES_PROMPT_LIMIT + 1;
      for (let index = 0; index < total; index += 1) {
        const routine = routines.create({ name: `Routine ${index}`, description: `Routine ${index} description.`, steps: `Step for routine ${index}.`, enabled: true });
        routines.markReviewed(routine.id);
      }

      const composed = await composeRuntimePromptWithReceipt({
        sessionId: 's', turnId: 't', source: 'turn', provider: 'openai',
        model: { registryKey: 'openai:gpt-4.1', id: 'gpt-4.1' }, contextWindow: 128_000,
        tierPrompt: '', runtimePrompt: 'Base.', operatorPolicy: 'Policy.', shellPaths, memoryRegistry: new MemoryRegistry(store),
      });

      const segment = composed.receipt.segments.find((entry) => entry.id === 'routines')!;
      const promptedHeadings = composed.prompt.split('\n').filter((line) => line.startsWith('### Routine '));
      expect(promptedHeadings).toHaveLength(ENABLED_ROUTINES_PROMPT_LIMIT);
      expect(segment.activeCount).toBe(promptedHeadings.length);
      expect(segment.suppressedCount).toBe(1);
      expect(String(segment.suppressed?.[0]?.reason)).toContain(`outside the first ${ENABLED_ROUTINES_PROMPT_LIMIT} routines`);
    } finally {
      await store.save();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the receipt and the prompt come from one read of each store', () => {
  test('a routine store emptied after the prompt was built does not change the receipt', async () => {
    const root = makeProjectTempDir('goodvibes-agent-receipt-one-read');
    const home = join(root, 'home');
    const workspace = join(root, 'workspace');
    mkdirSync(home, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    const realPaths = createShellPathService({ workingDirectory: workspace, homeDirectory: home });
    let routineStoreResolutions = 0;
    // The second time anything asks for the routine store, the file is gone: a second read would see no routines.
    const shellPaths = new Proxy(realPaths, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key !== 'resolveUserPath' || typeof value !== 'function') return value;
        return (...parts: string[]) => {
          const resolved = (value as (...args: string[]) => string).apply(target, parts);
          if (resolved.endsWith(join('routines', 'routines.json'))) {
            routineStoreResolutions += 1;
            if (routineStoreResolutions === 2) rmSync(resolved, { force: true });
          }
          return resolved;
        };
      },
    });
    const configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      configDir: join(home, '.goodvibes', GOODVIBES_AGENT_SURFACE_ROOT),
      workingDir: workspace,
    });
    const store = new MemoryStore(join(root, 'memory.sqlite'), { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }) });
    await store.init();
    try {
      const routines = AgentRoutineRegistry.fromShellPaths(realPaths);
      const routine = routines.create({ name: 'Only routine', description: 'Does one thing.', steps: 'Do it.', enabled: true });
      routines.markReviewed(routine.id);

      const composed = await composeRuntimePromptWithReceipt({
        sessionId: 's', turnId: 't', source: 'turn', provider: 'openai',
        model: { registryKey: 'openai:gpt-4.1', id: 'gpt-4.1' }, contextWindow: 128_000,
        tierPrompt: '', runtimePrompt: 'Base.', operatorPolicy: 'Policy.', shellPaths, memoryRegistry: new MemoryRegistry(store),
      });

      expect(composed.prompt).toContain('### Only routine');
      expect(composed.receipt.segments.find((entry) => entry.id === 'routines')!.activeCount).toBe(1);
    } finally {
      await store.save();
      store.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('the receipt journal is a diagnostic record', () => {
  const draft: PromptContextReceiptDraft = {
    sessionId: 's', turnId: 't', source: 'turn', provider: 'p', model: 'm', contextWindow: 1,
    promptChars: 1, approxPromptTokens: 1, activeRecords: 0, suppressedRecords: 0, segments: [],
  };

  test('a journal that cannot be written does not fail the turn, and the receipt is still returned', () => {
    const root = makeProjectTempDir('gv-receipt-journal-unwritable');
    try {
      // A file where the journal's directory should be: the append cannot succeed.
      const blocker = join(root, 'not-a-directory');
      writeFileSync(blocker, 'x');
      const store = new AgentPromptContextReceiptStore(join(blocker, 'receipts.jsonl'));
      const receipt = store.record(draft);
      expect(store.latest()?.receiptId).toBe(receipt.receiptId);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('two receipts minted in the same millisecond with the same sequence still get different ids', () => {
    const first = new AgentPromptContextReceiptStore().record(draft);
    const second = new AgentPromptContextReceiptStore().record(draft);
    expect(first.sequence).toBe(second.sequence);
    expect(first.receiptId).not.toBe(second.receiptId);
  });
});
