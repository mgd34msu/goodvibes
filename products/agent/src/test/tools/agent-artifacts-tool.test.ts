import { admittedToolWorkspace, executeAdmitted } from '../helpers/admitted-tool.ts';
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { installJudgmentPort } from '@goodvibes-jev/engine/errors';
import { fakePort } from '@goodvibes-jev/judgment/testing';
import { authoredPrivacyAnswer, errorText } from '../helpers/authored-diagnostic-readings.ts';
import type { ArtifactDescriptor, ArtifactRecord, ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { ToolRegistry } from '@goodvibes-jev/engine/platform/platform/tools';
import { createAgentArtifactsTool, registerAgentArtifactsTool } from '../../tools/agent-artifacts-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

class ArtifactBrowserTestStore implements Partial<Pick<ArtifactStore, 'get' | 'list' | 'readContent'>> {
  readonly records: ArtifactRecord[] = [];
  readonly contents = new Map<string, Buffer>();

  add(input: {
    readonly id: string;
    readonly kind?: ArtifactDescriptor['kind'];
    readonly mimeType?: string;
    readonly filename?: string;
    readonly text?: string;
    readonly buffer?: Buffer;
    readonly createdAt?: number;
    readonly metadata?: Record<string, unknown>;
    readonly sourceUri?: string;
  }): ArtifactRecord {
    const buffer = input.buffer ?? Buffer.from(input.text ?? '', 'utf-8');
    const record: ArtifactRecord = {
      id: input.id,
      kind: input.kind ?? 'data',
      mimeType: input.mimeType ?? 'text/plain',
      ...(input.filename ? { filename: input.filename } : {}),
      sizeBytes: buffer.byteLength,
      createdAt: input.createdAt ?? Date.now(),
      ...(input.sourceUri ? { sourceUri: input.sourceUri } : {}),
      acquisitionMode: 'inline-data',
      fetchMode: 'not-applicable',
      metadata: input.metadata ?? {},
      contentPath: `/tmp/${input.id}.data`,
      metadataPath: `/tmp/${input.id}.json`,
    };
    this.records.push(record);
    this.contents.set(record.id, buffer);
    return record;
  }

  list(limit = 100): ArtifactDescriptor[] {
    return [...this.records]
      .sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  get(id: string): ArtifactDescriptor | null {
    return this.records.find((record) => record.id === id) ?? null;
  }

  async readContent(id: string): Promise<{ record: ArtifactRecord; buffer: Buffer }> {
    const record = this.records.find((entry) => entry.id === id);
    const buffer = this.contents.get(id);
    if (!record || !buffer) throw new Error(`Unknown artifact: ${id}`);
    return { record, buffer };
  }
}

test('a list filter finds an artifact older than the newest hundred', async () => {
  const root = makeProjectTempDir('goodvibes-agent-artifact-list-window');
  try {
    const store = new ArtifactBrowserTestStore();
    store.add({ id: 'artifact-oldest', createdAt: 1, metadata: { purpose: 'quarterly-report' } });
    for (let index = 0; index < 150; index++) store.add({ id: `artifact-${index}`, createdAt: 1000 + index, metadata: { purpose: 'scratch' } });
    const tool = admittedToolWorkspace(createAgentArtifactsTool(store, { projectRoot: root }), root);

    const listed = await executeAdmitted(tool, { mode: 'list', purpose: 'quarterly-report' });

    expect(listed.success).toBe(true);
    expect(listed.output).toContain('artifact-oldest');
    expect(listed.output).toContain('returned 1/1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('list and show tell the model that artifact names and metadata are untrusted', async () => {
  const root = makeProjectTempDir('goodvibes-agent-artifact-untrusted-notice');
  try {
    const store = new ArtifactBrowserTestStore();
    store.add({ id: 'artifact-fetched', createdAt: 1, metadata: { purpose: 'fetched-page' } });
    const tool = admittedToolWorkspace(createAgentArtifactsTool(store, { projectRoot: root }), root);

    const listed = await executeAdmitted(tool, { mode: 'list' });
    const shown = await executeAdmitted(tool, { mode: 'show', artifactId: 'artifact-fetched' });

    for (const result of [listed, shown]) {
      expect(result.success).toBe(true);
      expect(result.output?.startsWith('Untrusted artifact content follows')).toBe(true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('artifact metadata withholds unknown roles and checks declared text without transmitting recovery material', async () => {
  const material = 'synthetic violet lantern recovery material';
  const description = 'An ordinary sample artifact.';
  const store = new ArtifactBrowserTestStore();
  store.add({ id: 'metadata-role-fixture', metadata: { accountRecoveryPhrase: material, purpose: material, description } });
  const privacy = authoredPrivacyAnswer({ parts: [[errorText(description)]] });
  const readings = fakePort((name, question, state) => {
    const answer = privacy(name, question, state);
    if (answer !== undefined) return answer;
    throw new Error(`Unexpected metadata fixture reading: ${name}`);
  });
  const previous = installJudgmentPort(readings.port);
  try {
    for (const mode of ['show', 'list']) {
      const result = await createAgentArtifactsTool(store).execute({ mode, artifactId: 'metadata-role-fixture' });
      expect(result.success).toBe(true);
      expect(result.output).not.toContain(material);
      if (mode === 'show') {
        expect(result.output).toContain('[REDACTED]');
        expect(result.output).toContain(description);
      }
    }
    expect(readings.requests.length).toBeGreaterThan(0);
    expect(readings.requests.some(request => request.context?.battery === 'engine.redaction.field-kind')).toBe(false);
    expect(JSON.stringify(readings.requests)).not.toContain(material);
  } finally { installJudgmentPort(previous); }
});

for (const mode of ['show', 'list']) for (const invalidation of ['abort'])
  test(`artifact ${mode} refuses metadata invalidated by ${invalidation} during screening`, async () => {
    const description = 'A retained sample description.';
    const store = new ArtifactBrowserTestStore();
    const record = store.add({ id: 'retained-metadata-fixture', metadata: { description } });
    const controller = new AbortController();
    let release!: () => void;
    let entered!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const arrival = new Promise<void>(resolve => { entered = resolve; });
    const privacy = authoredPrivacyAnswer({ parts: [[errorText(description)]] });
    const readings = fakePort(async (name, question, state) => {
      entered(); await held;
      const answer = privacy(name, question, state);
      if (answer === undefined) throw new Error(`Unexpected retained metadata reading: ${name}`);
      return answer;
    });
    const previous = installJudgmentPort(readings.port);
    try {
      const pending = createAgentArtifactsTool(store).execute({ mode, artifactId: record.id }, { signal: controller.signal });
      await arrival;
      if (invalidation === 'source') record.metadata.description = 'Changed after screening started.';
      else controller.abort();
      release();
      const result = await pending;
      expect(result.success).toBe(false);
      expect(result.output).toBeUndefined();
    } finally { release(); installJudgmentPort(previous); }
  });

function readdirSyncOrEmpty(dir: string): string[] {
  return existsSync(dir) ? readdirSync(dir) : [];
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

describe('agent_artifacts tool', () => {
  test('lists saved artifacts with filters and redacted metadata search', async () => {
    const store = new ArtifactBrowserTestStore();
    store.add({
      id: 'artifact-alpha',
      filename: 'blind-model-comparison-cmp-1.json',
      mimeType: 'application/json',
      text: '{"ok":true}',
      createdAt: 2,
      metadata: {
        purpose: 'agent-model-compare',
        source: 'agent-model-compare',
        secretToken: 'should-not-print',
      },
    });
    store.add({
      id: 'artifact-beta',
      filename: 'generated.png',
      kind: 'image',
      mimeType: 'image/png',
      buffer: Buffer.from([1, 2, 3]),
      createdAt: 1,
      metadata: { purpose: 'agent-media-generation', source: 'agent-media-generation' },
    });
    const tool = createAgentArtifactsTool(store);

    const result = await tool.execute({
      mode: 'list',
      purpose: 'model-compare',
      limit: 5,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Agent artifact browser');
    expect(result.output).toContain('artifact-alpha');
    expect(result.output).not.toContain('artifact-beta');
    expect(result.output).toContain('agent_artifacts mode:"show" artifactId:"artifact-alpha"');
    expect(result.output).not.toContain('should-not-print');
  });

  test('shows one text artifact with bounded preview and redacted metadata', async () => {
    const store = new ArtifactBrowserTestStore();
    store.add({
      id: 'artifact-text',
      filename: 'report.md',
      mimeType: 'text/markdown',
      text: 'First line\nSecond line\nThird line',
      metadata: {
        purpose: 'agent-model-compare-export',
        apiKey: 'secret-value',
      },
    });
    const tool = createAgentArtifactsTool(store);

    const result = await tool.execute({
      mode: 'show',
      artifactId: 'artifact-text',
      includeContent: true,
      previewBytes: 12,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Agent artifact');
    expect(result.output).toContain('report.md');
    expect(result.output).toContain('"apiKey": "[REDACTED]"');
    expect(result.output).toContain('First line');
    expect(result.output).toContain('more)');
    expect(result.output).not.toContain('secret-value');
    expect(result.output).not.toContain('Second line');
  });

  test('does not inline binary artifact content', async () => {
    const store = new ArtifactBrowserTestStore();
    store.add({
      id: 'artifact-image',
      kind: 'image',
      mimeType: 'image/png',
      filename: 'generated.png',
      buffer: Buffer.from([137, 80, 78, 71]),
    });
    const tool = createAgentArtifactsTool(store);

    const result = await tool.execute({
      mode: 'show',
      artifactId: 'artifact-image',
      includeContent: true,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('Content preview omitted for non-text MIME type image/png.');
    expect(result.output).not.toContain('iVBOR');
  });

  test('exports exact artifact bytes to a validated workspace path', async () => {
    const root = makeProjectTempDir('goodvibes-agent-artifact-export');
    try {
      const store = new ArtifactBrowserTestStore();
      const bytes = Buffer.from([0, 1, 2, 3, 255]);
      store.add({
        id: 'artifact-image',
        kind: 'image',
        mimeType: 'image/png',
        filename: 'generated.png',
        buffer: bytes,
      });
      const tool = admittedToolWorkspace(createAgentArtifactsTool(store, { projectRoot: root }), root);

      const exported = await executeAdmitted(tool, {
        mode: 'export',
        artifactId: 'artifact-image',
        destinationPath: 'exports/generated.png',
        confirm: true,
        explicitUserRequest: 'Export the generated image artifact.',
      });

      expect(exported.success).toBe(true);
      expect(exported.output).toContain('Exported Agent artifact');
      expect(exported.output).toContain('artifact artifact-image');
      expect(exported.output).toContain('content not printed');
      expect(readFileSync(join(root, 'exports', 'generated.png'))).toEqual(bytes);

      const existing = await executeAdmitted(tool, {
        mode: 'export',
        artifactId: 'artifact-image',
        destinationPath: 'exports/generated.png',
        confirm: true,
        explicitUserRequest: 'Export the generated image artifact again.',
      });
      expect(existing.success).toBe(false);
      expect(existing.error).toContain('already exists');

      const overwritten = await executeAdmitted(tool, {
        mode: 'export',
        artifactId: 'artifact-image',
        destinationPath: 'exports/generated.png',
        overwrite: true,
        confirm: true,
        explicitUserRequest: 'Replace the generated image export.',
      });
      expect(overwritten.success).toBe(true);
      expect(overwritten.output).toContain('overwrite yes');
      expect(readFileSync(join(root, 'exports', 'generated.png'))).toEqual(bytes);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires confirmation and rejects artifact export outside the workspace', async () => {
    const root = makeProjectTempDir('goodvibes-agent-artifact-export');
    try {
      const store = new ArtifactBrowserTestStore();
      store.add({ id: 'artifact-text', text: 'body' });
      const tool = admittedToolWorkspace(createAgentArtifactsTool(store, { projectRoot: root }), root);

      const unconfirmed = await tool.execute({
        mode: 'export',
        artifactId: 'artifact-text',
        destinationPath: 'exports/body.txt',
        explicitUserRequest: 'Export the text artifact.',
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('recorded effect admission');

      const escaped = await executeAdmitted(tool, {
        mode: 'export',
        artifactId: 'artifact-text',
        destinationPath: '../escaped.txt',
        confirm: true,
        explicitUserRequest: 'Export the text artifact.',
      });
      expect(escaped.success).toBe(false);
      expect(escaped.error).toContain('outside the project root');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exports multiple artifacts as a validated package directory with redacted manifest', async () => {
    const root = makeProjectTempDir('goodvibes-agent-artifact-package');
    try {
      const store = new ArtifactBrowserTestStore();
      const imageBytes = Buffer.from([137, 80, 78, 71]);
      store.add({
        id: 'artifact-report',
        mimeType: 'text/markdown',
        filename: '../report.md',
        text: '# Report\n\nBody',
        sourceUri: 'https://fixture-user:fixture-password@example.test/report?token=secret-token&recovery=unknown-query-secret&ok=1',
        metadata: { purpose: 'research', apiKey: 'secret-value', accountRecoveryPhrase: 'synthetic recovery phrase', nested: { password: 'nested-secret' } },
      });
      store.add({
        id: 'artifact-image',
        kind: 'image',
        mimeType: 'image/png',
        filename: 'generated.png',
        buffer: imageBytes,
        metadata: { purpose: 'media' },
      });
      const tool = admittedToolWorkspace(createAgentArtifactsTool(store, { projectRoot: root }), root);

      const exported = await executeAdmitted(tool, {
        mode: 'package',
        artifactIds: ['artifact-report', 'artifact-image'],
        destinationPath: 'exports/research-package',
        confirm: true,
        explicitUserRequest: 'Export the reviewed research artifacts as a package.',
      });

      expect(exported.success).toBe(true);
      expect(exported.output).toContain('Exported Agent artifact package');
      expect(exported.output).toContain('artifacts 2');
      const packageRoot = join(root, 'exports', 'research-package');
      expect(existsSync(join(packageRoot, 'README.md'))).toBe(true);
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'manifest.json'), 'utf-8')) as {
        readonly artifacts: Array<{ readonly id: string; readonly file: string; readonly metadata: Record<string, unknown>; readonly sourceUri: string }>;
      };
      expect(manifest.artifacts.map((entry) => entry.id)).toEqual(['artifact-report', 'artifact-image']);
      expect(manifest.artifacts[0]?.metadata.apiKey).toBe('[REDACTED]');
      expect(manifest.artifacts[0]?.metadata.accountRecoveryPhrase).toBe('[REDACTED]');
      expect((manifest.artifacts[0]?.metadata.nested as Record<string, unknown>).password).toBe('[REDACTED]');
      expect(manifest.artifacts[0]?.sourceUri).toContain('token=%5BREDACTED%5D');
      expect(JSON.stringify(manifest)).not.toContain('fixture-password');
      expect(JSON.stringify(manifest)).not.toContain('unknown-query-secret');
      expect(JSON.stringify(manifest)).not.toContain('synthetic recovery phrase');
      const reportFile = manifest.artifacts.find((entry) => entry.id === 'artifact-report')?.file;
      const imageFile = manifest.artifacts.find((entry) => entry.id === 'artifact-image')?.file;
      expect(reportFile).toBeTruthy();
      expect(imageFile).toBeTruthy();
      expect(readFileSync(join(packageRoot, reportFile ?? ''), 'utf-8')).toContain('# Report');
      expect(readFileSync(join(packageRoot, imageFile ?? ''))).toEqual(imageBytes);
      expect(exported.output).not.toContain('secret-value');
      expect(exported.output).not.toContain('# Report');

      const existing = await executeAdmitted(tool, {
        mode: 'package',
        artifactIds: 'artifact-report, artifact-image',
        destinationPath: 'exports/research-package',
        confirm: true,
        explicitUserRequest: 'Export the package again.',
      });
      expect(existing.success).toBe(false);
      expect(existing.error).toContain('already exists');

      const overwritten = await executeAdmitted(tool, {
        mode: 'package',
        artifactIds: 'artifact-report, artifact-image',
        destinationPath: 'exports/research-package',
        overwrite: true,
        confirm: true,
        explicitUserRequest: 'Replace the reviewed research artifact package.',
      });
      expect(overwritten.success).toBe(true);
      expect(overwritten.output).toContain('overwrite yes');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a reused package directory names the files the new manifest does not describe', async () => {
    const root = makeProjectTempDir('goodvibes-agent-artifact-package-leftover');
    try {
      const store = new ArtifactBrowserTestStore();
      store.add({ id: 'artifact-one', filename: 'one.txt', text: 'one' });
      store.add({ id: 'artifact-two', filename: 'two.txt', text: 'two' });
      const tool = admittedToolWorkspace(createAgentArtifactsTool(store, { projectRoot: root }), root);
      const base = { mode: 'package', destinationPath: 'exports/pkg', confirm: true, explicitUserRequest: 'Export the package.' };

      const first = await executeAdmitted(tool, { ...base, artifactIds: ['artifact-one'] });
      expect(first.success).toBe(true);
      expect(first.output).not.toContain('from an earlier package');
      const second = await executeAdmitted(tool, { ...base, artifactIds: ['artifact-two'], overwrite: true });
      expect(second.success).toBe(true);
      expect(second.output).toContain('from an earlier package');
      expect(second.output).toContain('one.txt');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a package that fails part way removes what it created and keeps the caller\'s own', async () => {
    const root = makeProjectTempDir('goodvibes-agent-artifact-package-partial');
    try {
      const store = new ArtifactBrowserTestStore();
      store.add({ id: 'artifact-one', filename: 'one.txt', text: 'one' });
      const tool = admittedToolWorkspace(createAgentArtifactsTool(store, { projectRoot: root }), root);
      const destination = join(root, 'exports', 'pkg');
      mkdirSync(join(destination, 'manifest.json'), { recursive: true });
      writeFileSync(join(destination, 'manifest.json', 'keep.txt'), 'the caller\'s own file');

      // artifacts/one.txt is written first; the manifest write then fails because a directory sits there.
      const failed = await executeAdmitted(tool, {
        mode: 'package', artifactIds: ['artifact-one'], destinationPath: 'exports/pkg', overwrite: true,
        confirm: true, explicitUserRequest: 'Export the package.',
      });
      expect(failed.success).toBe(false);
      expect(readdirSync(destination)).toEqual(['manifest.json']);
      expect(readFileSync(join(destination, 'manifest.json', 'keep.txt'), 'utf-8')).toBe('the caller\'s own file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('a package into a new directory that goes stale after the first file leaves no directory behind', async () => {
    const root = makeProjectTempDir('goodvibes-agent-artifact-package-fresh');
    try {
      const store = new ArtifactBrowserTestStore();
      const record = store.add({ id: 'artifact-one', filename: 'one.txt', text: 'one' });
      const destination = join(root, 'exports', 'pkg');
      const artifactDir = join(destination, 'artifacts');
      // The source changes once its first copy exists, so the next currency check refuses.
      store.get = (id: string) => (id !== record.id ? null : readdirSyncOrEmpty(artifactDir).length > 0 ? { ...record, metadata: { changed: true } } : record);
      const tool = admittedToolWorkspace(createAgentArtifactsTool(store, { projectRoot: root }), root);

      // A stale source is thrown to the tool runtime, which words it; either way nothing succeeded.
      const failed = await executeAdmitted(tool, {
        mode: 'package', artifactIds: ['artifact-one'], destinationPath: 'exports/pkg',
        confirm: true, explicitUserRequest: 'Export the package.',
      }).catch((error: unknown) => ({ success: false, error: String(error) }));
      expect(failed.success).toBe(false);
      expect(existsSync(destination)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('exports multiple artifacts as a validated ZIP archive with exact bytes and redacted manifest', async () => {
    const root = makeProjectTempDir('goodvibes-agent-artifact-archive');
    try {
      const store = new ArtifactBrowserTestStore();
      const imageBytes = Buffer.from([137, 80, 78, 71]);
      store.add({
        id: 'artifact-report',
        mimeType: 'text/markdown',
        filename: 'report.md',
        text: '# Report\n\nBody',
        sourceUri: 'https://example.test/report?token=secret-token&ok=1',
        metadata: { purpose: 'research', apiKey: 'secret-value' },
      });
      store.add({
        id: 'artifact-image',
        kind: 'image',
        mimeType: 'image/png',
        filename: 'generated.png',
        buffer: imageBytes,
      });
      const tool = admittedToolWorkspace(createAgentArtifactsTool(store, { projectRoot: root }), root);

      const exported = await executeAdmitted(tool, {
        mode: 'archive',
        artifactIds: ['artifact-report', 'artifact-image'],
        destinationPath: 'exports/research-package.zip',
        confirm: true,
        explicitUserRequest: 'Export the reviewed research artifacts as a ZIP archive.',
      });

      expect(exported.success).toBe(true);
      expect(exported.output).toContain('Exported Agent artifact archive');
      expect(exported.output).toContain('archive zip');
      expect(exported.output).toContain('artifacts 2');
      expect(exported.output).not.toContain('secret-value');
      expect(exported.output).not.toContain('# Report');
      const archive = readFileSync(join(root, 'exports', 'research-package.zip'));
      expect(archive.readUInt32LE(0)).toBe(0x04034b50);
      const entries = unzipLocalEntries(archive);
      const manifest = JSON.parse(entries.get('manifest.json')?.toString('utf-8') ?? '{}') as {
        readonly artifacts: Array<{ readonly id: string; readonly file: string; readonly metadata: Record<string, unknown>; readonly sourceUri: string }>;
      };
      expect(manifest.artifacts.map((entry) => entry.id)).toEqual(['artifact-report', 'artifact-image']);
      expect(manifest.artifacts[0]?.metadata.apiKey).toBe('[REDACTED]');
      expect(manifest.artifacts[0]?.sourceUri).toContain('token=%5BREDACTED%5D');
      const reportFile = manifest.artifacts.find((entry) => entry.id === 'artifact-report')?.file;
      const imageFile = manifest.artifacts.find((entry) => entry.id === 'artifact-image')?.file;
      expect(entries.get(reportFile ?? '')?.toString('utf-8')).toContain('# Report');
      expect(entries.get(imageFile ?? '')).toEqual(imageBytes);
      expect(entries.get('README.md')?.toString('utf-8')).toContain('GoodVibes Agent Artifact Package');

      const existing = await executeAdmitted(tool, {
        mode: 'archive',
        artifactIds: ['artifact-report', 'artifact-image'],
        destinationPath: 'exports/research-package.zip',
        confirm: true,
        explicitUserRequest: 'Export the archive again.',
      });
      expect(existing.success).toBe(false);
      expect(existing.error).toContain('already exists');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('requires confirmation and rejects package export outside the workspace', async () => {
    const root = makeProjectTempDir('goodvibes-agent-artifact-package');
    try {
      const store = new ArtifactBrowserTestStore();
      store.add({ id: 'artifact-text', text: 'body' });
      const tool = admittedToolWorkspace(createAgentArtifactsTool(store, { projectRoot: root }), root);

      const unconfirmed = await tool.execute({
        mode: 'package',
        artifactIds: ['artifact-text'],
        destinationPath: 'exports/package',
        explicitUserRequest: 'Export the package.',
      });
      expect(unconfirmed.success).toBe(false);
      expect(unconfirmed.error).toContain('recorded effect admission');

      const escaped = await executeAdmitted(tool, {
        mode: 'package',
        artifactIds: ['artifact-text'],
        destinationPath: '../escaped-package',
        confirm: true,
        explicitUserRequest: 'Export the package.',
      });
      expect(escaped.success).toBe(false);
      expect(escaped.error).toContain('outside the project root');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('fails clearly without an artifact store and registers with the tool registry', async () => {
    const unavailable = await createAgentArtifactsTool().execute({ mode: 'list' });
    expect(unavailable.success).toBe(false);
    expect(unavailable.error).toContain('artifact store');

    const registry = new ToolRegistry();
    registerAgentArtifactsTool(registry, new ArtifactBrowserTestStore());
    expect(registry.has('agent_artifacts')).toBe(true);
  });
});
