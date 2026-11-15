import { readFileSync } from 'node:fs';
import { atomicWriteFileSync } from '@goodvibes-jev/engine/platform/platform/config';
import type { MemoryApi } from '@goodvibes-jev/engine/platform/platform/knowledge';
import type { MemoryBundle, MemorySearchFilter } from '@goodvibes-jev/engine/platform/platform/state';
import type { ShellPathService } from '@goodvibes-jev/engine/platform/platform/runtime/shell';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { VALID_CLASSES, VALID_SCOPES, isValidClass, isValidScope, readRecallFlags, resolveConfinedBundlePath, type RecallFlagKind } from './recall-shared.js';
import { afterMemory, mutationArguments, type RecallQueryContext } from './recall-query.js';
function isMemoryBundle(value: unknown): value is MemoryBundle {
  if (typeof value !== 'object' || value === null) return false;
  const bundle = value as Record<string, unknown>;
  return (
    bundle['schemaVersion'] === 'v1' &&
    typeof bundle['exportedAt'] === 'number' &&
    typeof bundle['scope'] === 'string' &&
    typeof bundle['recordCount'] === 'number' &&
    typeof bundle['linkCount'] === 'number' &&
    Array.isArray(bundle['records']) &&
    Array.isArray(bundle['links'])
  );
}
// `--yes` is read by mutationArguments where a product asks for it and is harmless where it does not.
const EXPORT_FLAGS: Readonly<Record<string, RecallFlagKind>> = { '--scope': 'word', '--cls': 'word', '--yes': 'switch' };
const HANDOFF_EXPORT_FLAGS: Readonly<Record<string, RecallFlagKind>> = { '--scope': 'word', '--yes': 'switch' };
export function createRecallBundleCommands<Context extends RecallQueryContext>(
  getMemory: (context: Context) => {
    exportBundle(filter: MemorySearchFilter): MemoryBundle | Promise<MemoryBundle>;
    importBundle: MemoryApi['importBundle'];
  } | null,
  getPaths: (context: Context) => Pick<ShellPathService, 'resolveWorkspacePath' | 'isWithinWorkingDirectory'>,
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
  /** The resolved bundle path, or undefined after printing why a model-run command may not use it. */
  function bundlePath(pathArg: string, context: Context): string | undefined {
    const resolved = resolveConfinedBundlePath(pathArg, getPaths(context), context.invokedByModel);
    if (resolved === undefined) {
      context.print(
        `${presentation.tag} Refused: ${pathArg} is outside the workspace. A command run by the model may only use paths inside the workspace; ask the owner to run it for another location.`,
      );
    }
    return resolved;
  }
  function writeBundle(targetPath: string, bundle: MemoryBundle): void {
    // Owner-only and atomic: the bundle is durable project memory and may replace an existing file.
    atomicWriteFileSync(targetPath, JSON.stringify(bundle, null, 2) + '\n', { mkdirp: true });
  }
  function readBundle(targetPath: string): MemoryBundle {
    const parsed: unknown = JSON.parse(readFileSync(targetPath, 'utf-8'));
    if (!isMemoryBundle(parsed)) throw new Error('the file is not a memory bundle (expected schemaVersion "v1" with records and links)');
    return parsed;
  }
  function handleRecallExport(args: string[], context: Context): void | Promise<void> {
    const parsed = mutationArguments(args, presentation.confirmMutations);
    args = parsed.rest;
    const memory = getMemory(context);
    if (!memory) {
      return;
    }
    const usage = `${presentation.tag} Usage: /${presentation.command} export <path> [--scope <scope>] [--cls <class>]${presentation.confirmMutations ? ' --yes' : ''}`;
    const flags = readRecallFlags(args, EXPORT_FLAGS);
    if ('refusal' in flags) {
      context.print(`${presentation.tag} ${flags.refusal}\n${usage}`);
      return;
    }
    const [pathArg, ...extra] = flags.positional;
    if (!pathArg || extra.length > 0) {
      context.print(usage);
      return;
    }
    if (!parsed.yes) {
      context.print(
        `Refusing to export durable memory bundle to ${pathArg} without --yes.\nUsage: /${presentation.command} export <path> [--scope <scope>] [--cls <class>] --yes`,
      );
      return;
    }
    const filter: MemorySearchFilter = {};
    const scope = flags.values.get('--scope');
    if (scope !== undefined) {
      if (!isValidScope(scope)) {
        context.print(
          `${presentation.tag} Unknown scope "${scope}". ${presentation.validValuesLabel} ${VALID_SCOPES.join(', ')}${presentation.validValuesSuffix}`,
        );
        return;
      }
      filter.scope = scope;
    }
    const cls = flags.values.get('--cls');
    if (cls !== undefined) {
      if (!isValidClass(cls)) {
        context.print(
          `${presentation.tag} Unknown class "${cls}". ${presentation.validValuesLabel} ${VALID_CLASSES.join(', ')}${presentation.validValuesSuffix}`,
        );
        return;
      }
      filter.cls = cls;
    }
    const targetPath = bundlePath(pathArg, context);
    if (targetPath === undefined) return;
    return afterMemory(memory.exportBundle(filter), (bundle) => {
      writeBundle(targetPath, bundle);
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
    const targetPath = bundlePath(pathArg, context);
    if (targetPath === undefined) return;
    let bundle: MemoryBundle;
    try {
      bundle = readBundle(targetPath);
    } catch (error) {
      context.print(`${presentation.tag} Nothing was imported: could not read the memory bundle at ${targetPath}${presentation.errorSeparator}${summarizeError(error)}`);
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
    const usage = `${presentation.tag} Usage: /${presentation.command} handoff-export <path> [--scope <scope>]${presentation.confirmMutations ? ' --yes' : ''}`;
    const flags = readRecallFlags(args, HANDOFF_EXPORT_FLAGS);
    if ('refusal' in flags) {
      context.print(`${presentation.tag} ${flags.refusal}\n${usage}`);
      return;
    }
    const [pathArg, ...extra] = flags.positional;
    if (!pathArg || extra.length > 0) {
      context.print(usage);
      return;
    }
    if (!parsed.yes) {
      context.print(
        `Refusing to export memory handoff bundle to ${pathArg} without --yes.\nUsage: /${presentation.command} handoff-export <path> [--scope <scope>] --yes`,
      );
      return;
    }
    const scopeRaw = flags.values.get('--scope') ?? 'team';
    if (!isValidScope(scopeRaw)) {
      context.print(
        `${presentation.tag} Unknown scope "${scopeRaw}". ${presentation.validValuesLabel} ${VALID_SCOPES.join(', ')}${presentation.validValuesSuffix}`,
      );
      return;
    }
    const targetPath = bundlePath(pathArg, context);
    if (targetPath === undefined) return;
    return afterMemory(memory.exportBundle({ scope: scopeRaw }), (bundle) => {
      writeBundle(targetPath, bundle);
      context.print(`${presentation.tag} Exported ${scopeRaw} handoff bundle to ${targetPath}`);
    });
  }
  function handleRecallHandoffInspect(args: string[], context: Context): void {
    const pathArg = args[0];
    if (!pathArg) {
      context.print(`${presentation.tag} Usage: /${presentation.command} handoff-inspect <path>`);
      return;
    }
    const targetPath = bundlePath(pathArg, context);
    if (targetPath === undefined) return;
    try {
      context.print(inspectBundle(readBundle(targetPath)));
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
