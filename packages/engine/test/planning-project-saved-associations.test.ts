/** Native associations supersede redundant old selector derivation; no model calls. */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as crypto from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { KnowledgeStore } from '../platform/src/platform/knowledge/store.ts';
import { prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/project-planning/configured-project.ts';
import { ProjectIdentityRegistry } from '../platform/src/platform/knowledge/project-planning/project-registry.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'planning-saved-association-')), workspace = join(root, 'workspace'); roots.push(root); mkdirSync(workspace);
  const config = new ConfigManager({ workingDir: workspace, configDir: join(root, 'config'), homeDir: root, surfaceRoot: 'association-test', readOnly: true });
  const registry = new ProjectIdentityRegistry(join(root, '.goodvibes', 'project-identities'), () => {});
  return { root, workspace, config, registry };
}
async function seed(f: ReturnType<typeof fixture>, projectId: string) {
  const store = new KnowledgeStore({ configManager: f.config });
  try {
    await store.upsertSource({ id: 'saved-default-reference', connectorId: 'goodvibes-project-planning', sourceType: 'dataset', title: 'Saved selector', status: 'indexed',
      metadata: { projectId, knowledgeSpaceId: `project:${projectId}`, planningArtifactKind: 'state', planningArtifactId: 'current' } });
    return store.storagePath;
  } finally { await store.close(); }
}

test('an actual native binding reuses its sole already-associated old-looking selector with no hashing', async () => {
  const f = fixture(), projectId = 'workspace-0123456789';
  await f.registry.activate(f.workspace, projectId, undefined, () => {});
  const path = await seed(f, projectId), original = readFileSync(path), hashing = spyOn(crypto, 'createHash');
  try {
    expect(await prepareConfiguredProjectContext(f.config, f.workspace)).toEqual({ registration: 'registered', projectId });
    expect(await prepareConfiguredProjectContext(f.config, f.workspace, undefined, { activate: true })).toEqual({ registration: 'registered', projectId });
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(readFileSync(path)).toEqual(original);
  } finally { hashing.mockRestore(); }
});

test('a sole original projectRoot-owned plan association supplies the same saved selector without hashing', async () => {
  const f = fixture(), projectId = 'workspace-0123456789', path = await seed(f, projectId), original = readFileSync(path);
  const plans = join(f.root, 'config', 'work-plans'); mkdirSync(plans);
  writeFileSync(join(plans, 'original-plan.json'), JSON.stringify({ projectRoot: f.workspace, projectId }));
  const hashing = spyOn(crypto, 'createHash');
  try {
    expect(await prepareConfiguredProjectContext(f.config, f.workspace)).toEqual({ registration: 'registered', projectId });
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(0);
    expect(readFileSync(path)).toEqual(original);
  } finally { hashing.mockRestore(); }
});

test('a distinct old-looking candidate still selects the published recipe instead of blindly trusting the registry', async () => {
  const f = fixture(), projectId = 'workspace-0123456789';
  await f.registry.activate(f.workspace, projectId, undefined, () => {});
  const path = await seed(f, 'workspace-fedcba9876'), original = readFileSync(path), hashing = spyOn(crypto, 'createHash');
  try {
    expect(await prepareConfiguredProjectContext(f.config, f.workspace)).toEqual({ registration: 'registered', projectId });
    expect(hashing.mock.calls.filter(([algorithm]) => algorithm === 'sha256')).toHaveLength(1);
    expect(readFileSync(path)).toEqual(original);
  } finally { hashing.mockRestore(); }
});
