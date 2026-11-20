import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PluginManager } from '@goodvibes-jev/engine/platform/platform/plugins';
import type { TerminalSlashCommand } from './command-registry.js';
import type { CommandSubcommandHints } from './command-args-hint.js';
import { RefusalError, refusal } from '@goodvibes-jev/engine/errors';
import { commandRefusal, withOwnerConfirmation, type CommandConfirmation, type ConfirmationHost } from './command-confirmation.js';

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

/**
 * Runs `/plugin trust|trust-key|verify|capabilities`. Returns false for any
 * other subcommand, which the caller handles. A line that did not do what it
 * asked (usage, unknown plugin, unsaved tier) throws its refusal.
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
    if (rawTier !== 'untrusted' && rawTier !== 'limited' && rawTier !== 'trusted') {
      throw commandRefusal(`Invalid trust tier '${rawTier}'.`, 'Use untrusted, limited or trusted.');
    }
    const tier: PluginTrustTierName = rawTier;
    // `--override` was the old retyped answer; the confirmation now asks once when the signature fails.
    const userNote = args.slice(3).filter((word) => word !== '--override').join(' ');
    let note = userNote || undefined;
    const effect = PLUGIN_TIER_EFFECT[tier];
    if (tier === 'trusted') {
      const signed = manager.trustSigned(name);
      if (signed.ok) {
        print(`Plugin '${name}' elevated to 'trusted' via signed manifest${signed.fingerprint ? ` (fingerprint: ${signed.fingerprint})` : ''}: ${effect}\n${await restartLine(signed.restarting)}`);
        return true;
      }
      // The owner's override answers a signature that does not verify, the
      // reason the confirmation named; a closed manager, an unknown plugin or
      // an unsaved record is not that, and is a refusal.
      if (signed.signatureRejected !== true) {
        throw commandRefusal(signed.error ?? `the trust tier of '${name}' was not saved`, 'Nothing changed; fix the reason and run the line again.');
      }
      note = `owner override after failed signature check (${signed.error ?? 'unknown reason'})${userNote ? `; ${userNote}` : ''}`;
    }
    const result = manager.trust(name, tier, note);
    if (!result.ok) throw commandRefusal(result.error ?? `the trust tier of '${name}' was not saved`, 'Nothing changed; fix the reason and run the line again.');
    print(`Plugin '${name}' trust tier set to '${tier}'${note && tier === 'trusted' ? ' (signature not verified; recorded in the trust note)' : ''}: ${effect}\n${await restartLine(result.restarting)}`);
    return true;
  }
  if (sub === 'trust-key') {
    const keyPath = args[2];
    if (!name || !keyPath) throw commandRefusal('Usage: /plugin trust-key <name> <publisher-public-key.pem>');
    let pem: string;
    try { pem = readFileSync(resolve(keyPath), 'utf-8'); } catch (error) {
      throw commandRefusal(`could not read ${keyPath}: ${error instanceof Error ? error.message : String(error)}`, "Give the path of the publisher's Ed25519 public key file.");
    }
    const saved = manager.setPublisherKey(name, pem);
    if (!saved.ok) throw commandRefusal(saved.error ?? `the publisher key for '${name}' was not saved`);
    const check = manager.verify(name);
    print(`Publisher key saved for '${name}'. ${check.valid
      ? `Its manifest signature verifies with it; /plugin trust ${name} trusted now records the signed grant.`
      : `Its manifest signature does not verify with it (${check.reason ?? 'unknown reason'}); the tier is unchanged.`}`);
    return true;
  }
  if (sub === 'verify') {
    if (!name) throw commandRefusal('Usage: /plugin verify <name>');
    const result = manager.verify(name);
    if (!result.ok && result.reason?.includes('not found')) throw commandRefusal(result.reason ?? `Plugin '${name}' not found.`, '/plugin list shows the installed plugins.');
    print(result.valid
      ? `Plugin '${name}' manifest signature is VALID.${result.fingerprint ? `\nFingerprint: ${result.fingerprint}` : ''}`
      : `Plugin '${name}' manifest signature is INVALID.\nReason: ${result.reason ?? 'Unknown'}`);
    return true;
  }
  if (sub === 'capabilities') {
    if (!name) throw commandRefusal('Usage: /plugin capabilities <name>');
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
      lines.push('');
      lines.push(`It declares ${withheldHighRisk.join(', ')}, which needs the trusted tier, so it does not start.`);
      lines.push(`Use /plugin trust ${name} trusted to allow it, or remove the capability from its manifest.`);
    } else if (info.blocked.length > 0) {
      lines.push('');
      lines.push(`Its registrations of ${info.blocked.join(', ')} are refused at this tier; /plugin trust ${name} limited allows them.`);
    }
    print(lines.join('\n'));
    return true;
  }
  return false;
}

/**
 * Runs `/plugin enable|disable|reload|quarantine` against the running app's plugin
 * manager, the same lines in the terminal app and the Agent. Returns false for
 * any other subcommand. A line that did not do what it asked throws its refusal.
 */
