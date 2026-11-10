import { planMemoryMirror } from '../platform/src/platform/tools/state/memory-mirror.js';
/**
 * memory ingest/retrieval gap.
 *
 * Root cause: the `state` tool's `mode=memory action=set` wrote a preference ONLY to a flat
 * `.goodvibes/memory/*.json` file, while passive per-turn knowledge injection reads ONLY the
 * SQLite `memory_records` store. Two disjoint substrates with no bridge, so a "distilled"
 * preference was invisible to retrieval, the model couldn't answer it after a /reset.
 *
 * Fix: `set` also upserts a retrievable `memory_records` row (deduped per key, honest
 * `file` provenance, reviewState 'fresh' so it is not stamped as trusted). These tests prove the
 * record now exists, is retrievable by the passive-injection path, dedups on rewrite, and that the
 * flat-file write is unaffected (and still works with no registry wired).
 */
import { describe, expect, test, afterEach, beforeEach } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStateTool } from '../platform/src/platform/tools/state/index.js';
import { KVState } from '../platform/src/platform/state/kv-state.js';
import { ProjectIndex } from '../platform/src/platform/state/project-index.js';
import { ConfigManager } from '../platform/src/platform/config/manager.js';
import {
  MemoryEmbeddingProviderRegistry,
  MemoryRegistry,
  MemoryStore,
} from '../platform/src/platform/state/index.js';
import {
  buildPerTurnKnowledgeInjection,
  DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
} from '../platform/src/platform/agents/turn-knowledge-injection.js';
import { memoryReadingsPort } from './_helpers/memory-readings.ts';
import { toolReadingsPort, type ToolReadingTable } from './_helpers/tool-readings.ts';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { JudgmentError, type JudgmentPort } from '@goodvibes-jev/judgment';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { withDecisionModelPolicy } from '../platform/src/platform/runtime/decision-policy.js';
import { decisionModelPolicyState } from '@goodvibes-jev/engine/errors';

// Memory search and knowledge ranking read through the judgment port, and so
// does the class a new mirrored record is filed under
// (engine.tools.memory-class); the fakes answer them. A memory no entry names
// reads as a fact.
const CLASS_READINGS: ToolReadingTable = [['dark dashboard theme', { memoryClass: 'constraint' }]];

function statePort(classPort: JudgmentPort = toolReadingsPort(CLASS_READINGS).port): JudgmentPort {
  const memory = memoryReadingsPort().port;
  return {
    model: memory.model,
    ask: (request) => ('memory_class' in request.questions ? classPort.ask(request) : memory.ask(request)),
  };
}

let previousPort: ReturnType<typeof installJudgmentPort>;
beforeEach(() => {
  previousPort = installJudgmentPort(statePort());
});
afterEach(() => {
  installJudgmentPort(previousPort);
});

const tmpRoots: string[] = [];

