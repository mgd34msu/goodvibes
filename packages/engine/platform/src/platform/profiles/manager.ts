import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync } from 'fs';
import { RefusalError, refusal } from '@goodvibes/engine/errors';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { join } from 'path';
import { logger } from '../utils/logger.js';
import type { GoodVibesConfig } from '../config/schema.js';
import { summarizeError } from '../utils/error-display.js';
import { storedNameStem } from '../utils/stored-name.js';

/**
 * ProfileData - host-specific settings stored in a profile.
 * Excludes permissions and API keys, only display/behavior/provider settings.
 */
export interface ProfileData {
  display?: Partial<GoodVibesConfig['display']> | undefined;
  provider?: Pick<GoodVibesConfig['provider'], 'model' | 'reasoningEffort'> | undefined;
  behavior?: Partial<GoodVibesConfig['behavior']> | undefined;
}

/**
 * ProfileInfo - Summary of a saved profile.
 */
export interface ProfileInfo {
  name: string;
  timestamp: number;
  filePath: string;
}

/**
 * ProfileManager - Save and load named platform host config profiles.
 *
 * Profiles are stored as JSON files in the configured profile directory.
 * Only host-surface settings (display, provider, behavior categories) are saved;
 * permissions and API keys are never included.
 */
export class ProfileManager {
  private readonly profilesDir: string;
  private lastTimestamp = 0;

  constructor(baseDir: string) {
    this.profilesDir = baseDir;
  }

  public get storagePath(): string {
    return this.profilesDir;
  }

  /**
   * save - Persist a profile under the given name.
   * Overwrites an existing profile with the same name. The profile is stored
   * under `sanitizeName(name)`, so names that differ only in case, spacing or
   * punctuation ("Work Laptop", "work-laptop") are one profile. A name of
   * which nothing can be stored is refused (see storedName).
   */
  public save(name: string, data: ProfileData): string {
    if (!name || !name.trim()) throw new Error('Profile name cannot be empty');
    const sanitizedName = this.storedName(name);
    // Storing it under the fallback name would silently overwrite whatever
    // profile already has that name.
    if (sanitizedName === undefined) {
      throw new RefusalError(refusal({
        code: 'PROFILE_NAME_UNSTORABLE',
        state: 'the profile was not saved',
        reason: `Profile name "${name}" keeps no characters once stored (letters and digits of any script, "-" and "_" are kept), so it was not saved; use a name with at least one letter or digit`,
        next: ['Save again under a name with at least one letter or digit'],
      }));
    }
    mkdirSync(this.profilesDir, { recursive: true });
    const filePath = join(this.profilesDir, `${sanitizedName}.json`);
    const record = {
      name: sanitizedName,
      timestamp: this.nextTimestamp(),
      display: data.display ?? {},
      provider: data.provider ?? {},
      behavior: data.behavior ?? {},
    };
    writeJsonFileAtomic(filePath, record, { trailingNewline: false });
    logger.debug('ProfileManager: saved profile', { name: sanitizedName, filePath });
    return filePath;
  }

  /**
   * load - Load a profile by name. Returns the profile data or throws if not found.
   */
  public load(name: string): { data: ProfileData; timestamp: number } {
    if (!name || !name.trim()) throw new Error('Profile name cannot be empty');
    const sanitizedName = this.sanitizeName(name);
    const filePath = join(this.profilesDir, `${sanitizedName}.json`);
    if (!existsSync(filePath)) {
      throw new Error(`Profile not found: ${name}`);
    }
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const record = JSON.parse(raw) as Record<string, unknown>;
      return {
        timestamp: Number(record.timestamp ?? 0),
        data: {
          display: (record.display as Partial<GoodVibesConfig['display']>) ?? {},
          provider: record.provider as Pick<GoodVibesConfig['provider'], 'model' | 'reasoningEffort'>,
          behavior: (record.behavior as Partial<GoodVibesConfig['behavior']>) ?? {},
        },
      };
    } catch (e) {
      throw new Error(`Failed to parse profile "${name}": ${summarizeError(e)}`);
    }
  }

  /**
   * list - Return all saved profiles sorted by most recent first.
   */
  public list(): ProfileInfo[] {
    if (!existsSync(this.profilesDir)) return [];
    let files: string[];
    try {
      files = readdirSync(this.profilesDir).filter(f => f.endsWith('.json'));
    } catch (err) {
      logger.warn('ProfileManager: failed to list profiles directory', { dir: this.profilesDir, error: summarizeError(err) });
      return [];
    }
    const profiles: ProfileInfo[] = [];
    for (const file of files) {
      const name = file.replace(/\.json$/, '');
      // load() and delete() address a profile by its sanitized name, so a file
      // under any other name could be listed but never opened or removed.
      if (this.sanitizeName(name) !== name) {
        logger.warn('ProfileManager: ignoring a profile file whose name is not a stored profile name', { file });
        continue;
      }
      const filePath = join(this.profilesDir, file);
      let timestamp = 0;
      try {
        const raw = readFileSync(filePath, 'utf-8');
        const record = JSON.parse(raw) as Record<string, unknown>;
        timestamp = Number(record.timestamp ?? 0);
      } catch (err) {
        logger.warn('ProfileManager: skipping unreadable profile file', { file, error: summarizeError(err) });
        continue;
      }
      profiles.push({ name, timestamp, filePath });
    }
    profiles.sort((a, b) => {
      if (b.timestamp !== a.timestamp) return b.timestamp - a.timestamp;
      return b.name.localeCompare(a.name);
    });
    return profiles;
  }

  private nextTimestamp(): number {
    const now = Date.now();
    this.lastTimestamp = now > this.lastTimestamp ? now : this.lastTimestamp + 1;
    return this.lastTimestamp;
  }

  /**
   * delete - Remove a profile by name. Returns true if deleted, false if there
   * is no such profile; throws when the file exists but cannot be removed.
   */
  public delete(name: string): boolean {
    if (!name || !name.trim()) return false;
    const sanitizedName = this.sanitizeName(name);
    const filePath = join(this.profilesDir, `${sanitizedName}.json`);
    try {
      unlinkSync(filePath);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      logger.warn('ProfileManager: failed to delete profile', { filePath, error: summarizeError(err) });
      throw new Error(`Failed to delete profile "${name}": ${summarizeError(err)}`);
    }
  }

  /**
   * sanitizeName - Safe filename from profile name; 'profile' when nothing of
   * the name can be stored.
   */
  public sanitizeName(name: string): string {
    return this.storedName(name) ?? 'profile';
  }

  /**
   * storedName - The name a profile is stored under, or undefined when none
   * of its characters can be stored. The one test save() and imports use to
   * refuse a name before anything is written.
   */
  public storedName(name: string): string | undefined {
    const stored = storedNameStem(name);
    return stored === '' ? undefined : stored;
  }
}
