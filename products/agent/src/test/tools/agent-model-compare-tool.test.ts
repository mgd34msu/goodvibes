import { ordinaryResearchOwner, cleanupResearchScreeningFixtures } from '../helpers/research-screening.ts';
import { bindAgentResearchSourceOwner } from '../../agent/protected-research-report.ts';
import { effectAdmissionFixture } from '../helpers/effect-admission.ts';
import { afterAll, describe, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { ChatRequest, ChatResponse, LLMProvider } from '@goodvibes-jev/engine/platform/platform/providers';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { assertJudgmentInput } from '@goodvibes-jev/engine/platform/platform/gate';
import { saveComparisonJudgmentArtifact } from '../../tools/agent-model-compare-judgment.ts';
import { loadComparisonFromArtifact } from '../../tools/agent-model-compare-run.ts';
import {
  createAgentModelCompareTool as rawModelCompareTool,
  registerAgentModelCompareTool,
  type AgentModelCompareCatalogModel,
} from '../../tools/agent-model-compare-tool.ts';

afterAll(cleanupResearchScreeningFixtures);
function createAgentModelCompareTool(...[deps]: Parameters<typeof rawModelCompareTool>) { const admission = effectAdmissionFixture(); bindAgentResearchSourceOwner(admission.registry, ordinaryResearchOwner()); return admission.tool(rawModelCompareTool({ random: () => 0.999999, ...deps, toolRegistry: admission.registry })); }

class CompareTestProvider implements LLMProvider {
  readonly models: string[];
  readonly calls: ChatRequest[] = [];

  constructor(
    readonly name: string,
    modelId: string,
    private readonly content: string,
  ) {
    this.models = [modelId];
  }

  async chat(params: ChatRequest): Promise<ChatResponse> {
    this.calls.push(params);
    return {
      content: this.content,
      toolCalls: [],
      usage: { inputTokens: 11, outputTokens: 7 },
      stopReason: 'completed',
    };
  }
}

function artifactStore() {
  const inputs: ArtifactCreateInput[] = [];
  /** The id the store gave each input, in write order. */
  const ids: string[] = [];
  const records: ArtifactRecord[] = [];
  const contents = new Map<string, Buffer>();
  const store: Pick<ArtifactStore, 'create' | 'list' | 'readContent'> = {
    async create(input: ArtifactCreateInput): Promise<ArtifactDescriptor> {
      inputs.push(input);
      const id = `artifact-${inputs.length}`;
      ids.push(id);
      const buffer = typeof input.dataBase64 === 'string'
        ? Buffer.from(input.dataBase64, 'base64')
        : Buffer.from(input.text ?? '', 'utf-8');
      const record: ArtifactRecord = {
        id: `artifact-${inputs.length}`,
        kind: input.kind ?? 'data',
        mimeType: input.mimeType ?? 'application/json',
        filename: input.filename,
        sizeBytes: buffer.byteLength,
        createdAt: 0,
        acquisitionMode: 'inline-data',
        fetchMode: 'not-applicable',
        metadata: input.metadata ?? {},
        contentPath: `/tmp/${id}.data`,
        metadataPath: `/tmp/${id}.json`,
      };
      records.push(record);
      contents.set(id, buffer);
      return record;
    },
    list(limit = 100): ArtifactDescriptor[] {
      return [...records].reverse().slice(0, limit);
    },
    async readContent(id: string): Promise<{ record: ArtifactRecord; buffer: Buffer }> {
      const record = records.find((entry) => entry.id === id);
      const buffer = contents.get(id);
      if (!record || !buffer) throw new Error(`Unknown artifact: ${id}`);
      return { record, buffer };
    },
  };
  return { inputs, ids, store };
}

function unzipLocalEntries(buffer: Buffer): Map<string, Buffer> {
  const entries = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 4 < buffer.byteLength && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const dataEnd = dataStart + compressedSize;
    const name = buffer.subarray(nameStart, nameStart + nameLength).toString('utf-8');
    const compressed = buffer.subarray(dataStart, dataEnd);
    entries.set(name, method === 8 ? inflateRawSync(compressed) : Buffer.from(compressed));
    offset = dataEnd;
  }
  return entries;
}

function fixture(options: {
  readonly artifactStore?: Pick<ArtifactStore, 'create'> & Partial<Pick<ArtifactStore, 'list' | 'readContent'>>;
  readonly applyModelRoute?: (registryKey: string) => { readonly previousModel?: string; readonly selectedModel: string };
} = {}) {
  const models: AgentModelCompareCatalogModel[] = [
    {
      modelId: 'gpt-4.1',
      providerId: 'openai',
      registryKey: 'openai:gpt-4.1',
      displayName: 'GPT-4.1',
      selectable: true,
      current: true,
    },
    {
      modelId: 'claude-sonnet',
      providerId: 'anthropic',
      registryKey: 'anthropic:claude-sonnet',
      displayName: 'Claude Sonnet',
      selectable: true,
    },
  ];
  const openai = new CompareTestProvider('openai', 'gpt-4.1', 'Candidate A style answer.');
  const anthropic = new CompareTestProvider('anthropic', 'claude-sonnet', 'Candidate B style answer.');
  const providers = new Map<string, CompareTestProvider>([
    ['openai', openai],
    ['anthropic', anthropic],
  ]);
  const recordedUsage: string[] = [];
  const appliedModelRoutes: string[] = [];
  let selectedModel = 'openai:gpt-4.1';
  const deps: Parameters<typeof rawModelCompareTool>[0] = {
    modelCatalog: {
      listModels: () => models,
      getCurrentModel: () => models[0]!,
      recordModelUsage: async (registryKey) => {
        recordedUsage.push(registryKey);
      },
    },
    providerRegistry: {
      getForModel: (modelId, providerId) => {
        const provider = providers.get(providerId ?? '');
        if (!provider || !provider.models.includes(modelId)) throw new Error(`Unknown model ${providerId}:${modelId}`);
        return provider;
      },
    },
    artifactStore: options.artifactStore,
    applyModelRoute: options.applyModelRoute ?? ((registryKey) => {
      const previousModel = selectedModel;
      selectedModel = registryKey;
      appliedModelRoutes.push(registryKey);
      return { previousModel, selectedModel };
    }),
    };
  const tool = createAgentModelCompareTool(deps);
  const rawTool = rawModelCompareTool(deps);

  return {
    appliedModelRoutes,
    anthropic,
    openai,
    recordedUsage,
    tool,
    rawTool,
  };
}

