import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandContext } from '../command-registry.ts';
import { defineList, type ListRow } from '@goodvibes/engine/terminal-shell/command-actions';
import { CapabilityRefusal, type DeepLinkCapabilityServices, type ToolsExtrasSessionServices } from '@goodvibes/engine/platform/platform/capabilities';
import { requireShellPaths } from './runtime-services.ts';
import { DEEP_LINK_SURFACES, buildDeepLink, openDeepLink, parseDeepLink } from './deep-link.ts';

interface DeepLinkBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly links: readonly string[];
}

/** The views a link can open, as a live list (a static one: the views this terminal has). */
defineList<CommandContext>({
  name: 'deeplink.views',
  async read() { return DEEP_LINK_SURFACES.map((surface): ListRow => ({ value: surface, label: surface, detail: buildDeepLink(surface) })); },
  operator: { terminalOnly: 'the links open views of this terminal' },
});

function inspectDeepLinkBundle(bundle: DeepLinkBundle): string {
  return [
    'Saved links',
    `  exportedAt: ${new Date(bundle.exportedAt).toISOString()}`,
    `  links: ${bundle.links.length}`,
  ].join('\n');
}

/**
 * The terminal app's integration helper service in words (builtin/tools-extras.ts `tools.helpers`, a control in Tools
 * and extensions); undefined where the service is not wired.
 */
export function integrationHelpersOf(ctx: CommandContext): ToolsExtrasSessionServices['integrationHelpers'] {
  const helpers = ctx.extensions.integrationHelpers;
  if (!helpers) return undefined;
  return {
    review() {
      const review = helpers.buildReview();
      return [
        'Integration helpers',
        `  sessions: ${review.sessions}`,
        `  tasks: ${review.tasks}`,
        `  approvals waiting: ${review.pendingApprovals}`,
        `  remote contracts: ${review.remoteContracts}`,
        `  registered views: ${review.panels}`,
        '  interface families:',
        ...review.apiFamilies.map((family) => `    - ${family}`),
        '  routes:',
        ...review.routes.map((route) => `    - ${route}`),
        '  A support bundle (System, Health) holds these too, in platform-review.json.',
      ].join('\n');
    },
  };
}

/** Every view's link written to a file in the project (builtin/tools-extras.ts `deeplink.export`). */
export function viewLinkFileOf(ctx: CommandContext): NonNullable<ToolsExtrasSessionServices['viewLinkFile']> {
  return {
    save(path) {
      const targetPath = requireShellPaths(ctx).resolveWorkspacePath(path);
      const bundle: DeepLinkBundle = { version: 1, exportedAt: Date.now(), links: DEEP_LINK_SURFACES.map((surface) => buildDeepLink(surface)) };
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
      return `Links saved to ${targetPath}`;
    },
  };
}

// `/helpers` is gone: the integration helper interfaces are `tools.helpers` (builtin/tools-extras.ts), a control in Tools and extensions.
// `/deeplink` is gone: its four actions are capabilities that run here (deeplink.review, deeplink.open, deeplink.inspect in
// the System place's Links tab; deeplink.export in Tools and extensions), each with this program's services.

/** This app's views and its link files, as the link capabilities that run here take them (builtin/deeplink.ts). */
export function deepLinksOf(ctx: CommandContext): NonNullable<DeepLinkCapabilityServices['deepLinks']> {
  return {
    open(subject, target) {
      const parsed = subject.includes('://') ? parseDeepLink(subject) : { surface: subject, ...(target ? { target } : {}) };
      if (!parsed) throw new CapabilityRefusal(`Not opened: ${subject} is not a goodvibes://open/<view> link.`);
      return openDeepLink(ctx, parsed.surface, parsed.target);
    },
    inspect(path) {
      const targetPath = requireShellPaths(ctx).resolveWorkspacePath(path);
      try {
        return inspectDeepLinkBundle(JSON.parse(readFileSync(targetPath, 'utf-8')) as DeepLinkBundle);
      } catch (error) {
        throw new CapabilityRefusal(`${targetPath} could not be read as a link file: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  };
}
