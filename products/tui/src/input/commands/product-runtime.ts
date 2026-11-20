import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { CommandContext, CommandRegistry } from '../command-registry.ts';
import { listInstalledEcosystemEntries, loadEcosystemCatalog } from '@goodvibes-jev/engine/platform/platform/runtime/ecosystem/catalog';
import { discoverTasks } from '@/runtime/index.ts';
import { DEFAULT_TASK_SUITE_DIR } from './eval.ts';
import { requireEcosystemCatalogPaths, requireShellPaths } from './runtime-services.ts';
import { defineCommand } from '@goodvibes-jev/engine/terminal-shell/command-actions';
import { choiceInput, readAction, textInput } from '@goodvibes-jev/engine/terminal-shell/described-command-kit';
import { commandRefusal } from '@goodvibes-jev/engine/terminal-shell/command-confirmation';

interface ReleaseBundle {
  readonly version: 1;
  readonly capturedAt: number;
  readonly runtime: {
    readonly provider: string;
    readonly model: string;
    readonly sessionId: string;
  };
  /** The tasks in the project's eval task suite (/eval run). */
  readonly evalSuites: readonly string[];
  readonly incidentCount: number;
  readonly remote: {
    readonly pools: number;
    readonly contracts: number;
    readonly artifacts: number;
  };
  readonly ecosystem: {
    readonly pluginCatalog: number;
    readonly skillCatalog: number;
    readonly installedPlugins: number;
    readonly installedSkills: number;
  };
}

/** The ids of the tasks in the project's eval task suite; none when there is no suite or it cannot be read. */
function projectEvalTasks(projectRoot: string): string[] {
  const dir = join(projectRoot, DEFAULT_TASK_SUITE_DIR);
  if (!existsSync(dir)) return [];
  try {
    return discoverTasks(dir).map((task) => task.definition.id);
  } catch {
    return [];
  }
}

function buildReleaseBundle(ctx: CommandContext): ReleaseBundle {
  const remoteRuntime = ctx.ops.remoteRuntime;
  const incidents = ctx.extensions.forensicsRegistry?.getAll() ?? [];
  const ecosystemPaths = requireEcosystemCatalogPaths(ctx);
  return {
    version: 1,
    capturedAt: Date.now(),
    runtime: {
      provider: ctx.session.runtime.provider,
      model: ctx.session.runtime.model,
      sessionId: ctx.session.runtime.sessionId,
    },
    evalSuites: projectEvalTasks(requireShellPaths(ctx).workingDirectory),
    incidentCount: incidents.length,
    remote: {
      pools: remoteRuntime?.listPools().length ?? 0,
      contracts: remoteRuntime?.listContracts().length ?? 0,
      artifacts: remoteRuntime?.listArtifacts().length ?? 0,
    },
    ecosystem: {
      pluginCatalog: loadEcosystemCatalog('plugin', ecosystemPaths).length,
      skillCatalog: loadEcosystemCatalog('skill', ecosystemPaths).length,
      installedPlugins: listInstalledEcosystemEntries('plugin', ecosystemPaths).length,
      installedSkills: listInstalledEcosystemEntries('skill', ecosystemPaths).length,
    },
  };
}

function inspectReleaseBundle(path: string): string {
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as ReleaseBundle;
  return [
    'Release Bundle Review',
    `  provider/model: ${parsed.runtime.provider || '(unset)'}/${parsed.runtime.model || '(unset)'}`,
    `  eval tasks: ${parsed.evalSuites.length}`,
    `  incidents: ${parsed.incidentCount}`,
    `  remote pools/contracts/artifacts: ${parsed.remote.pools}/${parsed.remote.contracts}/${parsed.remote.artifacts}`,
    `  ecosystem catalog plugins/skills: ${parsed.ecosystem.pluginCatalog}/${parsed.ecosystem.skillCatalog}`,
  ].join('\n');
}

