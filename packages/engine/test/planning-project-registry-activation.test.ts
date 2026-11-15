import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectIdentityRegistry } from '../platform/src/platform/knowledge/project-planning/project-registry.ts';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'planning-registry-activation-')), workspace = join(root, 'workspace'), directory = join(root, 'registry');
  roots.push(root); mkdirSync(workspace);
  return { workspace, directory, registry: new ProjectIdentityRegistry(directory, () => {}) };
}
const names = (directory: string, suffix: string) => existsSync(directory) ? readdirSync(directory).filter((name) => name.endsWith(suffix)) : [];

test('an activation refused while its stage file exists leaves no stage file and no binding, and a retry publishes one', async () => {
  const f = fixture();
  const refuse = () => { if (names(f.directory, '.stage').length > 0) throw new Error('owner retired mid-publication'); };
  await expect(f.registry.activate(f.workspace, null, undefined, refuse)).rejects.toThrow('owner retired mid-publication');
  expect(names(f.directory, '.stage')).toEqual([]);
  expect(names(f.directory, '.json')).toEqual([]);
  const registered = await f.registry.activate(f.workspace, null, undefined, () => {});
  expect(names(f.directory, '.json')).toHaveLength(1);
  expect(f.registry.inspect(f.workspace)?.projectId).toBe(registered.projectId);
});

test('a binding published before the activation was refused is kept and adopted by the next activation', async () => {
  const f = fixture();
  const refuse = () => { if (names(f.directory, '.json').length > 0) throw new Error('acknowledgement lost'); };
  await expect(f.registry.activate(f.workspace, null, undefined, refuse)).rejects.toThrow('acknowledgement lost');
  expect(names(f.directory, '.stage')).toEqual([]);
  expect(names(f.directory, '.json')).toHaveLength(1);
  const adopted = await f.registry.activate(f.workspace, null, undefined, () => {});
  expect(names(f.directory, '.json')).toHaveLength(1);
  expect(f.registry.inspect(f.workspace)?.projectId).toBe(adopted.projectId);
});
