import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';
import { defineCommand, defineList, type ListRow } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { doAction, listInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { requireShellPaths } from './runtime-services.ts';
import { DEEP_LINK_SURFACES, buildDeepLink, openDeepLink, parseDeepLink } from './deep-link.ts';

interface DeepLinkBundle {
  readonly version: 1;
  readonly exportedAt: number;
  readonly links: readonly string[];
}

/** The views a link can open, as a live list (a static one: the views this terminal has). */
const DEEP_LINK_VIEWS = defineList<CommandContext>({
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

export function registerPlatformServicesRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'helpers',
    title: 'Integration helpers',
    summary: 'The local programming interfaces remote clients and web front ends use',
    group: 'Platform',
    actions: [readAction<CommandContext>({
      id: 'helpers', label: 'See the integration helper interfaces', word: '',
      sentence: 'Shows the sessions, tasks, approvals, remote contracts and views the helpers expose, with their interface families and routes.',
      operator: { terminalOnly: 'It reads the terminal app\'s own helper service.' },
      async run(_values, ctx) {
        const review = ctx.extensions.integrationHelpers?.buildReview();
        if (!review) throw commandRefusal('The integration helper service is not available in this session.');
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
          '  For a support thread these are in /setup support-bundle <dir> (platform-review.json).',
        ].join('\n');
      },
    })],
  }));

  registry.register(defineCommand<CommandContext>({
    name: 'deeplink',
    title: 'Links to views',
    summary: 'The goodvibes://open links to each view: see them, open one, or save them to a file and read one back',
    group: 'Views',
    report: 'review',
    actions: [
      readAction<CommandContext>({
        id: 'review', label: 'See the links to each view', word: 'review',
        sentence: 'Lists the goodvibes://open link of each view.',
        operator: { terminalOnly: 'the links open views of this terminal' },
        async run() { return ['Links to views:', ...DEEP_LINK_SURFACES.map((surface) => `  ${buildDeepLink(surface)}`), '  /deeplink open <view> [target] opens one.'].join('\n'); },
      }),
      doAction<CommandContext>({
        id: 'open', label: 'Open a view by its link', word: 'open',
        inputs: [
          listInput({ id: 'view', label: 'View', help: 'A view, or a whole goodvibes://open/... link', list: DEEP_LINK_VIEWS, other: 'a goodvibes://open/... link' }),
          textInput({ id: 'target', label: 'Target', help: 'A process to select in the Agents view', why: 'a process id', typed: { position: 2 }, optional: { default: '', means: 'nothing selected' } }),
        ],
        sentence: 'Opens {view}, with its target selected when one is given.', example: { view: 'tasks' },
        operator: { terminalOnly: 'the links open views of this terminal' },
        async run(values, ctx) {
          const subject = values.view!;
          const parsed = subject.includes('://') ? parseDeepLink(subject) : { surface: subject, ...(values.target ? { target: values.target } : {}) };
          if (!parsed) throw commandRefusal(`Not opened: ${subject} is not a goodvibes://open/<view> link.`);
          return openDeepLink(ctx, parsed.surface, parsed.target);
        },
      }),
      doAction<CommandContext>({
        id: 'export', label: 'Save the links to a file', word: 'export',
        inputs: [textInput({ id: 'path', label: 'File', help: 'Where to write them, in the workspace', why: 'a file path', kind: 'path', typed: { position: 1 } })],
        sentence: 'Every view\'s link is written to {path}.', example: { path: 'links.json' },
        operator: { terminalOnly: 'the file is written in this terminal\'s workspace' },
        async run(values, ctx) {
          const targetPath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          const bundle: DeepLinkBundle = { version: 1, exportedAt: Date.now(), links: DEEP_LINK_SURFACES.map((surface) => buildDeepLink(surface)) };
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, `${JSON.stringify(bundle, null, 2)}\n`, 'utf-8');
          return `Links saved to ${targetPath}`;
        },
      }),
      readAction<CommandContext>({
        id: 'inspect', label: 'Read a saved link file', word: 'inspect',
        inputs: [textInput({ id: 'path', label: 'File', help: 'A file saved by /deeplink export', why: 'a file path', kind: 'path', typed: { position: 1 } })],
        sentence: 'Shows when {path} was saved and how many links it holds.', example: { path: 'links.json' },
        operator: { terminalOnly: 'the file is read from this terminal\'s workspace' },
        async run(values, ctx) {
          const targetPath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          try {
            return inspectDeepLinkBundle(JSON.parse(readFileSync(targetPath, 'utf-8')) as DeepLinkBundle);
          } catch (error) {
            throw commandRefusal(`${targetPath} could not be read as a link file: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }),
    ],
  }));
}