afterEach(() => {
  for (const root of tmpRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

async function makeHarness(opts: { withRegistry: boolean }): Promise<{
  tool: ReturnType<typeof createStateTool>;
  memoryRegistry: MemoryRegistry;
  memoryDir: string;
  memoryStore: MemoryStore;
}> {
  const root = mkdtempSync(join(tmpdir(), 'gv-state-memory-promote-'));
  tmpRoots.push(root);
  const memoryDir = join(root, '.goodvibes', 'memory');
  mkdirSync(memoryDir, { recursive: true });

  const configManager = new ConfigManager({ configDir: join(root, 'config') });
  const memoryStore = new MemoryStore(join(root, 'memory.sqlite'), {
    embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager }),
    enableVectorIndex: false,
  });
  await memoryStore.init();
  const memoryRegistry = new MemoryRegistry(memoryStore);

  const kvState = new KVState({ stateDir: join(root, 'state') });
  const projectIndex = new ProjectIndex(root);
  const tool = createStateTool(kvState, projectIndex, {
    memoryDir,
    workingDir: root,
    ...(opts.withRegistry ? { memoryRegistry } : {}),
  });
  return { tool, memoryRegistry, memoryDir, memoryStore };
}

describe('state tool: mode=memory set mirrors into the retrievable memory store', () => {
  test('a set preference becomes a fresh, honestly-provenanced memory_record that passive injection surfaces', async () => {
    const { tool, memoryRegistry, memoryDir } = await makeHarness({ withRegistry: true });

    const result = await tool.execute({
      mode: 'memory',
      memoryAction: 'set',
      memoryKey: 'dashboard_prefs',
      memoryValue: 'The user prefers a dark dashboard theme and compact spacing.',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('"retrievable":true');
    // Flat file, the source of truth for mode=memory list/get, is still written.
    expect(existsSync(join(memoryDir, 'dashboard_prefs.json'))).toBe(true);

    // 1. The record now exists in the store passive injection reads.
    const records = memoryRegistry.getAll();
    const rec = records.find((r) => r.tags.includes('state-memory:dashboard_prefs'));
    expect(rec).toBeDefined();
    expect(rec!.summary).toContain('dark dashboard theme');

    // 2. Provenance honesty: reviewState 'fresh' (not stamped reviewed), retrievable confidence,
    //    and a file link back to the flat-file twin.
    expect(rec!.reviewState).toBe('fresh');
    // The class is the memory-class reading's, not a fixed class.
    expect(rec!.cls).toBe('constraint');
    expect(rec!.confidence).toBeGreaterThanOrEqual(55);
    expect(rec!.provenance.some((link) => link.kind === 'file' && link.ref.includes('dashboard_prefs'))).toBe(true);

    // 3. The passive per-turn injection path surfaces it on a turn whose query matches.
    const { block, record } = await buildPerTurnKnowledgeInjection({
      memoryRegistry,
      task: 'Assist the user with the dashboard.',
      conversationTail: [{ role: 'user', content: 'What dashboard theme and spacing should I use?' }],
      budgetTokens: 800,
      relevanceFloor: DEFAULT_TURN_KNOWLEDGE_RELEVANCE_FLOOR,
      alreadyInjectedIds: [],
      turn: 1,
    });
    expect(block).not.toBeNull();
    expect(record.injectedIds).toContain(rec!.id);
    expect(block).toContain('dark dashboard theme');
  });

  test('rewriting the same key updates the single record instead of piling up duplicates', async () => {
    const { tool, memoryRegistry } = await makeHarness({ withRegistry: true });

    await tool.execute({
      mode: 'memory',
      memoryAction: 'set',
      memoryKey: 'dashboard_prefs',
      memoryValue: 'The user prefers a dark dashboard theme.',
    });
    await tool.execute({
      mode: 'memory',
      memoryAction: 'set',
      memoryKey: 'dashboard_prefs',
      memoryValue: 'The user now prefers a dark dashboard theme with a spacious layout.',
    });

    const forKey = memoryRegistry.getAll().filter((r) => r.tags.includes('state-memory:dashboard_prefs'));
    expect(forKey).toHaveLength(1);
    // The single record reflects the latest write.
    expect(forKey[0]!.summary).toContain('spacious layout');
  });

  test.each([0.4, 0.57])('an unsettled memory-class reading (%s) preserves the memory with pending classification', async (confidence) => {
    const unsure = toolReadingsPort([]).port;
    installJudgmentPort(statePort({
      model: unsure.model,
      async ask(request) {
        const answered = await unsure.ask(request);
        const [name] = Object.keys(request.questions);
        const probabilities = { decision: 0.3, constraint: 0.3, fact: 0.4 };
        return { ...answered, answers: { [name!]: { type: 'choice', choice: 'fact', confidence, probabilities } } as never };
      },
    }));
    const { tool, memoryRegistry, memoryDir } = await makeHarness({ withRegistry: true });

    const result = await tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'build_notes', memoryValue: 'Maybe the build is slow on CI sometimes.' });

    expect(result.success).toBe(true);
    expect(existsSync(join(memoryDir, 'build_notes.json'))).toBe(true);
    expect(memoryRegistry.getAll()[0]?.tags).toContain('classification-pending');
  });

  test.each([
    'A long note. '.repeat(150) + 'Never deploy without review.',
    'A long note. '.repeat(150) + ' apiKey=private-example',
  ])('complete long memory is retained; private values never reach classification or indexing', async (memoryValue) => {
    let calls = 0;
    installJudgmentPort(statePort({ model: 'jev-1.13.0', ask: async () => { calls++; throw new Error('must not call'); } }));
    const { tool, memoryRegistry, memoryDir } = await makeHarness({ withRegistry: true });
    const result = await tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'long_note', memoryValue });
    expect(result.success).toBe(true);
    expect(existsSync(join(memoryDir, 'long_note.json'))).toBe(true);
    if (memoryValue.includes('apiKey=')) {
      expect(calls).toBe(0);
      expect(memoryRegistry.getAll()).toHaveLength(0);
    } else {
      expect(calls).toBeGreaterThan(0);
      expect(memoryRegistry.getAll()[0]?.detail).toBe(memoryValue);
    }
  });

  test('when Jev cannot read the class, the complete memory remains available', async () => {
    installJudgmentPort(statePort({
      model: 'jev-1.13.0',
      ask: async () => {
        throw new JudgmentError('unavailable', 'no answer');
      },
    }));
    const { tool, memoryRegistry, memoryDir } = await makeHarness({ withRegistry: true });

    const result = await tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'owner', memoryValue: 'The billing module is owned by the payments team.' });

    expect(result.success).toBe(true);
    expect(existsSync(join(memoryDir, 'owner.json'))).toBe(true);
    expect(memoryRegistry.getAll().some((r) => r.tags.includes('state-memory:owner'))).toBe(true);
  });

  test('with no registry wired, set still writes the flat file and reports retrievable:false (back-compat)', async () => {
    const { tool, memoryDir } = await makeHarness({ withRegistry: false });

    const result = await tool.execute({
      mode: 'memory',
      memoryAction: 'set',
      memoryKey: 'legacy_pref',
      memoryValue: 'A preference stored without a memory registry present.',
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('"retrievable":false');
    expect(existsSync(join(memoryDir, 'legacy_pref.json'))).toBe(true);
  });
});

