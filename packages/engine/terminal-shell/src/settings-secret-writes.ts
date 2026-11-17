import type { ConfigKey } from '@goodvibes-jev/engine/platform/platform/config';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import { logger } from '@goodvibes-jev/engine/platform/platform/utils';
import type { SecretsManager } from '@goodvibes-jev/engine/platform/platform/config';
import { buildSecretBackedConfigUpdate, defaultSecretBackedScope, getSecretWriteMedium } from '@goodvibes-jev/engine/platform/platform/config';
export type SettingsSecretsManager = Pick<SecretsManager, 'delete' | 'set'>;
/**
 * The daemon's own credential write, when this app has a daemon to write to.
 *
 * A daemon-scoped credential is two writes that only work together, the secret
 * value and the config reference that points at it, and `credentials.set` does
 * both, verifying the value reads back before it touches the config. Splitting
 * them across a process boundary leaves a window where the config names a
 * reference resolving to nothing, which every reader treats as a
 * configured-but-broken credential.
 */
export interface SettingsDaemonCredentialWriter {
  set(configKey: string, value: string): Promise<unknown>;
  clear(configKey: string): Promise<void>;
}
type SecretWriteStep = 'policy' | 'validate' | 'daemon' | 'store' | 'config';
const SECRET_WRITE_FAILURE: Record<SecretWriteStep, { readonly reason: string; readonly next: string }> = {
  policy: { reason: 'the settings policy could not be read', next: 'Check the managed settings policy file, then retry.' },
  validate: { reason: 'the value does not meet the setting\'s rule', next: 'Enter a value the setting accepts, then retry.' },
  daemon: { reason: 'the daemon refused it or could not be reached', next: 'Check that the daemon is running and this app is connected to it, then retry.' },
  store: { reason: 'the secret store could not write it', next: 'Check secret storage access and storage.secretPolicy, then retry.' },
  config: { reason: 'the setting that points at the stored value could not be saved', next: 'Check whether the setting is locked by policy, then retry.' },
};
/**
 * The reason a credential write failed, from the step that failed and the
 * error's status or code only. The error text itself is never shown: a store
 * or transport error may echo the credential.
 */
function describeSecretWriteFailure(key: string, step: SecretWriteStep, error: unknown, typed: readonly string[] = []): string {
  const failure = SECRET_WRITE_FAILURE[step];
  // The setting's own rule is the product's words; the typed text is removed from it before it is shown.
  if (step === 'validate' && error instanceof Error && error.message) {
    let rule = error.message;
    for (const text of typed) if (text.length > 0) rule = rule.split(text).join('<value>');
    return `The credential ${key} was not saved: ${rule.replace(/\.$/, '')}. ${failure.next}`;
  }
  let detail = '';
  if (error && typeof error === 'object') {
    const status = (error as { readonly status?: unknown }).status;
    const code = (error as { readonly code?: unknown }).code;
    if (typeof status === 'number' && Number.isInteger(status)) detail = ` (status ${status})`;
    else if (typeof code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,47}$/.test(code)) detail = ` (${code})`;
  }
  return `The credential ${key} was not saved: ${failure.reason}${detail}. ${failure.next}`;
}
export async function setSecretBackedSettingValue(args: {
  route?:
    | {
        readonly applies: (key: ConfigKey) => boolean;
        readonly write: (key: ConfigKey, value: string) => Promise<unknown>;
      }
    | undefined;
  onDaemonWrite?: (() => void) | undefined;
  onFailure?: ((message: string) => void) | undefined;
  key: ConfigKey;
  value: string;
  configManager: ConfigManager;
  secretsManager: SettingsSecretsManager | null;
  /** Present when a daemon is adopted; absent leaves the historical local path. */
  daemonCredentials?: (SettingsDaemonCredentialWriter | null) | undefined;
  setConfigValue: (key: ConfigKey, value: unknown) => void | Promise<void>;
  /** Surface the daemon's refusal; without it a failed write would be silent. */
  onError?: ((message: string) => void) | undefined;
}): Promise<boolean> {
  const { key, value, configManager, secretsManager, setConfigValue } = args;
  const assertPolicyAvailable = () => {
    // Re-read authority from the captured owner, including after storage waits.
    // A modal opened against another owner must not supply this metadata.
    for (const setting of configManager.getHostSettingsSchema?.() ?? []) {
      if (setting.type === 'boolean') configManager.getHostBooleanSetting(setting.key).getResolved();
    }
  };
  let step: SecretWriteStep = 'policy';
  try {
    assertPolicyAvailable();
    step = 'config';
    const update = buildSecretBackedConfigUpdate(key, value);
    if ((update.secretKey || update.clearSecretKey) && args.route?.applies(key)) {
      step = 'daemon';
      // The trimmed text, as the local path stores: a token pasted with a trailing newline must not reach the daemon with it.
      await args.route.write(key, value.trim());
      args.onDaemonWrite?.();
      return true;
    }
    if ((update.secretKey || update.clearSecretKey) && defaultSecretBackedScope(key) === 'daemon' && args.daemonCredentials) {
      const writer = args.daemonCredentials;
      step = 'daemon';
      if (value.trim().length === 0) await writer.clear(key);
      else await writer.set(key, value.trim());
      return true;
    }
    if ((update.secretKey || update.clearSecretKey) && !secretsManager) {
      step = 'store';
      throw new Error('Credential storage is unavailable.');
    }
    step = 'validate';
    configManager.validateDynamic?.(key, update.configValue);
    const scope = defaultSecretBackedScope(key);
    const medium = getSecretWriteMedium(configManager.get('storage.secretPolicy'));
    // Publishing a reference is the commit: readers must never see it before
    // the cross-process secret write has actually completed.
    if (update.secretKey && update.secretValue !== undefined) {
      step = 'store';
      await secretsManager!.set(update.secretKey, update.secretValue, { scope, medium });
    }
    step = 'policy';
    assertPolicyAvailable();
    step = 'config';
    configManager.validateDynamic?.(key, update.configValue);
    await setConfigValue(key, update.configValue);
    // A clear unpublishes the reference first and only then deletes the value:
    // the other order, failing at the config write, would leave a reference
    // that resolves to nothing, a broken credential.
    if (update.clearSecretKey) {
      try {
        await secretsManager!.delete(update.clearSecretKey, { scope });
      } catch {
        logger.error('SettingsModal: cleared secret reference but could not delete its stored value', { key });
        const message = `The credential was cleared, but its stored value could not be removed. Remove it with /secrets delete ${update.clearSecretKey}.`;
        args.onFailure?.(message);
        args.onError?.(message);
      }
    }
    return true;
  } catch (error) {
    // Store/transport errors may echo credential material. Never display or log their text.
    const message = describeSecretWriteFailure(key, step, error, [value, value.trim()]);
    logger.error('SettingsModal: failed to save secret config value', { key, step });
    args.onFailure?.(message);
    args.onError?.(message);
    return false;
  }
}
