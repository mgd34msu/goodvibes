import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describeUnappliedTier, type PluginManager } from '@goodvibes/engine/platform/platform/plugins';
import { PLUGIN_CATALOG_LIST, PLUGINS_LIST } from '@goodvibes/engine/platform/platform/capabilities';
import { RefusalError, refusal } from '@goodvibes/engine/errors';
import { commandRefusal, type CommandConfirmation } from './command-confirmation.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import { programSideOf, runDaemonCapability, type DaemonCapabilityBinding } from './command-actions/capability-actions.js';
import type { CommandActionContext } from './command-actions/types.js';

/**
 * Plugins. Every act on them is a capability (platform
 * capabilities/builtin/plugins.ts) shown in Tools and extensions: what is kept
 * (which are on, their trust, keys and the local catalog) runs in the daemon;
 * loading them again and a quarantine run in the program that runs them. This
 * file keeps the live lists a form chooses a plugin from (read through the
 * daemon) and the trust words of the `goodvibes plugin` command line.
 */

type PluginTrustTierName = 'untrusted' | 'limited' | 'trusted';

/** The plugin manager reads and writes the trust lines use. */
export type PluginTrustControls = Pick<PluginManager, 'list' | 'capabilities' | 'verify' | 'trust' | 'trustSigned' | 'setPublisherKey'>;
/** The plugin manager calls that switch a plugin on or off in a running app. */
export type PluginLifecycleControls = Pick<PluginManager, 'enable' | 'disable' | 'reload' | 'quarantine' | 'liftQuarantine'>;

/** What each trust tier lets a plugin do; the plugin loader enforces it at every start, in every app. */
export const PLUGIN_TIER_EFFECT: Readonly<Record<PluginTrustTierName, string>> = {
  untrusted: 'panels, commands and reading files only; its tool, provider, event-hook, gateway-method, channel and delivery registrations are refused',
  limited: 'the tools, providers and event hooks its manifest declares, plus gateway methods, channels and delivery strategies; high-risk capabilities stay withheld',
  trusted: 'everything its manifest declares, including shell, file-write and network capabilities',
};

export const PLUGIN_TRUST_USAGE = 'trust <name> <untrusted|limited|trusted> [note] | trust-key <name> <key.pem> | verify <name> | capabilities <name>';

/**
 * The one question the trust lines ask: recording `trusted` for a plugin whose
 * signature does not verify vouches for code nobody signed.
 */
export function pluginTrustConfirmation(manager: PluginTrustControls | undefined, args: readonly string[]): CommandConfirmation | undefined {
  if (args[0] !== 'trust' || !args[1] || args[2] !== 'trusted') return undefined;
  const verification = manager?.verify(args[1]);
  if (!verification || verification.valid || (!verification.ok && verification.reason?.includes('not found'))) return undefined;
  return {
    title: `Mark plugin ${args[1]} trusted although its signature does not verify?`,
    detail: `The manifest signature check failed: ${verification.reason ?? 'unknown reason'}. The override and that reason are kept in the plugin's trust note. Setting it to untrusted takes it back.`,
    confirmLabel: 'Trust',
  };
}

/** Starts one switched-on plugin that is not running (the manager's `enable`); absent where plugins do not run. */
export type PluginStart = (name: string) => Promise<{ ok: boolean; error?: string }>;

async function restartLine(
  manager: Pick<PluginManager, 'list'>,
  name: string,
  restarting: Promise<{ ok: boolean; error?: string }> | undefined,
  start: PluginStart | undefined,
): Promise<string> {
  const elsewhere = 'Other GoodVibes apps apply it the next time they start the plugin.';
  if (!restarting) {
    // A switched-on plugin that is not running (its tier kept it from starting) is started now at the new tier.
    const status = manager.list().find((plugin) => plugin.name === name);
    if (!start || !status?.enabled || status.active || status.quarantined) return `It applies when the plugin next starts. ${elsewhere}`;
    const started = await start(name);
    return started.ok ? `It was started at the new tier. ${elsewhere}` : `It did not start: ${started.error ?? 'unknown reason'}`;
  }
  const restarted = await restarting;
  return restarted.ok
    ? `The running plugin was started again at the new tier. ${elsewhere}`
    : `The running plugin was not restarted: ${restarted.error ?? 'unknown reason'}`;
}

