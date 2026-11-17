import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { ConfigKey, ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import type { TerminalSlashCommand } from './command-registry.js';
import { requireYesFlag, stripYesFlag } from './command-confirmation.js';
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
          ctx.print('Usage: /approval review <' + policy.matrix.map(([id]) => id).join('|') + '>');
          return;
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
  readonly confirmMutations: boolean;
  readonly reportFailure: boolean;
  readonly paths: (context: Context) => ShellPathService;
  readonly wake: (args: string[], ctx: Context, shellPaths: ShellPathService, yes: boolean) => void | Promise<void>;
  readonly provision: (
    sub: 'status' | 'setup',
    args: string[],
    ctx: Context,
    shellPaths: ShellPathService,
    yes: boolean,
  ) => void | Promise<void>;
  readonly review: (enabled: boolean) => string[];
}): TerminalSlashCommand<Context> {
  return {
    name: 'voice',
    description: policy.description,
    usage: policy.usage,
    async handler(args, ctx) {
      try {
        const { rest, yes } = policy.confirmMutations ? stripYesFlag(args) : { rest: args, yes: true };
        const commandArgs = [...rest],
          shellPaths = policy.paths(ctx),
          sub = (commandArgs[0] ?? 'review').toLowerCase();
        if (sub === 'wake') {
          await policy.wake(commandArgs, ctx, shellPaths, yes);
          return;
        }
        if (sub === 'status' || sub === 'setup') {
          await policy.provision(sub, commandArgs, ctx, shellPaths, yes);
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
              ctx.print(`Usage: /voice bundle ${mode} <path>${mode !== 'inspect' && policy.confirmMutations ? ' --yes' : ''}`);
              return;
            }
            const target = shellPaths.resolveWorkspacePath(path);
            if (mode === 'export') {
              if (!yes) {
                requireYesFlag(ctx, 'export voice bundle to ' + path, '/voice bundle export <path> --yes');
                return;
              }
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
            if (!existsSync(target)) {
              ctx.print('File not found: ' + target);
              return;
            }
            let value: unknown;
            try {
              value = JSON.parse(readFileSync(target, 'utf-8'));
            } catch (error) {
              ctx.print('could not read voice bundle: ' + (error instanceof Error ? error.message : String(error)));
              return;
            }
            if (mode === 'inspect') {
              ctx.print(inspectVoiceBundle(value));
              return;
            }
            if (!yes) {
              requireYesFlag(ctx, 'apply the voice settings in ' + path, '/voice bundle import <path> --yes');
              return;
            }
            const read = readVoiceBundle(value);
            if ('problem' in read) {
              ctx.print('Nothing was applied. ' + read.problem);
              return;
            }
            const changes = Object.entries(read.bundle.settings).map(([key, setting]) => ({ key: key as ConfigKey, value: setting }));
            const result = ctx.platform.configManager.setMany(changes, { kind: 'owner', surface: 'voice' });
            if (!result.ok) {
              ctx.print(`Voice bundle not applied: ${result.refusal.reason} ${result.refusal.next.join(' ')}`.trim());
              return;
            }
            ctx.print(`Voice bundle applied: ${result.saved.length} setting${result.saved.length === 1 ? '' : 's'} from ${target}.`);
            return;
          }
        }
        ctx.print(policy.help);
      } catch (error) {
        if (!policy.reportFailure) throw error;
        ctx.print('voice command failed: ' + (error instanceof Error ? error.message : String(error)));
      }
    },
  };
}
