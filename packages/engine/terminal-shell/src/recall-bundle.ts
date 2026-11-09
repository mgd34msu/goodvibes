import { dirname } from 'node:path';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemoryBundle, MemorySearchFilter } from '@goodvibes-jev/engine/platform/platform/state';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { VALID_CLASSES, VALID_SCOPES, isValidClass, isValidScope, resolveBundlePath } from './recall-shared.js';
import { afterMemory, mutationArguments, type RecallQueryContext } from './recall-query.js';
export function createRecallBundleCommands<Context extends RecallQueryContext>(
  getMemory: (context: Context) => {
    exportBundle(filter: MemorySearchFilter): MemoryBundle | Promise<MemoryBundle>;
    importBundle: MemoryApi['importBundle'];
  } | null,
  getPaths: (context: Context) => Pick<ShellPathService, 'resolveWorkspacePath'>,
  presentation: {
    readonly tag: string;
    readonly command: string;
    readonly validValuesLabel: string;
    readonly validValuesSuffix: string;
    readonly confirmMutations: boolean;
    readonly errorSeparator: string;
    readonly fieldSeparator: string;
    readonly recordsLabel: string;
    readonly linksLabel: string;
  },
) {
  function handleRecallExport(args: string[], context: Context): void | Promise<void> {
    const parsed = mutationArguments(args, presentation.confirmMutations);
    args = parsed.rest;
    const memory = getMemory(context);
    if (!memory) {
      return;
    }
    const pathArg = args[0];
    if (!pathArg) {
      context.print(
        `${presentation.tag} Usage: /${presentation.command} export <path> [--scope <scope>] [--cls <class>]${presentation.confirmMutations ? ' --yes' : ''}`,
      );
      return;
    }
    if (!parsed.yes) {
      context.print(
        `Refusing to export durable memory bundle to ${pathArg} without --yes.\nUsage: /${presentation.command} export <path> [--scope <scope>] [--cls <class>] --yes`,
      );
      return;
    }
    const filter: MemorySearchFilter = {};
    const scopeIdx = args.indexOf('--scope');
    const scope = scopeIdx !== -1 ? args[scopeIdx + 1] : undefined;
    if (scope) {
      if (!isValidScope(scope)) {
        context.print(
          `${presentation.tag} Unknown scope "${scope}". ${presentation.validValuesLabel} ${VALID_SCOPES.join(', ')}${presentation.validValuesSuffix}`,
        );
        return;
      }
      filter.scope = scope;
    }
    const clsIdx = args.indexOf('--cls');
    const cls = clsIdx !== -1 ? args[clsIdx + 1] : undefined;
    if (cls) {
      if (!isValidClass(cls)) {
        context.print(
          `${presentation.tag} Unknown class "${cls}". ${presentation.validValuesLabel} ${VALID_CLASSES.join(', ')}${presentation.validValuesSuffix}`,
        );
        return;
      }
      filter.cls = cls;
    }
    return afterMemory(memory.exportBundle(filter), (bundle) => {
      const targetPath = resolveBundlePath(pathArg, getPaths(context));
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
      context.print(`${presentation.tag} Exported ${bundle.recordCount} record(s) and ${bundle.linkCount} link(s) to ${targetPath}`);
    });
  }
  async function handleRecallImport(args: string[], context: Context): Promise<void> {
    const parsed = mutationArguments(args, presentation.confirmMutations);
    args = parsed.rest;
    const memory = getMemory(context);
    if (!memory) {
      return;
    }
    const pathArg = args[0];
    if (!pathArg) {
      context.print(`${presentation.tag} Usage: /${presentation.command} import <path>${presentation.confirmMutations ? ' --yes' : ''}`);
      return;
    }
    if (!parsed.yes) {
      context.print(
        `Refusing to import durable memory bundle from ${pathArg} without --yes.\nUsage: /${presentation.command} import <path> --yes`,
      );
      return;
    }
    const targetPath = resolveBundlePath(pathArg, getPaths(context));
    let bundle: MemoryBundle;
    try {
      bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as MemoryBundle;
    } catch (error) {
      context.print(`${presentation.tag} Failed to read memory bundle${presentation.errorSeparator}${summarizeError(error)}`);
      return;
    }
    const result = await memory.importBundle(bundle);
    context.print(`${presentation.tag} Imported bundle from ${targetPath}`);
    context.print(`  ${presentation.recordsLabel}imported=${result.importedRecords} skipped=${result.skippedRecords}`);
    context.print(`  ${presentation.linksLabel}imported=${result.importedLinks}`);
  }
  function inspectBundle(bundle: MemoryBundle): string {
    return [
      'Memory Handoff Review',
      `  scope${presentation.fieldSeparator}${bundle.scope}`,
      `  records${presentation.fieldSeparator}${bundle.recordCount}`,
      `  links${presentation.fieldSeparator}${bundle.linkCount}`,
      `  exportedAt${presentation.fieldSeparator}${new Date(bundle.exportedAt).toISOString()}`,
    ].join('\n');
  }
  function handleRecallHandoffExport(args: string[], context: Context): void | Promise<void> {
    const parsed = mutationArguments(args, presentation.confirmMutations);
    args = parsed.rest;
    const memory = getMemory(context);
    if (!memory) {
      return;
    }
    const pathArg = args[0];
    if (!pathArg) {
      context.print(
        `${presentation.tag} Usage: /${presentation.command} handoff-export <path> [--scope <scope>]${presentation.confirmMutations ? ' --yes' : ''}`,
      );
      return;
    }
    if (!parsed.yes) {
      context.print(
        `Refusing to export memory handoff bundle to ${pathArg} without --yes.\nUsage: /${presentation.command} handoff-export <path> [--scope <scope>] --yes`,
      );
      return;
    }
    const scopeIdx = args.indexOf('--scope');
    const scopeRaw = scopeIdx !== -1 ? args[scopeIdx + 1] : 'team';
    if (!scopeRaw || !isValidScope(scopeRaw)) {
      context.print(
        `${presentation.tag} Unknown scope "${scopeRaw ?? ''}". ${presentation.validValuesLabel} ${VALID_SCOPES.join(', ')}${presentation.validValuesSuffix}`,
      );
      return;
    }
    return afterMemory(memory.exportBundle({ scope: scopeRaw }), (bundle) => {
      const targetPath = resolveBundlePath(pathArg, getPaths(context));
      mkdirSync(dirname(targetPath), { recursive: true });
      writeFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', 'utf-8');
      context.print(`${presentation.tag} Exported ${scopeRaw} handoff bundle to ${targetPath}`);
    });
  }
  function handleRecallHandoffInspect(args: string[], context: Context): void {
    const pathArg = args[0];
    if (!pathArg) {
      context.print(`${presentation.tag} Usage: /${presentation.command} handoff-inspect <path>`);
      return;
    }
    const targetPath = resolveBundlePath(pathArg, getPaths(context));
    try {
      const bundle = JSON.parse(readFileSync(targetPath, 'utf-8')) as MemoryBundle;
      context.print(inspectBundle(bundle));
    } catch (error) {
      context.print(`${presentation.tag} Failed to inspect handoff bundle${presentation.errorSeparator}${summarizeError(error)}`);
    }
  }
  async function handleRecallHandoffImport(args: string[], context: Context): Promise<void> {
    const parsed = mutationArguments(args, presentation.confirmMutations);
    args = parsed.rest;
    const pathArg = args[0];
    if (!pathArg) {
      context.print(
        `${presentation.tag} Usage: /${presentation.command} handoff-import <path>${presentation.confirmMutations ? ' --yes' : ''}`,
      );
      return;
    }
    await handleRecallImport([pathArg, ...(presentation.confirmMutations && parsed.yes ? ['--yes'] : [])], context);
  }
  return { handleRecallExport, handleRecallImport, handleRecallHandoffExport, handleRecallHandoffInspect, handleRecallHandoffImport };
}
