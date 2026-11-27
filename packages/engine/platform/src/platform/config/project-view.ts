/**
 * project-view.ts, the host's settings as one project's turn reads them.
 *
 * A turn the daemon runs in a project (a web chat, a schedule, a hosted or handed-off turn, a unit of planned work)
 * is driven by engine code that asks its settings manager two things the daemon's one manager answers for the
 * daemon's own folder, which is none of the projects:
 *
 *  - the folder it works in: the folder line of its environment facts, the project its memory is read for, where its
 *    verification record and its completed work are kept. The view answers the project's folder.
 *  - the project's own settings layer: the project's one settings file (`<project>/.goodvibes/settings.json`, the file
 *    every program of the project reads and writes, project-settings-file.ts), admitted by the
 *    same rule a program's own project layer is (config/project-layer-restrictions.ts: only keys declared settable
 *    from a project, and a permission posture only in the stricter direction; a credential only as a named key in
 *    the owner's store). Read again when the file changes; a key the layer sets answers from it, every other key from
 *    the host's manager, live.
 *
 * Writes, watches and everything else go to the host's manager unchanged: a project's turn changes the owner's
 * settings exactly as any other turn of the host does. Made once per project (the daemon's project facilities hold
 * it) and reused by every turn there.
 */
import { readFileSync, statSync } from 'node:fs';
import type { ConfigManager } from './manager.js';
import { restrictProjectLayer } from './project-layer-restrictions.js';
import { carryProjectSettingsOnce, describeProjectSettingsCarry, projectSettingsFileOf } from './project-settings-file.js';
import { FeatureAnnouncementStore, featureAnnouncementsPath } from '../runtime/feature-announcements.js';
import { readDotPath } from './shared-config-tier.js';
import { projectIdentityOf } from '../workspace/project-identity.js';
import { logger } from '../utils/logger.js';
import { summarizeError } from '../utils/error-display.js';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** `over` laid on `under`, object by object; a value of `over` that is not an object replaces. */
function layered(under: unknown, over: unknown): unknown {
  if (!isPlainObject(under) || !isPlainObject(over)) return over;
  const out: Record<string, unknown> = { ...under };
  for (const [key, value] of Object.entries(over)) out[key] = layered(under[key], value);
  return out;
}

export interface ProjectConfigViewOptions {
  /**
   * The project's settings file (absolute); absent, the project's ONE settings file every program reads
   * (`<project>/.goodvibes/settings.json`, project-settings-file.ts), with the programs' old files carried into it once.
   * `null`: no project layer.
   */
  readonly layerFile?: string | null | undefined;
}

/** Each view's own layer reader, for the feature-flag view below. */
const layerReaders = new WeakMap<object, (key: string) => { readonly present: boolean; readonly value: unknown }>();

/**
 * A feature-flag reader for turns in a project: a flag whose state is a setting (`settings.key` in its declaration,
 * such as `exec-sandbox` and `sandbox.enabled`) follows the project's own layer when the layer sets that key, as the
 * setting itself does in `view`; every other flag is the host's.
 */
