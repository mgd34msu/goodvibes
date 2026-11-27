/**
 * The mailbox's state as the Agent reports it, from the `surfaces.email.*` settings the daemon reads. The mailbox is
 * set up through the daemon's capabilities (Mail, calendar and channels: set up mail, change a setting, store the
 * password); this file only reads.
 */
import {
  createSurfaceEmailConfigReader,
  readEmailConfig,
  readSurfaceEmailSettings,
  validateEmailConfig,
  type SurfaceEmailSettings,
} from '@goodvibes/engine/platform/platform/email';

/** What the status readers show: the settings, whether a password is recorded, and what is missing. */
export interface MailboxStatus {
  readonly settings: SurfaceEmailSettings;
  readonly passwordStored: boolean;
  readonly problems: readonly string[];
  readonly ready: boolean;
}

function configString(getConfig: (key: string) => unknown, key: string): string {
  try {
    const value = getConfig(key);
    return typeof value === 'string' ? value.trim() : '';
  } catch {
    return '';
  }
}

/** The mailbox's state from settings alone: no network, no secret-store read. */
export function readMailboxStatus(getConfig: (key: string) => unknown): MailboxStatus {
  const settings = readSurfaceEmailSettings(getConfig);
  const problems = [...validateEmailConfig(readEmailConfig(createSurfaceEmailConfigReader(getConfig)))]
    // The adapter always names the mailbox password's own reference; whether a
    // password is stored is the line below, so this one never applies.
    .filter((problem) => !problem.startsWith('the mailbox password'));
  const passwordStored = configString(getConfig, 'surfaces.email.password').length > 0
    || configString(getConfig, 'surfaces.email.imap.password').length > 0;
  if (!passwordStored) problems.push('the mailbox password is not stored: "Store the mailbox password" in Mail, calendar and channels asks for it hidden');
  return { settings, passwordStored, problems, ready: problems.length === 0 };
}
