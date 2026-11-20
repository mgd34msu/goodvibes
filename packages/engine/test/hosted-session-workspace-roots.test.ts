// Proves: A hosted session is started in a folder outside the daemon's own and the registered workspaces, directly or through a link.
// Red when: Creating a hosted session stops checking its folder against the allowed roots, or the check stops resolving links before comparing.
/**
 * A paired device with session write access can ask the daemon to start a
 * hosted session in any folder it names, and that session's agent gets file
 * tools rooted there. The real manager with the real allowed roots (the
 * daemon's own directory and the workspaces in a real register) and the real
 * settings manager, read as the daemon reads it, over temp directories; the floor factory is a stand-in that only counts the floors it
 * was asked for, which is the point at which a session would get its tools.
 */
import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigManager } from '../platform/src/platform/config/manager.ts';
import { HostedSessionManager } from '../platform/src/platform/hosted-sessions/manager.ts';
import { HostedSessionStore } from '../platform/src/platform/hosted-sessions/store.ts';
import { allowedWorkspaceRoots } from '../platform/src/platform/hosted-sessions/workspace-roots.ts';
import { RuntimeEventBus } from '../platform/src/platform/runtime/events/index.ts';
import { WorkspaceRegistrationStore } from '../platform/src/platform/workspace/registration/store.ts';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test('a hosted session starts only in the daemon\'s folder or a registered workspace, never through a link out', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'gv-hosted-roots-')));
  dirs.push(root);
  const daemonDir = join(root, 'daemon'), projects = join(root, 'projects'), registered = join(projects, 'app');
  const outside = join(root, 'elsewhere'), home = join(root, 'home'), registerPath = join(root, 'state', 'workspaces.json');
  for (const dir of [daemonDir, join(registered, 'src'), outside, home]) mkdirSync(dir, { recursive: true });
  symlinkSync(outside, join(registered, 'out'));
  await new WorkspaceRegistrationStore({ path: registerPath, homeDir: home, daemonStateDir: join(home, '.goodvibes'), probe: () => ({}) }).add(registered);

  const config = new ConfigManager({ configDir: join(root, 'config'), workingDir: daemonDir, surfaceRoot: 'goodvibes' });
  const asked: string[] = [];
  const manager = new HostedSessionManager({
    floorFactory: async ({ workspaceRoot }) => { asked.push(workspaceRoot); throw new Error('the floor stand-in only counts'); },
    store: new HostedSessionStore(join(root, 'hosted'), {
      get maxSessions(): number { return config.get('hostedSessions.maxSessions'); },
      get maxMessagesPerSession(): number { return config.get('hostedSessions.maxMessagesPerSession'); },
      get terminatedRetentionMs(): number { return config.get('hostedSessions.terminatedRetentionMs'); },
    }),
    settings: {
      detachPolicy: () => config.get('hostedSessions.detachPolicy'),
      maxSessions: () => config.get('hostedSessions.maxSessions'),
      attachmentTtlMs: () => config.get('hostedSessions.attachmentTtlMs'),
    },
    runtimeBus: new RuntimeEventBus(),
    systemPrompt: () => '',
    allowedWorkspaceRoots: () => allowedWorkspaceRoots(daemonDir, registerPath),
  });
  const create = (workspaceRoot: string) => manager.create({ workspaceRoot }).then(() => 'created', (error: Error) => error.name);
  const results = {
    unlisted: await create(outside),
    parentOfAllowed: await create(projects),
    linkOut: await create(join(registered, 'out')),
    registered: await create(registered),
    subfolder: await create(join(registered, 'src')),
    daemonDir: await create(daemonDir),
  };
  await manager.dispose();
  expect({ results, asked }).toEqual({
    results: {
      unlisted: 'HostedSessionArgumentError', parentOfAllowed: 'HostedSessionArgumentError', linkOut: 'HostedSessionArgumentError',
      registered: 'HostedSessionUnavailableError', subfolder: 'HostedSessionUnavailableError', daemonDir: 'HostedSessionUnavailableError',
    },
    asked: [registered, join(registered, 'src'), daemonDir],
  });
});
