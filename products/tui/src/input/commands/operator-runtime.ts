import {
  createContextInspectionCommand,
  createErrorNavigationCommands,
} from '@goodvibes-jev/engine/terminal-shell/context-inspection-command';
import { createInteractionModeCommand } from '@goodvibes-jev/engine/terminal-shell/interaction-mode-command';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { ToolContractVerifier } from '@/runtime/index.ts';
import type { ReplaySnapshotInput } from '@/runtime/index.ts';
import '@goodvibes-jev/engine/sdk/platform/utils';
import { registerLegacyPanelCommand } from './legacy-panel-command.ts';
import { requireOpsApi, requireProfileManager, requireReplayEngine } from './runtime-services.ts';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import { estimateConversationTokens } from '@goodvibes-jev/engine/sdk/platform/core';
import { handleContextWindowSubcommand } from './context-window.ts';

export function registerOperatorRuntimeCommands(registry: CommandRegistry): void {
  registerLegacyPanelCommand(registry);

  registry.register({
    name: 'settings',
    aliases: ['cfg-ui'],
    description: 'Open the fullscreen configuration workspace',
    handler(_args, ctx) {
      if (ctx.openSettingsModal) ctx.openSettingsModal();
      else ctx.print('Configuration workspace is not available in this runtime.');
    },
  });

  registry.register(contextInspectionCommand);

  registry.register(errorNavigationCommands.nextError);

  registry.register({
    name: 'profiles',
    // The singular `profile` alias was given up to /profile, the owner profile
    // (docs/owner-profile.md). These are two unrelated things, this command
    // loads saved display/provider settings presets, and the other one is what
    // the platform knows about the person who owns it, and the singular word
    // now belongs to the second. `/profiles` is unchanged; only the abbreviation
    // moved. See the naming note in docs/owner-profile.md §3.
    description: 'Browse and load config profiles',
    handler(_args, ctx) {
      if (ctx.openProfilePicker) {
        ctx.openProfilePicker();
      } else {
        const profiles = requireProfileManager(ctx).list();
        if (profiles.length === 0) ctx.print('No profiles saved. Open /profiles and press s to save the current settings as a profile.');
        else ctx.print(['Saved profiles:', ...profiles.map((p) => `  ${p.name}`)].join('\n'));
      }
    },
  });

  registry.register(errorNavigationCommands.prevError);

  registry.register(interactionModeCommand);

  registry.register({
    name: 'ops',
    description: 'Operator Control Plane: view audit log, cancel/pause/resume/retry tasks and agents',
    usage: 'view | task <cancel|pause|resume|retry> <id> [note] | agent cancel <id> [note]',
    argsHint: '[view|task|agent]',
    handler(args, ctx) {
      const sub = args[0];

      if (sub === 'view' || sub === undefined) {
        // The flag-wired opener when the control plane is on, else the
        // Agents view, which holds the live operations content either way.
        if (ctx.openOpsView) ctx.openOpsView();
        else if (!ctx.openView?.('ops-control')) ctx.print('The Agents view is not available in this shell.');
        return;
      }

      if (sub === 'task') {
        const action = args[1];
        const taskId = args[2];
        const note = args.slice(3).join(' ') || undefined;
        if (!action || !taskId) {
          ctx.print('Usage: /ops task <cancel|pause|resume|retry> <task-id> [note]');
          return;
        }
        const opsApi = requireOpsApi(ctx);
        try {
          switch (action) {
            case 'cancel':
              opsApi.tasks.cancel(taskId, note);
              break;
            case 'pause':
              opsApi.tasks.pause(taskId, note);
              break;
            case 'resume':
              opsApi.tasks.resume(taskId, note);
              break;
            case 'retry':
              opsApi.tasks.retry(taskId, note);
              break;
            default:
              ctx.print(`Unknown task action "${action}". Use: cancel, pause, resume, retry`);
              return;
          }
          ctx.print(`[Ops] Task ${taskId}: ${action} dispatched.`);
        } catch (e) {
          ctx.print(`[Ops] Error: ${summarizeError(e)}`);
        }
        return;
      }

      if (sub === 'agent') {
        const action = args[1];
        const agentId = args[2];
        const note = args.slice(3).join(' ') || undefined;
        if (action !== 'cancel' || !agentId) {
          ctx.print('Usage: /ops agent cancel <agent-id> [note]');
          return;
        }
        const opsApi = requireOpsApi(ctx);
        try {
          opsApi.agents.cancel(agentId, note);
          ctx.print(`[Ops] Agent ${agentId}: cancel dispatched.`);
        } catch (e) {
          ctx.print(`[Ops] Error: ${summarizeError(e)}`);
        }
        return;
      }

      ctx.print(
        'Usage: /ops <subcommand>\n' +
          '  /ops view                              — open Agents (F2 or Ctrl+O)\n' +
          '  /ops task cancel <id> [note]           — cancel a task\n' +
          '  /ops task pause  <id> [note]           — pause a task\n' +
          '  /ops task resume <id> [note]           — resume a blocked task\n' +
          '  /ops task retry  <id> [note]           — retry a failed task\n' +
          '  /ops agent cancel <id> [note]          — cancel a running agent',
      );
    },
  });

  registry.register({
    name: 'tool',
    description: 'Verify registered tool contracts',
    usage: 'verify <name> | verify-all | contract show <name>',
    argsHint: 'verify <name> | verify-all | contract show <name>',
    async handler(args, ctx) {
      const sub = args[0];
      if (sub === 'verify' && args[1]) {
        const result = await ctx.extensions.toolRegistry.verifyContract(args[1]);
        if (!result) {
          ctx.print(`[tool verify] Tool '${args[1]}' is not registered.`);
          return;
        }
        ctx.print(ToolContractVerifier.formatResult(result));
        return;
      }
      if (sub === 'verify-all') {
        ctx.print(ToolContractVerifier.formatAllResults(await ctx.extensions.toolRegistry.verifyAllContracts()));
        return;
      }
      if (sub === 'contract' && args[1] === 'show' && args[2]) {
        const toolName = args[2];
        const result = await ctx.extensions.toolRegistry.verifyContract(toolName);
        if (!result) {
          ctx.print(`[tool contract show] Tool '${toolName}' is not registered.`);
          return;
        }
        const lines: string[] = [ToolContractVerifier.formatResult(result)];
        const tool = ctx.extensions.toolRegistry.list().find((t) => t.definition.name === toolName);
        if (tool) {
          lines.push('');
          lines.push('Tool Definition:');
          lines.push(`  Name:        ${tool.definition.name}`);
          lines.push(`  Description: ${tool.definition.description}`);
          lines.push(`  Parameters:  ${JSON.stringify(tool.definition.parameters, null, 2).replace(/\n/g, '\n               ')}`);
        }
        ctx.print(lines.join('\n'));
        return;
      }

      ctx.print(
        'Usage: /tool <subcommand>\n' +
          '  /tool verify <name>             — verify contract for a specific registered tool\n' +
          '  /tool verify-all                — verify contracts for all registered tools\n' +
          '  /tool contract show <name>      — show full contract details for a tool',
      );
    },
  });

  registry.register({
    name: 'forensics',
    aliases: ['foren'],
    description: 'Failure Forensics: view, inspect, and export auto-classified failure reports',
    usage: '[latest | show <id> | export <id>]',
    argsHint: '[latest|show|export]',
    handler(args, ctx) {
      const sub = args[0];
      if (sub === undefined || sub === 'view') {
        if (ctx.openForensicsView) ctx.openForensicsView();
        else ctx.print('The Agents view is not available.');
        return;
      }
      if (sub === 'latest') {
        if (!ctx.extensions.forensicsRegistry) {
          ctx.print('[Forensics] Registry not active.');
          return;
        }
        const report = ctx.extensions.forensicsRegistry.latest();
        if (!report) {
          ctx.print('[Forensics] No failure reports recorded this session.');
          return;
        }
        const lines: string[] = [
          `[Forensics] Latest failure report (id: ${report.id})`,
          `  Time:           ${new Date(report.generatedAt).toISOString()}`,
          `  Classification: ${report.classification}`,
          `  Summary:        ${report.summary}`,
        ];
        if (report.errorMessage) lines.push(`  Error:          ${report.errorMessage}`);
        if (report.stopReason) lines.push(`  Stop reason:    ${report.stopReason}`);
        if (report.taskId) lines.push(`  Task ID:        ${report.taskId}`);
        if (report.turnId) lines.push(`  Turn ID:        ${report.turnId}`);
        if (report.causalChain.length > 0) {
          lines.push('  Causal chain:');
          for (const entry of report.causalChain) {
            const marker = entry.isRootCause ? '  ● ' : '  · ';
            lines.push(`  ${marker}${entry.description}`);
          }
        }
        if (report.jumpLinks.length > 0) {
          lines.push('  Jump links:');
          for (const link of report.jumpLinks) {
            lines.push(`    [${link.kind}] ${link.label} → ${link.target}${link.args ? ` (${link.args})` : ''}`);
          }
        }
        lines.push(`  Use "/forensics show ${report.id}" for full JSON.`);
        ctx.print(lines.join('\n'));
        return;
      }
      if (sub === 'show') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /forensics show <id>');
          return;
        }
        if (!ctx.extensions.forensicsRegistry) {
          ctx.print('[Forensics] Registry not active.');
          return;
        }
        const json = ctx.extensions.forensicsRegistry.exportAsJson(id);
        if (!json) {
          ctx.print(`[Forensics] No report found with id "${id}". Use /forensics latest to see the most recent.`);
          return;
        }
        ctx.print(json);
        return;
      }
      if (sub === 'export') {
        const id = args[1];
        if (!id) {
          ctx.print('Usage: /forensics export <id>');
          return;
        }
        if (!ctx.extensions.forensicsRegistry) {
          ctx.print('[Forensics] Registry not active.');
          return;
        }
        const json = ctx.extensions.forensicsRegistry.exportBundleAsJson(id, {
          replaySnapshot: requireReplayEngine(ctx).getSnapshot() as ReplaySnapshotInput,
        });
        if (!json) {
          ctx.print(`[Forensics] No report found with id "${id}".`);
          return;
        }
        ctx.print(`[Forensics] Incident bundle ${id}:\n${json}`);
        return;
      }
      ctx.print(
        'Usage: /forensics <subcommand>\n' +
          '  /forensics             — open Agents on forensics\n' +
          '  /forensics latest      — print the most recent failure report summary\n' +
          '  /forensics show <id>   — show full JSON for a specific report\n' +
          '  /forensics export <id> — export incident bundle JSON to the conversation',
      );
    },
  });
}

