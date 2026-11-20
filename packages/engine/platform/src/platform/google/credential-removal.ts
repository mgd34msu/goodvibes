/**
 * Removing or replacing a stored Google credential, which never happens
 * without the owner saying yes first.
 *
 * The defect this exists to fix: mid-flow, with nothing asked and nothing
 * announced, the stored refresh token was deleted. The owner found out because
 * the connection stopped working. A refresh token is not a cache entry, it is
 * the thing that took a person through a consent screen to obtain, and on a
 * published app it is the only durable half of the credential. Deleting one
 * unprompted destroys work the machine cannot recreate on its own.
 *
 * So this module makes the destructive step impossible to reach by accident.
 * There is no function here that deletes on the first call. `planRemoval`
 * returns a sentence naming exactly what would go; only a second call carrying
 * an explicit yes actually removes anything, and the result states what was
 * removed rather than reporting a bare success.
 *
 * The same gate covers REPLACEMENT, because overwriting a refresh token with a
 * different one destroys the old one just as thoroughly as deleting it.
 */

import { GOOGLE_CONFIG_KEYS, GOOGLE_SECRET_KEYS } from './setup-plan.js';
import type { GoogleConfigPort, GoogleSecretPort } from './types.js';
import { contentDigest } from '../utils/target-ref.js';

/** Per item shown in a removal question, the digest of the stored value it named (never the value). */
export type GoogleRemovalReview = Readonly<Partial<Record<GoogleCredentialItem, string>>>;

/**
 * Secret storage that can also remove. Deliberately separate from
 * `GoogleSecretPort`: a store with no delete simply cannot perform a removal,
 * and that must be a typed refusal rather than a silent no-op.
 */
export interface GoogleRemovableSecretPort extends GoogleSecretPort {
  delete(key: string): Promise<void>;
}

/** Which stored things a removal would touch. */
export type GoogleCredentialItem = 'refresh-token' | 'client-secret' | 'app-password' | 'calendar-address';

/** Safe-to-display name for each item. Never a value. */
const ITEM_LABELS: Readonly<Record<GoogleCredentialItem, string>> = {
  'refresh-token': 'the Google refresh token (the credential your consent produced)',
  'client-secret': 'the OAuth client secret',
  'app-password': 'the Gmail app password',
  'calendar-address': 'the private calendar address',
};

const ITEM_SECRET_KEYS: Readonly<Record<GoogleCredentialItem, string>> = {
  'refresh-token': GOOGLE_SECRET_KEYS.oauthRefreshToken,
  'client-secret': GOOGLE_SECRET_KEYS.oauthClientSecret,
  'app-password': GOOGLE_SECRET_KEYS.appPassword,
  'calendar-address': GOOGLE_SECRET_KEYS.calendarIcsUrl,
};

/** Nothing has been removed. This is the only thing a first call can return. */
export interface GoogleRemovalPlan {
  readonly confirmed: false;
  readonly removed: readonly [];
  /** The items that WOULD be removed, by safe label. */
  readonly wouldRemove: readonly string[];
  /** One sentence, ending in a question. Show this and wait for a yes. */
  readonly prompt: string;
  /** What the question named, to pass back as `reviewed` with the yes: only those exact values are removed. */
  readonly reviewed: GoogleRemovalReview;
}

/** Something was actually removed, and this says exactly what. */
export interface GoogleRemovalDone {
  readonly confirmed: true;
  readonly removed: readonly string[];
  readonly wouldRemove: readonly [];
  readonly detail: string;
}

/** The removal could not run at all. Nothing was touched. */
export interface GoogleRemovalRefused {
  readonly confirmed: false;
  readonly removed: readonly [];
  readonly wouldRemove: readonly [];
  readonly prompt: string;
  readonly refused: true;
}

/** The store failed part way: `removed` is what is already gone, `wouldRemove` what is still there. */
export interface GoogleRemovalPartial {
  readonly confirmed: true;
  readonly removed: readonly string[];
  readonly wouldRemove: readonly string[];
  readonly detail: string;
  readonly partial: true;
}

export type GoogleRemovalResult = GoogleRemovalPlan | GoogleRemovalDone | GoogleRemovalRefused | GoogleRemovalPartial;

export interface GoogleRemovalRequest {
  readonly items: readonly GoogleCredentialItem[];
  /**
   * The owner's explicit yes, for this exact removal.
   *
   * Defaults to false and there is no way to default it to true. A caller that
   * wants a removal to happen has to pass this deliberately, which means the
   * decision is always written down at the call site.
   */
  readonly confirmed?: boolean;
  /** Why the removal was proposed, quoted back in the prompt. */
  readonly reason?: string;
  /**
   * The plan's `reviewed`, when the yes answers a question that was shown:
   * an item whose stored value was replaced since (a new setup) is kept, not
   * removed, and the result says so.
   */
  readonly reviewed?: GoogleRemovalReview | undefined;
}

export interface GoogleRemovalDeps {
  readonly secrets: GoogleSecretPort;
  readonly config: GoogleConfigPort;
}

function isRemovable(secrets: GoogleSecretPort): secrets is GoogleRemovableSecretPort {
  return typeof (secrets as Partial<GoogleRemovableSecretPort>).delete === 'function';
}