describe('agent_model_compare tool', () => {
  test('generated judgment IDs retain digit-heavy UUID entropy through complete-source synthesis while actual card material stays held', async () => {
    const uuid = 'aaaaaaaa-bbbb-4abc-8111-111111111112' as const;
    expect(() => assertJudgmentInput({ judgmentId: `jdg_${uuid}` })).toThrow('Refused before judgment: payment card material');
    const artifacts = artifactStore(), runner = fixture({ artifactStore: artifacts.store });
    const run = await runner.tool.execute({ mode: 'run', prompt: 'Write a concise product update.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'], confirm: true, explicitUserRequest: 'Compare product update drafts.' });
    expect(run.success, run.error).toBe(true);
    const comparison = await loadComparisonFromArtifact(artifacts.store, 'artifact-1');
    if (!comparison) throw new Error('Original saved comparison was not readable');
    const winner = comparison.candidates.find(candidate => candidate.blindId === 'B');
    if (!winner) throw new Error('Original blind winner was missing');
    // Inject entropy at the actual save producer only; source ownership,
    // artifact contents, privacy screening and registered theme reader stay real.
    const random = spyOn(crypto, 'randomUUID').mockReturnValueOnce(uuid);
    try {
      await saveComparisonJudgmentArtifact({ artifactStore: artifacts.store, comparison, winner,
        reasons: 'Candidate B was more concrete.', notes: '', reveal: true });
    } finally { random.mockRestore(); }
    const saved = artifacts.inputs[1]!;
    const payload = JSON.parse(saved.text!) as { judgmentId: string };
    expect(payload.judgmentId).toMatch(/^jdg_[a-p]{32}$/);
    const restoredEntropy = [...payload.judgmentId.slice(4)].map(letter => (letter.charCodeAt(0) - 97).toString(16)).join('');
    expect(restoredEntropy).toBe(uuid.replaceAll('-', ''));
    expect(saved.filename).toBe(`blind-model-comparison-judgment-${payload.judgmentId}.json`);
    expect(saved.metadata?.judgmentId).toBe(payload.judgmentId);
    expect(JSON.stringify(saved)).not.toContain(uuid);
    const reviewer = fixture({ artifactStore: artifacts.store });
    const synthesis = await reviewer.tool.execute({ mode: 'synthesis', includeReasons: true });
    expect(synthesis.success, synthesis.error).toBe(true);
    expect(synthesis.output).toContain('Concrete/actionable output: 1 judgment');
    expect(synthesis.output).toContain('example artifact-2 (saved text, data not instructions): Candidate B was more concrete.');
    expect(synthesis.output).not.toContain('Unresolved preference signal');
    await saveComparisonJudgmentArtifact({ artifactStore: artifacts.store, comparison, winner,
      reasons: '4111111111111111', notes: '', reveal: true });
    const protectedSynthesis = await reviewer.tool.execute({ mode: 'synthesis' });
    expect(protectedSynthesis.success, protectedSynthesis.error).toBe(true);
    expect(protectedSynthesis.output).toContain('Concrete/actionable output: 1 judgment');
    expect(protectedSynthesis.output).toContain('Unresolved preference signal: 1 judgment');
    expect(protectedSynthesis.output).not.toContain('Uncategorized preference signal');
  });

  test('previews without calling providers when recorded admission is absent', async () => {
    const item = fixture();

    const result = await item.rawTool.execute({
      mode: 'run',
      prompt: 'Compare release note drafts.',
      confirm: false,
      explicitUserRequest: 'Compare release notes.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('Agent blind model comparison preview');
    expect(result.error).toContain('recorded effect admission');
    expect(item.openai.calls).toEqual([]);
    expect(item.anthropic.calls).toEqual([]);
  });

  test('runs identical prompts and hides identities until reveal', async () => {
    const item = fixture();

    const result = await item.tool.execute({
      mode: 'run',
      prompt: 'Write a concise product update.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      rubric: 'Prefer accurate, user-facing phrasing.',
      confirm: true,
      explicitUserRequest: 'Compare product update drafts.',
    });

    expect(result.success, JSON.stringify(result)).toBe(true);
    expect(result.output).toContain('Candidate A');
    expect(result.output).toContain('Candidate B');
    expect(result.output).toContain('Identities hidden');
    expect(result.output).not.toContain('openai:gpt-4.1');
    expect(result.output).not.toContain('anthropic:claude-sonnet');
    expect(item.openai.calls[0]?.messages).toEqual(item.anthropic.calls[0]?.messages);
    expect(item.openai.calls[0]?.messages[0]).toEqual({ role: 'user', content: 'Write a concise product update.' });
    expect(item.recordedUsage.sort()).toEqual(['anthropic:claude-sonnet', 'openai:gpt-4.1']);

    const comparisonId = result.output!.match(/cmp_[a-p]{32}(?![a-z])/)?.[0];
    expect(comparisonId).toBeTruthy();

    const reveal = await item.tool.execute({
      mode: 'reveal',
      comparisonId,
    });
    expect(reveal.success, JSON.stringify(reveal)).toBe(true);
    expect(reveal.output).toContain('A: openai:gpt-4.1 (GPT-4.1)');
    expect(reveal.output).toContain('B: anthropic:claude-sonnet (Claude Sonnet)');

    const protectedReference = await item.tool.execute({ mode: 'reveal', comparisonId: 'cmp_41111111-1111-4115-a111-111111111111' });
    expect(protectedReference.success).toBe(false);
    expect(protectedReference.output ?? '').not.toContain('GPT-4.1');
    expect(item.openai.calls).toHaveLength(1);
    expect(item.anthropic.calls).toHaveLength(1);
  });

  test('can reveal identities immediately when explicitly requested', async () => {
    const item = fixture();

    const result = await item.tool.execute({
      mode: 'run',
      prompt: 'Write a concise product update.',
      candidateCount: 2,
      reveal: true,
      confirm: true,
      explicitUserRequest: 'Compare product update drafts and reveal now.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Reveal');
    expect(result.output).toContain('A: openai:gpt-4.1 (GPT-4.1)');
    expect(result.output).toContain('No selected model was changed.');
  });

  test('saves a durable comparison artifact without leaking identities into blind output', async () => {
    const artifacts = artifactStore();
    const item = fixture({ artifactStore: artifacts.store });

    const result = await item.tool.execute({
      mode: 'run',
      prompt: 'Write a concise product update.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      rubric: 'Prefer accurate, user-facing phrasing.',
      confirm: true,
      explicitUserRequest: 'Compare product update drafts.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('artifact artifact-1 blind-model-comparison-');
    expect(result.output).toContain('includes full prompt, blinded outputs, and reveal map');
    expect(result.output).not.toContain('openai:gpt-4.1');
    expect(result.output).not.toContain('anthropic:claude-sonnet');
    expect(artifacts.inputs).toHaveLength(1);
    expect(artifacts.inputs[0]?.filename).toMatch(/^blind-model-comparison-cmp_/);
    expect(artifacts.inputs[0]?.metadata).toMatchObject({
      purpose: 'agent-model-compare',
      candidateCount: 2,
      completedCandidates: 2,
      revealStored: true,
      revealIncludedInTranscript: false,
    });

    const payload = JSON.parse(artifacts.inputs[0]?.text ?? '{}') as {
      readonly schema?: string;
      readonly prompt?: string;
      readonly rubric?: string;
      readonly reviewFlow?: { readonly routeMutation?: string };
      readonly candidates?: readonly {
        readonly blindId?: string;
        readonly content?: string;
        readonly model?: { readonly registryKey?: string };
      }[];
    };
    expect(payload.schema).toBe('goodvibes.agent.model_compare.v1');
    expect(payload.prompt).toBe('Write a concise product update.');
    expect(payload.rubric).toBe('Prefer accurate, user-facing phrasing.');
    expect(payload.reviewFlow?.routeMutation).toBe('none');
    expect(payload.candidates?.map((candidate) => candidate.blindId)).toEqual(['A', 'B']);
    expect(payload.candidates?.[0]?.model?.registryKey).toBe('openai:gpt-4.1');
    expect(payload.candidates?.[1]?.model?.registryKey).toBe('anthropic:claude-sonnet');
    expect(payload.candidates?.[0]?.content).toBe('Candidate A style answer.');
  });

  test('tags local model benchmark comparison artifacts for setup history', async () => {
    const artifacts = artifactStore();
    const item = fixture({ artifactStore: artifacts.store });

    const result = await item.tool.execute({
      mode: 'run',
      prompt: 'local model benchmark: Ollama',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      benchmarkKind: 'local-model-route',
      confirm: true,
      explicitUserRequest: 'Compare this local model route before making it default.',
    });

    expect(result.success).toBe(true);
    expect(artifacts.inputs).toHaveLength(1);
    expect(artifacts.inputs[0]?.metadata).toMatchObject({
      purpose: 'agent-model-compare',
      benchmarkKind: 'local-model-route',
      candidateCount: 2,
      completedCandidates: 2,
    });
    const latencyEvidence = artifacts.inputs[0]?.metadata?.candidateLatencyEvidence;
    expect(Array.isArray(latencyEvidence)).toBe(true);
    expect((latencyEvidence as unknown as readonly Record<string, unknown>[]).map((entry) => entry.registryKey)).toEqual([
      'openai:gpt-4.1',
      'anthropic:claude-sonnet',
    ]);
    expect(typeof ((latencyEvidence as unknown as Array<Record<string, unknown>>)[0] as Record<string, unknown>).latencyMs).toBe('number');
    const payload = JSON.parse(artifacts.inputs[0]?.text ?? '{}') as {
      readonly benchmarkKind?: string;
      readonly prompt?: string;
      readonly reviewFlow?: { readonly routeMutation?: string };
    };
    expect(payload.benchmarkKind).toBe('local-model-route');
    expect(payload.prompt).toBe('local model benchmark: Ollama');
    expect(payload.reviewFlow?.routeMutation).toBe('none');
  });

  test('runs blind comparison from a saved text artifact as shared prompt context', async () => {
    const artifacts = artifactStore();
    const source = await artifacts.store.create({
      kind: 'document',
      mimeType: 'text/markdown',
      filename: 'launch-brief.md',
      text: 'Launch facts: ship the safer artifact reuse workflow.',
      metadata: { purpose: 'source-brief' },
    });
    const item = fixture({ artifactStore: artifacts.store });

    const result = await item.tool.execute({
      mode: 'run',
      artifactId: source.id,
      prompt: 'Write a concise launch summary from the saved artifact.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      rubric: 'Prefer faithful use of saved source facts.',
      confirm: true,
      explicitUserRequest: 'Compare summaries from the saved launch brief artifact.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain(`source artifact ${source.id}`);
    expect(result.output).toContain('artifact artifact-2 blind-model-comparison-');
    expect(result.output).not.toContain('openai:gpt-4.1');
    expect(item.openai.calls[0]?.messages).toEqual(item.anthropic.calls[0]?.messages);
    const prompt = item.openai.calls[0]?.messages[0]?.content;
    expect(prompt).toContain('Write a concise launch summary from the saved artifact.');
    expect(prompt).toContain('Saved artifact context');
    expect(prompt).toContain(`Artifact ID: ${source.id}`);
    expect(prompt).toContain('Launch facts: ship the safer artifact reuse workflow.');
    expect(artifacts.inputs).toHaveLength(2);
    expect(artifacts.inputs[1]?.metadata).toMatchObject({
      purpose: 'agent-model-compare',
      sourceArtifactId: source.id,
    });
    const payload = JSON.parse(artifacts.inputs[1]?.text ?? '{}') as {
      readonly sourceArtifact?: { readonly artifactId?: string };
      readonly prompt?: string;
    };
    expect(payload.sourceArtifact?.artifactId).toBe(source.id);
    expect(payload.prompt).toContain('Launch facts: ship the safer artifact reuse workflow.');
  });

  test('filters saved preference analytics by task type document id and benchmark tag', async () => {
    const artifacts = artifactStore();
    const source = await artifacts.store.create({
      kind: 'document',
      mimeType: 'text/markdown',
      filename: 'launch-plan.md',
      text: 'Launch plan: keep the evidence packet concise.',
      metadata: { purpose: 'agent-document-export', documentId: 'doc_launch' },
    });
    const runner = fixture({ artifactStore: artifacts.store });

    const documentRun = await runner.tool.execute({
      mode: 'run',
      artifactId: source.id,
      prompt: 'Draft a launch update from this document.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      benchmarkKind: 'doc-draft',
      taskType: 'writing',
      confirm: true,
      explicitUserRequest: 'Compare launch update drafts for this document.',
    });
    expect(documentRun.success, documentRun.error).toBe(true);
    expect(documentRun.output).toContain('benchmark doc-draft');
    expect(documentRun.output).toContain('task type writing');
    expect(documentRun.output).toContain('document doc_launch');

    const reviewer = fixture({ artifactStore: artifacts.store });
    const documentJudgment = await reviewer.tool.execute({
      mode: 'judge',
      artifactId: 'artifact-2',
      winnerBlindId: 'B',
      reasons: 'Document draft was more concrete.',
      reveal: true,
      confirm: true,
      explicitUserRequest: 'Save the document comparison winner.',
    });
    expect(documentJudgment.success).toBe(true);
    expect(artifacts.inputs[2]?.metadata).toMatchObject({
      purpose: 'agent-model-compare-judgment',
      benchmarkKind: 'doc-draft',
      taskType: 'writing',
      documentId: 'doc_launch',
      sourceDocumentId: 'doc_launch',
    });

    const researchRun = await runner.tool.execute({
      mode: 'run',
      prompt: 'Answer a research question.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      benchmarkKind: 'research-bench',
      taskType: 'research',
      confirm: true,
      explicitUserRequest: 'Compare research answer drafts.',
    });
    expect(researchRun.success).toBe(true);
    const researchJudgment = await reviewer.tool.execute({
      mode: 'judge',
      artifactId: 'artifact-4',
      winnerBlindId: 'A',
      reasons: 'Research answer was easier to scan.',
      confirm: true,
      explicitUserRequest: 'Save the research comparison winner.',
    });
    expect(researchJudgment.success).toBe(true);

    const analytics = await reviewer.tool.execute({
      mode: 'analytics',
      benchmarkKind: 'doc-draft',
      taskType: 'writing',
      documentId: 'doc_launch',
      includeReasons: true,
    });
    expect(analytics.success).toBe(true);
    expect(analytics.output).toContain('filters benchmarkKind doc-draft; taskType writing; documentId doc_launch');
    expect(analytics.output).toContain('judgments 1; revealed 1; hidden 0');
    expect(analytics.output).toContain('Trend dimensions');
    expect(analytics.output).toContain('doc-draft: 1');
    expect(analytics.output).toContain('writing: 1');
    expect(analytics.output).toContain('doc_launch: 1');
    expect(analytics.output).toContain('Document draft was more concrete.');
    expect(analytics.output).not.toContain('Research answer was easier to scan.');

    const synthesis = await reviewer.tool.execute({
      mode: 'synthesis',
      documentId: 'missing-doc',
    });
    expect(synthesis.success).toBe(true);
    expect(synthesis.output).toContain('No saved comparison judgments matched filters documentId missing-doc');
  });

  test('rejects non-text source artifacts for blind comparison prompts', async () => {
    const artifacts = artifactStore();
    const image = await artifacts.store.create({
      kind: 'image',
      mimeType: 'image/png',
      filename: 'image.png',
      text: '',
      metadata: { purpose: 'generated-image' },
    });
    const item = fixture({ artifactStore: artifacts.store });

    const result = await item.tool.execute({
      mode: 'run',
      artifactId: image.id,
      prompt: 'Compare descriptions of this saved image.',
      confirm: true,
      explicitUserRequest: 'Compare a saved image artifact.',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('can only inline text-like artifacts');
    expect(item.openai.calls).toEqual([]);
    expect(item.anthropic.calls).toEqual([]);
  });

  /** One saved comparison, plus a second tool instance over the same store, as a reviewer would have. */
  async function seededComparison() {
    const artifacts = artifactStore();
    const runner = fixture({ artifactStore: artifacts.store });
    const run = await runner.tool.execute({
      mode: 'run',
      prompt: 'Write a concise product update.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      confirm: true,
      explicitUserRequest: 'Compare product update drafts.',
    });
    expect(run.success, run.error).toBe(true);
    return { artifacts, comparisonId: artifacts.ids[0]!, reviewer: fixture({ artifactStore: artifacts.store }) };
  }
  type SeededComparison = Awaited<ReturnType<typeof seededComparison>>;

  async function saveJudgment(scene: SeededComparison, winnerBlindId: 'A' | 'B', options: { readonly reasons: string; readonly notes?: string; readonly reveal: boolean }) {
    const result = await scene.reviewer.tool.execute({
      mode: 'judge',
      artifactId: scene.comparisonId,
      winnerBlindId,
      reasons: options.reasons,
      ...(options.notes === undefined ? {} : { notes: options.notes }),
      ...(options.reveal ? { reveal: true } : {}),
      confirm: true,
      explicitUserRequest: 'Save the comparison winner.',
    });
    expect(result.success, result.error).toBe(true);
    return { result, id: scene.artifacts.ids.at(-1)! };
  }
  const revealedJudgment = (scene: SeededComparison) => saveJudgment(scene, 'B', {
    reasons: 'Candidate B was more concrete.', notes: 'Use this as evidence before any route change.', reveal: true,
  });
  const hiddenJudgment = (scene: SeededComparison) => saveJudgment(scene, 'A', { reasons: 'Candidate A was easier to scan.', reveal: false });

  async function applyWinner(scene: SeededComparison, judgmentId: string) {
    const result = await scene.reviewer.tool.execute({
      mode: 'apply', artifactId: judgmentId, confirm: true, explicitUserRequest: 'Apply the comparison winner.',
    });
    expect(result.success, result.error).toBe(true);
    return { result, id: scene.artifacts.ids.at(-1)! };
  }

  async function saveDocument(scene: SeededComparison, filename: string, lines: readonly string[]) {
    return scene.artifacts.store.create({
      kind: 'data',
      mimeType: 'text/markdown',
      filename,
      text: lines.join('\n'),
      metadata: { purpose: 'agent-document-export', documentId: 'doc_launch' },
    });
  }
  const launchPlan = (scene: SeededComparison) => saveDocument(scene, 'launch-plan.md', [
    '# Launch Plan', '', 'Ship the reviewed document workflow.', '', '## Review Comments', '', '- c1 [resolved] Clarify the launch owner.',
  ]);
  const inputOf = (scene: SeededComparison, id: string) => scene.artifacts.inputs[scene.artifacts.ids.indexOf(id)];

  test('reviews and reveals a saved comparison artifact across tool instances', async () => {
    const { reviewer, comparisonId } = await seededComparison();

    const list = await reviewer.tool.execute({ mode: 'review' });
    expect(list.success).toBe(true);
    expect(list.output).toContain('Saved blind comparison artifacts');
    expect(list.output).toContain(comparisonId);
    expect(list.output).toContain('Write a concise product update.');

    const review = await reviewer.tool.execute({ mode: 'review', artifactId: comparisonId });
    expect(review.success).toBe(true);
    expect(review.output).toContain('Blind model comparison review');
    expect(review.output).toContain('Review board');
    expect(review.output).toContain('Candidate A style answer.');
    expect(review.output).toContain('Decision worksheet');
    expect(review.output).not.toContain('openai:gpt-4.1');
    expect(review.output).not.toContain('anthropic:claude-sonnet');

    const reveal = await reviewer.tool.execute({ mode: 'reveal', artifactId: comparisonId });
    expect(reveal.success).toBe(true);
    expect(reveal.output).toContain('A: openai:gpt-4.1 (GPT-4.1)');
    expect(reveal.output).toContain('B: anthropic:claude-sonnet (Claude Sonnet)');
  });

  test('saves a judgment only after confirmation, with the winning model only when revealed', async () => {
    const scene = await seededComparison();
    const { artifacts, reviewer, comparisonId } = scene;
    const savedBefore = artifacts.inputs.length;

    const preview = await reviewer.rawTool.execute({
      mode: 'judge',
      artifactId: comparisonId,
      winnerBlindId: 'B',
      reasons: 'Candidate B was more concrete.',
      confirm: false,
      explicitUserRequest: 'Save the comparison winner.',
    });
    expect(preview.success).toBe(false);
    expect(preview.error).toContain('comparison judgment preview');
    expect(artifacts.inputs).toHaveLength(savedBefore);

    const revealed = await revealedJudgment(scene);
    expect(revealed.result.output).toContain('Blind model comparison judgment saved');
    expect(revealed.result.output).toContain('winner Candidate B');
    expect(revealed.result.output).toContain('winner model anthropic:claude-sonnet');
    expect(revealed.result.output).toContain(`agent_model_compare mode:"apply" artifactId:"${revealed.id}"`);
    expect(revealed.result.output).toContain('No selected model was changed.');
    expect(artifacts.inputs).toHaveLength(savedBefore + 1);

    const judgmentPayload = JSON.parse(inputOf(scene, revealed.id)?.text ?? '{}') as {
      readonly schema?: string;
      readonly winnerBlindId?: string;
      readonly winnerModel?: { readonly registryKey?: string };
      readonly reasons?: string;
      readonly routeHandoff?: { readonly policy?: string };
    };
    expect(judgmentPayload.schema).toBe('goodvibes.agent.model_compare_judgment.v1');
    expect(judgmentPayload.winnerBlindId).toBe('B');
    expect(judgmentPayload.winnerModel?.registryKey).toBe('anthropic:claude-sonnet');
    expect(judgmentPayload.reasons).toBe('Candidate B was more concrete.');
    expect(judgmentPayload.routeHandoff?.policy).toContain('does not change the selected model');

    const hidden = await hiddenJudgment(scene);
    expect(hidden.result.output).toContain('winner Candidate A');
    expect(hidden.result.output).toContain('a blind judgment can be applied');
    expect(hidden.result.output).not.toContain('openai:gpt-4.1');
    expect(hidden.result.output).not.toContain('anthropic:claude-sonnet');
    expect(artifacts.inputs).toHaveLength(savedBefore + 2);

    const hiddenPayload = JSON.parse(inputOf(scene, hidden.id)?.text ?? '{}') as {
      readonly winnerModel?: unknown;
      readonly routeHandoff?: { readonly routeInspection?: string };
      readonly candidates?: readonly { readonly model?: unknown }[];
    };
    expect(hiddenPayload.winnerModel).toBeUndefined();
    expect(hiddenPayload.routeHandoff?.routeInspection).not.toContain('openai:gpt-4.1');
    expect(hiddenPayload.candidates?.some((candidate) => candidate.model)).toBe(false);

    // Judgments are not comparisons: the review list shows only the comparison.
    const listAfterJudgment = await reviewer.tool.execute({ mode: 'review' });
    expect(listAfterJudgment.output).toContain(comparisonId);
    expect(listAfterJudgment.output).not.toContain(revealed.id);
    expect(listAfterJudgment.output).not.toContain(hidden.id);
  });

  test('analytics and synthesis count a comparison judged twice once', async () => {
    const scene = await seededComparison();
    const revealed = await revealedJudgment(scene);
    const hidden = await hiddenJudgment(scene);

    const analytics = await scene.reviewer.tool.execute({ mode: 'analytics', includeReasons: true });
    expect(analytics.success).toBe(true);
    expect(analytics.output).toContain('judgments 1;');
    expect([revealed.id, hidden.id].filter((id) => analytics.output?.includes(id))).toHaveLength(1);

    const synthesis = await scene.reviewer.tool.execute({ mode: 'synthesis', includeReasons: true });
    expect(synthesis.success).toBe(true);
    expect(synthesis.output).toContain('judgments 1;');
    expect(synthesis.output).toContain('compared comparisons 1');
  });

  test('applies a judged winner after confirmation and records a route decision receipt', async () => {
    const scene = await seededComparison();
    const { artifacts, reviewer } = scene;
    const revealed = await revealedJudgment(scene);
    await hiddenJudgment(scene);

    const savedBefore = artifacts.inputs.length;
    const applyPreview = await reviewer.rawTool.execute({
      mode: 'apply', artifactId: revealed.id, confirm: false, explicitUserRequest: 'Apply the comparison winner.',
    });
    expect(applyPreview.success).toBe(false);
    expect(applyPreview.error).toContain('route update preview');
    expect(applyPreview.error).toContain('model anthropic:claude-sonnet');
    expect(reviewer.appliedModelRoutes).toEqual([]);
    expect(artifacts.inputs).toHaveLength(savedBefore);

    const apply = await applyWinner(scene, revealed.id);
    expect(apply.result.output).toContain('Applied blind model comparison winner');
    expect(apply.result.output).toContain('selected model anthropic:claude-sonnet');
    expect(apply.result.output).toContain('previous model openai:gpt-4.1');
    expect(apply.result.output).toContain(`route decision receipt ${apply.id}`);
    expect(reviewer.appliedModelRoutes).toEqual(['anthropic:claude-sonnet']);
    expect(artifacts.inputs).toHaveLength(savedBefore + 1);
    expect(inputOf(scene, apply.id)?.metadata).toMatchObject({
      purpose: 'agent-model-compare-route-decision',
      decision: 'applied-winner',
      judgmentArtifactId: revealed.id,
      winnerModel: 'anthropic:claude-sonnet',
      previousModel: 'openai:gpt-4.1',
      selectedModel: 'anthropic:claude-sonnet',
    });
    const receipt = JSON.parse(inputOf(scene, apply.id)?.text ?? '{}') as {
      readonly schema?: string;
      readonly decision?: string;
      readonly selectedModel?: string;
    };
    expect(receipt.schema).toBe('goodvibes.agent.model_compare.route_decision.v1');
    expect(receipt.decision).toBe('applied-winner');
    expect(receipt.selectedModel).toBe('anthropic:claude-sonnet');
  });

  test('exports a comparison without identities and a judgment with its winner, and exports do not count as evidence', async () => {
    const scene = await seededComparison();
    const { artifacts, reviewer, comparisonId } = scene;
    const revealed = await revealedJudgment(scene);
    await hiddenJudgment(scene);
    const savedBefore = artifacts.inputs.length;

    const exportPreview = await reviewer.rawTool.execute({
      mode: 'export', artifactId: comparisonId, confirm: false, explicitUserRequest: 'Export the comparison report.',
    });
    expect(exportPreview.success).toBe(false);
    expect(exportPreview.error).toContain('comparison export preview');
    expect(artifacts.inputs).toHaveLength(savedBefore);

    const comparisonExport = await reviewer.tool.execute({
      mode: 'export', artifactId: comparisonId, reveal: false, confirm: true, explicitUserRequest: 'Export the comparison report.',
    });
    expect(comparisonExport.success, comparisonExport.error).toBe(true);
    const comparisonExportId = artifacts.ids.at(-1)!;
    expect(comparisonExport.output).toContain('Blind model comparison export saved');
    expect(comparisonExport.output).toContain(`source ${comparisonId} (comparison)`);
    expect(comparisonExport.output).toContain(comparisonExportId);
    expect(comparisonExport.output).toContain('No selected model was changed.');
    expect(artifacts.inputs).toHaveLength(savedBefore + 1);
    const comparisonExportInput = inputOf(scene, comparisonExportId);
    expect(comparisonExportInput?.mimeType).toBe('text/markdown');
    expect(comparisonExportInput?.metadata?.purpose).toBe('agent-model-compare-export');
    expect(comparisonExportInput?.metadata?.sourceKind).toBe('comparison');
    const comparisonExportText = comparisonExportInput?.text ?? '';
    expect(comparisonExportText).toContain('# Blind Model Comparison');
    expect(comparisonExportText).toContain('Candidate A style answer.');
    expect(comparisonExportText).toContain('Candidate B style answer.');
    expect(comparisonExportText).not.toContain('openai:gpt-4.1');
    expect(comparisonExportText).not.toContain('anthropic:claude-sonnet');

    const judgmentExport = await reviewer.tool.execute({
      mode: 'export', artifactId: revealed.id, confirm: true, explicitUserRequest: 'Export the judgment report.',
    });
    expect(judgmentExport.success, judgmentExport.error).toBe(true);
    const judgmentExportId = artifacts.ids.at(-1)!;
    expect(judgmentExport.output).toContain('Blind model comparison export saved');
    expect(judgmentExport.output).toContain(`source ${revealed.id} (judgment)`);
    expect(judgmentExport.output).toContain(judgmentExportId);
    expect(artifacts.inputs).toHaveLength(savedBefore + 2);
    const judgmentExportInput = inputOf(scene, judgmentExportId);
    expect(judgmentExportInput?.mimeType).toBe('text/markdown');
    expect(judgmentExportInput?.metadata?.purpose).toBe('agent-model-compare-export');
    expect(judgmentExportInput?.metadata?.sourceKind).toBe('judgment');
    const judgmentExportText = judgmentExportInput?.text ?? '';
    expect(judgmentExportText).toContain('# Blind Model Comparison Judgment');
    expect(judgmentExportText).toContain('Winner model: anthropic:claude-sonnet');
    expect(judgmentExportText).toContain('Candidate B was more concrete.');
    expect(judgmentExportText).toContain('Use this as evidence before any route change.');

    const listAfterExport = await reviewer.tool.execute({ mode: 'review' });
    expect(listAfterExport.output).toContain(comparisonId);
    expect(listAfterExport.output).not.toContain(comparisonExportId);
    expect(listAfterExport.output).not.toContain(judgmentExportId);

    const analyticsAfterExport = await reviewer.tool.execute({ mode: 'analytics', includeReasons: false });
    expect(analyticsAfterExport.success).toBe(true);
    expect(analyticsAfterExport.output).toContain('judgments 2; revealed 1; hidden 1');
    expect(analyticsAfterExport.output).not.toContain(comparisonExportId);
    expect(analyticsAfterExport.output).not.toContain(judgmentExportId);
    expect(analyticsAfterExport.output).not.toContain('Candidate B was more concrete.');
  });

  test('shows a judgment beside related document evidence without saving anything', async () => {
    const scene = await seededComparison();
    const { artifacts, reviewer } = scene;
    const revealed = await revealedJudgment(scene);
    const document = await launchPlan(scene);
    const savedBefore = artifacts.inputs.length;

    const sideBySide = await reviewer.tool.execute({
      mode: 'sideBySide', artifactId: revealed.id, relatedArtifactIds: [document.id], previewBytes: 600,
    });
    expect(sideBySide.success, sideBySide.error).toBe(true);
    expect(sideBySide.output).toContain('Blind model comparison side-by-side reviewer view');
    expect(sideBySide.output).toContain('Left pane: related document/artifact evidence');
    expect(sideBySide.output).toContain('Right pane: comparison evidence');
    expect(sideBySide.output).toContain(`${document.id} launch-plan.md`);
    expect(sideBySide.output).toContain('# Launch Plan');
    expect(sideBySide.output).toContain('winner Candidate B');
    expect(sideBySide.output).toContain('winner model anthropic:claude-sonnet');
    expect(sideBySide.output).toContain('create handoff agent_model_compare mode:"handoff"');
    expect(sideBySide.output).toContain('No selected model was changed.');

    const sideBySideList = await reviewer.tool.execute({ mode: 'sideBySide' });
    expect(sideBySideList.success).toBe(true);
    expect(sideBySideList.output).toContain('Saved blind comparison artifacts');
    expect(sideBySideList.output).toContain('mode:"sideBySide"');
    expect(sideBySideList.output).toContain('Choose a saved comparison or judgment artifactId');
    expect(artifacts.inputs).toHaveLength(savedBefore);
  });

  test('creates a reviewer handoff, then archives it with its source, related evidence and route decision', async () => {
    const scene = await seededComparison();
    const { artifacts, reviewer } = scene;
    const revealed = await revealedJudgment(scene);
    const receipt = await applyWinner(scene, revealed.id);
    const document = await launchPlan(scene);
    const savedBefore = artifacts.inputs.length;

    const handoffPreview = await reviewer.rawTool.execute({
      mode: 'handoff', artifactId: revealed.id, relatedArtifactIds: [document.id], confirm: false, explicitUserRequest: 'Create a reviewer handoff.',
    });
    expect(handoffPreview.success).toBe(false);
    expect(handoffPreview.error).toContain('reviewer handoff preview');
    expect(handoffPreview.error).toContain(`related artifacts ${document.id}`);
    expect(artifacts.inputs).toHaveLength(savedBefore);

    const handoff = await reviewer.tool.execute({
      mode: 'handoff', artifactId: revealed.id, relatedArtifactIds: [document.id], confirm: true, explicitUserRequest: 'Create a reviewer handoff.',
    });
    expect(handoff.success, handoff.error).toBe(true);
    const handoffId = artifacts.ids.at(-1)!;
    expect(handoff.output).toContain('Blind model comparison reviewer handoff saved');
    expect(handoff.output).toContain(`source ${revealed.id} (judgment)`);
    expect(handoff.output).toContain('related artifacts 1');
    expect(handoff.output).toContain(`artifact ${handoffId}`);
    expect(handoff.output).toContain('No selected model was changed.');
    expect(artifacts.inputs).toHaveLength(savedBefore + 1);
    const handoffInput = inputOf(scene, handoffId);
    expect(handoffInput?.mimeType).toBe('text/markdown');
    expect(handoffInput?.metadata).toMatchObject({
      purpose: 'agent-model-compare-handoff',
      sourceArtifactId: revealed.id,
      sourceKind: 'judgment',
      relatedArtifactIds: [document.id],
    });
    const handoffText = handoffInput?.text ?? '';
    expect(handoffText).toContain('# Blind Model Comparison Reviewer Handoff');
    expect(handoffText).toContain('## Related Artifacts');
    expect(handoffText).toContain('# Launch Plan');
    expect(handoffText).toContain('## Review Comments');
    expect(handoffText).toContain('## Comparison Evidence');
    expect(handoffText).toContain('# Blind Model Comparison Judgment');
    expect(handoffText).toContain('Winner model: anthropic:claude-sonnet');
    expect(handoffText).toContain('Route changes require a separately admitted');

    const archivePreview = await reviewer.rawTool.execute({
      mode: 'handoffArchive', artifactId: handoffId, confirm: false, explicitUserRequest: 'Archive the reviewer handoff.',
    });
    expect(archivePreview.success).toBe(false);
    expect(archivePreview.error).toContain('reviewer handoff archive preview');
    expect(archivePreview.error).toContain(`source ${revealed.id} (judgment)`);
    expect(archivePreview.error).toContain(`related artifacts ${document.id}`);
    expect(archivePreview.error).toContain(`route-decision receipts ${receipt.id}`);
    expect(artifacts.inputs).toHaveLength(savedBefore + 1);

    const archive = await reviewer.tool.execute({
      mode: 'handoffArchive', artifactId: handoffId, confirm: true, explicitUserRequest: 'Archive the reviewer handoff.',
    });
    expect(archive.success, archive.error).toBe(true);
    const archiveId = artifacts.ids.at(-1)!;
    expect(archive.output).toContain('Blind model comparison reviewer handoff archive saved');
    expect(archive.output).toContain(`handoff ${handoffId}`);
    expect(archive.output).toContain(`source ${revealed.id} (judgment)`);
    expect(archive.output).toContain('route-decision receipts 1');
    expect(archive.output).toContain('included artifacts 4');
    expect(archive.output).toContain(`archive ${archiveId}`);
    expect(archive.output).toContain(`export agent_artifacts mode:"export" artifactId:"${archiveId}"`);
    expect(archive.output).toContain('No selected model was changed.');
    expect(artifacts.inputs).toHaveLength(savedBefore + 2);
    const archiveInput = inputOf(scene, archiveId);
    expect(archiveInput?.kind).toBe('archive');
    expect(archiveInput?.mimeType).toBe('application/zip');
    expect(archiveInput?.metadata).toMatchObject({
      purpose: 'agent-model-compare-handoff-archive',
      handoffArtifactId: handoffId,
      sourceArtifactId: revealed.id,
      sourceKind: 'judgment',
      relatedArtifactIds: [document.id],
      routeDecisionArtifactIds: [receipt.id],
      includedArtifactIds: [handoffId, revealed.id, document.id, receipt.id],
      artifactCount: 4,
    });
    const entries = unzipLocalEntries(Buffer.from(String(archiveInput?.dataBase64 ?? ''), 'base64'));
    expect(entries.get('README.md')?.toString('utf-8')).toContain('GoodVibes Agent Comparison Handoff Archive');
    const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf-8') ?? '{}') as {
      readonly archiveKind?: string;
      readonly handoff?: {
        readonly sourceArtifactId?: string;
        readonly relatedArtifactIds?: readonly string[];
        readonly routeDecisionArtifactIds?: readonly string[];
      };
      readonly artifacts?: readonly { readonly role?: string; readonly id?: string; readonly file?: string }[];
    };
    expect(manifest.archiveKind).toBe('agent-model-compare-handoff');
    expect(manifest.handoff?.sourceArtifactId).toBe(revealed.id);
    expect(manifest.handoff?.relatedArtifactIds).toEqual([document.id]);
    expect(manifest.handoff?.routeDecisionArtifactIds).toEqual([receipt.id]);
    expect(manifest.artifacts?.map((entry) => entry.role)).toEqual(['handoff', 'source', 'related', 'route-decision']);
    const fileOf = (role: string) => String(manifest.artifacts?.find((entry) => entry.role === role)?.file);
    expect(entries.get(fileOf('handoff'))?.toString('utf-8')).toContain('# Blind Model Comparison Reviewer Handoff');
    expect(entries.get(fileOf('source'))?.toString('utf-8')).toContain('"schema": "goodvibes.agent.model_compare_judgment.v1"');
    expect(entries.get(fileOf('related'))?.toString('utf-8')).toContain('# Launch Plan');
    expect(entries.get(fileOf('route-decision'))?.toString('utf-8')).toContain('"schema": "goodvibes.agent.model_compare.route_decision.v1"');

    const archiveList = await reviewer.tool.execute({ mode: 'handoffArchive' });
    expect(archiveList.success).toBe(true);
    expect(archiveList.output).toContain('Saved blind comparison reviewer handoffs');
    expect(archiveList.output).toContain(handoffId);
  });

  test('diffs two reviewer handoffs built on different versions of the related document', async () => {
    const scene = await seededComparison();
    const { reviewer } = scene;
    const revealed = await revealedJudgment(scene);
    const first = await launchPlan(scene);
    const second = await saveDocument(scene, 'launch-plan-v2.md', [
      '# Launch Plan', '', 'Ship the reviewer handoff diff workflow.', '', '## Review Comments', '',
      '- c1 [resolved] Clarify the launch owner.',
      '- c2 [open] Confirm the reviewer packet before archive.',
    ]);
    const handoffFor = async (relatedId: string) => {
      const result = await reviewer.tool.execute({
        mode: 'handoff', artifactId: revealed.id, relatedArtifactIds: [relatedId], confirm: true, explicitUserRequest: 'Create a reviewer handoff.',
      });
      expect(result.success, result.error).toBe(true);
      return scene.artifacts.ids.at(-1)!;
    };
    const leftId = await handoffFor(first.id);
    const rightId = await handoffFor(second.id);

    const handoffDiff = await reviewer.tool.execute({ mode: 'handoffDiff', leftArtifactId: leftId, rightArtifactId: rightId });
    expect(handoffDiff.success, handoffDiff.error).toBe(true);
    expect(handoffDiff.output).toContain('Blind model comparison reviewer handoff visual diff');
    expect(handoffDiff.output).toContain(`left ${leftId}`);
    expect(handoffDiff.output).toContain(`right ${rightId}`);
    expect(handoffDiff.output).toContain('Metadata delta');
    expect(handoffDiff.output).toContain('related artifacts: changed');
    expect(handoffDiff.output).toContain('Section delta');
    expect(handoffDiff.output).toContain('Related Artifacts: changed');
    expect(handoffDiff.output).toContain('- Ship the reviewed document workflow.');
    expect(handoffDiff.output).toContain('+ Ship the reviewer handoff diff workflow.');
    expect(handoffDiff.output).toContain('+ - c2 [open] Confirm the reviewer packet before archive.');
    expect(handoffDiff.output).toContain('No selected model was changed.');

    const relatedHandoffDiff = await reviewer.tool.execute({
      mode: 'handoffDiff', leftArtifactId: leftId, rightArtifactId: rightId, sectionId: 'related',
    });
    expect(relatedHandoffDiff.success, relatedHandoffDiff.error).toBe(true);
    expect(relatedHandoffDiff.output).toContain('section jump Related Artifacts');
    expect(relatedHandoffDiff.output).toContain('available sections Metadata delta');
    expect(relatedHandoffDiff.output).toContain('- Ship the reviewed document workflow.');
    expect(relatedHandoffDiff.output).toContain('+ Ship the reviewer handoff diff workflow.');

    const handoffDiffList = await reviewer.tool.execute({ mode: 'handoffDiff' });
    expect(handoffDiffList.success).toBe(true);
    expect(handoffDiffList.output).toContain('Saved blind comparison reviewer handoffs');
    expect(handoffDiffList.output).toContain('leftArtifactId');
    expect(handoffDiffList.output).toContain(rightId);
  });

  test('can deliberately skip artifact persistence', async () => {
    const artifacts = artifactStore();
    const item = fixture({ artifactStore: artifacts.store });

    const result = await item.tool.execute({
      mode: 'run',
      prompt: 'Write a concise product update.',
      saveArtifact: false,
      confirm: true,
      explicitUserRequest: 'Compare product update drafts without saving.',
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('artifact not saved (saveArtifact false)');
    expect(artifacts.inputs).toEqual([]);
  });

  test('records leave-unchanged route-decision receipts without changing model routing', async () => {
    const artifacts = artifactStore();
    const runner = fixture({ artifactStore: artifacts.store });

    const run = await runner.tool.execute({
      mode: 'run',
      prompt: 'Compare route-decision wording.',
      modelRefs: ['openai:gpt-4.1', 'anthropic:claude-sonnet'],
      confirm: true,
      explicitUserRequest: 'Compare route-decision wording.',
    });
    expect(run.success, run.error).toBe(true);

    const reviewer = fixture({ artifactStore: artifacts.store });
    const judgment = await reviewer.tool.execute({
      mode: 'judge',
      artifactId: 'artifact-1',
      winnerBlindId: 'B',
      reasons: 'Candidate B was better, but keep the current model for now.',
      reveal: true,
      confirm: true,
      explicitUserRequest: 'Save the comparison winner.',
    });
    expect(judgment.success).toBe(true);

    const preview = await reviewer.rawTool.execute({
      mode: 'routeDecision',
      artifactId: 'artifact-2',
      decision: 'left-unchanged',
      confirm: false,
      explicitUserRequest: 'Leave the current model unchanged for this judgment.',
    });
    expect(preview.success).toBe(false);
    expect(preview.error).toContain('route-decision preview');
    expect(preview.error).toContain('decision left-unchanged');
    expect(artifacts.inputs).toHaveLength(2);
    expect(reviewer.appliedModelRoutes).toEqual([]);

    const receipt = await reviewer.tool.execute({
      mode: 'routeDecision',
      artifactId: 'artifact-2',
      decision: 'left-unchanged',
      confirm: true,
      explicitUserRequest: 'Leave the current model unchanged for this judgment.',
    });
    expect(receipt.success, receipt.error).toBe(true);
    expect(receipt.output).toContain('Recorded blind model comparison route decision left-unchanged');
    expect(receipt.output).toContain('route decision receipt artifact-3');
    expect(receipt.output).toContain('No selected model was changed.');
    expect(reviewer.appliedModelRoutes).toEqual([]);
    expect(artifacts.inputs).toHaveLength(3);
    expect(artifacts.inputs[2]?.metadata).toMatchObject({
      purpose: 'agent-model-compare-route-decision',
      decision: 'left-unchanged',
      judgmentArtifactId: 'artifact-2',
      winnerModel: 'anthropic:claude-sonnet',
      currentModel: 'openai:gpt-4.1',
      selectedModel: 'openai:gpt-4.1',
    });
  });

  test('is registered in the model tool registry', () => {
    const item = fixture();
    const registry = new ToolRegistry();

    registerAgentModelCompareTool(registry, {
      modelCatalog: {
        listModels: () => [],
      },
      providerRegistry: {
        getForModel: () => item.openai,
      },
    });

    expect(registry.has('agent_model_compare')).toBe(true);
  });
});
