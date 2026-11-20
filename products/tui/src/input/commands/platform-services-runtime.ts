import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandRegistry } from '../command-registry.ts';
import { requireShellPaths } from './runtime-services.ts';
import { DEEP_LINK_SURFACES, buildDeepLink, openDeepLink, parseDeepLink } from './deep-link.ts';

interface DeepLinkBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly links: readonly string[];
}

function inspectDeepLinkBundle(bundle: DeepLinkBundle): string {
  return [
    'Deep Link Bundle Review',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  links: ${bundle.links.length}`,
  ].join('\n');
}

export function registerPlatformServicesRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'helpers',
    aliases: ['integration-api'],
    description: 'Review local integration helper APIs for remote clients and future web frontends',
    usage: '[review]',
    handler(args, ctx) {
      const sub = args[0] ?? 'review';
      const review = ctx.extensions.integrationHelpers?.buildReview();
      if (!review) {
        ctx.print('Integration helper service unavailable in this runtime.');
        return;
      }
      if (sub === 'review') {
        ctx.print([
          'Integration Helper Review',
          `  sessions: ${review.sessions}`,
          `  tasks: ${review.tasks}`,
          `  pending approvals: ${review.pendingApprovals}`,
          `  remote contracts: ${review.remoteContracts}`,
          `  registered views: ${review.panels}`,
          '  api families:',
          ...review.apiFamilies.map((family) => `    - ${family}`),
          '  routes:',
          ...review.routes.map((route) => `    - ${route}`),
        ].join('\n'));
        return;
      }
      ctx.print('Usage: /helpers [review]\n  The API families and routes for a support thread are in /setup support-bundle <dir> (platform-review.json).');
    },
  });

  registry.register({
    name: 'deeplink',
    aliases: ['link'],
    description: 'List, open and package goodvibes://open links to views; a target selects a process in the Agents view',
    usage: '[review|open <view|goodvibes://open/...> [target]|bundle export <path>|bundle inspect <path>]',
    handler(args, ctx) {
      const sub = args[0] ?? 'review';
      const links = DEEP_LINK_SURFACES.map((surface) => buildDeepLink(surface));
      if (sub === 'review') {
        ctx.print(['Deep Link Review', ...links.map((link) => `  ${link}`), '  open one: /deeplink open <view> [target]'].join('\n'));
        return;
      }
      if (sub === 'open') {
        const subject = args[1];
        if (!subject) {
          ctx.print('Usage: /deeplink open <view|goodvibes://open/...> [target]');
          return;
        }
        const parsed = subject.includes('://') ? parseDeepLink(subject) : { surface: subject, ...(args[2] ? { target: args[2] } : {}) };
        if (!parsed) {
          ctx.print(`Not opened: ${subject} is not a goodvibes://open/<view> link.`);
          return;
        }
        ctx.print(openDeepLink(ctx, parsed.surface, parsed.target));
        return;
      }
      if (sub === 'bundle') {
        const shellPaths = requireShellPaths(ctx);
        const mode = args[1];
        const pathArg = args[2];
        if ((mode !== 'export' && mode !== 'inspect') || !pathArg) {
          ctx.print(`Usage: /deeplink bundle ${mode === 'export' || mode === 'inspect' ? mode : 'export|inspect'} <path>`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        if (mode === 'export') {
          const bundle: DeepLinkBundle = {
            version: 1,
            exportedAt: Date.now(),
            links,
          };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
          ctx.print(`Deep link bundle exported to ${targetPath}`);
          return;
        }
        if (mode === 'inspect') {
          const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as DeepLinkBundle;
          ctx.print(inspectDeepLinkBundle(bundle));
          return;
        }
      }
      ctx.print('Usage: /deeplink [review|open <view|goodvibes://open/...> [target]|bundle export <path>|bundle inspect <path>]');
    },
  });
}