export function projectFeatureFlags<Flags extends { isEnabled(flag: string): boolean }>(
  base: Flags,
  view: ConfigManager,
  settingOf: (flag: string) => string | undefined,
): Flags {
  const layer = layerReaders.get(view);
  if (!layer) return base;
  return new Proxy(base, {
    get(target, property) {
      if (property === 'isEnabled') {
        return (flag: string): boolean => {
          const key = settingOf(flag);
          const own = key ? layer(key) : undefined;
          return own?.present ? own.value === true : target.isEnabled(flag);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** `base` as a turn in `folder` reads it. See the module header. */
export function projectConfigView(base: ConfigManager, folder: string, options: ProjectConfigViewOptions = {}): ConfigManager {
  const file = options.layerFile === null ? undefined : options.layerFile ?? projectSettingsFileOf(folder);
  if (options.layerFile === undefined) {
    try {
      const carried = carryProjectSettingsOnce(folder);
      if (carried) logger.info('[settings] the programs\' project settings files were carried into the project\'s one file', { file: carried.file, from: carried.carriedFrom, differed: carried.differed.map((entry) => entry.key) });
      // The owner is told once which keys the programs' files set differently, as a program's own carry tells him
      // (manager.ts migrationReceipt: the same announce-once store, delivered to the next surface that reads it).
      if (carried && carried.differed.length > 0) {
        new FeatureAnnouncementStore(featureAnnouncementsPath(base)).record(`carried-forward:project-settings:${carried.file}`, describeProjectSettingsCarry(carried));
      }
    } catch (error) {
      logger.warn('[settings] the programs\' project settings files could not be carried into the project\'s one file; its turns read it as it is', { folder, error: summarizeError(error) });
    }
  }
  let read: { readonly stamp: string; readonly layer: Record<string, unknown> } | undefined;
  // The host's configuration incarnation: every change of the host's settings (a set, a reload of its file, a save)
  // moves it. The layer is admitted against the host's values, so it is admitted again when either moves: a host value
  // tightened later makes a project value that was stricter then and is looser now stop counting at once.
  const hostRevision = typeof (base as { getConfigurationIncarnation?: unknown }).getConfigurationIncarnation === 'function'
    ? (): number => base.getConfigurationIncarnation()
    : (): number => Number.NaN;
  /** The admitted layer, read again when the file's size or time or the host's settings change; empty when there is none. */
  const layer = (): Record<string, unknown> => {
    if (!file) return {};
    let stamp = 'absent';
    try { const stat = statSync(file); stamp = `${stat.mtimeMs}:${stat.size}`; } catch { /* no file: no layer */ }
    stamp = `${stamp}:${hostRevision()}`;
    if (read?.stamp === stamp) return read.layer;
    let admitted: Record<string, unknown> = {};
    if (!stamp.startsWith('absent:')) {
      try {
        const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
        if (isPlainObject(parsed)) {
          const restricted = restrictProjectLayer(structuredClone(parsed), base.getRaw(), file);
          admitted = restricted.layer;
          for (const notice of restricted.notices) logger.info('[settings] a project setting was not applied to the daemon\'s turns there', { file, key: notice.key, reason: notice.reason });
        }
      } catch (error) {
        logger.warn('[settings] a project\'s settings file could not be read; its turns use the daemon\'s settings', { file, error: summarizeError(error) });
      }
    }
    read = { stamp, layer: admitted };
    return admitted;
  };
  const view = new Proxy(base, {
    get(target, property) {
      if (property === 'getWorkingDirectory') return (): string => folder;
      if (property === 'get') {
        return (key: string): unknown => {
          const own = readDotPath(layer(), key);
          return own.present ? own.value : (target.get as (key: string) => unknown)(key);
        };
      }
      if (property === 'getCategory') {
        return (category: string): unknown => {
          const own = readDotPath(layer(), category);
          const host = (target.getCategory as (category: string) => unknown)(category);
          return own.present ? layered(host, own.value) : host;
        };
      }
      if (property === 'getRaw' || property === 'getAll') {
        return (): unknown => {
          const own = layer();
          const host = (target[property] as () => unknown).call(target);
          return Object.keys(own).length === 0 ? host : layered(host, own);
        };
      }
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
  layerReaders.set(view, (key) => readDotPath(layer(), key));
  return view;
}

/** What the project's own file sets for `key` in a view (admitted, so never looser than the host's), else undefined. */
export function projectLayerSetting(view: ConfigManager, key: string): unknown {
  const own = layerReaders.get(view)?.(key);
  return own?.present ? own.value : undefined;
}

/** The views of {@link projectSettingsInForce}, per host manager and project; the oldest goes past this many projects. */
const IN_FORCE_VIEWS = 64;
const inForceViews = new WeakMap<object, Map<string, ConfigManager>>();

/**
 * The settings in force for the project `folder` belongs to (its one project identity): the host's settings with the
 * project's own file over them, a protection only ever stricter (the rule of {@link projectConfigView}). The ONE reader
 * of them for that host: the daemon's permission manager decides a call made for the project with it
 * (permissions/manager.ts `createPermissionConfigReader`), the project's turns and the security review read it, so a
 * web chat, a schedule, a trigger, a runner, a hosted session, a channel turn and a step of Work in the project are
 * decided under the same settings a terminal program opened there reads. Made on first ask and reused.
 */
export function projectSettingsInForce(base: ConfigManager, folder: string): ConfigManager {
  const project = projectIdentityOf(folder);
  let views = inForceViews.get(base);
  if (!views) { views = new Map(); inForceViews.set(base, views); }
  let view = views.get(project);
  if (view) return view;
  view = projectConfigView(base, project);
  views.set(project, view);
  while (views.size > IN_FORCE_VIEWS) views.delete(views.keys().next().value!);
  return view;
}
