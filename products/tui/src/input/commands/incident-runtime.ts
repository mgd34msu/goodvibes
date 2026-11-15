import { dirname, resolve } from 'path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import type { CommandRegistry } from '../command-registry.ts';
import { buildIncidentMemoryAddOptions } from '@goodvibes-jev/engine/platform/platform/state';
import { requireShellPaths } from './runtime-services.ts';
import { getMemorySpine } from './recall-query.ts';

export function registerIncidentRuntimeCommands(registry: CommandRegistry): void {
  registry.register({
    name: 'incident',
    aliases: [],
    description: 'Open, export, and capture incident review bundles',
    usage: '[open | latest | show <id|latest> | export <id|latest> <path> [--overwrite] | capture <id|latest>]',
    async handler(args, ctx) {
      const shellPaths = requireShellPaths(ctx);
      const subcommand = (args[0] ?? 'open').toLowerCase();
      const forensicRegistry = ctx.extensions.forensicsRegistry;
      if (subcommand === 'open') {
        if (ctx.openIncidentView) {
          ctx.openIncidentView();
          return;
        }
        ctx.print('The Agents view is not available in this runtime.');
        return;
      }
      if (!forensicRegistry) {
        ctx.print('Forensics registry is not available in this runtime.');
        return;
      }
      const requestedId = args[1];
      const report = !requestedId || requestedId === 'latest'
        ? forensicRegistry.latest()
        : forensicRegistry.getById(requestedId);
      if (subcommand === 'latest' || subcommand === 'show') {
        if (!report) {
          ctx.print(requestedId && requestedId !== 'latest' ? `Incident not found: ${requestedId}` : 'No incident bundle is available.');
          return;
        }
        const bundle = forensicRegistry.buildBundle(report.id);
        if (!bundle) {
          ctx.print(`Failed to build incident bundle for ${report.id}.`);
          return;
        }
        ctx.print([
          `Incident ${report.id}`,
          `  classification: ${report.classification}`,
          `  summary: ${report.summary}`,
          `  root cause: ${bundle.evidence.rootCause ?? 'n/a'}`,
          `  denied permissions: ${bundle.evidence.deniedPermissionCount}`,
          `  budget breaches: ${bundle.evidence.budgetBreachCount}`,
          `  replay mismatches: ${bundle.replay.mismatchCount}`,
        ].join('\n'));
        return;
      }
      if (subcommand === 'export') {
        const pathArg = args[2];
        if (!requestedId || !pathArg) {
          ctx.print('Usage: /incident export <id|latest> <path> [--overwrite]');
          return;
        }
        if (!report) {
          ctx.print(`Incident not found: ${requestedId}`);
          return;
        }
        const bundleJson = forensicRegistry.exportBundleAsJson(report.id);
        if (!bundleJson) {
          ctx.print(`Failed to export incident bundle for ${report.id}.`);
          return;
        }
        const targetPath = shellPaths.resolveWorkspacePath(pathArg);
        if (existsSync(targetPath) && !args.includes('--overwrite')) {
          ctx.print(`${targetPath} already exists; nothing was written. Choose another path or add --overwrite.`);
          return;
        }
        mkdirSync(dirname(targetPath), { recursive: true });
        writeFileSync(targetPath, `${bundleJson}\n`, 'utf-8');
        ctx.print(`Exported incident bundle ${report.id} to ${targetPath}`);
        return;
      }
      if (subcommand === 'capture') {
        const memory = getMemorySpine(ctx);
        if (!memory) return;
        if (!report) {
          ctx.print(`Incident not found: ${requestedId ?? 'latest'}`);
          return;
        }
        const bundle = forensicRegistry.buildBundle(report.id);
        if (!bundle) {
          ctx.print(`Failed to build incident bundle for ${report.id}.`);
          return;
        }
        // One durable record per incident: the id tag is what a repeat capture looks for.
        const incidentTag = `incident:${report.id}`;
        const existing = await memory.list({ cls: 'incident', tags: [incidentTag], limit: 1 });
        if (existing[0]) {
          ctx.print(`Incident ${report.id} is already in durable memory as ${existing[0].id}; nothing was added.`);
          return;
        }
        const options = buildIncidentMemoryAddOptions(bundle);
        const record = await memory.add({ ...options, tags: [...(options.tags ?? []), incidentTag] });
        ctx.print(`Captured incident ${report.id} into durable memory as ${record.id}`);
        return;
      }
      ctx.print('Usage: /incident [open | latest | show <id|latest> | export <id|latest> <path> [--overwrite] | capture <id|latest>]');
    },
  });
}
