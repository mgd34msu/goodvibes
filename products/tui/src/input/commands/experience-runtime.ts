import {
  createApprovalMatrixCommand,
  COMMON_APPROVAL_SUMMARIES,
  createVoiceExperienceCommand,
} from '@goodvibes-jev/engine/terminal-shell/experience-commands';
import '@goodvibes-jev/engine/terminal-shell/voice-settings-review';
import 'node:fs';
import 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import {
  createVoiceProvisionGateway,
  renderVoiceProvision,
  runVoiceSetupWithProgress,
  VOICE_SETUP_ANNOUNCEMENT,
} from '../../core/voice-provision-gateway.ts';
import { resolveWakeRuntimeSettings } from '@goodvibes-jev/engine/platform/platform/voice/wake/runtime';
import { terminalWakeCapabilities } from '../../core/wake-provision-status.ts';
import { printWakeStatus, runWakeProvision } from '../../core/wake-provision-runner.ts';
import { wakeProvisionStatus } from '@goodvibes-jev/engine/platform/platform/voice';

export function registerExperienceRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'remote-setup',
    description: 'Dedicated front-door for remote setup review and portable setup bundles',
    usage: '[review|export <path>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      if (ctx.executeCommand) {
        if (sub === 'review') {
          await ctx.executeCommand('remote', ['setup']);
          return;
        }
        if (sub === 'export') {
          const pathArg = args[1];
          if (!pathArg) {
            ctx.print('Usage: /remote-setup export <path>');
            return;
          }
          await ctx.executeCommand('remote', ['setup', 'export', pathArg]);
          return;
        }
      }
      ctx.print('Remote setup controls are not available in this runtime.');
    },
  });

  registry.register({
    name: 'remote-env',
    description: 'Dedicated front-door for remote environment snippets and portable env exports',
    usage: '[review|export <path>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      if (ctx.executeCommand) {
        if (sub === 'review') {
          await ctx.executeCommand('remote', ['env']);
          return;
        }
        if (sub === 'export') {
          const pathArg = args[1];
          if (!pathArg) {
            ctx.print('Usage: /remote-env export <path>');
            return;
          }
          await ctx.executeCommand('remote', ['env', 'export', pathArg]);
          return;
        }
      }
      ctx.print('Remote environment controls are not available in this runtime.');
    },
  });

  registry.register({
    name: 'tunnel',
    description: 'Dedicated front-door for remote tunnel review and export flows',
    usage: '[review|export <path>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'review').toLowerCase();
      if (ctx.executeCommand) {
        if (sub === 'review') {
          await ctx.executeCommand('remote', ['tunnel', 'review']);
          return;
        }
        if (sub === 'export') {
          const pathArg = args[1];
          if (!pathArg) {
            ctx.print('Usage: /tunnel export <path>');
            return;
          }
          await ctx.executeCommand('remote', ['tunnel', 'export', pathArg]);
          return;
        }
      }
      ctx.print('Tunnel controls are not available in this runtime.');
    },
  });

  registry.register({
    name: 'bootstrap',
    description: 'Dedicated front-door for remote bootstrap bundle export and inspection',
    usage: '[export <path>|inspect <path>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? '').toLowerCase();
      const pathArg = args[1];
      if (!ctx.executeCommand) {
        ctx.print('Bootstrap controls are not available in this runtime.');
        return;
      }
      if ((sub === 'export' || sub === 'inspect') && pathArg) {
        await ctx.executeCommand('remote', ['bootstrap', sub, pathArg]);
        return;
      }
      ctx.print('Usage: /bootstrap [export <path>|inspect <path>]');
    },
  });

  registry.register({
    name: 'runner-pool',
    aliases: ['pool'],
    description: 'Dedicated front-door for remote runner pool review and assignment flows',
    usage: '[list|show <id>|create <id> <label...>|assign <pool> <runner>|unassign <pool> <runner>]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'list').toLowerCase();
      if (!ctx.executeCommand) {
        ctx.print('Runner pool controls are not available in this runtime.');
        return;
      }
      if (sub === 'list') {
        await ctx.executeCommand('remote', ['pool', 'list']);
        return;
      }
      if (sub === 'show' && args[1]) {
        await ctx.executeCommand('remote', ['pool', 'show', args[1]]);
        return;
      }
      if (sub === 'create' && args[1] && args.length >= 3) {
        await ctx.executeCommand('remote', ['pool', 'create', args[1], ...args.slice(2)]);
        return;
      }
      if ((sub === 'assign' || sub === 'unassign') && args[1] && args[2]) {
        await ctx.executeCommand('remote', ['pool', sub, args[1], args[2]]);
        return;
      }
      ctx.print('Usage: /runner-pool [list|show <id>|create <id> <label...>|assign <pool> <runner>|unassign <pool> <runner>]');
    },
  });

  registry.register(approvalMatrixCommand);

  registry.register({
    name: 'memory-review',
    aliases: ['knowledge-review'],
    description: 'Dedicated front-door for knowledge review queues and task-specific memory injection explanations',
    usage: '[queue [limit]|explain <task...> [--scope <path> ...]]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'queue').toLowerCase();
      if (!ctx.executeCommand) {
        ctx.print('Memory review controls are not available in this runtime.');
        return;
      }
      if (sub === 'queue') {
        await ctx.executeCommand('knowledge', ['queue', ...(args[1] ? [args[1]] : [])]);
        return;
      }
      if (sub === 'explain' && args.length >= 2) {
        await ctx.executeCommand('knowledge', ['explain', ...args.slice(1)]);
        return;
      }
      ctx.print('Usage: /memory-review [queue [limit]|explain <task...> [--scope <path> ...]]');
    },
  });

  registry.register(voiceExperienceCommand);
}

