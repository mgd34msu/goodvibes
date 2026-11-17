import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { TerminalSlashCommand } from './command-registry.js';
import { readRefusal } from '@goodvibes-jev/engine/errors';
import { commandRefusal, stripYesFlag } from './command-confirmation.js';
import { switchAlwaysSpeak } from './tts-runtime-commands.js';
import { inspectVoiceBundle, isVoiceBundleKey, readVoiceBundle, type VoiceBundle } from './voice-settings-review.js';
interface ExperienceContext {
  print(message: string): void;
  readonly platform: { readonly configManager: Pick<ConfigManager, 'get' | 'setDynamic' | 'setMany' | 'getSchema'>; readonly voiceService?: unknown };
}
export function createApprovalMatrixCommand<Context extends ExperienceContext>(policy: {
  readonly hidden?: boolean | undefined;
  readonly usage: string;
  readonly help: string;
  readonly matrix: readonly (readonly [string, string])[];
  readonly related: string;
  readonly open: (context: Context) => void;
  readonly action?: ((args: string[], context: Context) => Promise<boolean>) | undefined;
}): TerminalSlashCommand<Context> {
  return {
    name: 'approval',
    effect: 'connected-host-state',
    aliases: ['approvals'],
    description: 'Review action-specific approval classes and the specialized security UX matrix',
    hidden: policy.hidden,
    usage: policy.usage,
    async handler(args, ctx) {
      const sub = (args[0] ?? 'matrix').toLowerCase();
      if (await policy.action?.(args, ctx)) return;
      if (sub === 'open' || sub === 'panel') {
        policy.open(ctx);
        return;
      }
      if (sub === 'matrix') {
        ctx.print(['Approval Matrix', ...policy.matrix.map(([kind, summary]) => '  ' + kind.padEnd(10) + ' ' + summary)].join('\n'));
        return;
      }
      if (sub === 'review') {
        const kind = (args[1] ?? '').toLowerCase(),
          entry = policy.matrix.find(([id]) => id === kind);
        if (!entry) {
          throw commandRefusal('Usage: /approval review <' + policy.matrix.map(([id]) => id).join('|') + '>');
        }
        ctx.print(['Approval Review: ' + entry[0], '  ' + entry[1], policy.related].join('\n'));
        return;
      }
      ctx.print(policy.help);
    },
  };
}
export const COMMON_APPROVAL_SUMMARIES = {
  shell: 'Shell execution approval with side-effect and credential review.',
  file: 'File mutation approval with config/notebook differentiation.',
  network: 'Network access approval with host/scope review.',
  mcp: 'MCP trust escalation approval with host/path review.',
  remote: 'Remote dispatch approval with trust/artifact review.',
  hook: 'Hook execution approval with deny/mutate authority review.',
  plugin: 'Plugin lifecycle approval with provenance and capability review.',
} as const;
export function createVoiceExperienceCommand<Context extends ExperienceContext>(policy: {
  readonly description: string;
  readonly usage: string;
  readonly help: string;
  readonly reportFailure: boolean;
  readonly paths: (context: Context) => ShellPathService;
  readonly wake: (args: string[], ctx: Context, shellPaths: ShellPathService) => void | Promise<void>;
  readonly provision: (
    sub: 'status' | 'setup',
    args: string[],
    ctx: Context,
    shellPaths: ShellPathService,
  ) => void | Promise<void>;
  readonly review: (enabled: boolean) => string[];
}): TerminalSlashCommand<Context> {
  return {
    name: 'voice',
    effect: 'mixed',
    description: policy.description,
    usage: policy.usage,
    async handler(args, ctx) {
      try {
        const { rest } = stripYesFlag(args);
        const commandArgs = [...rest],
          shellPaths = policy.paths(ctx),
          sub = (commandArgs[0] ?? 'review').toLowerCase();
        if (sub === 'wake') {
          await policy.wake(commandArgs, ctx, shellPaths);
          return;
        }
        if (sub === 'status' || sub === 'setup') {
          await policy.provision(sub, commandArgs, ctx, shellPaths);
          return;
        }
        if (sub === 'review') {
          ctx.print(policy.review(Boolean(ctx.platform.configManager.get('ui.voiceEnabled') ?? false)).join('\n'));
          return;
        }
        if (sub === 'enable' || sub === 'disable') {
          // Same switch, same rule as /tts on|off: a reversible preference, so no confirmation.
          ctx.print(switchAlwaysSpeak(ctx, sub === 'enable'));
          return;
        }
        if (sub === 'bundle') {
          const mode = commandArgs[1],
            path = commandArgs[2];
          if (mode === 'export' || mode === 'inspect' || mode === 'import') {
            if (!path) {
              throw commandRefusal(`Usage: /voice bundle ${mode} <path>`);
            }
            const target = shellPaths.resolveWorkspacePath(path);
            if (mode === 'export') {
              const config = ctx.platform.configManager;
              const settings: Record<string, unknown> = {};
              for (const setting of config.getSchema()) {
                if (!isVoiceBundleKey(setting.key)) continue;
                const value = config.get(setting.key);
                if (JSON.stringify(value) !== JSON.stringify(setting.default)) settings[setting.key] = value;
              }
              const bundle: VoiceBundle = { version: 2, exportedAt: Date.now(), settings };
              mkdirSync(dirname(target), { recursive: true });
              writeFileSync(target, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
              ctx.print(`Voice bundle exported to ${target} (${Object.keys(settings).length} changed voice setting${Object.keys(settings).length === 1 ? '' : 's'}).`);
              return;
            }
            if (!existsSync(target)) throw commandRefusal('File not found: ' + target);
            let value: unknown;
            try {
              value = JSON.parse(readFileSync(target, 'utf-8'));
            } catch (error) {
              throw commandRefusal('Could not read the voice bundle: ' + (error instanceof Error ? error.message : String(error)));
            }
            if (mode === 'inspect') {
              ctx.print(inspectVoiceBundle(value));
              return;
            }
            const read = readVoiceBundle(value);
            if ('problem' in read) throw commandRefusal('Nothing was applied. ' + read.problem);
            const changes = Object.entries(read.bundle.settings).map(([key, setting]) => ({ key: key as ConfigKey, value: setting }));
            const result = ctx.platform.configManager.setMany(changes, { kind: 'owner', surface: 'voice' });
            if (!result.ok) throw commandRefusal(`Voice bundle not applied: ${result.refusal.reason}`, result.refusal.next.join(' ') || undefined);
            // The daemon's settings in the bundle went to it as one update; it is applied only once the daemon took it.
            const refused = result.pending ? await result.pending.settle() : [];
            if (refused.length > 0) {
              const first = refused[0]!;
              const kept = result.saved.length - refused.length;
              throw commandRefusal(`Voice bundle not fully applied: the daemon refused ${refused.map(refusal => refusal.key).join(', ')} (${first.error instanceof Error ? first.error.message : String(first.error)}), which keep their previous values${kept > 0 ? `; the other ${kept} setting${kept === 1 ? ' was' : 's were'} saved` : ''}.`);
            }
            ctx.print(`Voice bundle applied: ${result.saved.length} setting${result.saved.length === 1 ? '' : 's'} from ${target}.`);
            return;
          }
        }
        ctx.print(policy.help);
      } catch (error) {
        // A refusal already says what was not done; anything else is reported as one.
        if (!policy.reportFailure || readRefusal(error)) throw error;
        throw commandRefusal('voice command failed: ' + (error instanceof Error ? error.message : String(error)));
      }
    },
  };
}
