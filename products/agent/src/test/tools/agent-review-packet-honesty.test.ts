import { executeAdmitted } from '../helpers/admitted-tool.ts';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { fakePort, noulAnswer } from '@goodvibes-jev/judgment/testing';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import type { ArtifactCreateInput, ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import type { ChannelDeliveryRequest } from '@goodvibes-jev/engine/platform/platform/channels';
import { createAgentReviewPacketPresetsTool } from '../../tools/agent-review-packet-presets-tool.ts';
import { createAgentReviewPacketShareTool } from '../../tools/agent-review-packet-share-tool.ts';
import { resetSessionUntrustedContentLedgerForTests } from '../../trust/untrusted-content.ts';

function artifactStore() {
  const inputs: ArtifactCreateInput[] = [];
  const records: ArtifactRecord[] = [];
  const contents = new Map<string, Buffer>();
  const addArtifact = (input: {
    readonly id: string;
    readonly createdAt: number;
    readonly purpose: string;
    readonly filename?: string;
    readonly metadata?: Record<string, unknown>;
  }): ArtifactRecord => {
    const buffer = Buffer.from(`${input.id}\n`, 'utf-8');
    const record: ArtifactRecord = {
      id: input.id,
      kind: 'data',
      mimeType: 'application/json',
      filename: input.filename ?? `${input.id}.json`,
      sizeBytes: buffer.byteLength,
      sha256: `sha-${input.id}`,
      createdAt: input.createdAt,
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: { purpose: input.purpose, ...(input.metadata ?? {}) },
      contentPath: `/tmp/${input.id}.json`,
      metadataPath: `/tmp/${input.id}.metadata.json`,
    };
    records.push(record);
    contents.set(input.id, buffer);
    return record;
  };
  const store: Pick<ArtifactStore, 'create' | 'list' | 'readContent'> = {
    async create(input: ArtifactCreateInput): Promise<ArtifactDescriptor> {
      inputs.push(input);
      const id = `artifact-${inputs.length}`;
      const buffer = Buffer.from(input.text ?? '', 'utf-8');
      const record: ArtifactRecord = {
        id,
        kind: input.kind ?? 'data',
        mimeType: input.mimeType ?? 'application/json',
        filename: input.filename,
        sizeBytes: buffer.byteLength,
        sha256: `sha-${inputs.length}`,
        createdAt: Date.now() + inputs.length,
        acquisitionMode: 'inline-data',
        fetchMode: 'not-applicable',
        metadata: input.metadata ?? {},
        contentPath: `/tmp/${id}.json`,
        metadataPath: `/tmp/${id}.metadata.json`,
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
  return { addArtifact, inputs, records, store };
}


function fakeRouter(requests: ChannelDeliveryRequest[]) {
  const strategies = [{ id: 'fake-channel', canHandle: () => true, deliver: async () => ({}) }];
  return {
    listStrategies: () => strategies,
    deliver: async (request: ChannelDeliveryRequest) => {
      requests.push(request);
      return 'review-packet-share-1';
    },
  };
}

function archiveRecord(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: 'artifact-archive',
    kind: 'archive',
    mimeType: 'application/zip',
    filename: 'blind-model-comparison-handoff-archive.zip',
    sizeBytes: 2048,
    sha256: 'sha-archive',
    createdAt: Date.now(),
    acquisitionMode: 'inline-data',
    fetchMode: 'not-applicable',
    metadata: {
      purpose: 'agent-model-compare-handoff-archive',
      archiveId: 'hndarc_launch',
      handoffArtifactId: 'artifact-handoff',
      handoffId: 'hnd_launch',
      sourceArtifactId: 'artifact-judgment',
      sourceKind: 'judgment',
      relatedArtifactIds: ['artifact-doc', 'artifact-source'],
      routeDecisionArtifactIds: ['artifact-route'],
      includedArtifactIds: ['artifact-handoff', 'artifact-judgment', 'artifact-doc', 'artifact-source', 'artifact-route'],
      comparisonId: 'cmp_launch',
      artifactCount: 5,
      archiveBytes: 4096,
      revealIncludedInHandoff: true,
    },
    contentPath: '/tmp/archive.zip',
    metadataPath: '/tmp/archive.json',
    ...overrides,
  };
}

function shareStore(records: ArtifactRecord[] = [archiveRecord()]) {
  const store: Pick<ArtifactStore, 'get' | 'list' | 'readContent'> = {
    get(id: string): ArtifactDescriptor | null {
      return records.find((record) => record.id === id) ?? null;
    },
    list(limit = 100): ArtifactDescriptor[] {
      return records.slice(0, limit);
    },
    async readContent(id: string): Promise<{ record: ArtifactRecord; buffer: Buffer }> {
      const record = records.find((entry) => entry.id === id);
      if (!record) throw new Error(`Unknown artifact: ${id}`);
      return { record, buffer: Buffer.from('zip-bytes-never-printed') };
    },
  };
  return store;
}



const comparison = (id: string, createdAt: number, comparisonId: string, extra: { purpose?: string; filename?: string } = {}) => ({
  id, createdAt, purpose: extra.purpose ?? 'agent-model-compare', ...(extra.filename ? { filename: extra.filename } : {}), metadata: { comparisonId, documentId: 'doc1' } });

describe('review packet presets', () => {
  test('more related ids than the cap is refused by name, not cut silently', async () => {
    const artifacts = artifactStore();
    const tool = createAgentReviewPacketPresetsTool(artifacts.store);
    const ids = Array.from({ length: 31 }, (_, index) => `artifact-${index}`);
    const result = await executeAdmitted(tool, { mode: 'save', documentId: 'doc1', relatedArtifactIds: ids, explicitUserRequest: 'Save it.' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('at most 30'); expect(result.error).toContain('31');
    expect(artifacts.inputs).toHaveLength(0);
  });

  test('saving an id that is not in the store says so in the result', async () => {
    const artifacts = artifactStore();
    artifacts.addArtifact(comparison('artifact-real', 1, 'cmp_1'));
    const tool = createAgentReviewPacketPresetsTool(artifacts.store);
    const result = await executeAdmitted(tool, { mode: 'save', documentId: 'doc1', comparisonArtifactId: 'typo-id', documentExportArtifactId: 'artifact-real', explicitUserRequest: 'Save it.' });
    expect(result.success, result.error).toBe(true);
    expect(result.output).toContain('missing comparison typo-id');
    expect(result.output).toContain('freshness needs-review');
  });

  test('a comparison saved before purposes were recorded still supersedes an older one', async () => {
    const artifacts = artifactStore();
    artifacts.addArtifact(comparison('cmp-old', 1, 'cmp_1'));
    artifacts.addArtifact(comparison('cmp-legacy', 10, 'cmp_2', { purpose: '', filename: 'blind-model-comparison-cmp_2.json' }));
    const tool = createAgentReviewPacketPresetsTool(artifacts.store);
    const saved = await executeAdmitted(tool, { mode: 'save', documentId: 'doc1', comparisonArtifactId: 'cmp-old', explicitUserRequest: 'Save it.' });
    const presetId = /artifact (artifact-\d+)/.exec(saved.output ?? '')?.[1];
    const shown = await tool.execute({ mode: 'show', artifactId: presetId });
    expect(shown.output).toContain('newer comparison cmp-old -> cmp-legacy');
  });

  test('a refresh does not call a packet repaired while its judgment still describes the old comparison', async () => {
    const artifacts = artifactStore();
    artifacts.addArtifact(comparison('cmp-old', 1, 'cmp_1'));
    artifacts.addArtifact({ id: 'judge-1', createdAt: 2, purpose: 'agent-model-compare-judgment', metadata: { comparisonId: 'cmp_1', documentId: 'doc1' } });
    artifacts.addArtifact(comparison('cmp-new', 10, 'cmp_2'));
    const tool = createAgentReviewPacketPresetsTool(artifacts.store);
    const saved = await executeAdmitted(tool, { mode: 'save', documentId: 'doc1', comparisonArtifactId: 'cmp-old', judgmentArtifactId: 'judge-1', explicitUserRequest: 'Save it.' });
    const presetId = /artifact (artifact-\d+)/.exec(saved.output ?? '')?.[1];
    const refreshed = await executeAdmitted(tool, { mode: 'refresh', artifactId: presetId, explicitUserRequest: 'Refresh it.' });
    expect(refreshed.success, refreshed.error).toBe(true);
    expect(refreshed.output).toContain('repaired 1; unresolved 1');
    // The refreshed packet pairs the new comparison with the old judgment, and a later audit still says so.
    const refreshedId = /artifact (artifact-\d+)/.exec(refreshed.output ?? '')?.[1];
    const shown = await tool.execute({ mode: 'show', artifactId: refreshedId });
    expect(shown.output).toContain('unresolved judgment judge-1');
    expect(shown.output).toContain('describes comparison cmp_1');
  });
});

describe('review packet share target', () => {
  let previousPort: ReturnType<typeof installJudgmentPort>;
  let readings: ReturnType<typeof fakePort>;
  beforeEach(() => { resetSessionUntrustedContentLedgerForTests(); readings = fakePort(() => noulAnswer(0.03)); previousPort = installJudgmentPort(readings.port); });
  afterEach(() => { installJudgmentPort(previousPort); resetSessionUntrustedContentLedgerForTests(); });

  test('no target and two targets are refused before the outward-effect reading and before any delivery', async () => {
    const requests: ChannelDeliveryRequest[] = [];
    const tool = createAgentReviewPacketShareTool(shareStore(), fakeRouter(requests));
    const none = await executeAdmitted(tool, { archiveArtifactId: 'artifact-archive' });
    expect(none.success).toBe(false); expect(none.error).toContain('exactly one of channel, route, webhook or link is required');
    const two = await executeAdmitted(tool, { archiveArtifactId: 'artifact-archive', channel: 'slack:review:Review', link: 'https://example.test/x' });
    expect(two.success).toBe(false); expect(two.error).toContain('exactly one delivery target');
    expect(readings.requests).toHaveLength(0); expect(requests).toEqual([]);
  });

  test('a delivery that fails once it has started reports an unknown outcome instead of a plain failure', async () => {
    const strategies = [{ id: 'fake', canHandle: () => true, deliver: async () => ({}) }];
    const router = { listStrategies: () => strategies,
      deliver: async (): Promise<string> => { throw new Error('connection reset'); } };
    const tool = createAgentReviewPacketShareTool(shareStore(), router);
    const result = await executeAdmitted(tool, { archiveArtifactId: 'artifact-archive', channel: 'slack:review:Review' });
    expect(result.success).toBe(false);
    expect(result.error).toContain('outcome unknown'); expect(result.error).toContain('connection reset'); expect(result.error).toContain('check the destination');
  });
});
