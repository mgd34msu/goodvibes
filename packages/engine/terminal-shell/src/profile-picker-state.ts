/**
 * ProfilePickerModal, state management for the /presets picker modal.
 *
 * Lists profiles from ProfileManager.list(), tracks selected index,
 * and handles load/delete/save actions.
 */
import { PROFILE_SETTING_KEYS, type ProfileInfo, type ProfileData, type ProfileManager } from '@goodvibes/engine/platform/platform/profiles';
import { logger } from '@goodvibes/engine/platform/platform/utils';
import type { ConfigManager, ConfigKey } from '@goodvibes/engine/platform/platform/config';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
/**
 * The settings a profile carries come from the one list in the profiles
 * module; saving and loading read it, so whatever is saved is what a load restores.
 */
function profileKeys(section: 'display' | 'behavior'): readonly ConfigKey[] {
  return PROFILE_SETTING_KEYS.filter((key) => key.startsWith(`${section}.`));
}
const DISPLAY_KEYS = profileKeys('display');
const BEHAVIOR_KEYS = profileKeys('behavior');
/** The provider settings a profile carries (the model and its reasoning effort). */
const PROVIDER_FIELDS: ReadonlySet<string> = new Set(
  PROFILE_SETTING_KEYS.filter((key) => key.startsWith('provider.')).map((key) => key.slice('provider.'.length)),
);
interface ProfileApplyOutcome {
  readonly applied: string[];
  readonly failed: string[];
  /** Keys in the file that a profile does not carry (older or newer release, or approval settings). */
  readonly skipped: string[];
}
/**
 * Apply a profile data category to the config manager.
 * Iterates only known/valid keys rather than open-ended Object.entries.
 */
