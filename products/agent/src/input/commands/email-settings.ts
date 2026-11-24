/**
 * The mailbox settings as the Agent reads and writes them: one set of keys,
 * `surfaces.email.*`, the same ones the daemon reads, so a mailbox configured
 * here is the mailbox the daemon answers with.
 *
 * `/mail set`, the workspace connect form and the status readers all go
 * through this file: one field table, one validation, one persistence path.
 */
import {
  createSurfaceEmailConfigReader,
  readEmailConfig,
  readSurfaceEmailSettings,
  validateEmailConfig,
  withSurfaceEmailConfig,
  type EmailServiceDeps,
  type SurfaceEmailSettings,
} from '@goodvibes/engine/platform/platform/email';
import type { Secret } from '@goodvibes/engine/platform/platform/security';
import type { ConfigKey } from '../../config/index.ts';
import { persistSecretBackedConfigValue } from '../../config/secret-config.ts';

/** Every field the owner can set, by the name `/mail set` takes, and the setting it writes. */
export const MAILBOX_FIELDS = {
  host: 'surfaces.email.host',
  'imap.host': 'surfaces.email.imap.host',
  'imap.port': 'surfaces.email.imap.port',
  'imap.secure': 'surfaces.email.imap.secure',
  'imap.mailbox': 'surfaces.email.imap.mailbox',
  'smtp.host': 'surfaces.email.smtp.host',
  'smtp.port': 'surfaces.email.smtp.port',
  'smtp.secure': 'surfaces.email.smtp.secure',
  user: 'surfaces.email.user',
  from: 'surfaces.email.from',
  password: 'surfaces.email.password',
} as const;

export type MailboxField = keyof typeof MAILBOX_FIELDS;

/** The field names earlier builds took, still accepted so a remembered command keeps working. */
const FIELD_ALIASES: Readonly<Record<string, MailboxField>> = {
  imapHost: 'imap.host',
  imapPort: 'imap.port',
  smtpHost: 'smtp.host',
  smtpPort: 'smtp.port',
  username: 'user',
  fromAddress: 'from',
  passwordRef: 'password',
  mailbox: 'imap.mailbox',
};

/** The settings that decide where, and as whom, the stored password is presented. */
export const MAILBOX_CREDENTIAL_FIELDS: ReadonlySet<MailboxField> = new Set<MailboxField>([
  'host', 'imap.host', 'imap.port', 'imap.secure', 'smtp.host', 'smtp.port', 'smtp.secure', 'user', 'password',
]);

export const MAILBOX_FIELD_LIST = Object.keys(MAILBOX_FIELDS).join(', ');

/** The field a typed name means (`imap.host`, `surfaces.email.imap.host` or an older `imapHost`), or null. */
export function resolveMailboxField(raw: string): MailboxField | null {
  const trimmed = raw.trim();
  const name = trimmed.startsWith('surfaces.email.')
    ? trimmed.slice('surfaces.email.'.length)
    : trimmed.startsWith('email.') ? trimmed.slice('email.'.length) : trimmed;
  if (Object.prototype.hasOwnProperty.call(MAILBOX_FIELDS, name)) return name as MailboxField;
  return FIELD_ALIASES[name] ?? null;
}

/**
 * The stored form of one non-secret field, or why it is not valid. Pure: no
 * write, no I/O, so a form can check every field before it stores any.
 */
export function validateMailboxFieldValue(
  field: MailboxField,
  rawValue: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false; readonly error: string } {
  if (field === 'imap.port' || field === 'smtp.port') {
    const n = Number(rawValue);
    if (!Number.isInteger(n) || n < 1 || n > 65535) {
      return { ok: false, error: `Invalid port number: ${rawValue}. Must be an integer between 1 and 65535.` };
    }
    return { ok: true, value: n };
  }
  if (field === 'imap.secure' || field === 'smtp.secure') {
    const lower = rawValue.trim().toLowerCase();
    if (lower === 'true' || lower === 'yes' || lower === 'tls') return { ok: true, value: true };
    if (lower === 'false' || lower === 'no' || (field === 'smtp.secure' && lower === 'starttls')) return { ok: true, value: false };
    return {
      ok: false,
      error: field === 'smtp.secure'
        ? `Invalid ${field} value: "${rawValue}". Use true for implicit TLS (port 465) or false for STARTTLS (port 587).`
        : `Invalid ${field} value: "${rawValue}". Use true for TLS (port 993) or false for a plain connection (local servers only).`,
    };
  }
  return { ok: true, value: rawValue.trim() };
}

/** Config manager surface needed to persist one field. */
export interface MailboxConfigManagerLike {
  get: (key: string) => unknown;
  setDynamic: (key: string, value: unknown) => void;
}

/** Secret store surface needed to store the password. */
export interface MailboxSecretsManagerLike {
  readonly get: (key: string) => Promise<Secret | null>;
}

export interface PersistMailboxFieldResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly configKey?: string;
  /** Set only for the password: the stored goodvibes:// reference, never the value. */
  readonly secretRef?: string;
  /**
   * Set for every other field: the value the owning runtime reports holding
   * after the write (the connected host's read-back), else the validated value sent.
   */
  readonly value?: unknown;
}

/**
 * Persist one field. A non-secret value is validated and written through
 * `writeValue`, the routed write (the mailbox keys are daemon-owned, so it
 * reaches the connected host and fails when no host answers); the password
 * (`rawValue` is the password itself) goes over `credentials.set` and only a
 * reference reaches the settings. Never logs or returns the password.
 */
export async function persistMailboxField(
  cm: MailboxConfigManagerLike,
  secretsManager: MailboxSecretsManagerLike,
  field: MailboxField,
  rawValue: string,
  writeValue: (key: string, value: unknown) => Promise<{ readonly value: unknown } | void> | { readonly value: unknown } | void,
): Promise<PersistMailboxFieldResult> {
  const configKey = MAILBOX_FIELDS[field];
  if (field === 'password') {
    // No scope argument: the password is what the daemon reads and sends with
    // unattended, and the key is daemon-owned, so the ownership default files it
    // in the daemon tier.
    const storedRef = await persistSecretBackedConfigValue(
      cm as unknown as Parameters<typeof persistSecretBackedConfigValue>[0],
      secretsManager as unknown as Parameters<typeof persistSecretBackedConfigValue>[1],
      configKey as ConfigKey,
      rawValue,
    );
    return { ok: true, configKey, secretRef: storedRef };
  }
  const validated = validateMailboxFieldValue(field, rawValue);
  if (!validated.ok) return { ok: false, error: validated.error, configKey };
  const written = await writeValue(configKey, validated.value);
  return { ok: true, configKey, value: written ? written.value : validated.value };
}

/** `EmailService` deps over the mailbox settings and the password chain the daemon uses. */
export function mailboxServiceDeps(deps: EmailServiceDeps): EmailServiceDeps {
  return withSurfaceEmailConfig(deps);
}

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
  const passwordStored = configString(getConfig, MAILBOX_FIELDS.password).length > 0
    || configString(getConfig, 'surfaces.email.imap.password').length > 0;
  if (!passwordStored) problems.push('the mailbox password is not stored: /mail password (asks for it hidden)');
  return { settings, passwordStored, problems, ready: problems.length === 0 };
}
