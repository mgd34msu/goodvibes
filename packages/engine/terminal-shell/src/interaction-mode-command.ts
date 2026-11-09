import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ShellModeManagerService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { requireYesFlag, stripYesFlag } from './command-confirmation.js';
import type { TerminalSlashCommand } from './command-registry.js';
interface InteractionModeContext {
  readonly ops: { readonly modeManager?: ShellModeManagerService | null | undefined };
  readonly platform: { readonly configManager: Pick<ConfigManager, 'setDynamic'> };
  print(message: string): void;
  renderRequest(): void;
}
export function createInteractionModeCommand<Context extends InteractionModeContext>(policy: {
  readonly description: string;
  readonly usage: string;
  readonly argsHint: string;
  readonly hidden?: boolean | undefined;
  readonly confirmMutations: boolean;
  readonly help: string;
  readonly invalidVerbosity: (value: string) => string;
  readonly domainSet: (domain: string, value: string) => string;
}): TerminalSlashCommand<Context> {
  return {
    name: 'mode',
    aliases: ['hitl'],
    description: policy.description,
    usage: policy.usage,
    argsHint: policy.argsHint,
    hidden: policy.hidden,
    handler(args, ctx) {
      const mgr = ctx.ops.modeManager;
      if (!mgr) {
        ctx.print('Interaction mode manager is not available in this runtime.');
        return;
      }
      const parsed = policy.confirmMutations ? stripYesFlag(args) : { rest: args, yes: true };
      const commandArgs = parsed.rest;
      const sub = commandArgs[0] ?? 'show';

      if (sub === 'quiet' || sub === 'balanced' || sub === 'operator') {
        if (!parsed.yes) {
          requireYesFlag(ctx, `set HITL mode to ${sub}`, '/mode <quiet|balanced|operator> --yes');
          return;
        }
        const newMode = sub as 'quiet' | 'balanced' | 'operator';
        mgr.setHITLMode(newMode);
        try {
          ctx.platform.configManager.setDynamic(
            'behavior.hitlMode' as import('@goodvibes-jev/engine/platform/platform/config').ConfigKey,
            newMode,
          );
        } catch (e) {
          logger.warn('[/mode] Failed to persist mode', { error: summarizeError(e) });
        }
        const preset = mgr.getHITLPreset();
        ctx.print(`HITL mode set to: ${preset.name}\n${preset.description}`);
        ctx.renderRequest();
        return;
      }

      if (sub === 'show') {
        const current = mgr.getHITLMode();
        const preset = mgr.getHITLPreset();
        const overrides = mgr.getDomainOverrides();
        const lines: string[] = [
          `HITL mode: ${current}`,
          `  ${preset.description}`,
          `  Default domain verbosity: ${preset.defaultDomainVerbosity}`,
          `  Quiet-while-typing: ${preset.quietWhileTyping}`,
          `  Batch window: ${preset.batchWindowMs}ms`,
        ];
        const overrideEntries = Object.entries(overrides);
        if (overrideEntries.length > 0) {
          lines.push('  Per-domain overrides:');
          for (const [domain, verbosity] of overrideEntries) lines.push(`    ${domain}: ${verbosity}`);
        } else {
          lines.push('  No per-domain overrides.');
        }
        lines.push('');
        lines.push('Available presets:');
        for (const p of mgr.listHITLPresets()) {
          const marker = p.name === current ? '\u25b6' : ' ';
          lines.push(`  ${marker} ${p.name.padEnd(10)} ${p.description}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      if (sub === 'set-domain') {
        const domain = commandArgs[1];
        const verbosity = commandArgs[2];
        if (!domain || !verbosity) {
          ctx.print('Usage: /mode set-domain <domain> <minimal|normal|verbose>' + (policy.confirmMutations ? ' --yes' : ''));
          return;
        }
        if (verbosity !== 'minimal' && verbosity !== 'normal' && verbosity !== 'verbose') {
          ctx.print(policy.invalidVerbosity(verbosity));
          return;
        }
        if (!parsed.yes) {
          requireYesFlag(ctx, `set HITL verbosity for ${domain}`, '/mode set-domain <domain> <minimal|normal|verbose> --yes');
          return;
        }
        mgr.setDomainVerbosity(domain, verbosity as 'minimal' | 'normal' | 'verbose');
        ctx.print(policy.domainSet(domain, verbosity));
        return;
      }

      ctx.print(policy.help);
    },
  };
}