for (const policy of ['Classic - Off', 'Preferred'] as const) {
  test(`${policy} memory set/get/update retains raw content and pending-class provenance without reusing a prior review`, async () => {
    const fake = fakePort(() => { throw new JudgmentError('unavailable', 'Synthetic exhausted chain'); }); installJudgmentPort(fake.port);
    await withDecisionModelPolicy(() => policy, async () => {
      const h = await makeHarness({ withRegistry: true });
      try {
        const first = await h.tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'owner_note', memoryValue: 'The exact owner supplied note.' });
        expect(first.success).toBe(true);
        expect(JSON.parse(first.output!)).toMatchObject({ provenance: 'classic', classification: 'pending', retrievable: true });
        const record = h.memoryRegistry.getAll()[0]!;
        expect(record.tags).toContain('classic-memory'); expect(record.tags).toContain('classification-pending');
        expect(record.reviewState).toBe('fresh');
        h.memoryRegistry.review(record.id, { state: 'reviewed', confidence: 99, reviewedBy: 'synthetic-owner' });
        const attempted = fake.requests.length;
        const second = await h.tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'owner_note', memoryValue: 'The complete replacement note.' });
        expect(second.success).toBe(true);
        const records = h.memoryRegistry.getAll(); expect(records).toHaveLength(1);
        expect(records[0]!.id).toBe(record.id); expect(records[0]!.detail).toBe('The complete replacement note.');
        expect(records[0]!.reviewState).toBe('fresh'); expect(records[0]!.confidence).toBe(60);
        expect(records[0]!.reviewedAt).toBeUndefined(); expect(records[0]!.reviewedBy).toBeUndefined();
        expect(records[0]!.tags).toContain('classification-pending');
        const read = await h.tool.execute({ mode: 'memory', memoryAction: 'get', memoryKey: 'owner_note' });
        expect(JSON.parse(read.output!).value).toBe('The complete replacement note.');
        expect(readFileSync(join(h.memoryDir, 'owner_note.json'), 'utf8')).toBe('The complete replacement note.');
        expect(fake.requests).toHaveLength(attempted);
        expect(policy === 'Classic - Off' ? attempted === 0 : attempted > 0).toBe(true);
        // These are native fresh-record defaults, not a model confidence score.
        const dbPath = h.memoryStore.dbPath; expect(dbPath).not.toBeNull(); h.memoryStore.close();
        const reopened = new MemoryStore(dbPath!, { embeddingRegistry: new MemoryEmbeddingProviderRegistry({ configManager: new ConfigManager({ configDir: join(h.memoryDir, 'config') }) }), enableVectorIndex: false });
        await reopened.init();
        try {
          expect(reopened.get(record.id)).toMatchObject({ detail: 'The complete replacement note.', reviewState: 'fresh', confidence: 60 });
          expect(reopened.get(record.id)?.reviewedBy).toBeUndefined();
          expect(reopened.get(record.id)?.tags).toContain('classic-memory');
        } finally { reopened.close(); }
      } finally { h.memoryStore.close(); }
    });
  });
}

