import { createCloudflareCommand } from '@goodvibes-jev/engine/terminal-shell/cloudflare-command';
import { requireShellPaths } from '@goodvibes-jev/engine/terminal-shell/command-service-access';
import { createCloudflareDaemonClient } from '../../runtime/cloudflare-control-plane.ts';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';

export { readCloudflareLine } from '@goodvibes-jev/engine/terminal-shell/cloudflare-command';

/** /cloudflare over the daemon this terminal dials; `setup` opens the onboarding wizard's Cloudflare step. */
export function registerCloudflareRuntimeCommands(registry: CommandRegistry): void {
  registry.register(createCloudflareCommand<CommandContext>({
    client: (ctx) => createCloudflareDaemonClient({
      configManager: ctx.platform.configManager,
      homeDirectory: requireShellPaths(ctx).homeDirectory,
    }),
    readSetting: (ctx, key) => ctx.platform.configManager.get(key),
    openSetup: (ctx) => {
      if (!ctx.openOnboardingWizard) return false;
      ctx.openOnboardingWizard({ mode: 'edit', reset: true, topic: 'cloudflare' });
      return true;
    },
  }));
}