// ---------------------------------------------------------------------------
// The `goodvibes plugin trust|trust-key|verify|capabilities` command line.
// ---------------------------------------------------------------------------

/** Record a trust tier; `trusted` uses the signed grant when the signature verifies, else records the owner's override in the note. */
export async function trustPlugin(manager: PluginTrustControls, name: string, tier: PluginTrustTierName, userNote: string | undefined, start?: PluginStart): Promise<string> {
  let note = userNote || undefined;
  const effect = PLUGIN_TIER_EFFECT[tier];
  if (tier === 'trusted') {
    const signed = manager.trustSigned(name);
    if (signed.ok) return `Plugin '${name}' elevated to 'trusted' via signed manifest${signed.fingerprint ? ` (fingerprint: ${signed.fingerprint})` : ''}: ${effect}\n${await restartLine(manager, name, signed.restarting, start)}`;
    if (signed.signatureRejected !== true) throw commandRefusal(signed.error ?? `the trust tier of '${name}' was not saved`, 'Nothing changed; fix the reason and run the line again.');
    note = `owner override after failed signature check (${signed.error ?? 'unknown reason'})${userNote ? `; ${userNote}` : ''}`;
  }
  const result = manager.trust(name, tier, note);
  if (!result.ok) throw commandRefusal(result.error ?? `the trust tier of '${name}' was not saved`, 'Nothing changed; fix the reason and run the line again.');
  return `Plugin '${name}' trust tier set to '${tier}'${note && tier === 'trusted' ? ' (signature not verified; recorded in the trust note)' : ''}: ${effect}\n${await restartLine(manager, name, result.restarting, start)}`;
}

export function savePluginPublisherKey(manager: PluginTrustControls, name: string, keyPath: string, command = 'plugin'): string {
  let pem: string;
  try { pem = readFileSync(resolve(keyPath), 'utf-8'); } catch (error) {
    throw commandRefusal(`could not read ${keyPath}: ${error instanceof Error ? error.message : String(error)}`, "Give the path of the publisher's Ed25519 public key file.");
  }
  const saved = manager.setPublisherKey(name, pem);
  if (!saved.ok) throw commandRefusal(saved.error ?? `the publisher key for '${name}' was not saved`);
  const check = manager.verify(name);
  return `Publisher key saved for '${name}'. ${check.valid
    ? `Its manifest signature verifies with it; goodvibes ${command} trust ${name} trusted now records the signed grant.`
    : `Its manifest signature does not verify with it (${check.reason ?? 'unknown reason'}); the tier is unchanged.`}`;
}

export function verifyPlugin(manager: PluginTrustControls, name: string): string {
  const result = manager.verify(name);
  if (!result.ok && result.reason?.includes('not found')) throw commandRefusal(result.reason ?? `Plugin '${name}' not found.`);
  return result.valid
    ? `Plugin '${name}' manifest signature is VALID.${result.fingerprint ? `\nFingerprint: ${result.fingerprint}` : ''}`
    : `Plugin '${name}' manifest signature is INVALID.\nReason: ${result.reason ?? 'Unknown'}`;
}

