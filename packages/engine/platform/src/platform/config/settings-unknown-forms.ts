/**
 * settings-unknown-forms.ts: the notice for a settings key this build does not
 * know, in a section it does.
 *
 * The synchronous screen (settings-ingestion.ts) collects every such key
 * exactly and leaves it in the file. Each one is announced at load, in every
 * mode: "ignored in silence" is how a migrated setting became a daemon that
 * looked configured and behaved as if it were not. The notice names the
 * nearest known setting of the section when one is close (a typo, a plural, a
 * longer or shorter form of the same name), and otherwise lists the section's
 * known names. Both are decided here by comparing names; no model is asked.
 */
import { knownSettingNamesBySection, type SettingsIngestionNotice, type UnknownSettingKey } from './settings-ingestion.js';

/** At most this many known names are listed when no single one is close. */
const LISTED_NAMES = 12;

/**
 * Edit distance between two names, case-insensitive, counting a swap of two
 * neighbouring letters as one edit (`prot` is one edit from `port`); stops
 * counting past `limit`.
 */
function editDistance(a: string, b: string, limit: number): number {
  const left = a.toLowerCase();
  const right = b.toLowerCase();
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let before: number[] = [];
  let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    let rowMin = i;
    for (let j = 1; j <= right.length; j++) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      let value = Math.min(previous[j]! + 1, current[j - 1]! + 1, previous[j - 1]! + cost);
      if (i > 1 && j > 1 && left[i - 1] === right[j - 2] && left[i - 2] === right[j - 1]) value = Math.min(value, before[j - 2]! + 1);
      current.push(value);
      if (value < rowMin) rowMin = value;
    }
    if (rowMin > limit) return limit + 1;
    before = previous;
    previous = current;
  }
  return previous[right.length]!;
}

/**
 * The known name of `section` that `name` is closest to, or undefined when none
 * is close. Close means a small edit distance for the name's length, or one
 * name extending the other (`clientSecretRef` beside `clientSecret`).
 */
export function nearestKnownSettingName(name: string, known: readonly string[]): string | undefined {
  const limit = Math.max(1, Math.floor(name.length / 3));
  let best: { name: string; distance: number } | undefined;
  for (const candidate of known) {
    const distance = editDistance(name, candidate, limit);
    if (distance <= limit && (best === undefined || distance < best.distance)) best = { name: candidate, distance };
  }
  if (best) return best.name;
  const lower = name.toLowerCase();
  const extended = known
    .filter(candidate => candidate.length >= 3 && (lower.startsWith(candidate.toLowerCase()) || candidate.toLowerCase().startsWith(lower)))
    .sort((a, b) => Math.abs(a.length - name.length) - Math.abs(b.length - name.length));
  return extended[0];
}

/** One skipped-key notice per unknown key: the nearest known setting, or the section's known names. */
export function unknownSettingNotices(file: string, unknownKeys: readonly UnknownSettingKey[]): SettingsIngestionNotice[] {
  const sections = knownSettingNamesBySection();
  return unknownKeys.map((unknown) => {
    const known = [...(sections.get(unknown.section) ?? [])].sort();
    const nearest = nearestKnownSettingName(unknown.name, known);
    const qualify = (name: string) => unknown.section ? `${unknown.section}.${name}` : name;
    const listed = known.slice(0, LISTED_NAMES).join(', ');
    const more = known.length > LISTED_NAMES ? ` and ${known.length - LISTED_NAMES} more` : '';
    return {
      file,
      key: unknown.key,
      action: 'skipped' as const,
      reason: nearest !== undefined
        ? `is not a setting this build knows; did you mean ${qualify(nearest)}`
        : `is not a setting this build knows${known.length > 0 ? `; ${unknown.section || 'this section'} has ${listed}${more}` : ''}`,
      remedy: 'fix the name, or update this component if the key comes from a newer version; the value was left in the file untouched',
    };
  });
}
