import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ArtifactStore } from '../platform/src/platform/artifacts/index.js';
import { HOME_GRAPH_KNOWLEDGE_EXTENSION } from '../platform/src/platform/knowledge/home-graph/extension.js';
import { HomeGraphService } from '../platform/src/platform/knowledge/home-graph/service.js';
import { KnowledgeSemanticService } from '../platform/src/platform/knowledge/semantic/index.js';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.js';

const roots: string[] = [], stores: KnowledgeStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map(store => store.close()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('Home Graph knowledge extension', () => {
  test('a Home Graph service hands its object profiles to the semantic service it is given', () => {
    const root = mkdtempSync(join(tmpdir(), 'goodvibes-homegraph-extension-')); roots.push(root);
    const store = new KnowledgeStore({ dbPath: join(root, 'knowledge.sqlite') }); stores.push(store);
    const semanticService = new KnowledgeSemanticService(store, { isBackgroundPaused: () => true });
    const register = spyOn(semanticService, 'addObjectProfiles');
    new HomeGraphService(store, new ArtifactStore({ rootDir: join(root, 'artifacts') }), { semanticService });
    expect(register).toHaveBeenCalledTimes(1);
    expect(register).toHaveBeenCalledWith(HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles);
  });

  test('every profile can be told apart and names the kinds it covers', () => {
    const profiles = HOME_GRAPH_KNOWLEDGE_EXTENSION.objectProfiles ?? [];
    expect(profiles.length).toBeGreaterThan(0);
    expect(new Set(profiles.map(profile => profile.id)).size).toBe(profiles.length);
    for (const profile of profiles) expect(profile.subjectKinds.length).toBeGreaterThan(0);
  });
});
