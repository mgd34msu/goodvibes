/**
 * Runtime import boundaries of the products, run by `bun run architecture:check`:
 * the daemon's original four boundaries (adapted to current owners) and the
 * Agent's layer rules plus "the Agent never imports TUI source".
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runtimeArchitectureProblems, runtimeImportSpecifiers, type RuntimeArchitecture } from './runtime-import-architecture.ts';

function sources(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'test' || entry.name === '__tests__') return [];
    const file = resolve(root, entry.name);
    return entry.isDirectory() ? sources(file) : /\.[cm]?ts$/.test(entry.name) && !/\.(?:test|d)\.ts$/.test(entry.name) ? [file] : [];
  });
}

export function daemonArchitecture(root: string): RuntimeArchitecture {
  const product = resolve(root, 'products/daemon/src');
  const terminal = resolve(root, 'packages/engine/terminal-shell/src');
  // These are the mapped owners of the original src/cluster transport readers.
  const cluster = new Set(['daemon-ws-call.ts', 'raw-reply-route.ts'].map((file) => resolve(terminal, file)));
  for (const file of cluster) if (!existsSync(file)) throw new Error(`Missing mapped cluster owner: ${file}`);
  const composition = new Set(['configuration.ts', 'entrypoint.ts', 'index.ts', 'production-runtime.ts', 'run.ts', 'serve.ts', 'startup-maintenance.ts', 'startup-pairing.ts']);
  return {
    files: [...sources(product), ...sources(terminal)],
    layer(file) {
      if (cluster.has(file)) return 'cluster';
      const local = relative(product, file).split(sep);
      if (local[0] === '..' || local.length < 2) return undefined;
      // CLI execution now lives beside the command catalog. Only the latter is
      // the original cli layer; run/serve/entrypoint are composition roots.
      if (local[0] === 'cli') return composition.has(local[1]!) ? 'daemon' : 'cli';
      return local[0];
    },
    rules: [
      { from: 'config', forbidden: ['cli', 'cluster', 'daemon', 'runtime'] },
      { from: 'core', forbidden: ['cli', 'cluster', 'config', 'daemon', 'runtime'] },
      { from: 'cluster', forbidden: ['cli', 'daemon', 'runtime'] },
      { from: 'cli', forbidden: ['daemon'] },
    ],
  };
}

const TERMINAL_SHELL_SPECIFIER = '@goodvibes-jev/engine/terminal-shell';
const CLUSTER_OWNER_FILES = ['daemon-ws-call.ts', 'raw-reply-route.ts'];

/** Names a source file exports as runtime values (types are erased and cannot be a dependency). */
function runtimeExportNames(file: string): Set<string> {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
  const names = new Set<string>();
  for (const statement of source.statements) {
    if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) && statement.name) names.add(statement.name.text);
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) names.add(declaration.name.text);
    }
  }
  return names;
}

/**
 * Product code reaches the cluster readers through the engine's package
 * specifier, which the relative-import analysis cannot follow. A layer that may
 * not depend on the cluster layer is therefore checked here, by the names it
 * imports from that specifier.
 */
export function clusterPackageImportProblems(root: string): string[] {
  const architecture = daemonArchitecture(root);
  const restricted = new Set(architecture.rules.filter((rule) => rule.forbidden.includes('cluster')).map((rule) => rule.from));
  const clusterNames = new Set(CLUSTER_OWNER_FILES.flatMap((file) => [...runtimeExportNames(resolve(root, 'packages/engine/terminal-shell/src', file))]));
  const problems: string[] = [];
  for (const file of architecture.files) {
    const layer = architecture.layer(file);
    if (layer === undefined || !restricted.has(layer)) continue;
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    for (const statement of source.statements) {
      if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
      const specifier = statement.moduleSpecifier.text;
      if (specifier !== TERMINAL_SHELL_SPECIFIER && !specifier.startsWith(`${TERMINAL_SHELL_SPECIFIER}/`)) continue;
      const clause = statement.importClause;
      const bindings = clause?.namedBindings;
      if (!clause || clause.isTypeOnly || !bindings || !ts.isNamedImports(bindings)) continue;
      for (const element of bindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        if (!element.isTypeOnly && clusterNames.has(name)) problems.push(`layer ${layer}: ${file} -> ${specifier} (${name}, a cluster reader)`);
      }
    }
  }
  return problems;
}

/** The Agent's layers are its top-level `src/` directories; files directly in `src/` belong to none. */
export function agentArchitecture(root: string): RuntimeArchitecture {
  const product = resolve(root, 'products/agent/src');
  return {
    files: sources(product),
    layer(file) {
      const local = relative(product, file).split(sep);
      return local[0] === '..' || local.length < 2 ? undefined : local[0];
    },
    rules: [
      // The renderer draws; argument parsing and entry points are not its concern.
      { from: 'renderer', forbidden: ['cli'] },
      // These run headless (config is read everywhere, providers and audio by
      // the daemon-hosted and headless paths), so they never reach shell UI.
      { from: 'config', forbidden: ['renderer', 'input', 'cli'] },
      { from: 'providers', forbidden: ['renderer', 'input', 'cli'] },
      { from: 'audio', forbidden: ['renderer', 'input', 'cli'] },
    ],
  };
}

/** The Agent shares code with the TUI through the engine's terminal-shell, never by importing TUI source. */
export function agentTuiSourceImportProblems(root: string): string[] {
  const tuiRoot = resolve(root, 'products/tui') + sep;
  const problems: string[] = [];
  for (const file of agentArchitecture(root).files) {
    for (const specifier of runtimeImportSpecifiers(readFileSync(file, 'utf8'))) {
      const reachesTui = specifier.startsWith('.')
        ? resolve(dirname(file), specifier).startsWith(tuiRoot)
        : specifier === '@goodvibes-jev/tui' || specifier.startsWith('@goodvibes-jev/tui/');
      if (reachesTui) problems.push(`agent imports TUI source: ${file} -> ${specifier}; move the shared code to packages/engine/terminal-shell/src`);
    }
  }
  return problems;
}

/**
 * The Agent's layer and TUI-source problems. Its runtime import cycles are not
 * reported yet: two cycles inside `src/tools` (the harness and settings
 * admission files) are being taken apart, and this gate fails only on what is
 * already clean.
 */
export function agentArchitectureProblems(root: string): string[] {
  const layerProblems = runtimeArchitectureProblems(agentArchitecture(root)).filter((problem) => !problem.startsWith('runtime import cycle:'));
  return [...layerProblems, ...agentTuiSourceImportProblems(root)];
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const input = daemonArchitecture(root);
  const problems = [...runtimeArchitectureProblems(input), ...clusterPackageImportProblems(root), ...agentArchitectureProblems(root)];
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
  else {
    console.log(`Daemon architecture: ${input.files.length} runtime files, four non-vacuous boundaries (the cluster one also checked through the package specifier), no relative runtime cycles.`);
    console.log(`Agent architecture: ${agentArchitecture(root).files.length} runtime files, four non-vacuous layer boundaries, no TUI source imports.`);
  }
}
