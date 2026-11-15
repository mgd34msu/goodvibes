import { describe, expect, test } from 'bun:test';
import { join } from 'node:path';
import { ConfigManager, SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
import { GOOGLE_SECRET_KEYS, type LoopbackListener } from '@goodvibes-jev/engine/platform/platform/google';
import { makeProjectTempDir } from '../helpers/project-temp.ts';
import { executeAdmitted } from '../helpers/admitted-tool.ts';
import { createAgentGoogleTool, agentGoogleInputProjector } from '../../tools/agent-google-tool.ts';
import { captureGoogleConnectionCurrent } from '../../runtime/bootstrap-google-tool.ts';

const CLIENT_ID = '918273645500-abcdefghijklmnop.apps.googleusercontent.com';
const CLIENT_SECRET = 'GOCSPX-thisIsTheSecretValue';

async function rig(loopback: () => LoopbackListener) {
  const root = makeProjectTempDir('google-consent-state');
  const config = new ConfigManager({ configDir: join(root, 'config'), homeDir: root, workingDir: root, surfaceRoot: 'agent', diagnosticMode: 'structural' });
  config.load();
  const secrets = new SecretsManager({ projectRoot: root, globalHome: root, surfaceRoot: 'agent', configManager: config, diagnosticMode: 'structural',
    secureProjectFilePath: join(root, 'project-secrets.enc'), plaintextProjectFilePath: join(root, 'project-secrets.json'),
    secureUserFilePath: join(root, 'user-secrets.enc'), plaintextUserFilePath: join(root, 'user-secrets.json') });
  await secrets.set(GOOGLE_SECRET_KEYS.oauthClientSecret, CLIENT_SECRET);
  const deps = { configManager: config, secretsManager: secrets, homeDirectory: root };
  const tool = createAgentGoogleTool({ ...deps,
    configGet: key => {
      let value: unknown = config.getRaw();
      for (const part of key.split('.')) value = value && typeof value === 'object' ? Object.getOwnPropertyDescriptor(value, part)?.value : undefined;
      return value;
    }, secretGet: key => secrets.get(key), captureConnectionCurrent: () => captureGoogleConnectionCurrent(deps), loopback,
    fetchImpl: async () => Response.json({}),
  });
  const run = (args: Record<string, unknown>) => executeAdmitted(tool, args, { directory: root, configManager: config, registration: { inputProjection: agentGoogleInputProjector(tool) } });
  return { run };
}

const waitingListener = (): LoopbackListener => ({ redirectUri: 'http://127.0.0.1:41234/', waitForCode: () => new Promise<never>(() => {}), close() {} });

describe('connect.complete answers with the real consent state', () => {
  test('before any connect.client it says no consent is in progress and names the way to start one', async () => {
    const { run } = await rig(waitingListener);
    const result = await run({ action: 'connect.complete' });
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('No Google consent is in progress');
    expect(result.error ?? '').toContain('connect.client');
    expect(result.error ?? '').not.toContain('unavailable');
  });

  test('while the owner has not approved yet it says consent is pending, not that Google is unavailable', async () => {
    const { run } = await rig(waitingListener);
    expect((await run({ action: 'connect.client', clientId: CLIENT_ID })).success).toBe(true);
    const result = await run({ action: 'connect.complete' });
    expect(result.success).toBe(false);
    expect(result.error ?? '').toContain('consent is still pending');
    expect(result.error ?? '').not.toContain('unavailable');
  });

  test('a consent that cannot start leaves nothing pending and says to start again', async () => {
    const { run } = await rig(() => { throw new Error('EADDRINUSE'); });
    const started = await run({ action: 'connect.client', clientId: CLIENT_ID });
    expect(started.success).toBe(false);
    expect(started.error ?? '').toContain('No consent is pending');
    const completed = await run({ action: 'connect.complete' });
    expect(completed.error ?? '').toContain('No Google consent is in progress');
  });
});
