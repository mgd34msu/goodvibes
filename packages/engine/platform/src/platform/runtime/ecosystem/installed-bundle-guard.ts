/**
 * The capability guard of a plugin installed from a pinned bundle.
 *
 * A bundle install (catalog.ts `installVerifiedBundle`) writes the plugin into
 * `<root>/.goodvibes/plugins/<id>` and its receipt, carrying the granted set,
 * into `<root>/.goodvibes/ecosystem/installed/plugin-<id>.json`. The plugin
 * loader asks here once per load; a plugin with no receipt, or whose receipt
 * names no bundle, is not a bundle and gets no guard.
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { PluginCapability } from '../plugins/types.js';
import { ALL_CAPABILITIES } from '../plugins/types.js';
import { createBundleCapabilityGuard, type BundleCapabilityGuard } from './bundle-manifest.js';
import type { EcosystemInstallReceipt } from './catalog.js';

export type InstalledBundleGuardReading =
  | { readonly kind: 'not-a-bundle' }
  | { readonly kind: 'bundle'; readonly guard: BundleCapabilityGuard }
  | { readonly kind: 'unreadable'; readonly reason: string };

/** Receipt path of a plugin installed under the default layout (see the module comment). */
export function bundleReceiptPathForPluginDirectory(pluginDir: string): string {
  const goodvibesRoot = dirname(dirname(resolve(pluginDir)));
  return join(goodvibesRoot, 'ecosystem', 'installed', `plugin-${basename(pluginDir)}.json`);
}

function stringList(value: unknown): readonly string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/**
 * Build the guard for a plugin directory from its install receipt. A receipt
 * that exists but cannot be read is reported, not ignored: the plugin's grant
 * cannot be known, so the caller must not load it unguarded.
 */
export function readInstalledBundleGuard(pluginDir: string): InstalledBundleGuardReading {
  const path = bundleReceiptPathForPluginDirectory(pluginDir);
  if (!existsSync(path)) return { kind: 'not-a-bundle' };
  let receipt: Partial<EcosystemInstallReceipt>;
  try {
    receipt = JSON.parse(readFileSync(path, 'utf-8')) as Partial<EcosystemInstallReceipt>;
  } catch (error) {
    return { kind: 'unreadable', reason: `its install receipt ${path} could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  // A receipt for another copy (a different install root) says nothing about this directory.
  if (typeof receipt.targetPath !== 'string' || resolve(receipt.targetPath) !== resolve(pluginDir)) return { kind: 'not-a-bundle' };
  const grant = receipt.bundle;
  if (!grant) return { kind: 'not-a-bundle' };
  if (typeof grant !== 'object') return { kind: 'unreadable', reason: `its install receipt ${path} holds a bundle grant that is not an object` };
  // The guard holds what the bundle declared (granted and withheld at install);
  // the plugin's live trust tier is checked at each start by the loader's grant.
  const runtime = [...new Set([...stringList(grant.granted), ...stringList(grant.withheld)])]
    .filter((cap): cap is PluginCapability => (ALL_CAPABILITIES as readonly string[]).includes(cap));
  const entry = receipt.entry;
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
