import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginManager } from '@goodvibes-jev/engine/platform/platform/plugins';
import type { TerminalCommandRegistry } from './command-registry.js';
import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import { commandRefusal, type CommandConfirmation } from './command-confirmation.js';
import { defineCommand } from './command-actions/define.js';
import { defineList, type ListRow } from './command-actions/lists.js';
import type { ActionDescription, CommandActionContext, InputDescription } from './command-actions/types.js';
import { doAction, listInput, readAction, textInput } from './described-command-kit.js';

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
    detail: `The manifest signature check failed: ${verification.reason ?? 'unknown reason'}. The override and that reason are kept in the plugin's trust note. /plugin trust ${args[1]} untrusted takes it back.`,
    confirmLabel: 'Trust',
  };
}

async function restartLine(restarting: Promise<{ ok: boolean; error?: string }> | undefined): Promise<string> {
  const elsewhere = 'Other GoodVibes apps apply it the next time they start the plugin.';
  if (!restarting) return `It applies when the plugin next starts. ${elsewhere}`;
  const restarted = await restarting;
  return restarted.ok
    ? `The running plugin was started again at the new tier. ${elsewhere}`
    : `The running plugin was not restarted: ${restarted.error ?? 'unknown reason'}`;
}

// ---------------------------------------------------------------------------
// What each plugin act does, by value: the slash actions below and the CLI's
// `goodvibes plugin` lines (runPluginTrustSubcommand) both call these.
// ---------------------------------------------------------------------------

/** Record a trust tier; `trusted` uses the signed grant when the signature verifies, else records the owner's override in the note. */
export async function trustPlugin(manager: PluginTrustControls, name: string, tier: PluginTrustTierName, userNote: string | undefined): Promise<string> {
  let note = userNote || undefined;
  const effect = PLUGIN_TIER_EFFECT[tier];
  if (tier === 'trusted') {
    const signed = manager.trustSigned(name);
    if (signed.ok) return `Plugin '${name}' elevated to 'trusted' via signed manifest${signed.fingerprint ? ` (fingerprint: ${signed.fingerprint})` : ''}: ${effect}\n${await restartLine(signed.restarting)}`;
    // The owner's answer covers a signature that does not verify; a closed manager,
    // an unknown plugin or an unsaved record is not that, and is a refusal.
    if (signed.signatureRejected !== true) throw commandRefusal(signed.error ?? `the trust tier of '${name}' was not saved`, 'Nothing changed; fix the reason and run the line again.');
    note = `owner override after failed signature check (${signed.error ?? 'unknown reason'})${userNote ? `; ${userNote}` : ''}`;
  }
  const result = manager.trust(name, tier, note);
  if (!result.ok) throw commandRefusal(result.error ?? `the trust tier of '${name}' was not saved`, 'Nothing changed; fix the reason and run the line again.');
  return `Plugin '${name}' trust tier set to '${tier}'${note && tier === 'trusted' ? ' (signature not verified; recorded in the trust note)' : ''}: ${effect}\n${await restartLine(result.restarting)}`;
}

export function savePluginPublisherKey(manager: PluginTrustControls, name: string, keyPath: string): string {
  let pem: string;
  try { pem = readFileSync(resolve(keyPath), 'utf-8'); } catch (error) {
    throw commandRefusal(`could not read ${keyPath}: ${error instanceof Error ? error.message : String(error)}`, "Give the path of the publisher's Ed25519 public key file.");
  }
  const saved = manager.setPublisherKey(name, pem);
  if (!saved.ok) throw commandRefusal(saved.error ?? `the publisher key for '${name}' was not saved`);
  const check = manager.verify(name);
  return `Publisher key saved for '${name}'. ${check.valid
    ? `Its manifest signature verifies with it; /plugin trust ${name} trusted now records the signed grant.`
    : `Its manifest signature does not verify with it (${check.reason ?? 'unknown reason'}); the tier is unchanged.`}`;
}

export function verifyPlugin(manager: PluginTrustControls, name: string): string {
  const result = manager.verify(name);
  if (!result.ok && result.reason?.includes('not found')) throw commandRefusal(result.reason ?? `Plugin '${name}' not found.`, '/plugin list shows the installed plugins.');
  return result.valid
    ? `Plugin '${name}' manifest signature is VALID.${result.fingerprint ? `\nFingerprint: ${result.fingerprint}` : ''}`
    : `Plugin '${name}' manifest signature is INVALID.\nReason: ${result.reason ?? 'Unknown'}`;
}

