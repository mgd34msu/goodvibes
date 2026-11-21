/**
 * The capability guard of a plugin installed from a pinned bundle.
 *
 * A bundle install (catalog.ts `installVerifiedBundle`) writes the grant into
 * the plugin's own directory as {@link BUNDLE_GRANT_FILE}, so it moves with
 * the plugin and no catalog listing or quarantine touches it, and writes the
 * receipt into `<root>/.goodvibes/ecosystem/installed/plugin-<id>.json`. The
 * plugin loader asks here once per load. The grant file decides when it is
 * there; a plugin installed before the grant file existed is read from its
 * receipt, found beside the plugin's install root and matched by entry id. A
 * plugin with neither, or whose receipt names no bundle, is not a bundle and
 * gets no guard.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { PluginCapability } from '../plugins/types.js';
import { ALL_CAPABILITIES } from '../plugins/types.js';
import { createBundleCapabilityGuard, type BundleCapabilityGuard } from './bundle-manifest.js';
import type { EcosystemBundleGrant, EcosystemCatalogEntry, EcosystemInstallReceipt } from './catalog.js';

export type InstalledBundleGuardReading =
  | { readonly kind: 'not-a-bundle' }
  | { readonly kind: 'bundle'; readonly guard: BundleCapabilityGuard }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** The reserved file in a bundle-installed plugin's directory that carries its grant; a bundle may not ship a member of this name. */
export const BUNDLE_GRANT_FILE = '.bundle-grant.json';

/** What {@link BUNDLE_GRANT_FILE} holds: the entry facts and the grant the install recorded. */
export interface InstalledBundleGrantFile {
  readonly version: 1;
  readonly entry: Pick<EcosystemCatalogEntry, 'id' | 'name' | 'version' | 'summary'>;
  readonly bundle: EcosystemBundleGrant;
}

/** Receipt path of a plugin installed under the default layout (see the module comment). */
export function bundleReceiptPathForPluginDirectory(pluginDir: string): string {
  const goodvibesRoot = dirname(dirname(resolve(pluginDir)));
  return join(goodvibesRoot, 'ecosystem', 'installed', `plugin-${basename(pluginDir)}.json`);
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function guardFrom(
  pluginDir: string,
  entry: Partial<Pick<EcosystemCatalogEntry, 'id' | 'name' | 'version' | 'summary'>> | undefined,
  grant: Partial<EcosystemBundleGrant>,
): InstalledBundleGuardReading {
  // The guard holds what the bundle declared (granted and withheld at install);
  // the plugin's live trust tier is checked at each start by the loader's grant.
  const runtime = [...new Set([...stringList(grant.granted), ...stringList(grant.withheld)])]
    .filter((cap): cap is PluginCapability => (ALL_CAPABILITIES as readonly string[]).includes(cap));
  const guard = createBundleCapabilityGuard({
    schemaVersion: 1,
    id: entry?.id ?? basename(pluginDir),
    name: entry?.name ?? basename(pluginDir),
    version: entry?.version ?? '',
    description: entry?.summary ?? '',
    kind: 'plugin',
    capabilities: {
      runtime,
      tools: stringList(grant.tools),
      hooks: stringList(grant.hooks),
      configDomains: stringList(grant.configDomains),
      channels: stringList(grant.channels),
    },
  });
  return { kind: 'bundle', guard };
}

function readGrantFile(pluginDir: string, path: string): InstalledBundleGuardReading {
  let file: Partial<InstalledBundleGrantFile> | null;
  try {
    file = JSON.parse(readFileSync(path, 'utf-8')) as Partial<InstalledBundleGrantFile> | null;
  } catch (error) {
    return { kind: 'unreadable', reason: `its bundle grant ${path} could not be read (${errorText(error)})` };
  }
  if (!file || typeof file !== 'object' || file.version !== 1 || !file.bundle || typeof file.bundle !== 'object') {
    return { kind: 'unreadable', reason: `its bundle grant ${path} is not a version 1 grant` };
  }
  return guardFrom(pluginDir, file.entry, file.bundle);
}

/** Whether a quarantined copy of `receiptPath` (`<name>.corrupt-*`) sits beside it. */
function receiptWasQuarantined(receiptPath: string): boolean {
  const prefix = `${basename(receiptPath)}.corrupt-`;
  try {
    return readdirSync(dirname(receiptPath)).some((name) => name.startsWith(prefix));
  } catch {
    return false;
  }
}

/**
 * Build the guard for a plugin directory from its grant file, or, for a plugin
 * installed before the grant file existed, from its install receipt. A grant
 * or receipt that exists but cannot be read, or a receipt that was moved into
 * quarantine, is reported, not ignored: the plugin's grant cannot be known, so
 * the caller must not load it unguarded.
 */
export function readInstalledBundleGuard(pluginDir: string): InstalledBundleGuardReading {
  const grantPath = join(resolve(pluginDir), BUNDLE_GRANT_FILE);
  if (existsSync(grantPath)) return readGrantFile(pluginDir, grantPath);
  const path = bundleReceiptPathForPluginDirectory(pluginDir);
  if (!existsSync(path)) {
    if (receiptWasQuarantined(path)) return { kind: 'unreadable', reason: `its install receipt ${path} was moved into quarantine as unreadable` };
    return { kind: 'not-a-bundle' };
  }
  let receipt: Partial<EcosystemInstallReceipt> | null;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf-8')) as Partial<EcosystemInstallReceipt> | null;
  } catch (error) {
    return { kind: 'unreadable', reason: `its install receipt ${path} could not be read (${errorText(error)})` };
  }
  if (!receipt || typeof receipt !== 'object') return { kind: 'unreadable', reason: `its install receipt ${path} is not a receipt object` };
  // The receipt path is derived from the directory name, so a receipt for another entry says nothing about this directory.
  if (receipt.entry?.id !== basename(resolve(pluginDir))) return { kind: 'not-a-bundle' };
  const grant = receipt.bundle;
  if (!grant) return { kind: 'not-a-bundle' };
  if (typeof grant !== 'object') return { kind: 'unreadable', reason: `its install receipt ${path} holds a bundle grant that is not an object` };
  return guardFrom(pluginDir, receipt.entry, grant);
}
