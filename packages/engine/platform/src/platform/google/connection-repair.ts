/**
 * connection-repair.ts, finishing an adoption that only half landed.
 *
 * The owner ran `/google adopt`. It reported success. The secret half went into
 * the store; the config half, the OAuth client id, and the reference naming
 * where its secret lives, did not reach anywhere the daemon reads, because the
 * `calendar` config section did not exist to write into outside the one product
 * that carried a seeder for it. The result is a machine holding half a
 * credential, which reports "no Google account connected" exactly as loudly as
 * holding none, and a person who was told the setup worked.
 *
 * Moving stored credentials between tiers cannot fix that: there is nothing in
 * any tier to move. What DOES fix it is the thing the adoption already does,
 * run again, and the files it reads are still on the machine, untouched,
 * because adoption never writes them.
 *
 * ── The boundary, and why it is where it is ─────────────────────────────────
 *
 * This does NOT adopt credentials on someone's behalf. It runs only when the
 * secret store already holds a Google credential, which is to say only when
 * someone already ran an adoption or a setup on this machine and it half
 * landed. Finishing what a person started is repair. Starting it for them
 * would be the daemon deciding on its own to take up credentials belonging to
 * another tool, and that is not this function's call to make.
 *
 * It is also idempotent and cheap: a connection whose config half is present
 * returns `already-connected` after two config reads and one secret read.
 */

import { adoptExistingGoogleCredentials } from './setup-actions.js';
import { detectGoogleSetupState } from './setup-state.js';
import { GOOGLE_CONFIG_KEYS } from './setup-plan.js';
import { safeConfigString } from './config-access.js';
import type { GoogleConfigPort, GoogleSecretPort } from './types.js';
import type { GoogleFilePort } from './credential-adoption.js';

/** What the repair found, and what it did about it. */
export type GoogleConnectionRepairOutcome =
  /** The client id, its secret and a refresh token are all present. Nothing was written. */
  | 'already-connected'
  /**
   * A client id is configured but the secret or the refresh token is missing,
   * and no consent can be completed from here: the owner has to connect again.
   */
  | 'incomplete'
  /** The files hold a different refresh token than the stored one; replacing it needs the owner's yes. */
  | 'needs-confirmation'
  /** No Google credential exists on this machine at all. Not this function's job. */
  | 'nothing-to-repair'
  /** A credential was present with no config half, and the config half was written. */
  | 'repaired'
  /** A credential was present with no config half, and no adoptable source remained. */
  | 'source-gone';

export interface GoogleConnectionRepairResult {
  readonly outcome: GoogleConnectionRepairOutcome;
  /** Safe to display and to log: provenance and state only, never a value. */
  readonly detail: string;
}

/**
 * Complete a Google connection whose config half never landed.
 *
 * Every value that moves goes through the ordinary adoption path, so it is
 * routed and scoped by the same rules any other write is, this adds no second
 * way to store a credential.
 */
export async function repairHalfLandedGoogleConnection(deps: {
  readonly files: GoogleFilePort;
  readonly config: GoogleConfigPort;
  readonly secrets: GoogleSecretPort;
  readonly homeDirectory: string;
}): Promise<GoogleConnectionRepairResult> {
  const state = await detectGoogleSetupState({ config: deps.config, secrets: deps.secrets });

  // The config half, present: nothing is broken.
  const clientId = safeConfigString(deps.config, GOOGLE_CONFIG_KEYS.oauthClientId);
  if (clientId !== null) {
    if (state.hasRefreshToken && state.hasOAuthClientSecret) {
      return { outcome: 'already-connected', detail: 'The Google connection is complete; nothing was changed.' };
    }
    const missing = !state.hasRefreshToken && !state.hasOAuthClientSecret
      ? 'the client secret and the refresh token'
      : state.hasRefreshToken ? 'the client secret' : 'the refresh token';
    return {
      outcome: 'incomplete',
      detail:
        `A Google client id is configured but ${missing} ${missing.includes(' and ') ? 'are' : 'is'} not stored, so no Google account can be used yet. `
        + 'Connect Google again to finish it.',
    };
  }

  // No credential in the store: nobody has run a setup here, and starting one
  // unasked is not this function's call.
  if (!state.hasRefreshToken && !state.hasOAuthClientSecret && !state.hasAppPassword) {
    return {
      outcome: 'nothing-to-repair',
      detail: 'No Google credential is stored on this machine, so there is no half-finished setup to complete.',
    };
  }

  const outcome = await adoptExistingGoogleCredentials({
    files: deps.files,
    config: deps.config,
    secrets: deps.secrets,
    homeDirectory: deps.homeDirectory,
  });

  if (!outcome.adopted && outcome.needsConfirmation === true) {
    return {
      outcome: 'needs-confirmation',
      detail:
        'A Google credential is stored without its client id, and the files on this machine hold a different refresh token. '
        + 'Nothing was replaced; adopt the Google credentials and confirm the replacement to finish the connection.',
    };
  }
  if (!outcome.adopted) {
    return {
      outcome: 'source-gone',
      detail:
        'A Google credential is stored but the connection is incomplete, and the files it was taken from are no longer on this machine. '
        + 'Re-run the Google setup to finish it.',
    };
  }

  return {
    outcome: 'repaired',
    detail:
      'A Google credential was stored without the client id that goes with it, the setup reported success and left the daemon holding half a connection. '
      + 'The missing half has been written from the same files the credential came from, which were read and left untouched.',
  };
}