function formatReleaseBundle(title: string, bundle: ReleaseBundle): string {
  return [
    title,
    `  provider/model: ${bundle.runtime.provider || '(unset)'}/${bundle.runtime.model || '(unset)'}`,
    `  eval tasks: ${bundle.evalSuites.length}`,
    `  failure reports: ${bundle.incidentCount}`,
    `  remote pools/contracts/artifacts: ${bundle.remote.pools}/${bundle.remote.contracts}/${bundle.remote.artifacts}`,
    `  ecosystem catalog plugins/skills: ${bundle.ecosystem.pluginCatalog}/${bundle.ecosystem.skillCatalog}`,
    `  installed plugins/skills: ${bundle.ecosystem.installedPlugins}/${bundle.ecosystem.installedSkills}`,
  ].join('\n');
}

const TERMINAL = { terminalOnly: 'The evidence is read from the terminal app\'s own session.' } as const;

/** `/release`, described once (command-actions/): whether this project is ready to release, and the evidence as a file. */
export function registerProductRuntimeCommands(registry: CommandRegistry): void {
  registry.register(defineCommand<CommandContext>({
    name: 'release',
    title: 'Release readiness',
    summary: 'See whether this project is ready to release, and keep the evidence as a file',
    group: 'Product',
    report: 'review',
    actions: [
      readAction<CommandContext>({
        id: 'review', label: 'See release readiness', word: 'review',
        sentence: 'Shows the model in use, the project\'s eval tasks, this session\'s failure reports, remote work and the plugins and skills installed.',
        operator: TERMINAL,
        async run(_values, ctx) { return formatReleaseBundle('Release readiness', buildReleaseBundle(ctx)); },
      }),
      readAction<CommandContext>({
        id: 'checklist', label: 'See the release checklist', word: 'checklist',
        sentence: 'Lists the checks to run before a release, each with its line.',
        async run() {
          return [
            'Release checklist',
            '  1. /setup and /health: everything is set up and working',
            '  2. /security and /security trust: nothing needs attention, and you know what is trusted',
            '  3. /security preflight and /security simulate-policy: the policy is what you mean to enforce',
            '  4. /eval gate over the project\'s eval tasks',
            '  5. /health failure and /remote: no failure or remote work is left unexplained',
            '  6. /release save <file>: keep the evidence',
          ].join('\n');
        },
      }),
      {
        id: 'save', label: 'Save the release evidence to a file', word: 'save',
        inputs: [
          textInput({ id: 'path', label: 'File', help: 'Where to write it', why: 'a file path', kind: 'path', typed: { position: 1 } }),
          choiceInput({
            id: 'replace', label: 'If the file exists', help: 'Keep it, or write over it', typed: { flag: '--replace', switchOn: 'yes' },
            choices: [{ value: 'no', label: 'Keep it and stop' }, { value: 'yes', label: 'Write over it', risk: 'cannot-be-undone' }],
            optional: { default: 'no', means: 'keep it and stop' },
          }),
        ],
        sentence: 'The release evidence (what "See release readiness" shows) will be written to {path}, until you change it.',
        done: '', touches: 'this-machine', lasts: 'kept', risk: 'none',
        operator: TERMINAL, example: { path: 'release-evidence.json' },
        async run(values, ctx) {
          const targetPath = requireShellPaths(ctx).resolveWorkspacePath(values.path!);
          if (existsSync(targetPath) && values.replace !== 'yes') throw commandRefusal(`${targetPath} already exists; nothing was written.`, `Write over it: /release save ${values.path} --replace`);
          mkdirSync(dirname(targetPath), { recursive: true });
          writeFileSync(targetPath, JSON.stringify(buildReleaseBundle(ctx), null, 2) + '\n', 'utf-8');
          return `Saved the release evidence to ${targetPath}.`;
        },
      },
      readAction<CommandContext>({
        id: 'read', label: 'Read saved release evidence', word: 'read',
        inputs: [textInput({ id: 'path', label: 'File', help: 'Release evidence saved earlier', why: 'a file path', kind: 'path', typed: { position: 1 } })],
        sentence: 'Reads the release evidence saved in {path} and shows what it recorded.',
        example: { path: 'release-evidence.json' },
        async run(values, ctx) {
          try {
            return inspectReleaseBundle(requireShellPaths(ctx).resolveWorkspacePath(values.path!));
          } catch (error) {
            throw commandRefusal(`Could not read ${values.path}: ${error instanceof Error ? error.message : String(error)}`);
          }
        },
      }),
    ],
  }));
}
