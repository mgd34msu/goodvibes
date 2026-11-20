/**
 * A daemon's real settings and secret store in a scratch home, set up as the
 * owner sets them: a credential goes into the secret store and the setting
 * holds its reference; any other value is written as it is. Writes go through
 * `setMany` as the local owner, so a value the product refuses fails the
 * fixture instead of being read from a stand-in.
 */
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { localOwnerActor } from '@goodvibes/engine/daemon-api/http-policy';
import { ConfigManager } from '../../platform/src/platform/config/manager.ts';
import type { ConfigKey } from '../../platform/src/platform/config/schema.ts';
import { credentialValueRefusal } from '../../platform/src/platform/config/write-admission.ts';
import { daemonSecretKeyFor } from '../../platform/src/platform/config/daemon-secret-keys.ts';
import { SecretsManager } from '../../platform/src/platform/config/secrets.ts';

export interface ScratchSettings {
  readonly root: string;
  readonly configManager: ConfigManager;
  readonly secretsManager: SecretsManager;
}

/** `root`: the scratch home (made here when absent; the caller removes it). */
export async function scratchSettings(values: Readonly<Record<string, unknown>>, root = mkdtempSync(join(tmpdir(), 'gv-settings-'))): Promise<ScratchSettings> {
  const configManager = new ConfigManager({ configDir: join(root, 'config'), daemonTierPath: join(root, 'daemon', 'settings.json'), ownsDaemonTier: true });
  const secretsManager = new SecretsManager({ surfaceRoot: 'goodvibes', globalHome: join(root, 'home'), projectRoot: root, policy: 'plaintext_allowed' });
  const changes: Array<{ key: ConfigKey; value: unknown }> = [];
  for (const [key, value] of Object.entries(values)) {
    if (credentialValueRefusal(key, value)?.code === 'CONFIG_SECRET_LITERAL') {
      await secretsManager.set(daemonSecretKeyFor(key), String(value), { scope: 'user' });
      changes.push({ key: key as ConfigKey, value: `goodvibes://secrets/goodvibes/${daemonSecretKeyFor(key)}` });
    } else {
      changes.push({ key: key as ConfigKey, value });
    }
  }
  if (changes.length > 0) {
    const written = configManager.setMany(changes, localOwnerActor());
    if (!written.ok) throw new Error(`the fixture settings were refused: ${JSON.stringify(written)}`);
  }
  return { root, configManager, secretsManager };
}
