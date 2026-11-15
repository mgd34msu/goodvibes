/**
 * Onboarding rolls back the operation that failed as well as the ones before
 * it. A profile directory that appeared between validation and the create
 * (someone else made it) is not this request's to delete when the create then
 * refuses with "already exists".
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { createShellPathService } from '@/runtime/index.ts';
import { resolveAgentRuntimeProfileHome } from '../../../agent/runtime-profile.ts';
import { GOODVIBES_AGENT_SURFACE_ROOT } from '../../../config/surface.ts';
import { SecretsManager } from '../../../config/secrets.ts';
import { applyOnboardingRequest } from '../../../runtime/onboarding/index.ts';
import { makeProjectTempDir } from '../../helpers/project-temp.ts';

describe('onboarding profile rollback ownership', () => {
  let root: string;
  let configManager: ConfigManager;
  let shellPaths: ReturnType<typeof createShellPathService>;

  beforeEach(() => {
    root = makeProjectTempDir('gv-onboarding-profile-rollback');
    shellPaths = createShellPathService({ workingDirectory: join(root, 'workspace'), homeDirectory: join(root, 'home') });
    configManager = new ConfigManager({
      surfaceRoot: GOODVIBES_AGENT_SURFACE_ROOT,
      homeDir: join(root, 'home'),
      workingDir: join(root, 'workspace'),
    });
  });

  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  test('a profile created elsewhere mid-request survives the failed create', async () => {
    const foreign = resolveAgentRuntimeProfileHome(shellPaths.homeDirectory, 'desk').homeDirectory;
    const real = new SecretsManager({ projectRoot: shellPaths.workingDirectory, globalHome: join(root, 'home'), configManager });
    // The secret is written before the profile is created; that write is where
    // the other process's profile appears.
    const secrets = Object.assign(Object.create(real) as SecretsManager, {
      set: async (...args: Parameters<SecretsManager['set']>) => {
        mkdirSync(foreign, { recursive: true });
        writeFileSync(join(foreign, 'profile.json'), '{"owner":"someone else"}');
        return await real.set(...args);
      },
    });

    const result = await applyOnboardingRequest(
      { clock: () => 100, config: configManager, shellPaths, acknowledgementScope: 'project', secrets },
      {
        mode: 'new',
        source: 'wizard',
        operations: [
          { kind: 'set-secret', key: 'GOODVIBES_ROLLBACK_PROBE', value: 'v', scope: 'project', medium: 'plaintext' },
          { kind: 'create-agent-profile', name: 'desk' },
        ],
      },
    );

    expect(result.ok).toBe(false);
    expect(result.errors.map((error) => error.message).join('\n')).toContain('Agent profile already exists');
    expect(existsSync(join(foreign, 'profile.json'))).toBe(true);
    expect(readFileSync(join(foreign, 'profile.json'), 'utf8')).toContain('someone else');
  });
});