test('Classic source privacy keeps protected values out of the retrievable mirror', async () => {
  const fake = fakePort(() => { throw new Error('Classic cannot ask'); }); installJudgmentPort(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const h = await makeHarness({ withRegistry: true });
    try {
      const result = await h.tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'local_only', memoryValue: 'apiKey=synthetic-private-secret' });
      expect(result.success).toBe(true); expect(JSON.parse(result.output!).retrievable).toBe(false);
      expect(h.memoryRegistry.getAll()).toEqual([]); expect(fake.requests).toHaveLength(0);
    } finally { h.memoryStore.close(); }
  });
});

test('Classic cancellation and native owner revocation stop memory writes before filesystem or indexed publication', async () => {
  const fake = fakePort(() => { throw new Error('Classic cannot ask'); }); installJudgmentPort(fake.port);
  await withDecisionModelPolicy(() => 'Classic - Off', async () => {
    const h = await makeHarness({ withRegistry: true });
    try {
      const controller = new AbortController(); controller.abort();
      const input = { mode: 'memory', memoryAction: 'set', memoryKey: 'cancelled', memoryValue: 'Original content.' };
      expect((await h.tool.execute(input, { signal: controller.signal })).success).toBe(false);
      expect((await h.tool.execute(input, { assertCurrent: () => { throw new Error('Retired memory owner'); } })).success).toBe(false);
      expect(existsSync(join(h.memoryDir, 'cancelled.json'))).toBe(false);
      expect(h.memoryRegistry.getAll()).toEqual([]); expect(fake.requests).toHaveLength(0);
    } finally { h.memoryStore.close(); }
  });
});

test('Preferred cancellation during a failed class reading cannot activate Classic or persist the value', async () => {
  const controller = new AbortController();
  const fake = fakePort(() => { controller.abort(); throw new JudgmentError('unavailable', 'Synthetic availability failure concurrent with cancellation'); }); installJudgmentPort(fake.port);
  await withDecisionModelPolicy(() => 'Preferred', async () => {
    const h = await makeHarness({ withRegistry: true });
    try {
      const result = await h.tool.execute({ mode: 'memory', memoryAction: 'set', memoryKey: 'cancelled', memoryValue: 'Original content.' }, { signal: controller.signal });
      expect(result.success).toBe(false); expect(decisionModelPolicyState().operation).toBe('decision');
      expect(existsSync(join(h.memoryDir, 'cancelled.json'))).toBe(false); expect(h.memoryRegistry.getAll()).toEqual([]);
    } finally { h.memoryStore.close(); }
  });
});


test('an internal memory classifier fault stops before a mirror plan or flat-file publication', async () => {
  const h = await makeHarness({ withRegistry: true });
  const fake = fakePort(() => { throw new JudgmentError('internal', 'Private classifier client fault'); });
  installJudgmentPort(fake.port);
  try {
    await withDecisionModelPolicy(() => 'Preferred', async () => {
      await expect(planMemoryMirror(h.memoryRegistry, 'synthetic_key', 'Synthetic remembered preference'))
        .rejects.toMatchObject({ kind: 'internal' });
    });
    expect(fake.requests).toHaveLength(1);
    expect(h.memoryRegistry.getAll()).toHaveLength(0);
    expect(existsSync(join(h.memoryDir, 'synthetic_key.json'))).toBe(false);
  } finally { h.memoryStore.close(); }
});
