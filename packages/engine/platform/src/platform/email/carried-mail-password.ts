/**
 * carried-mail-password.ts, moving a carried-over mail password to the name
 * every mail reader looks under.
 *
 * The connector's `email.passwordRef` / `email.smtpPasswordRef` are moved onto
 * `surfaces.email.password` / `surfaces.email.smtp.password` when a settings
 * file loads, keeping the reference they held. That reference names the secret
 * where it was stored (`GOODVIBES_EMAIL_PASSWORD_REF`, or whatever the operator
 * chose), while the mail readers look under the name the new setting derives
 * (`GOODVIBES_SURFACES_EMAIL_PASSWORD`). This copies the secret across once,
 * reads it back, and only then points the setting at the derived name. The old
 * secret is left where it was.
 *
 * Runs at daemon start. Cost: two config reads; secret reads and writes only
 * when a carried reference is present, which is once.
 */

import { daemonSecretKeyFor } from '../config/daemon-secret-keys.js';
import { parseEmailSecretRef } from './email-config.js';

const PASSWORD_SETTINGS = ['surfaces.email.password', 'surfaces.email.smtp.password'] as const;

const SECRET_REF_PREFIX = 'goodvibes://secrets/goodvibes/';

export interface CarriedMailPasswordConfig {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
}

export interface CarriedMailPasswordSecrets {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

/** The settings whose secret now lives under the derived name. */
export async function adoptCarriedMailPasswords(
  config: CarriedMailPasswordConfig,
  secrets: CarriedMailPasswordSecrets,
): Promise<readonly string[]> {
  const adopted: string[] = [];
  for (const setting of PASSWORD_SETTINGS) {
    let ref: unknown;
    try { ref = config.get(setting); } catch { continue; }
    if (typeof ref !== 'string' || ref.trim() === '') continue;
    const parsed = parseEmailSecretRef(setting, ref.trim());
    const target = daemonSecretKeyFor(setting);
    if (!('key' in parsed) || parsed.key === target) continue;
    const present = await secrets.get(target);
    if (present === null || present.length === 0) {
      const carried = await secrets.get(parsed.key);
      if (carried === null || carried.length === 0) continue;
      await secrets.set(target, carried);
      if (await secrets.get(target) !== carried) continue;
    }
    config.set(setting, `${SECRET_REF_PREFIX}${encodeURIComponent(target)}`);
    adopted.push(setting);
  }
  return adopted;
}