const approvalMatrixCommand = createApprovalMatrixCommand<CommandContext>({
  usage: '[matrix|review <kind>]',
  help: 'Usage: /approval [open|matrix|review <kind>]',
  hidden: false,
  matrix: [
    ['shell', COMMON_APPROVAL_SUMMARIES.shell],
    ['file', COMMON_APPROVAL_SUMMARIES.file],
    ['network', COMMON_APPROVAL_SUMMARIES.network],
    ['delegate', 'Agent spawn/delegation approval with recursion ceilings.'],
    ['mcp', COMMON_APPROVAL_SUMMARIES.mcp],
    ['remote', COMMON_APPROVAL_SUMMARIES.remote],
    ['hook', COMMON_APPROVAL_SUMMARIES.hook],
    ['plugin', COMMON_APPROVAL_SUMMARIES.plugin],
    ['sandbox', 'Sandbox isolation/policy change approval with WSL/VM review.'],
  ] as const,
  related: '  Related surfaces: /security, /policy preflight, /trust, /sandbox, /mcp',
  open(ctx) {
    // Approvals waiting on you are rows in the Agents view (b jumps to them).
    if (!ctx.openView?.('approval')) ctx.print('The Agents view is not available in this session.');
    return;
  },
});
const voiceExperienceCommand = createVoiceExperienceCommand<CommandContext>({
  description:
    'Review or toggle always-speak mode, provision the managed local voice runtime and the wake-word models (setup/status), and package portable voice metadata',
  usage: '[review|status|setup|enable|disable|wake status|wake setup|bundle export <path>|bundle inspect <path>]',
  help: 'Usage: /voice [review|status|setup|enable|disable|wake status|wake setup|bundle export <path>|bundle inspect <path>]',
  confirmMutations: false,
  reportFailure: false,
  paths: requireShellPaths,
  async wake(args, ctx, shellPaths, _yes) {
    // The wake models are provisioned locally by the platform (checksum-pinned
    // download), not through a daemon verb, so this path needs no gateway.
    // Installation already provisions them and a daemon retries at boot;
    // `setup` here is the recovery act, and nothing downloads unless the user
    // typed it, see wake-provision-runner.ts.
    const wakeSub = (args[1] ?? 'status').toLowerCase();
    const managedRoot = shellPaths.resolveUserPath('voice');
    const runner = {
      managedRoot,
      settings: resolveWakeRuntimeSettings(
        (key: string) => ctx.platform.configManager.get(key as Parameters<typeof ctx.platform.configManager.get>[0]),
        'tui',
        // Read from disk, so `/voice wake status` reports the speech gate as
        // available exactly when its artifact is there and verified.
        terminalWakeCapabilities(wakeProvisionStatus({ managedRoot })),
      ),
      print: (block: string) => ctx.print(block),
    };
    if (wakeSub === 'setup') {
      await runWakeProvision(runner);
      return;
    }
    if (wakeSub === 'status') {
      printWakeStatus(runner);
      return;
    }
    ctx.print('Usage: /voice wake [status|setup]');
    return;
  },
  async provision(sub, _args, ctx, _shellPaths, _yes) {
    // The one-act managed install returns a final receipt (no per-phase
    // streaming over the verb), so the announcement block prints first and
    // the receipt/failure block follows once the (possibly long,
    // multi-hundred-MB) install resolves.
    const resolution = createVoiceProvisionGateway({
      configManager: ctx.platform.configManager,
      // Lazy: the daemon-disabled / no-base-URL refusals resolve before shell paths.
      homeDirectory: () => requireShellPaths(ctx).homeDirectory,
    });
    if (sub === 'setup') {
      // Print the up-front announcement, then drive the install with live
      // per-component progress polled from voice.local.status.
      if (resolution.available) ctx.print(VOICE_SETUP_ANNOUNCEMENT);
      await runVoiceSetupWithProgress(resolution, { print: (block) => ctx.print(block) });
      return;
    }
    ctx.print(await renderVoiceProvision(sub, resolution));
    return;
  },
  review: (enabled) => [
    'Voice Review',
    `  always-speak: ${enabled ? 'on' : 'off'}`,
    '  config key: ui.voiceEnabled (same as /tts on|off)',
    '  posture: optional local TTS output; disabled by default',
    '  note: voice remains an optional operator convenience, not a required SaaS dependency',
  ],
  toggled: (next) =>
    `Always-speak mode ${next ? 'enabled' : 'disabled'}. ${next ? 'Every submitted turn will be played through live TTS.' : 'Use /tts <prompt> to speak individual turns.'}`,
  notes: ['Voice is optional and local-first.', 'Secure sandbox mode and operator review remain the primary control surfaces.'],
  inspectMissingFile: false,
  reportReadFailure: false,
});