export function pluginCapabilitiesText(manager: PluginTrustControls, name: string): string {
  const info = manager.capabilities(name);
  if (!info) throw commandRefusal(`Plugin '${name}' not found.`, '/plugin list shows the installed plugins.');
  const lines: string[] = [`Plugin: ${name}`, `Trust tier: ${info.tier} (${PLUGIN_TIER_EFFECT[info.tier]})`, '', `Declared capabilities (${info.requested.length}):`];
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
    lines.push('', `It declares ${withheldHighRisk.join(', ')}, which needs the trusted tier, so it does not start.`, `Use /plugin trust ${name} trusted to allow it, or remove the capability from its manifest.`);
  } else if (info.blocked.length > 0) {
    lines.push('', `Its registrations of ${info.blocked.join(', ')} are refused at this tier; /plugin trust ${name} limited allows them.`);
  }
  return lines.join('\n');
}

export async function reloadPlugins(manager: PluginLifecycleControls): Promise<string> {
  const summary = await manager.reload();
  const lines = [`Done. ${summary.reloaded} plugin(s) reloaded${summary.failed > 0 ? `, ${summary.failed} failed` : ''}.`];
  for (const { name: failed, reason } of summary.loadFailed ?? []) lines.push(`  ${failed}: did not start, ${reason}`);
  for (const busy of summary.notDrained) lines.push(`  ${busy}: not reloaded, calls into it were still running; it keeps its current version. Run /plugin reload again once they finish.`);
  for (const held of summary.quarantined ?? []) lines.push(`  ${held}: not loaded, it is quarantined. Run /plugin lift ${held}, then /plugin reload.`);
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
  return `Plugin '${name}' quarantined and stopped.\nReason: ${reason}\nIt will not load until you run /plugin lift ${name} and then /plugin reload.`;
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
    if (!name || !rawTier) throw commandRefusal('Usage: /plugin trust <name> <untrusted|limited|trusted> [note]');
    if (rawTier !== 'untrusted' && rawTier !== 'limited' && rawTier !== 'trusted') throw commandRefusal(`Invalid trust tier '${rawTier}'.`, 'Use untrusted, limited or trusted.');
    print(await trustPlugin(manager, name, rawTier, args.slice(3).join(' ')));
    return true;
  }
  if (sub === 'trust-key') {
    if (!name || !args[2]) throw commandRefusal('Usage: /plugin trust-key <name> <publisher-public-key.pem>');
    print(savePluginPublisherKey(manager, name, args[2]));
    return true;
  }
  if (sub === 'verify') {
    if (!name) throw commandRefusal('Usage: /plugin verify <name>');
    print(verifyPlugin(manager, name));
    return true;
  }
  if (sub === 'capabilities') {
    if (!name) throw commandRefusal('Usage: /plugin capabilities <name>');
    print(pluginCapabilitiesText(manager, name));
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The plugin actions both terminal apps describe: the terminal app's /plugin
// and the Agent's /plugin-trust are built from these.
// ---------------------------------------------------------------------------

export type PluginControls = PluginTrustControls & PluginLifecycleControls;
export type PluginManagerOf<Ctx> = (ctx: Ctx) => PluginControls | undefined;

function controlsOf<Ctx>(manager: PluginManagerOf<Ctx>, ctx: Ctx): PluginControls {
  const plugins = manager(ctx);
  if (!plugins) throw commandRefusal('Plugin manager is not available in this runtime.', undefined, 'PLUGINS_UNAVAILABLE');
  return plugins;
}

/** The plugins on this machine: both apps' command contexts carry the plugin manager under `extensions`. */
const PLUGINS = defineList<{ readonly extensions?: { readonly pluginManager?: PluginControls | undefined } | undefined }>({
  name: 'plugins',
  async read(ctx) {
    return (ctx.extensions?.pluginManager?.list() ?? []).map((plugin): ListRow => ({
      value: plugin.name, label: plugin.name,
      detail: plugin.description,
      state: `${plugin.quarantined ? 'quarantined' : plugin.active ? 'active' : plugin.enabled ? 'enabled' : 'disabled'}, ${plugin.trustTier}`,
    }));
  },
  operator: { terminalOnly: 'Plugins run inside each terminal app.' },
});
const PLUGIN: InputDescription = listInput({ id: 'plugin', label: 'Plugin', help: 'Plugins found on this machine', list: PLUGINS });
const TERMINAL_ONLY = { terminalOnly: 'Plugins run inside each terminal app.' } as const;
const TIERS = [
  { value: 'untrusted', label: 'Untrusted', help: PLUGIN_TIER_EFFECT.untrusted },
  { value: 'limited', label: 'Limited', help: PLUGIN_TIER_EFFECT.limited },
  { value: 'trusted', label: 'Trusted', help: PLUGIN_TIER_EFFECT.trusted, risk: 'loosens-a-protection' as const },
];

/** List, switch on and off, reload, quarantine, and set the trust of plugins. */
export function pluginActions<Ctx extends CommandActionContext>(manager: PluginManagerOf<Ctx>, command: string): readonly ActionDescription<Ctx>[] {
  return [
    readAction<Ctx>({
      id: 'list', label: 'See your plugins', word: 'list',
      sentence: 'Shows every plugin with its state and trust tier.',
      async run(_values, ctx) {
        const listed = controlsOf(manager, ctx).list();
        if (listed.length === 0) return 'No plugins installed. Place a plugin folder with manifest.json in ~/.goodvibes/plugins or <project>/.goodvibes/plugins.';
        return [
          'Plugins:',
          ...listed.map((plugin) => `  ${(plugin.active ? '[active]' : plugin.enabled ? '[enabled]' : '[disabled]').padEnd(11)} ${plugin.name.padEnd(24)} v${plugin.version}  tier ${plugin.trustTier}${plugin.quarantined ? '  QUARANTINED' : ''}`),
          '',
          `A plugin runs only once switched on: /${command} enable <plugin> starts it, /${command} disable <plugin> stops it.`,
          `A tier decides what a plugin may register: /${command} capabilities <plugin> shows it, /${command} trust <plugin> <tier> changes it.`,
        ].join('\n');
      },
    }),
    {
      id: 'enable', label: 'Switch a plugin on', word: 'enable', inputs: [PLUGIN],
      sentence: '{plugin} starts now and at every start, under its trust tier, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'disable', operator: TERMINAL_ONLY, example: { plugin: 'jira' },
      async run(values, ctx) {
        const result = await controlsOf(manager, ctx).enable(values.plugin!);
        if (!result.ok) throw commandRefusal(result.error ?? `Plugin '${values.plugin}' was not switched on.`, `/${command} list shows each plugin and its state`, 'NOT_DONE');
        return `Plugin '${values.plugin}' switched on and started.`;
      },
    },
    {
      id: 'disable', label: 'Switch a plugin off', word: 'disable', inputs: [PLUGIN],
      sentence: '{plugin} stops now and does not start again, until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'enable', operator: TERMINAL_ONLY, example: { plugin: 'jira' },
      async run(values, ctx) {
        const result = await controlsOf(manager, ctx).disable(values.plugin!);
        if (!result.ok) throw commandRefusal(result.error ?? `Plugin '${values.plugin}' was not switched off.`, `/${command} list shows each plugin and its state`, 'NOT_DONE');
        return `Plugin '${values.plugin}' switched off.`;
      },
    },
    doAction<Ctx>({
      id: 'reload', label: 'Load the plugins again', word: 'reload',
      sentence: 'Every switched-on plugin is stopped and started again from its files.', operator: TERMINAL_ONLY,
      async run(_values, ctx) { ctx.print('Reloading plugins...'); return reloadPlugins(controlsOf(manager, ctx)); },
    }),
    {
      id: 'quarantine', label: 'Quarantine a plugin', word: 'quarantine',
      inputs: [PLUGIN, textInput({ id: 'reason', label: 'Why', help: 'A note you will see when you look at it', why: 'your own words', typed: { tail: true }, optional: { default: 'quarantined by operator', means: 'no note' } })],
      sentence: '{plugin} is stopped and blocked from loading until you lift the quarantine.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', undoneBy: 'lift', operator: TERMINAL_ONLY, example: { plugin: 'jira', reason: 'it changed unexpectedly' },
      async run(values, ctx) { return quarantinePlugin(controlsOf(manager, ctx), values.plugin!, values.reason || 'quarantined by operator'); },
    },
    {
      id: 'lift', label: 'Lift a plugin\'s quarantine', word: 'lift', inputs: [PLUGIN],
      sentence: '{plugin} may load again (after a reload), until you change it.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'loosens-a-protection', undoneBy: 'quarantine',
      ownerOnly: { reason: 'it lets a quarantined plugin load again', instead: `Ask the owner to lift it with /${command} lift.` },
      operator: TERMINAL_ONLY, example: { plugin: 'jira' },
      async run(values, ctx) {
        const result = controlsOf(manager, ctx).liftQuarantine(values.plugin!);
        if (!result.ok) throw commandRefusal(result.error ?? `Plugin '${values.plugin}' quarantine was not lifted.`, undefined, 'NOT_DONE');
        return `Plugin '${values.plugin}' quarantine lifted; it can load again. Run /${command} reload to load it.`;
      },
    },
    {
      id: 'trust', label: 'Set what a plugin may do', word: 'trust',
      inputs: [PLUGIN, { id: 'tier', label: 'Trust tier', help: 'What it may register', kind: 'choice', choices: TIERS, required: true, typed: { position: 2 } },
        textInput({ id: 'note', label: 'Note', help: 'Why you chose it', why: 'your own words', typed: { tail: true }, optional: { default: '', means: 'no note' } })],
      sentence: '{plugin} is set to the {tier} tier on every app of this machine until you change it; a trusted tier without a valid signature is recorded in its trust note.', done: '',
      touches: 'this-machine', lasts: 'kept', risk: 'none', operator: TERMINAL_ONLY, example: { plugin: 'jira', tier: 'limited' },
      async run(values, ctx) { return trustPlugin(controlsOf(manager, ctx), values.plugin!, values.tier as PluginTrustTierName, values.note); },
    },
    {
      id: 'trust-key', label: 'Save a plugin publisher\'s key', word: 'trust-key',
      inputs: [PLUGIN, textInput({ id: 'key', label: 'Key file', help: 'The publisher\'s Ed25519 public key (.pem)', why: 'a file path on this machine', kind: 'path', typed: { position: 2 } })],
      sentence: 'The key in {key} is saved as {plugin}\'s publisher key, until you change it, so its signature can be checked.', done: '',
      touches: 'credential', lasts: 'kept', risk: 'none', operator: TERMINAL_ONLY, example: { plugin: 'jira', key: 'keys/acme.pem' },
      async run(values, ctx) { return savePluginPublisherKey(controlsOf(manager, ctx), values.plugin!, values.key!); },
    },
    readAction<Ctx>({
      id: 'verify', label: 'Check a plugin\'s signature', word: 'verify', inputs: [PLUGIN],
      sentence: 'Checks {plugin}\'s manifest signature against its publisher key.', example: { plugin: 'jira' },
      async run(values, ctx) { return verifyPlugin(controlsOf(manager, ctx), values.plugin!); },
    }),
    readAction<Ctx>({
      id: 'capabilities', label: 'See what a plugin asks to do', word: 'capabilities', inputs: [PLUGIN],
      sentence: 'Shows the capabilities {plugin} declares and which its tier grants or withholds.', example: { plugin: 'jira' },
      async run(values, ctx) { return pluginCapabilitiesText(controlsOf(manager, ctx), values.plugin!); },
    }),
  ];
}

/**
 * `/plugin-trust`: plugins in a shell with no plugin workspace of its own (the
 * Agent): the plugin list with each tier, switching plugins on and off, and
 * the trust lines. The tier is shared by every app on this machine, so a tier
 * set here also holds in the terminal app and daemon.
 */
export function registerPluginTrustCommand<Ctx extends CommandActionContext>(registry: Pick<TerminalCommandRegistry<Ctx>, 'register'>, manager: PluginManagerOf<Ctx>): void {
  registry.register(defineCommand<Ctx>({
    name: 'plugin-trust',
    title: 'Plugins and their trust',
    summary: 'Switch plugins on and off, and set what each one may do',
    group: 'Extensions',
    report: 'list',
    actions: pluginActions(manager, 'plugin-trust'),
  }));
}
