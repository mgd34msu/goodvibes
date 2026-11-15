/** The daemon's original four runtime boundaries, adapted to current owners. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { runtimeArchitectureProblems, type RuntimeArchitecture } from './runtime-import-architecture.ts';

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

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const input = daemonArchitecture(root);
  const problems = [...runtimeArchitectureProblems(input), ...clusterPackageImportProblems(root)];
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
  else console.log(`Daemon architecture: ${input.files.length} runtime files, four non-vacuous boundaries (the cluster one also checked through the package specifier), no relative runtime cycles.`);
}