const interactionModeCommand = createInteractionModeCommand<CommandContext>({
  description: 'Manage HITL UX notification mode (quiet/balanced/operator)',
  usage: '[quiet|balanced|operator|show|set-domain <domain> <verbosity>]',
  argsHint: '[preset|show|set-domain]',
  confirmMutations: false,
  help:
    'Usage: /mode [quiet|balanced|operator|show|set-domain <domain> <verbosity>]\n' +
    '  /mode                          — show current mode and settings\n' +
    '  /mode show                     — show current mode and settings\n' +
    '  /mode quiet                    — suppress all non-critical notifications\n' +
    '  /mode balanced                 — surface warnings, batch info noise (default)\n' +
    '  /mode operator                 — full verbosity, no suppression\n' +
    '  /mode set-domain <d> <v>       — per-domain verbosity override (minimal|normal|verbose)',
  invalidVerbosity: (verbosity) => `Invalid verbosity "${verbosity}". Valid values: minimal, normal, verbose`,
  domainSet: (domain, verbosity) => `Domain "${domain}" verbosity set to: ${verbosity}`,
});

const contextInspectionCommand = createContextInspectionCommand<CommandContext>({
  description: 'Inspect context usage, or set/clear a custom context window for the current model',
  window: handleContextWindowSubcommand,
  estimate: (message) => estimateConversationTokens([message]),
  total: (messages) => estimateConversationTokens(messages),
});
const errorNavigationCommands = createErrorNavigationCommands<CommandContext>(false);
