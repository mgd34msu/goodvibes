import { CodeIntelligence } from '@goodvibes-jev/engine/platform/platform/intelligence';
import { LANGUAGE_SERVER_INSTALL_USAGE, runLanguageServerInstall } from '@goodvibes-jev/engine/terminal-shell';
import type { CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';

/**
 * /intelligence install: the explicit owner action that installs the language
 * server code lookups use. A lookup never installs one; its "no server" answer
 * names this command, which the TUI runs the same way.
 */
export function registerIntelligenceRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'intelligence',
    aliases: ['intel'],
    description: 'Install the language server code lookups use for a language',
    usage: 'install <file|language>',
    argsHint: 'install <file|language>',
    // It downloads the server program into the user's bin directory.
    effect: 'external-network',
    async handler(args, ctx) {
      const sub = (args[0] ?? '').toLowerCase();
      if (sub !== 'install') {
        ctx.print(`Intelligence\n  Usage: ${LANGUAGE_SERVER_INSTALL_USAGE}  (installs the language server for that language into your GoodVibes bin directory)`);
        return;
      }
      await runLanguageServerInstall(args[1], {
        print: (text) => ctx.print(text),
        resolvePath: (target) => requireShellPaths(ctx).resolveWorkspacePath(target),
        // The workspace's one facade, the one the model's read and find tools hold, so a server
        // installed here is the one their next lookup starts.
        hold: () => CodeIntelligence.holdForWorkspace(requireShellPaths(ctx)),
        nextAfterInstall: 'code lookups for this language (find, read symbols) use it from now on',
      });
    },
  });
}