export function pluginCapabilitiesText(manager: PluginTrustControls, name: string, command = 'plugin'): string {
  const info = manager.capabilities(name);
  if (!info) throw commandRefusal(`Plugin '${name}' not found.`);
  const lines: string[] = [`Plugin: ${name}`, `Trust tier: ${info.tier} (${PLUGIN_TIER_EFFECT[info.tier]})`];
  if (info.unappliedTier !== undefined) {
    const sentence = describeUnappliedTier(name, info.unappliedTier, `goodvibes ${command}`);
    lines.push(`${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`);
  }
  lines.push('', `Declared capabilities (${info.requested.length}):`);
  if (info.requested.length === 0) {
    lines.push(info.tier === 'untrusted'
      ? '  (none: it may register commands only)'
      : '  (none: it may register commands, gateway methods, channels and delivery strategies only)');
  } else {
    for (const cap of info.requested) {
      const tag = info.blocked.includes(cap)
        ? (info.highRisk.includes(cap) ? '[withheld: needs trusted]' : '[withheld: needs limited]')
        : info.highRisk.includes(cap) ? '[granted, high-risk]' : '[granted]';
      lines.push(`  ${cap.padEnd(32)} ${tag}`);
    }
  }
  const withheldHighRisk = info.blocked.filter((cap) => info.highRisk.includes(cap));
  if (withheldHighRisk.length > 0) {
    lines.push('', `It declares ${withheldHighRisk.join(', ')}, which needs the trusted tier, so it does not start.`, `goodvibes ${command} trust ${name} trusted allows it; or remove the capability from its manifest.`);
  } else if (info.blocked.length > 0) {
    lines.push('', `Its registrations of ${info.blocked.join(', ')} are refused at this tier; goodvibes ${command} trust ${name} limited allows them.`);
  }
  return lines.join('\n');
}

export async function reloadPlugins(manager: PluginLifecycleControls): Promise<string> {
  const summary = await manager.reload();
  const lines = [`Done. ${summary.reloaded} plugin(s) reloaded${summary.failed > 0 ? `, ${summary.failed} failed` : ''}.`];
  for (const { name: failed, reason } of summary.loadFailed ?? []) lines.push(`  ${failed}: did not start, ${reason}`);
  for (const busy of summary.notDrained) lines.push(`  ${busy}: not reloaded, calls into it were still running; it keeps its current version.`);
  for (const held of summary.quarantined ?? []) lines.push(`  ${held}: not loaded, it is quarantined.`);
  for (const stuck of summary.cleanupFailed ?? []) lines.push(`  ${stuck}: stopping its earlier copy reported an error; restart to clear anything that copy left behind.`);
  return lines.join('\n');
}

export async function quarantinePlugin(manager: PluginLifecycleControls, name: string, reason: string): Promise<string> {
  const result = manager.quarantine(name, reason);
  if (!result.ok) throw commandRefusal(result.error ?? `Plugin '${name}' was not quarantined.`, undefined, 'NOT_DONE');
  try {
    await result.unloading;
  } catch (error) {
    throw new RefusalError(refusal({
      code: 'PLUGIN_STOP_FAILED',
      state: `Plugin '${name}' is quarantined and will not load again`,
      reason: `Stopping the running instance reported an error: ${error instanceof Error ? error.message : String(error)}`,
      next: ['Restart to clear anything the running instance left behind'],
    }));
  }
  return `Plugin '${name}' quarantined and stopped.\nReason: ${reason}\nIt will not load until its quarantine is lifted, which starts it again.`;
}

/**
 * The CLI's `goodvibes plugin trust|trust-key|verify|capabilities` lines.
 * Returns false for any other subcommand. A line that did not do what it asked
 * throws its refusal.
 */
