import { afterEach, expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { prepareConfiguredProjectContext } from '../platform/src/platform/knowledge/project-planning/configured-project.ts';
import { ProjectIdentityRegistry } from '../platform/src/platform/knowledge/project-planning/project-registry.ts';

const roots: string[] = [];
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'planning-work-plan-listing-')), workspace = join(root, 'workspace');
  roots.push(root); mkdirSync(workspace);
  const config = new ConfigManager({ workingDir: workspace, configDir: join(root, 'config'), surfaceRoot: 'listing-test', readOnly: true });
  return { root, workspace, config };
}

test('another surface saving a work plan for a different workspace while this one starts does not refuse startup', async () => {
  const f = fixture(), plans = join(f.root, 'config', 'work-plans');
  mkdirSync(plans, { recursive: true });
  const activate = ProjectIdentityRegistry.prototype.activate;
  const spy = spyOn(ProjectIdentityRegistry.prototype, 'activate').mockImplementation(function (this: ProjectIdentityRegistry, ...args: Parameters<typeof activate>) {
    writeFileSync(join(plans, 'saved-by-another-surface.json'), JSON.stringify({ projectRoot: join(f.root, 'elsewhere'), projectId: 'project-elsewhere' }));
    return activate.apply(this, args);
  });
  try {
    const prepared = await prepareConfiguredProjectContext(f.config, f.workspace, undefined, { activate: true });
    expect(prepared.registration).toBe('registered');
  } finally { spy.mockRestore(); }
});

test('a work plan that changes which project owns this workspace still refuses startup', async () => {
  const f = fixture(), plans = join(f.root, 'config', 'work-plans');
  mkdirSync(plans, { recursive: true });
  const activate = ProjectIdentityRegistry.prototype.activate;
  const spy = spyOn(ProjectIdentityRegistry.prototype, 'activate').mockImplementation(function (this: ProjectIdentityRegistry, ...args: Parameters<typeof activate>) {
    writeFileSync(join(plans, 'claims-this-workspace.json'), JSON.stringify({ projectRoot: f.workspace, projectId: 'project-claimed' }));
    return activate.apply(this, args);
  });
  try {
    await expect(prepareConfiguredProjectContext(f.config, f.workspace, undefined, { activate: true })).rejects.toThrow();
  } finally { spy.mockRestore(); }
});
