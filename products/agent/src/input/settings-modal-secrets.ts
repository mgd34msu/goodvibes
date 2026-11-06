import { setSecretBackedSettingValue as writeSetting } from '@goodvibes-jev/engine/terminal-shell/settings-secret-writes';
import { agentDaemonCredentialsInstalled, isDaemonOwnedConfigKey, routeDaemonOwnedCredentialWrite } from '../config/daemon-credential-routing.ts';
export type { SettingsSecretsManager } from '@goodvibes-jev/engine/terminal-shell/settings-secret-writes';
export interface SettingsSecretWriteReport { readonly ok: boolean; readonly message: string; }
type WriteArgs = Omit<Parameters<typeof writeSetting>[0], 'route' | 'onDaemonWrite' | 'onFailure' | 'onError' | 'daemonCredentials'>;
export function setSecretBackedSettingValue(args: WriteArgs & { readonly onWriteReported?: ((report: SettingsSecretWriteReport) => void) | undefined }): Promise<boolean> {
 return writeSetting({ ...args,
  route: { applies: key => isDaemonOwnedConfigKey(key) && agentDaemonCredentialsInstalled(), write: routeDaemonOwnedCredentialWrite },
  onDaemonWrite: () => args.onWriteReported?.({ ok: true, message: 'Stored by the connected host; it takes effect for every client.' }),
  onFailure: message => args.onWriteReported?.({ ok: false, message: `Save failed: ${message}` }),
 });
}