export async function runPluginTrustSubcommand(
  manager: PluginTrustControls,
  args: readonly string[],
  print: (text: string) => void,
): Promise<boolean> {
  const sub = args[0];
  const name = args[1];
  if (sub === 'trust') {
    const rawTier = args[2];
    if (!name || !rawTier) throw commandRefusal('Usage: goodvibes plugin trust <name> <untrusted|limited|trusted> [note]');
    if (rawTier !== 'untrusted' && rawTier !== 'limited' && rawTier !== 'trusted') throw commandRefusal(`Invalid trust tier '${rawTier}'.`, 'Use untrusted, limited or trusted.');
    print(await trustPlugin(manager, name, rawTier, args.slice(3).join(' ')));
    return true;
  }
  if (sub === 'trust-key') {
    if (!name || !args[2]) throw commandRefusal('Usage: goodvibes plugin trust-key <name> <publisher-public-key.pem>');
    print(savePluginPublisherKey(manager, name, args[2]));
    return true;
  }
  if (sub === 'verify') {
    if (!name) throw commandRefusal('Usage: goodvibes plugin verify <name>');
    print(verifyPlugin(manager, name));
    return true;
  }
  if (sub === 'capabilities') {
    if (!name) throw commandRefusal('Usage: goodvibes plugin capabilities <name>');
    print(pluginCapabilitiesText(manager, name));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// What this program does itself when the daemon switches a plugin on or off:
// the daemon keeps the one state file; this program starts or stops its own copy.
// ---------------------------------------------------------------------------

type RunningPlugins = Pick<PluginManager, 'list' | 'enable' | 'disable'>;
const runningIn = (ctx: CommandActionContext): RunningPlugins | undefined =>
  (ctx as { readonly extensions?: { readonly pluginManager?: RunningPlugins | undefined } | undefined }).extensions?.pluginManager;

programSideOf('plugin.enable', {
  // Switched on in the one state file: started here too (its tier may still keep it from starting, which the list then shows).
  async after(values, ctx) {
    const plugins = runningIn(ctx);
    const name = values.plugin ?? '';
    if (!plugins || plugins.list().find((plugin) => plugin.name === name)?.active) return;
    await plugins.enable(name);
  },
});
programSideOf('plugin.disable', {
  // Switched off by the daemon in the one state file (its answer says so), then stopped here too. Stopping here first
  // switched it off before the daemon looked, so the daemon answered "was already switched off" to a plugin that was on.
  async after(values, ctx) {
    const plugins = runningIn(ctx);
    const name = values.plugin ?? '';
    if (!plugins?.list().find((plugin) => plugin.name === name)?.active) return;
    await plugins.disable(name);
  },
});

// ---------------------------------------------------------------------------
// The live lists a form chooses a plugin from, read through the daemon.
// ---------------------------------------------------------------------------

let pluginBinding: DaemonCapabilityBinding<CommandActionContext> | undefined;

/** How the plugin lists reach the daemon: set by the program when it wires its places. */
export function bindPluginLists(binding: DaemonCapabilityBinding<never>): void {
  pluginBinding = binding as unknown as DaemonCapabilityBinding<CommandActionContext>;
}

async function daemonRows(ctx: CommandActionContext, id: string, field: string): Promise<readonly Record<string, unknown>[]> {
  if (!pluginBinding) throw commandRefusal('Plugins are kept by the daemon, and this program has no way to reach it yet.');
  const answer = await runDaemonCapability(id, {}, ctx, pluginBinding);
  const rows = answer.data?.[field];
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object') : [];
}
const text = (value: unknown): string => typeof value === 'string' ? value : '';

defineList<CommandActionContext>({
  name: PLUGINS_LIST,
  async read(ctx) {
    return (await daemonRows(ctx, 'plugin.list', 'plugins')).map((plugin): ListRow => ({
      value: text(plugin['name']), label: text(plugin['name']),
      ...(text(plugin['description']) ? { detail: text(plugin['description']) } : {}),
      state: `${text(plugin['state'])}, ${text(plugin['tier'])}`,
    }));
  },
  operator: { method: 'capabilities.run', input: { id: 'plugin.list' }, rows: { from: 'data.plugins', value: 'name', label: 'name', detail: 'description', state: 'state' } },
});

defineList<CommandActionContext>({
  name: PLUGIN_CATALOG_LIST,
  async read(ctx) {
    return (await daemonRows(ctx, 'plugin.catalog', 'entries')).map((entry): ListRow => ({ value: text(entry['id']), label: text(entry['name']) || text(entry['id']), detail: text(entry['summary']) }));
  },
  operator: { method: 'capabilities.run', input: { id: 'plugin.catalog' }, rows: { from: 'data.entries', value: 'id', label: 'name', detail: 'summary' } },
});
