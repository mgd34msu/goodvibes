import { AgentPersonaRegistry } from '@goodvibes-jev/engine/terminal-shell/agent-turn/persona-registry';
import { discoverVibeFiles, formatVibeStatus, initVibeFile, loadVibeImportSource, resolveVibePathReference } from '@goodvibes-jev/engine/terminal-shell/agent-turn/vibe-file';
import { existsSync } from 'node:fs';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { parseAgentLocalLibraryArgs } from './agent-local-library-args.ts';
import { requireShellPaths } from './runtime-services.ts';
import { commandRefusal } from './confirmation.ts';
import { readRefusal } from '@goodvibes-jev/engine/errors';

const VIBE_VALUE_FLAGS = ['name', 'description'] as const;

/** A failed step is the command's failed result: a refusal passes through, anything else is reported as failed. */
function printError(_ctx: CommandContext, error: unknown): never {
  if (readRefusal(error)) throw error;
  throw commandRefusal(`Error: ${error instanceof Error ? error.message : String(error)}`, undefined, 'COMMAND_FAILED');
}

function usage(): string {
  return [
    'Usage: /vibe [status|init|show|import-persona]',
    '  /vibe',
    '  /vibe init [--global] [--force]',
    '  /vibe show [project|global|path]',
    '  /vibe import-persona [project|global|path] [--name <name>] [--description <summary>] [--review] [--use]',
  ].join('\n');
}

export function registerVibeRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'vibe',
    // A reference may hold spaces and quotes; it is kept as typed.
    rawRest: (args) => ((args[0] ?? '').toLowerCase() === 'show' ? 1 : undefined),
    effect: 'local-state',
    aliases: ['vibes'],
    // Creating VIBE.md or importing it as a persona runs at once (a persona is
    // removed with /personas delete). Replacing an existing VIBE.md with the
    // template (--force) loses what the owner wrote, so the registry asks once.
    confirm(args, ctx) {
      if ((args[0] ?? '').toLowerCase() !== 'init' || !args.includes('--force')) return undefined;
      const path = resolveVibePathReference(requireShellPaths(ctx), args.includes('--global') ? 'global' : 'project');
      if (!existsSync(path)) return undefined;
      return { title: `Replace ${path}?`, detail: `${path} is replaced with the starter VIBE.md; what it says now cannot be recovered from here.`, confirmLabel: 'Replace' };
    },
    description: 'Inspect, create, and import VIBE.md personality files',
    hidden: true,
    usage: '[status|init|show|import-persona]',
    async handler(args, ctx) {
      const sub = (args[0] ?? 'status').toLowerCase();
      const shellPaths = requireShellPaths(ctx);
      try {
        if (sub === 'status' || sub === 'list' || sub === 'open') {
          ctx.print(formatVibeStatus(discoverVibeFiles(shellPaths)));
          return;
        }

        if (sub === 'init') {
          const parsed = parseAgentLocalLibraryArgs(args.slice(1), { valueFlags: VIBE_VALUE_FLAGS });
          const scope = parsed.flags.has('global') ? 'global' : 'project';
          const result = initVibeFile(shellPaths, { scope, force: parsed.flags.has('force') });
          ctx.print(result.created
            ? `Created ${scope} VIBE.md\n  path ${result.path}`
            : `VIBE.md already exists, so nothing was written\n  path ${result.path}\n  next /vibe init${scope === 'global' ? ' --global' : ''} --force replaces it with the starter`);
          return;
        }

        if (sub === 'show') {
          const reference = args.slice(1).join(' ').trim() || 'project';
          const source = loadVibeImportSource(shellPaths, reference);
          ctx.print([
            `${source.scope === 'global' ? 'Global' : 'Project'} VIBE.md`,
            `  path ${source.path}`,
            `  name ${source.name}`,
            `  description ${source.description}`,
            '',
            source.body,
          ].join('\n'));
          return;
        }

        if (sub === 'import-persona' || sub === 'import') {
          const parsed = parseAgentLocalLibraryArgs(args.slice(1), { valueFlags: VIBE_VALUE_FLAGS });
          const reference = parsed.rest.join(' ').trim() || 'project';
          const source = loadVibeImportSource(shellPaths, reference);
          const name = parsed.flags.get('name')?.trim() || source.name;
          const description = parsed.flags.get('description')?.trim() || source.description;
          if (ctx.invokedByModel === true && parsed.flags.has('review')) {
            throw commandRefusal('Refused: marking a persona reviewed is the owner\'s decision that its text may reach the prompt, so it only counts when you type it yourself. This came from the model running a command, which is the route content that was just read would use. Nothing was imported; rerun without --review, then review it yourself with /personas review <id>.');
          }
          const personaRegistry = AgentPersonaRegistry.fromShellPaths(shellPaths);
          const persona = personaRegistry.create({
            name,
            description,
            body: source.body,
            tags: ['vibe', source.scope],
            triggers: ['vibe'],
            source: 'imported',
            provenance: `Imported VIBE.md (${source.scope}): ${source.path}`,
          });
          if (parsed.flags.has('review')) personaRegistry.markReviewed(persona.id);
          if (parsed.flags.has('use')) personaRegistry.setActive(persona.id);
          ctx.print([
            `Imported VIBE.md persona ${persona.id}: ${persona.name}`,
            `  source ${source.scope}`,
            `  path ${source.path}`,
            `  reviewed ${parsed.flags.has('review') ? 'yes' : 'no'}`,
            `  active ${parsed.flags.has('use') ? 'yes' : 'no'}`,
          ].join('\n'));
          return;
        }

        ctx.print(usage());
      } catch (error) {
        printError(ctx, error);
      }
    },
  });
}
