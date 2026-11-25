/**
 * provider-stores-carry-forward.ts: the Agent's own provider stores carried
 * into the daemon's once, at the daemon's first start of this release.
 *
 * Up to 3.5.0 the Agent kept its own pinned models (`~/.goodvibes/agent/favorites.json`),
 * its own providers of your own (`~/.goodvibes/agent/providers/*.json`), its own
 * services file (`~/.goodvibes/agent/services.json`) and its own context window
 * sizes (`~/.goodvibes/agent/context-window-overrides.json`); the terminal app's were the
 * daemon's already (its stores sit under the daemon's root, `tui`). From this
 * release every program reads the daemon's (runtime/services.ts
 * `providerStoresRoot`), so what only the Agent held is copied there:
 *
 *  - a pin the daemon does not hold is added (with when it was pinned);
 *  - a provider file of a name the daemon's folder does not have is copied; one
 *    whose name it has with other content is not, and the owner is told which;
 *  - a service of a name the daemon's file does not list is added; one listed
 *    with other settings is not, and the owner is told which.
 *
 * Nothing is removed and the Agent's own files are not written, so a return to
 * 3.5.0 finds them as they were. A record of names only
 * (`<daemon home>/provider-stores-carried-forward.json`) makes it once; it is
 * written after every copy landed, so a start that stops part way copies again.
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeJsonFileAtomic } from '../utils/atomic-json-store.js';
import { FavoritesStore } from '../providers/favorites.js';
import { resolveSurfaceDirectory } from '../runtime/surface-root.js';
import { getContextWindowOverridesPath, loadContextWindowOverrides, saveContextWindowOverrides } from '../providers/context-window-overrides.js';
import { noteListChanged } from '../runtime/list-changes.js';

/** The daemon's own root for these stores (the terminal app's, for a historical reason: daemon/lifecycle-marker.ts). */
const DAEMON_ROOT = 'tui';
/** The program whose own copies are carried. */
const AGENT_ROOT = 'agent';

export interface ProviderStoresCarryForward {
  /** Pins added to the daemon's favourites. */
  readonly pins: readonly string[];
  /** Provider files copied into the daemon's providers folder. */
  readonly providers: readonly string[];
  /** Provider files of a name the daemon already has, with other content: left where they are. */
  readonly providersDiffering: readonly string[];
  /** Services added to the daemon's services file. */
  readonly services: readonly string[];
  /** Services of a name the daemon's file already lists, with other settings: left where they are. */
  readonly servicesDiffering: readonly string[];
  /** Models whose context window size the Agent had set, added to the daemon's file. */
  readonly contextWindows: readonly string[];
  /** Models the daemon's file already sizes differently: the daemon's size is kept. */
  readonly contextWindowsDiffering: readonly string[];
}

export interface ProviderStoresCarryForwardOptions {
  /** The owner's home directory (the folder `.goodvibes` sits in). */
  readonly homeDirectory: string;
  /** Where the daemon keeps its own records (`~/.goodvibes/daemon`). */
  readonly daemonHome: string;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
  return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
}