export async function runPluginLifecycleSubcommand(
  manager: PluginLifecycleControls,
  args: readonly string[],
  print: (text: string) => void,
): Promise<boolean> {
  const sub = args[0];
  const name = args[1];
  if (sub === 'enable') {
    if (!name) throw commandRefusal('Usage: /plugin enable <name>');
    const result = await manager.enable(name);
    if (!result.ok) throw commandRefusal(result.error ?? `Plugin '${name}' was not enabled.`, '/plugin list shows each plugin and its state', 'NOT_DONE');
    print(`Plugin '${name}' enabled and activated.`);
    return true;
  }
  if (sub === 'disable') {
    if (!name) throw commandRefusal('Usage: /plugin disable <name>');
    const result = await manager.disable(name);
    if (!result.ok) throw commandRefusal(result.error ?? `Plugin '${name}' was not disabled.`, '/plugin list shows each plugin and its state', 'NOT_DONE');
    print(`Plugin '${name}' disabled.`);
    return true;
  }
  if (sub === 'reload') {
    print('Reloading plugins...');
    const summary = await manager.reload();
    const lines = [`Done. ${summary.reloaded} plugin(s) reloaded${summary.failed > 0 ? `, ${summary.failed} failed` : ''}.`];
    for (const { name: failed, reason } of summary.loadFailed ?? []) {
      lines.push(`  ${failed}: did not start, ${reason}`);
    }
    for (const busy of summary.notDrained) {
      lines.push(`  ${busy}: not reloaded, calls into it were still running; it keeps its current version. Run /plugin reload again once they finish.`);
    }
    for (const held of summary.quarantined ?? []) {
      lines.push(`  ${held}: not loaded, it is quarantined. Run /plugin quarantine ${held} lift, then /plugin reload.`);
    }
    for (const stuck of summary.cleanupFailed ?? []) {
      lines.push(`  ${stuck}: stopping its earlier copy reported an error; restart to clear anything that copy left behind.`);
    }
    print(lines.join('\n'));
    return true;
  }
  if (sub === 'quarantine') {
    const action = args[2] ?? 'add';
    if (!name) throw commandRefusal('Usage: /plugin quarantine <name> [add|lift] [reason]');
    if (action === 'lift') {
      const result = manager.liftQuarantine(name);
      if (!result.ok) throw commandRefusal(result.error ?? `Plugin '${name}' quarantine was not lifted.`, undefined, 'NOT_DONE');
      print(`Plugin '${name}' quarantine lifted; it can load again. Run /plugin reload to load it.`);
      return true;
    }
    const reason = args.slice(action === 'add' ? 3 : 2).join(' ') || 'quarantined by operator';
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
    print(`Plugin '${name}' quarantined and stopped.\nReason: ${reason}\nIt will not load until you run /plugin quarantine ${name} lift and then /plugin reload.`);
    return true;
  }
  return false;
}

/**
 * `/plugin` for a shell that has no plugin workspace of its own: the plugin
 * list with each tier, and the trust lines. The tier is shared by every app on
 * this machine, so a tier set here also holds in the terminal app and daemon.
 */
export function createPluginTrustCommand<Context extends ConfirmationHost>(
  manager: (context: Context) => (PluginTrustControls & PluginLifecycleControls) | undefined,
): TerminalSlashCommand<Context> & CommandSubcommandHints {
  const command = {
    name: 'plugin',
    effect: 'mixed' as const,
    readVerbs: ['list'],
    aliases: [] as string[],
    description: 'List, enable and disable plugins, and set what each one may do (its trust tier)',
    usage: `list | enable <name> | disable <name> | reload | ${PLUGIN_TRUST_USAGE} | quarantine <name> [add|lift] [reason]`,
    subcommands: {
      list: '', enable: '<name>', disable: '<name>', reload: '', quarantine: '<name> [add|lift] [reason]',
      trust: '<name> <untrusted|limited|trusted> [note]', 'trust-key': '<name> <key.pem>',
      verify: '<name>', capabilities: '<name>',
    },
    confirm: (args: readonly string[], context: Context): CommandConfirmation | undefined => pluginTrustConfirmation(manager(context), args),
    async handler(args: string[], context: Context): Promise<void> {
      const plugins = manager(context);
      if (!plugins) throw commandRefusal('Plugin manager is not available in this runtime.');
      const sub = args[0] ?? 'list';
      if (sub === 'list') {
        const listed = plugins.list();
        if (listed.length === 0) {
          context.print('No plugins installed. Place a plugin folder with manifest.json in ~/.goodvibes/plugins or <project>/.goodvibes/plugins.');
          return;
        }
        context.print([
          'Plugins:',
          ...listed.map((plugin) => `  ${(plugin.active ? '[active]' : plugin.enabled ? '[enabled]' : '[disabled]').padEnd(11)} ${plugin.name.padEnd(24)} v${plugin.version}  tier ${plugin.trustTier}${plugin.quarantined ? '  QUARANTINED' : ''}`),
          '',
          'A plugin runs only once enabled: /plugin enable <name> starts it, /plugin disable <name> stops it.',
          'A tier decides what a plugin may register: /plugin capabilities <name> shows it, /plugin trust <name> <tier> changes it.',
        ].join('\n'));
        return;
      }
      if (await runPluginLifecycleSubcommand(plugins, args, (text) => context.print(text))) return;
      if (await runPluginTrustSubcommand(plugins, args, (text) => context.print(text))) return;
      throw commandRefusal(`Unknown /plugin subcommand: ${sub}`, `Usage: /plugin ${command.usage}`);
    },
  };
  return withOwnerConfirmation<Context, typeof command>(command);
}
