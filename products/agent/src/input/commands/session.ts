import { createSessionGraphHandler } from '@goodvibes-jev/engine/terminal-shell/session-graph-command';
/**
 * /session command handler, Multi-session Orchestration.
 *
 * Implements read-only session graph inspection plus session continuity commands.
 * Local task graph mutation commands are blocked in Agent; explicit build/fix/review
 * handoff must use `/delegate` so GoodVibes TUI owns execution.
 */

import type { SlashCommand, CommandContext } from '../command-registry.ts';

import { handleSessionWorkflowCommand } from './session-workflow.ts';
import { requireSessionOrchestration } from './runtime-services.ts';

// ── Argument parsing helpers ──────────────────────────────────────────────────

/**
 * Extract a named flag value from args (e.g. `--to <value>`).
 * Returns undefined if the flag is not present.
 */

// ── Formatting helpers ────────────────────────────────────────────────────────

/** Status badge for display. */

/** Format a ref as a compact one-line string. */

function printSessionGraphMutationBlocked(context: CommandContext): void {
  context.print(
    [
      '[session] Local cross-session task graph mutation is blocked in GoodVibes Agent.',
      '[session] Use /session graph for read-only inspection.',
      '[session] Use /delegate <task> for explicit build/fix/review handoff to GoodVibes TUI.',
    ].join('\n'),
  );
}

// ── /session graph ────────────────────────────────────────────────────────────

// ── Top-level command definition ───────────────────────────────────────────────

/**
 * sessionCommand, The `/session` slash command.
 *
 * Routes to multi-session orchestration subcommand handlers based on args[0].
 */
export const sessionCommand: SlashCommand = {
  name: 'session',
  effect: 'session-lifecycle',
  aliases: ['sess'],
  description: 'Session continuity and read-only cross-session graph inspection.',
  usage: '<subcommand> [args]',
  argsHint: 'list|resume|save|events|groups|hotspots|graph',
  // A new name is the rest of the line exactly as typed.
  rawRest: (args) => (args[0] === 'rename' && args.length === 1 ? 1 : undefined),
  handler: async (args: string[], context: CommandContext): Promise<void> => {
    const [sub, ...rest] = args;

    switch (sub) {
      case 'link-task':
      case 'link':
        printSessionGraphMutationBlocked(context);
        break;

      case 'handoff':
      case 'ho':
        printSessionGraphMutationBlocked(context);
        break;

      case 'graph':
      case 'g':
        handleGraph(rest, context);
        break;

      case 'cancel':
        printSessionGraphMutationBlocked(context);
        break;

      default: {
        const handled = await handleSessionWorkflowCommand(args, context);
        if (!handled) {
          const usage = [
            'Usage: /session <subcommand>',
            '  list | rename <name> | resume <id|name> [--force] | fork [name] | save [name] | info [id] | export <id> [format] | search <query> | delete <id> --yes',
            '                                , Session continuity, export, resume, and pruning',
            '  events [kind] [start-row] [--last N] | groups [kind] [start-row] [--last N] | hotspots [kind]',
            '                                , Transcript structure: event log, grouped view, hotspot summary',
            '  graph [--session <sid>] [--format text|json]',
            '                                , Display the cross-session task dependency graph',
            '  link-task | handoff | cancel',
            '                                , Blocked in Agent; use /delegate for explicit build/fix/review handoff',
          ].join('\n');
          context.print(usage);
        }
        break;
      }
    }
  },
};

const handleGraph = createSessionGraphHandler<CommandContext>(
  requireSessionOrchestration,
  '[session] Task graph is empty. Local task graph mutation is blocked in Agent; use /delegate for explicit build/fix/review handoff.',
);
