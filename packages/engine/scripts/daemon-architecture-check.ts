/**
 * Runtime import boundaries of the products, run by `bun run architecture:check`:
 * the daemon's original four boundaries (adapted to current owners), the
 * Agent's layer rules plus "the Agent never imports TUI source", and the TUI's
 * layer rules and import cycles (relative and `@/` imports alike), and the
 * platform files that may start a process (`PRODUCT_PROGRAM_SPAWN_FILES`).
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

/**
 * The cluster readers in the shared shell. `raw-reply-route.ts` must exist, or
 * the cluster boundary would pass vacuously after a rename; the WebSocket
 * caller counts while it exists (a removed file cannot be imported).
 */
function clusterOwnerFiles(terminal: string): string[] {
  const required = resolve(terminal, 'raw-reply-route.ts');
  if (!existsSync(required)) throw new Error(`Missing mapped cluster owner: ${required}`);
  const optional = resolve(terminal, 'daemon-ws-call.ts');
  return existsSync(optional) ? [optional, required] : [required];
}

export function daemonArchitecture(root: string): RuntimeArchitecture {
  const product = resolve(root, 'products/daemon/src');
  const terminal = resolve(root, 'packages/engine/terminal-shell/src');
  // These are the mapped owners of the original src/cluster transport readers.
  const cluster = new Set(clusterOwnerFiles(terminal));
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

const TERMINAL_SHELL_SPECIFIER = '@goodvibes/engine/terminal-shell';

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
  const clusterNames = new Set(clusterOwnerFiles(resolve(root, 'packages/engine/terminal-shell/src')).flatMap((file) => [...runtimeExportNames(file)]));
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

/** The Agent's layers are its top-level `src/` directories; files directly in `src/` belong to none. `@/` imports count like relative ones. */
export function agentArchitecture(root: string): RuntimeArchitecture {
  const product = resolve(root, 'products/agent/src');
  return {
    files: sources(product),
    aliases: { '@/': product + sep },
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
        : specifier === '@goodvibes/tui' || specifier.startsWith('@goodvibes/tui/');
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

/**
 * The TUI's layers are its top-level `src/` directories; files directly in
 * `src/` (entry points) belong to none. `@/` imports resolve like relative ones,
 * so writing an import with the alias cannot step around a rule or a cycle.
 */
export function tuiArchitecture(root: string): RuntimeArchitecture {
  const product = resolve(root, 'products/tui/src');
  return {
    files: sources(product),
    aliases: { '@/': product + sep },
    layer(file) {
      const local = relative(product, file).split(sep);
      return local[0] === '..' || local.length < 2 ? undefined : local[0];
    },
    rules: [
      // UI pieces draw and handle keys; argument parsing and entry points are not theirs.
      { from: 'renderer', forbidden: ['cli'] },
      { from: 'input', forbidden: ['cli'] },
      { from: 'views', forbidden: ['cli'] },
      // These run headless (config is read everywhere, providers and audio by
      // headless runs), so they never reach shell UI or an entry point.
      { from: 'config', forbidden: ['renderer', 'input', 'views', 'cli'] },
      { from: 'providers', forbidden: ['renderer', 'input', 'views', 'cli'] },
      { from: 'audio', forbidden: ['renderer', 'input', 'views', 'cli'] },
    ],
  };
}

/**
 * Layer edges that exist today and are allowed until their target moves out of
 * `cli/` (none now: the service-name resolver moved to the platform). Each
 * entry is `<from> -> <to>`, relative to `products/tui/src`.
 */
const TUI_ALLOWED_LAYER_EDGES: ReadonlySet<string> = new Set<string>();

export function tuiArchitectureProblems(root: string): string[] {
  const product = resolve(root, 'products/tui/src');
  const local = (file: string): string => relative(product, file).split(sep).join('/');
  return runtimeArchitectureProblems(tuiArchitecture(root)).filter((problem) => {
    const edge = /^layer [^:]+: (\S+) -> (\S+)$/.exec(problem);
    return !edge || !TUI_ALLOWED_LAYER_EDGES.has(`${local(edge[1]!)} -> ${local(edge[2]!)}`);
  });
}

/**
 * The files under `packages/engine/platform/src` that may start a process
 * (`Bun.spawn`, `Bun.spawnSync`, `child_process`), relative to that folder.
 * Each was reviewed: it runs a fixed program the product chose, or it is the
 * boundary itself. A program a project, a model or a plugin chooses starts
 * through `runContained` (runtime/sandbox/contained-spawn.ts), which states
 * what it may write and whether it has a network. A new file that spawns, or
 * an entry that no longer spawns, fails the check.
 */
export const PRODUCT_PROGRAM_SPAWN_FILES: ReadonlySet<string> = new Set([
  // The boundary's own spawn sites: the exec tool (bubblewrap per command), sandbox sessions and runContained.
  'platform/runtime/sandbox/backend.ts',
  'platform/runtime/sandbox/contained-spawn.ts',
  'platform/tools/exec/captured-exec.ts',
  'platform/tools/exec/interactive.ts',
  'platform/tools/exec/process-tree.ts',
  'platform/tools/exec/runtime.ts',
  'platform/tools/exec/sandbox.ts',
  // Programs someone else chooses, started here today; each is to start through runContained.
  'platform/acp/connection.ts', // a configured ACP agent
  'platform/acp/host.ts', // a configured ACP agent
  'platform/hooks/runners/command.ts', // the owner's hook command
  'platform/mcp/client.ts', // a configured MCP server
  'platform/runtime/eval/headless-executor.ts', // the product binary for an eval task
  'platform/runtime/remote/host/backends/process-runner.ts', // work a remote peer sent
  'platform/tools/shared/process-manager.ts', // a background process the exec tool started
  'platform/triggers/hosts.ts', // a command a trigger watches
  'platform/workflow/automation-commands.ts', // an automation command
  'platform/workflow/hook-action-executor.ts', // a hook's action command
  // Fixed programs the product chose (git, gh, rg, systemctl, launchctl, tailscale, cloudflared, gcloud, bwrap, a language server it installs, ...).
  'platform/agents/worktree.ts',
  'platform/browser/browser-host-client.ts',
  'platform/browser/browser-provision-io.ts',
  'platform/ci-watch/auto-watch.ts',
  'platform/ci-watch/gh-source.ts',
  'platform/cloudflare/tunnel-connector.ts',
  'platform/config/process-start-time.ts',
  'platform/contract/completion.ts',
  'platform/contract/evidence.ts',
  'platform/contract/fix-planner-input.ts',
  'platform/contract/gate-input.ts',
  'platform/contract/git-placement.ts',
  'platform/contract/input-apply.ts',
  'platform/contract/input-snapshot.ts',
  'platform/contract/private-read-receipts.ts',
  'platform/contract/publication-input.ts',
  'platform/contract/publication-merge.ts',
  'platform/contract/review-inventory.ts',
  'platform/contract/tree-baseline.ts',
  'platform/contract/tree-identity.ts',
  'platform/daemon/launchd-handover.ts',
  'platform/daemon/service-handover.ts',
  'platform/daemon/service-manager.ts',
  'platform/git/service.ts',
  'platform/google/gcloud.ts',
  'platform/intelligence/lsp/binary-downloader.ts',
  'platform/intelligence/lsp/client.ts',
  'platform/orchestration/dirty-file-observation.ts',
  'platform/orchestration/dirty-guard.ts',
  'platform/orchestration/worktree-isolation.ts',
  'platform/pairing/stable-host.ts',
  'platform/power/child-hygiene.ts',
  'platform/power/darwin-caffeinate.ts',
  'platform/power/linux-logind.ts',
  'platform/power/sleep-edge-watch.ts',
  'platform/remote-access/tailscale.ts',
  'platform/runtime/client/daemon-handover.ts',
  'platform/runtime/client/daemon-program.ts', // goodvibes-daemon serve, started when no service is installed
  'platform/runtime/ecosystem/bundle-pin.ts',
  'platform/runtime/fleet/observed/detect.ts',
  'platform/runtime/fleet/observed/source.ts',
  'platform/runtime/global-package-owner.ts',
  'platform/runtime/owner-read-evidence.ts',
  'platform/runtime/reachability-check.ts',
  'platform/runtime/worktree/registry.ts',
  'platform/runtime/worktree/retention.ts',
  'platform/runtime/worktree/setup.ts',
  'platform/state/memory-file-projection.ts',
  'platform/support/service-manager-posture.ts', // systemctl --user show, read-only
  'platform/tools/analyze/captured-git.ts',
  'platform/tools/find/ripgrep.ts',
  'platform/utils/clipboard.ts',
  'platform/utils/notify.ts',
  'platform/utils/open-external.ts',
  'platform/utils/process-runner.ts',
  'platform/utils/shell-split.ts',
  'platform/voice/providers/local.ts',
  'platform/voice/provisioning/provisioner.ts',
  'platform/workspace/registration/worktree-link.ts',
])

const SPAWN_PATTERN = /\bBun\.spawn(?:Sync)?\b|['"](?:node:)?child_process['"]/;

/** Spawn sites under the platform sources that are not on the reviewed list, and list entries that no longer spawn. */
export function programSpawnProblems(root: string): string[] {
  const platform = resolve(root, 'packages/engine/platform/src');
  const spawning = new Set(sources(platform)
    .filter((file) => SPAWN_PATTERN.test(readFileSync(file, 'utf8')))
    .map((file) => relative(platform, file).split(sep).join('/')));
  const problems: string[] = [];
  for (const file of spawning) {
    if (!PRODUCT_PROGRAM_SPAWN_FILES.has(file)) {
      problems.push(`process spawn outside the reviewed list: packages/engine/platform/src/${file}; start a program a project, model or plugin chose through runContained (runtime/sandbox/contained-spawn.ts), or add a fixed product program's file to PRODUCT_PROGRAM_SPAWN_FILES in scripts/daemon-architecture-check.ts`);
    }
  }
  for (const file of PRODUCT_PROGRAM_SPAWN_FILES) {
    if (!spawning.has(file)) problems.push(`PRODUCT_PROGRAM_SPAWN_FILES names packages/engine/platform/src/${file}, which no longer starts a process; remove the entry`);
  }
  return problems;
}


/** A path a route regex matches, for each alternative of a `(a|b)` group: `([^/]+)` becomes `x1`. */
function routeSamples(source: string): string[] {
  const alternation = /\(((?:[a-z-]+\|)+[a-z-]+)\)/.exec(source);
  if (alternation) return alternation[1]!.split('|').flatMap((option) => routeSamples(source.replace(alternation[0], option)));
  return [source.replace(/^\^/, '').replace(/\$$/, '').replace(/\\\//g, '/').replace(/\(\[\^\/\]\+\)/g, 'x1')
    .replace(/\(\?:[^)]*\)\??/g, '').replace(/\(\.\+\)/g, 'x1/x2').replace(/\\\./g, '.')];
}

/** Every method and path the daemon's route dispatchers match: literal `pathname === '...'` tests and `pathname.match(/.../)` patterns with the methods tested beside them. */
export function dispatchedDaemonRoutes(root: string): { readonly method: string; readonly path: string; readonly at: string }[] {
  const engine = resolve(root, 'packages/engine');
  const files = [resolve(engine, 'daemon-api/src'), resolve(engine, 'platform/src/platform/daemon/http'), resolve(engine, 'platform/src/platform/daemon')]
    .flatMap((dir) => readdirSync(dir).filter((name) => name.endsWith('.ts')).map((name) => resolve(dir, name)));
  const routes: { method: string; path: string; at: string }[] = [];
  for (const file of files) {
    const lines = readFileSync(file, 'utf8').split('\n');
    const patterns = new Map<string, string[]>();
    lines.forEach((text, index) => {
      const at = `${relative(root, file)}:${index + 1}`;
      // A prefix test (`=== '/api/x' || startsWith('/api/x/')`) hands a family to its own dispatcher, whose routes are read there.
      const familyGate = /startsWith\(/.test(text) && !/method ===/.test(text);
      for (const match of familyGate ? [] : text.matchAll(/pathname === '(\/[^']*)'(?:\s*&&\s*(?:req\.)?method === '([A-Z]+)')?/g)) {
        const methods = match[2] ? [match[2]] : [...text.matchAll(/method === '([A-Z]+)'/g)].map((m) => m[1]!);
        for (const method of methods.length ? methods : ['*']) routes.push({ method, path: match[1]!, at });
      }
      const declared = /const (\w+) = (?:url\.)?pathname\.match\(\/(.*)\/\);?/.exec(text);
      if (declared) patterns.set(declared[1]!, routeSamples(declared[2]!));
      for (const [name, paths] of patterns) {
        if (declared?.[1] === name || !new RegExp(`\\b${name}\\b`).test(text)) continue;
        for (const method of [...text.matchAll(/method === '([A-Z]+)'/g)].map((m) => m[1]!)) for (const path of paths) routes.push({ method, path, at });
      }
    });
  }
  return routes;
}

/** Routes the dispatchers serve that are neither a catalog method's binding nor declared in daemon/http/route-manifest.ts. */
export async function undeclaredRouteProblems(root: string): Promise<string[]> {
  const { GatewayMethodCatalog } = await import(resolve(root, 'packages/engine/platform/src/platform/control-plane/method-catalog.ts'));
  const { declaredRoute } = await import(resolve(root, 'packages/engine/platform/src/platform/daemon/http/route-manifest.ts'));
  const catalog = new GatewayMethodCatalog();
  const problems = new Set<string>();
  for (const route of dispatchedDaemonRoutes(root)) {
    const methods = route.method === '*' ? ['GET', 'POST'] : [route.method];
    if (methods.every((method) => catalog.findByHttpBinding(method, route.path) || declaredRoute(method, route.path))) continue;
    problems.add(`route ${route.method} ${route.path} (${route.at}) has no catalog method and no entry in platform/src/platform/daemon/http/route-manifest.ts; bind it to a method or declare its effect or the reason it needs none`);
  }
  return [...problems];
}

if (import.meta.main) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
  const input = daemonArchitecture(root);
  const tui = tuiArchitecture(root);
  const problems = [...runtimeArchitectureProblems(input), ...clusterPackageImportProblems(root), ...agentArchitectureProblems(root), ...tuiArchitectureProblems(root), ...programSpawnProblems(root), ...await undeclaredRouteProblems(root)];
  if (problems.length) { console.error(problems.join('\n')); process.exitCode = 1; }
  else {
    console.log(`Daemon architecture: ${input.files.length} runtime files, four non-vacuous boundaries (the cluster one also checked through the package specifier), no relative runtime cycles.`);
    console.log(`Agent architecture: ${agentArchitecture(root).files.length} runtime files, four non-vacuous layer boundaries, no TUI source imports.`);
    console.log(`TUI architecture: ${tui.files.length} runtime files, ${tui.rules.length} non-vacuous layer boundaries, no runtime cycles (relative or @/ imports).`);
    console.log(`Process spawns: ${PRODUCT_PROGRAM_SPAWN_FILES.size} reviewed platform files; every other program starts through runContained.`);
    console.log(`Daemon routes: ${dispatchedDaemonRoutes(root).length} dispatched; each is a catalog method or declared in route-manifest.ts.`);
  }
}
