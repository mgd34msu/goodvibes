import { admittedToolWorkspace, executeAdmitted } from '../helpers/admitted-tool.ts';
import { afterEach, describe, expect, setSystemTime, test } from 'bun:test';
import { join } from 'node:path';
import { ArtifactStore } from '@goodvibes-jev/engine/platform/platform/artifacts';
import { createShellPathService } from '@/runtime/index.ts';
import { AgentDocumentRegistry } from '../../agent/document-registry.ts';
import { createAgentDocumentsTool } from '../../tools/agent-documents-tool.ts';
import { makeProjectTempDir } from '../helpers/project-temp.ts';

function fixture() {
  const root = makeProjectTempDir('goodvibes-agent-documents-limits');
  const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
  const artifactStore = new ArtifactStore({ rootDir: join(root, 'artifacts') });
  const tool = admittedToolWorkspace(createAgentDocumentsTool(shellPaths, artifactStore), root);
  const documents = AgentDocumentRegistry.fromShellPaths(shellPaths);
  return { artifactStore, tool, documents };
}

describe('agent_documents artifact insertion', () => {
  test('a large text artifact is cut to a bounded block and the result says it was truncated', async () => {
    const { artifactStore, tool, documents } = fixture();
    await executeAdmitted(tool, { mode: 'create', title: 'Run Log', body: 'Notes.' });
    const artifact = await artifactStore.create({ kind: 'document', mimeType: 'text/plain', filename: 'big.log', text: 'x'.repeat(1_000_000), metadata: { purpose: 'log' } });
    const inserted = await executeAdmitted(tool, { mode: 'insertArtifact', documentId: 'run-log', artifactId: artifact.id });
    expect(inserted.success).toBe(true);
    expect(inserted.output).toContain('truncated');
    expect(inserted.output).not.toContain('bounded text content');
    const body = documents.get('run-log')!.body;
    expect(body.length).toBeLessThan(70_000);
    expect(body).toContain('Truncated: the first');
    expect(body).toContain(`agent_artifacts mode:"show" artifactId:"${artifact.id}"`);
  });

  test('a store that cannot read content reports a reference, not inserted text', async () => {
    const { artifactStore, documents } = fixture();
    const artifact = await artifactStore.create({ kind: 'document', mimeType: 'text/plain', filename: 'note.txt', text: 'Some note.', metadata: {} });
    const withoutRead = { get: (id: string) => artifactStore.get(id) };
    const root = makeProjectTempDir('goodvibes-agent-documents-noread');
    const shellPaths = createShellPathService({ workingDirectory: root, homeDirectory: root });
    const tool = admittedToolWorkspace(createAgentDocumentsTool(shellPaths, withoutRead), root);
    await executeAdmitted(tool, { mode: 'create', title: 'No Read', body: 'Body.' });
    const inserted = await executeAdmitted(tool, { mode: 'insertArtifact', documentId: 'no-read', artifactId: artifact.id });
    expect(inserted.success).toBe(true);
    expect(inserted.output).toContain('artifact reference only');
    expect(inserted.output).not.toContain('text content');
    expect(documents).toBeDefined();
  });
});

describe('agent_documents suggestions', () => {
  afterEach(() => setSystemTime());

  test('accepting a suggestion made before later edits is refused and the edits survive', async () => {
    const { tool, documents } = fixture();
    setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    await executeAdmitted(tool, { mode: 'create', title: 'Plan', body: 'Original text.' });
    const suggested = await executeAdmitted(tool, { mode: 'suggest', documentId: 'plan', body: 'Suggested replacement.' });
    expect(suggested.success).toBe(true);
    setSystemTime(new Date('2026-01-01T00:00:05.000Z'));
    await executeAdmitted(tool, { mode: 'update', documentId: 'plan', body: 'Owner edit made after the suggestion.' });
    const accepted = await executeAdmitted(tool, { mode: 'acceptSuggestion', documentId: 'plan', suggestionId: 's1' });
    expect(accepted.success).toBe(false);
    expect(accepted.error ?? '').toContain('would undo the changes made since');
    expect(documents.get('plan')!.body).toBe('Owner edit made after the suggestion.');
  });

  test('accepting an untouched document suggestion still applies it', async () => {
    const { tool, documents } = fixture();
    await executeAdmitted(tool, { mode: 'create', title: 'Plan', body: 'Original text.' });
    await executeAdmitted(tool, { mode: 'suggest', documentId: 'plan', body: 'Suggested replacement.' });
    const accepted = await executeAdmitted(tool, { mode: 'acceptSuggestion', documentId: 'plan', suggestionId: 's1' });
    expect(accepted.success).toBe(true);
    expect(documents.get('plan')!.body).toBe('Suggested replacement.');
  });
});