/** The digest of a stored, non-empty secret, or null when there is none; throws when the store cannot be read. Never returns the value. */
async function secretDigest(secrets: GoogleSecretPort, key: string): Promise<string | null> {
  const value = await secrets.get(key);
  return typeof value === 'string' && value.trim().length > 0 ? contentDigest(value) : null;
}

function buildPrompt(labels: readonly string[], reason: string | undefined): string {
  const list =
    labels.length === 1
      ? labels[0]
      : `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
  const because = reason === undefined || reason.trim().length === 0 ? '' : ` ${reason.trim()}`;
  return (
    `This would permanently remove ${list} from the encrypted store, and re-approving a consent screen is the only way to get it back.${because}`
    + ' Do you want me to remove it?'
  );
}

/**
 * Remove stored Google credentials, but only with an explicit yes.
 *
 * Called without `confirmed`, this changes nothing and hands back the sentence
 * to put in front of the owner. Called with `confirmed: true`, it removes the
 * items that are actually present and reports each one by name.
 */
export async function removeGoogleCredentials(
  deps: GoogleRemovalDeps,
  request: GoogleRemovalRequest,
): Promise<GoogleRemovalResult> {
  const present: GoogleCredentialItem[] = [];
  const digests: Partial<Record<GoogleCredentialItem, string>> = {};
  for (const item of request.items) {
    try {
      const digest = await secretDigest(deps.secrets, ITEM_SECRET_KEYS[item]);
      if (digest !== null) { present.push(item); digests[item] = digest; }
    } catch {
      // An unreadable store is not an empty one: saying "nothing is stored"
      // would send the owner to set up again over credentials that are there.
      return {
        confirmed: false,
        removed: [],
        wouldRemove: [],
        refused: true,
        prompt: 'The encrypted store could not be read, so nothing was removed and it is not known what is stored. Unlock or repair the store, then ask again.',
      };
    }
  }

  if (present.length === 0) {
    return {
      confirmed: true,
      removed: [],
      wouldRemove: [],
      detail: 'Nothing was removed, none of those credentials are stored on this machine.',
    };
  }

  const labels = present.map((item) => ITEM_LABELS[item]);

  if (request.confirmed !== true) {
    return {
      confirmed: false,
      removed: [],
      wouldRemove: labels,
      prompt: buildPrompt(labels, request.reason),
      reviewed: Object.freeze({ ...digests }),
    };
  }

  // Answering a question that was shown: only the values it named are removed.
  const reviewed = request.reviewed;
  const replaced = reviewed ? present.filter((item) => reviewed[item] !== digests[item]) : [];
  const removable = present.filter((item) => !replaced.includes(item));
  const keptNote = replaced.length > 0
    ? ` Kept ${replaced.map((item) => ITEM_LABELS[item]).join(', ')}: ${replaced.length === 1 ? 'it was' : 'they were'} stored or replaced after you were asked, so ${replaced.length === 1 ? 'it is' : 'they are'} not what you agreed to remove; ask again to remove ${replaced.length === 1 ? 'it' : 'them'}.`
    : '';
  if (removable.length === 0) {
    return { confirmed: true, removed: [], wouldRemove: [], detail: `Nothing was removed.${keptNote}` };
  }

  if (!isRemovable(deps.secrets)) {
    return {
      confirmed: false,
      removed: [],
      wouldRemove: [],
      refused: true,
      prompt: 'This secret store cannot remove values, so nothing was changed. Remove the credential with the tool that owns the store.',
    };
  }

  const secrets = deps.secrets;
  const removed: string[] = [];
  const unclearedRefs: string[] = [];
  for (const item of removable) {
    try {
      await secrets.delete(ITEM_SECRET_KEYS[item]);
    } catch {
      return {
        confirmed: true,
        removed,
        wouldRemove: removable.filter((rest) => !removed.includes(ITEM_LABELS[rest])).map((rest) => ITEM_LABELS[rest]),
        partial: true,
        detail:
          `Removal stopped at ${ITEM_LABELS[item]}, which the store would not delete. `
          + `${removed.length === 0 ? 'Nothing was removed.' : `Already removed: ${removed.join(', ')}.`} Ask again to remove the rest.`,
      };
    }
    removed.push(ITEM_LABELS[item]);
    // The config reference is cleared alongside the value it points at, or the
    // machine is left claiming a credential that is no longer there.
    // A failed clear is reported with what was removed, never thrown past the receipt.
    const ref = item === 'client-secret' ? GOOGLE_CONFIG_KEYS.oauthClientSecretRef
      : item === 'app-password' ? GOOGLE_CONFIG_KEYS.emailPassword
      : item === 'calendar-address' ? GOOGLE_CONFIG_KEYS.calendarIcsUrl : null;
    if (ref !== null) {
      try { deps.config.set(ref, ''); } catch { unclearedRefs.push(ref); }
    }
  }

  return {
    confirmed: true,
    removed,
    wouldRemove: [],
    detail: `Removed ${removed.join(', ')} from the encrypted store. Nothing else was touched.${unclearedRefs.length > 0 ? ` The setting${unclearedRefs.length === 1 ? '' : 's'} ${unclearedRefs.join(', ')} still point${unclearedRefs.length === 1 ? 's' : ''} at the removed value and could not be cleared; clear ${unclearedRefs.length === 1 ? 'it' : 'them'} with /settings.` : ''}${keptNote}`,
  };
}