function applyProfileCategory(cm: ConfigManager, section: 'display' | 'behavior', data: object, keys: readonly ConfigKey[], outcome: ProfileApplyOutcome): void {
  const known = new Set(keys.map((key) => key.split('.')[1]));
  for (const field of Object.keys(data)) if (!known.has(field)) outcome.skipped.push(`${section}.${field}`);
  for (const key of keys) {
    const field = key.split('.')[1];
    if (field && Object.prototype.hasOwnProperty.call(data, field)) {
      try {
        cm.setDynamic(key, Reflect.get(data, field));
        outcome.applied.push(key);
      } catch (e) {
        logger.debug('applyProfileCategory: key set failed', { key, error: summarizeError(e) });
        outcome.failed.push(key);
      }
    }
  }
}
// ---------------------------------------------------------------------------
// ProfilePickerModal
// ---------------------------------------------------------------------------
export interface ProfilePickerPolicy {
  readonly rejectLoad?: ((data: ProfileData) => string | undefined) | undefined;
  readonly deletionDisabled?: ((name: string) => string) | undefined;
  readonly savingDisabled?: ((name: string) => string) | undefined;
  readonly loadedPrefix?: string | undefined;
  readonly savedPrefix?: string | undefined;
  readonly errorPrefix?: string | undefined;
}
export class ProfilePickerModal {
  public active = false;
  public profiles: ProfileInfo[] = [];
  public selectedIndex = 0;
  public scrollOffset = 0;
  public visibleRows = 8;
  public deleteConfirmationTarget: string | null = null;
  /** Last status message (success/error feedback). */
  public statusMessage = '';
  /** The always-live search row's query; selectedIndex indexes visibleProfiles. */
  public query = '';
  public constructor(
    private readonly profileManager: ProfileManager,
    private readonly policy: ProfilePickerPolicy = {},
  ) {}
  /**
   * Open the modal, loading profiles from ProfileManager.
   */
  open(): void {
    this.profiles = this.profileManager.list();
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
    this.query = '';
    this.active = true;
  }
  close(): void {
    this.active = false;
    this.statusMessage = '';
    this.deleteConfirmationTarget = null;
    this.query = '';
  }
  /** The profiles the search row lets through, in order. */
  get visibleProfiles(): ProfileInfo[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.profiles;
    return this.profiles.filter((profile) => profile.name.toLowerCase().includes(q));
  }
  /** Replace the query; the selection moves to the first match and any armed delete is dropped. */
  setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
    this.scrollOffset = 0;
    this.deleteConfirmationTarget = null;
  }
  /** Esc's first level: drop an armed delete. Returns true when one was armed. */
  cancelDeleteConfirmation(): boolean {
    if (this.deleteConfirmationTarget === null) return false;
    this.deleteConfirmationTarget = null;
    this.statusMessage = '';
    return true;
  }
  moveUp(): void {
    const n = this.visibleProfiles.length;
    if (n === 0) return;
    this.selectedIndex = (this.selectedIndex - 1 + n) % n;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }
  moveDown(): void {
    const n = this.visibleProfiles.length;
    if (n === 0) return;
    this.selectedIndex = (this.selectedIndex + 1) % n;
    this._clampScroll();
    this.deleteConfirmationTarget = null;
  }
  setVisibleRows(rows: number): void {
    this.visibleRows = Math.max(3, rows);
    this._clampScroll();
  }
  getSelected(): ProfileInfo | null {
    return this.visibleProfiles[this.selectedIndex] ?? null;
  }
  /**
   * Load the selected profile into configManager.
   * Returns true only when every setting the profile carries was applied;
   * a setting the config rejects is named in the status message and returns false.
   */
  loadSelected(configManager: ConfigManager): boolean {
    const profile = this.getSelected();
    if (!profile) return false;
    try {
      const { data } = this.profileManager.load(profile.name);
      const refusal = this.policy.rejectLoad?.(data);
      if (refusal) {
        this.statusMessage = refusal;
        return false;
      }
      const outcome: ProfileApplyOutcome = { applied: [], failed: [], skipped: [] };
      // Apply display settings using validated key list
      if (data.display) {
        applyProfileCategory(configManager, 'display', data.display, DISPLAY_KEYS, outcome);
      }
      // Apply provider settings (model + reasoningEffort only); any other provider setting in the file is named as not applied.
      if (data.provider) {
        for (const field of Object.keys(data.provider)) if (!PROVIDER_FIELDS.has(field)) outcome.skipped.push(`provider.${field}`);
        if (data.provider.model !== undefined) {
          try {
            configManager.set('provider.model', data.provider.model);
            outcome.applied.push('provider.model');
          } catch (e) {
            outcome.failed.push('provider.model');
            logger.debug('profile: model set failed', { error: summarizeError(e) });
          }
        }
        if (data.provider.reasoningEffort !== undefined) {
          try {
            configManager.set('provider.reasoningEffort', data.provider.reasoningEffort);
            outcome.applied.push('provider.reasoningEffort');
          } catch (e) {
            outcome.failed.push('provider.reasoningEffort');
            logger.debug('profile: reasoningEffort set failed', { error: summarizeError(e) });
          }
        }
      }
      // Apply behavior settings using validated key list
      if (data.behavior) {
        applyProfileCategory(configManager, 'behavior', data.behavior, BEHAVIOR_KEYS, outcome);
      }
      if (outcome.failed.length > 0) {
        // Each applied key was saved by its own write; a partial load keeps what did apply.
        this.statusMessage = `${this.policy.loadedPrefix ?? 'Loaded profile: '}${profile.name} (partial: could not apply ${outcome.failed.join(', ')})`;
        if (outcome.applied.length === 0) this.statusMessage = `${this.policy.errorPrefix ?? 'Error: '}profile ${profile.name} was not loaded; the config rejected ${outcome.failed.join(', ')}`;
        return false;
      }
      const skipped = outcome.skipped.length > 0 ? ` (not applied, this release does not take them from a profile: ${outcome.skipped.join(', ')})` : '';
      this.statusMessage = `${this.policy.loadedPrefix ?? 'Loaded profile: '}${profile.name}${skipped}`;
      return true;
    } catch (e) {
      this.statusMessage = `${this.policy.errorPrefix ?? 'Error: '}${summarizeError(e)}`;
      return false;
    }
  }
  /**
   * Delete the selected profile from disk.
   * Refreshes the list after deletion.
   */
  deleteSelected(): boolean {
    const profile = this.getSelected();
    if (!profile) return false;
    if (this.policy.deletionDisabled) {
      this.deleteConfirmationTarget = null;
      this.statusMessage = this.policy.deletionDisabled(profile.name);
      return false;
    }
    if (this.deleteConfirmationTarget !== profile.name) {
      this.deleteConfirmationTarget = profile.name;
      this.statusMessage = `Press delete again to remove profile: ${profile.name}`;
      return false;
    }
    try {
      const deleted = this.profileManager.delete(profile.name);
      if (!deleted) {
        this.statusMessage = `Profile not found: ${profile.name}`;
        this.deleteConfirmationTarget = null;
        return false;
      }
      this.profiles = this.profileManager.list();
      if (this.selectedIndex >= this.visibleProfiles.length) {
        this.selectedIndex = Math.max(0, this.visibleProfiles.length - 1);
      }
      this._clampScroll();
      this.deleteConfirmationTarget = null;
      this.statusMessage = `Deleted: ${profile.name}`;
      return true;
    } catch (e) {
      this.deleteConfirmationTarget = null;
      this.statusMessage = `${this.policy.errorPrefix ?? 'Error: '}${summarizeError(e)}`;
      return false;
    }
  }
  /**
   * Save the current config settings as a new profile under `name`.
   */
  saveCurrentAs(name: string, configManager: ConfigManager): boolean {
    if (!name || !name.trim()) {
      this.statusMessage = 'Profile name cannot be empty';
      return false;
    }
    if (this.policy.savingDisabled) {
      this.statusMessage = this.policy.savingDisabled(name);
      return false;
    }
    return this.saveCurrentProfile(name, configManager);
  }
  protected saveCurrentProfile(name: string, configManager: ConfigManager): boolean {
    if (!name || !name.trim()) {
      this.statusMessage = 'Profile name cannot be empty';
      return false;
    }
    try {
      const section = (keys: readonly ConfigKey[]): Record<string, unknown> =>
        Object.fromEntries(keys.map((key) => [key.split('.')[1]!, configManager.get(key)]));
      const data: ProfileData = {
        display: section(DISPLAY_KEYS) as unknown as NonNullable<ProfileData['display']>,
        provider: {
          model: configManager.get('provider.model'),
          reasoningEffort: configManager.get('provider.reasoningEffort'),
        },
        behavior: section(BEHAVIOR_KEYS) as unknown as NonNullable<ProfileData['behavior']>,
      };
      this.profileManager.save(name, data);
      // Reload list
      this.profiles = this.profileManager.list();
      this.statusMessage = `${this.policy.savedPrefix ?? 'Saved profile: '}${name}`;
      this._clampScroll();
      return true;
    } catch (e) {
      this.statusMessage = `${this.policy.errorPrefix ?? 'Error: '}${summarizeError(e)}`;
      return false;
    }
  }
  private _clampScroll(): void {
    const visRows = Math.max(3, this.visibleRows);
    if (this.selectedIndex < this.scrollOffset) {
      this.scrollOffset = this.selectedIndex;
    } else if (this.selectedIndex >= this.scrollOffset + visRows) {
      this.scrollOffset = this.selectedIndex - visRows + 1;
    }
    const maxOffset = Math.max(0, this.visibleProfiles.length - visRows);
    this.scrollOffset = Math.max(0, Math.min(this.scrollOffset, maxOffset));
  }
}
