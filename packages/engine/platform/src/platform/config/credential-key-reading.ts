/**
 * Reads whether an undeclared config key holds credential material, through
 * the `config.credential-key` battery. The declared list in
 * secret-bearing-config-keys.ts is checked first and exactly; only a key it
 * does not name is read.
 */
import type { YesNoReading } from '@goodvibes/judgment';
import { captureJudgmentPort, type JudgmentReadingOptions } from '@goodvibes/engine/errors';
import { admitJudgmentJson } from '../gate/judgment-result.js';
import { credentialKey, type CredentialKeyState } from './batteries/credential-key.js';
import { isSecretBearingConfigKey } from './secret-bearing-config-keys.js';
import { CONFIG_SCHEMA } from './schema.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';

/**
 * Jev's reading of whether `state.key` holds a credential. Throws when no reading can be made.
 * The state is admitted once as an immutable snapshot; the caller's `assertCurrent`, when given, runs before each attempt.
 */
export async function readCredentialKey(state: CredentialKeyState, site: string, options: JudgmentReadingOptions = {}): Promise<YesNoReading> {
  const snapshot = admitJudgmentJson(state);
  const owner = captureJudgmentPort(site, options);
  const run = await credentialKey.run(owner.port, snapshot, { site, signal: owner.signal, beforeAttempt: owner.assertCurrent });
  owner.assertCurrent();
  return run.readings.credential;
}

/**
 * True when the key is declared secret-bearing, or reads as a credential with
 * a yes strong enough to act on. `description` is the key's schema
 * description, or empty when it has none.
 */
export async function holdsCredential(key: string, description: string, site: string): Promise<boolean> {
  if (isSecretBearingConfigKey(key)) return true;
  return decisionOrClassic(async () => {
    const reading = await readCredentialKey({ key, description }, site);
    return reading.verdict === 'yes' && reading.outcome === 'act';
  }, () => !CONFIG_SCHEMA.some(setting => setting.key === key));
}

/** The schema description of a config key, or empty when the schema has no entry for it. */
export function configKeyDescription(key: string): string {
  return CONFIG_SCHEMA.find((setting) => setting.key === key)?.description ?? '';
}
