// Proves: A call the daemon decides for a project is decided under the daemon's own permission mode, so a project whose settings file asks to be asked runs its commands unasked from a web chat, a schedule or any other daemon turn there.
// Red when: The permission reader (permissions/manager.ts createPermissionConfigReader) stops laying the project's own settings file over the daemon's for a decision made in that project, so beta's "Ask me" is not read and its command runs under the daemon's Just YOLO, or gamma's looser file is taken over the daemon's Ask me.
// Proves: A project value admitted while it was no looser than the daemon's keeps deciding the project's daemon turns after the owner makes the daemon stricter, so a command the owner has since denied runs there.
// Red when: The project's settings view (config/project-view.ts projectConfigView) stops admitting the project's file again when the daemon's settings change, keeping the layer it admitted against the old value, so beta's "prompt" still asks and runs after the daemon denies exec.

/**
 * One daemon's permission manager over its real settings manager (its own folder in no project), two daemon modes:
 * Just YOLO, then Ask me. Three projects, each a repository: alpha sets nothing, beta's `.goodvibes/settings.json` says
 * Ask me, gamma's says Just YOLO and allows `exec`. Each call is decided inside `decideInProject`, as every daemon turn
 * in a project is (permissions/call-project.ts). The ask function stands for the owner answering yes. Real settings
 * manager, real project files, real gate; nothing stands in for them.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../platform/src/platform/config/schema.ts';
import { createPermissionConfigReader, PermissionManager } from '../platform/src/platform/permissions/manager.ts';
import { decideInProject } from '../platform/src/platform/permissions/call-project.ts';
import { withOwnerInput } from '../platform/src/platform/security/turn-input-party.ts';
import { PolicyRuntimeState } from '../platform/src/platform/runtime/permissions/policy-runtime.ts';

let dir: string;
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

test('a daemon call in a project is decided under the project\'s stricter settings, never looser ones', async () => {
  dir = mkdtempSync(join(tmpdir(), 'gv-project-permission-settings-'));
  const home = join(dir, 'home');
  const own = join(dir, 'daemon-own');
  const project = (name: string): string => join(dir, 'projects', name);
  for (const folder of [home, own, ...['alpha', 'beta', 'gamma'].map((name) => join(project(name), '.git'))]) mkdirSync(folder, { recursive: true });
  for (const [name, settings] of [['beta', { permissions: { mode: 'ask-me' } }], ['gamma', { permissions: { mode: 'yolo', tools: { exec: 'allow' } } }]] as const) {
    mkdirSync(join(project(name), '.goodvibes'), { recursive: true });
    writeFileSync(join(project(name), '.goodvibes', 'settings.json'), JSON.stringify(settings));
  }

  const asked: string[] = [];
  const decide = async (daemonMode: string): Promise<string> => {
    const config = new ConfigManager({ surfaceRoot: 'daemon', workingDir: own, homeDir: home, configDir: join(home, '.goodvibes', 'daemon', daemonMode), ownsDaemonTier: true });
    expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: daemonMode }], localOwnerActor()).ok).toBe(true);
    const gate = new PermissionManager(async (request) => { asked.push(String(request.workingDirectory).split('/').pop()); return { approved: true }; },
      createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, { workspaceTrust: null });
    const runs: string[] = [];
    for (const name of ['alpha', 'beta', 'gamma']) {
      const before = asked.length;
      // The owner's own daemon turn (the daemon marks every run of the owner's it starts; unmarked work is someone else's).
      const decision = await withOwnerInput(() => decideInProject(project(name), () => gate.checkDetailed('exec', { commands: [{ cmd: 'pwd' }] })));
      runs.push(`${name} ${decision.approved ? 'runs' : 'refused'}${asked.length > before ? ' asked' : ''}`);
    }
    return `${daemonMode}: ${runs.join(', ')}`;
  };

  // Rows: alpha (nothing set) follows the daemon; beta's Ask me holds under Just YOLO; gamma's looser file is not taken.
  expect([await decide('yolo'), await decide('ask-me')]).toEqual([
    'yolo: alpha runs, beta runs asked, gamma runs',
    'ask-me: alpha runs asked, beta runs asked, gamma runs asked',
  ]);
});

test("a project value admitted against the daemon's old value stops counting once the daemon is made stricter", async () => {
  dir = mkdtempSync(join(tmpdir(), 'gv-project-permission-settings-later-'));
  const home = join(dir, 'home');
  const own = join(dir, 'daemon-own');
  const beta = join(dir, 'projects', 'beta');
  for (const folder of [home, own, join(beta, '.git'), join(beta, '.goodvibes')]) mkdirSync(folder, { recursive: true });
  // Beta's own file sets exec to "prompt", as the daemon does at first: admitted, being no looser.
  writeFileSync(join(beta, '.goodvibes', 'settings.json'), JSON.stringify({ permissions: { tools: { exec: 'prompt' } } }));
  const config = new ConfigManager({ surfaceRoot: 'daemon', workingDir: own, homeDir: home, configDir: join(home, '.goodvibes', 'daemon'), ownsDaemonTier: true });
  expect(config.setMany([{ key: 'permissions.mode' as ConfigKey, value: 'ask-me' }, { key: 'permissions.tools.exec' as ConfigKey, value: 'prompt' }], localOwnerActor()).ok).toBe(true);
  const gate = new PermissionManager(async () => ({ approved: true }), createPermissionConfigReader(config), new PolicyRuntimeState(), null, null, null, { workspaceTrust: null });
  // The owner's own daemon turn in beta (the daemon marks every run of the owner's it starts).
  const inBeta = async (): Promise<string> => ((await withOwnerInput(() => decideInProject(beta, () => gate.checkDetailed('exec', { commands: [{ cmd: 'pwd' }] })))).approved ? 'runs' : 'refused');
  const before = await inBeta();
  // The owner denies exec on the daemon; beta's file is not touched.
  expect(config.setMany([{ key: 'permissions.tools.exec' as ConfigKey, value: 'deny' }], localOwnerActor()).ok).toBe(true);
  // Rows: beta under the daemon's first value (its own "prompt", answered yes), then under the denial.
  expect([`before: ${before}`, `after the denial: ${await inBeta()}`]).toEqual(['before: runs', 'after the denial: refused']);
});
