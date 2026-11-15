import { describe, expect, test } from 'bun:test';
import type { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import { listGeneratedKnowledgePages } from '../platform/src/platform/knowledge/generated-pages.js';
import type { KnowledgeSourceRecord } from '../platform/src/platform/knowledge/types.js';

const source = { id: 'page-1', connectorId: 'synthetic', sourceType: 'document', title: 'Page', status: 'indexed', tags: [], artifactId: 'artifact-1', metadata: {}, createdAt: 1, updatedAt: 1 } as unknown as KnowledgeSourceRecord;
const artifact = { id: 'artifact-1', mimeType: 'text/markdown', filename: 'page.md', createdAt: 1, metadata: {} };

function list(artifactStore: Pick<ArtifactStore, 'get' | 'readContent'>, includeMarkdown: boolean) {
  return listGeneratedKnowledgePages({ artifactStore: artifactStore as ArtifactStore, spaceId: 'default', sources: [source], nodes: [], edges: [],
    limit: 10, includeMarkdown, isGeneratedSource: () => true });
}

describe('generated page list with markdown', () => {
  test('a markdown read that fails flags the page instead of returning it as if it had no markdown', async () => {
    const { pages } = await list({ get: () => artifact, readContent: async () => { throw new Error('disk offline'); } } as never, true);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.markdown).toBeUndefined();
    expect(pages[0]?.markdownError).toContain('disk offline');
  });

  test('a readable page carries its markdown and no error, and markdown not requested sets neither', async () => {
    const store = { get: () => artifact, readContent: async () => ({ buffer: Buffer.from('# Title') }) } as never;
    expect((await list(store, true)).pages[0]).toMatchObject({ markdown: '# Title' });
    expect((await list(store, true)).pages[0]?.markdownError).toBeUndefined();
    const plain = (await list(store, false)).pages[0];
    expect(plain?.markdown).toBeUndefined();
    expect(plain?.markdownError).toBeUndefined();
  });
});