/** Carry the Agent's own pins, providers of your own and services into the daemon's, once. Undefined when nothing was done. */
export async function carryAgentProviderStoresToDaemon(options: ProviderStoresCarryForwardOptions): Promise<ProviderStoresCarryForward | undefined> {
  const recordPath = join(options.daemonHome, 'provider-stores-carried-forward.json');
  if (existsSync(recordPath)) return undefined;
  const agentDir = resolveSurfaceDirectory(options.homeDirectory, AGENT_ROOT);
  const daemonDir = resolveSurfaceDirectory(options.homeDirectory, DAEMON_ROOT);
  const pins: string[] = [];
  const providers: string[] = [];
  const providersDiffering: string[] = [];
  const services: string[] = [];
  const servicesDiffering: string[] = [];

  // Pinned models: added, never replaced; the use history stays each program's (a turn records it as it runs).
  if (existsSync(join(agentDir, 'favorites.json'))) {
    const agentPins = (await new FavoritesStore({ dir: agentDir }).load()).pinned;
    if (agentPins.length > 0) {
      const daemonStore = new FavoritesStore({ dir: daemonDir });
      const daemonData = await daemonStore.load();
      const held = new Set(daemonData.pinned.map((entry) => entry.registryKey));
      const added = agentPins.filter((entry) => !held.has(entry.registryKey));
      if (added.length > 0) {
        await daemonStore.save({ ...daemonData, pinned: [...daemonData.pinned, ...added] });
        pins.push(...added.map((entry) => entry.registryKey));
      }
    }
  }

  // Providers of your own: a file the daemon's folder lacks is copied; the same name with other content is reported.
  const agentProviders = join(agentDir, 'providers');
  if (existsSync(agentProviders)) {
    const daemonProviders = join(daemonDir, 'providers');
    for (const file of readdirSync(agentProviders).filter((name) => name.endsWith('.json'))) {
      const target = join(daemonProviders, file);
      const name = file.slice(0, -'.json'.length);
      if (existsSync(target)) {
        if (readFileSync(target, 'utf-8').trim() !== readFileSync(join(agentProviders, file), 'utf-8').trim()) providersDiffering.push(name);
        continue;
      }
      mkdirSync(daemonProviders, { recursive: true });
      copyFileSync(join(agentProviders, file), target);
      providers.push(name);
    }
  }

  // Services: a name the daemon's file does not list is added; the same name with other settings is reported.
  const agentServices = readJsonObject(join(agentDir, 'services.json'));
  if (agentServices && Object.keys(agentServices).length > 0) {
    const daemonServicesPath = join(daemonDir, 'services.json');
    const daemonServices = readJsonObject(daemonServicesPath) ?? {};
    const merged: Record<string, unknown> = { ...daemonServices };
    for (const [name, entry] of Object.entries(agentServices)) {
      if (Object.hasOwn(daemonServices, name)) {
        if (JSON.stringify(daemonServices[name]) !== JSON.stringify(entry)) servicesDiffering.push(name);
        continue;
      }
      merged[name] = entry;
      services.push(name);
    }
    if (services.length > 0) {
      mkdirSync(daemonDir, { recursive: true });
      writeJsonFileAtomic(daemonServicesPath, merged, { durable: true });
    }
  }

  // Context window sizes (context-window-overrides.json): a size the Agent had set for a model the daemon's file does
  // not size is added; one sized differently there is reported. A learned limit is taken when it is lower, an accepted
  // floor when it is higher (the same rules a provider's answer applies).
  const contextWindows: string[] = [];
  const contextWindowsDiffering: string[] = [];
  const agentWindowsPath = getContextWindowOverridesPath(agentDir);
  if (existsSync(agentWindowsPath)) {
    const agentWindows = loadContextWindowOverrides(agentWindowsPath);
    const daemonWindowsPath = getContextWindowOverridesPath(daemonDir);
    const daemonWindows = loadContextWindowOverrides(daemonWindowsPath);
    let changed = false;
    for (const [key, size] of agentWindows.overrides) {
      const held = daemonWindows.overrides.get(key);
      if (held === undefined) { daemonWindows.overrides.set(key, size); contextWindows.push(key); changed = true; }
      else if (held !== size) contextWindowsDiffering.push(key);
    }
    for (const [key, limit] of agentWindows.observed) {
      const held = daemonWindows.observed.get(key);
      if (held === undefined || limit < held) { daemonWindows.observed.set(key, limit); changed = true; }
    }
    for (const [key, floor] of agentWindows.accepted) {
      const held = daemonWindows.accepted.get(key);
      if (held === undefined || floor > held) { daemonWindows.accepted.set(key, floor); changed = true; }
    }
    if (changed) {
      mkdirSync(daemonDir, { recursive: true });
      saveContextWindowOverrides(daemonWindowsPath, daemonWindows);
      // Every program reads the daemon's file again (providers/registry.ts, terminal-shell context-windows-follow.ts).
      noteListChanged({ list: 'context-windows', change: 'changed' });
    }
  }

  const result: ProviderStoresCarryForward = { pins, providers, providersDiffering, services, servicesDiffering, contextWindows, contextWindowsDiffering };
  mkdirSync(options.daemonHome, { recursive: true });
  // Names only: never a key, a token or a provider's settings.
  writeJsonFileAtomic(recordPath, { version: 1, carriedAt: Date.now(), ...result }, { durable: true });
  const did = pins.length + providers.length + providersDiffering.length + services.length + servicesDiffering.length
    + contextWindows.length + contextWindowsDiffering.length;
  return did > 0 ? result : undefined;
}

/** The one line the owner is told, or undefined when nothing needs saying. */
export function describeProviderStoresCarryForward(carried: ProviderStoresCarryForward): string | undefined {
  const parts: string[] = [];
  if (carried.pins.length > 0) parts.push(`pinned models (${carried.pins.join(', ')})`);
  if (carried.providers.length > 0) parts.push(`providers of your own (${carried.providers.join(', ')})`);
  if (carried.services.length > 0) parts.push(`services (${carried.services.join(', ')})`);
  if (carried.contextWindows.length > 0) parts.push(`context window sizes (${carried.contextWindows.join(', ')})`);
  const kept: string[] = [];
  if (carried.providersDiffering.length > 0) kept.push(`the providers ${carried.providersDiffering.join(', ')}`);
  if (carried.servicesDiffering.length > 0) kept.push(`the services ${carried.servicesDiffering.join(', ')}`);
  if (carried.contextWindowsDiffering.length > 0) kept.push(`the context window sizes of ${carried.contextWindowsDiffering.join(', ')}`);
  if (parts.length === 0 && kept.length === 0) return undefined;
  return [
    parts.length > 0 ? `The Agent's own ${parts.join(', ')} were carried into the daemon's, which every program now uses; the Agent's own files are left as they were.` : '',
    kept.length > 0 ? `Not carried, because the daemon's copy differs: ${kept.join('; ')}. The daemon's are used; the Agent's are left in ~/.goodvibes/agent.` : '',
  ].filter(Boolean).join(' ');
}
