import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { discoverPlugins, getPluginDirectories, PluginManager } from '@goodvibes-jev/engine/platform/platform/plugins';
import { validateManifestV2 } from '@/runtime/index.ts';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { formatRefusal, RefusalError } from '@goodvibes-jev/engine/errors';
import type { CliCommandOutput, CliCommandRuntime } from '@goodvibes-jev/engine/terminal-shell';
import { handlePluginBundlesCommand } from '@goodvibes-jev/engine/terminal-shell/plugin-bundles-command';
import { pluginTrustConfirmation, runPluginTrustSubcommand, type PluginTrustControls } from '@goodvibes-jev/engine/terminal-shell/plugin-trust-command';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';

// ---------------------------------------------------------------------------
// `goodvibes plugin init` / `plugin validate`, scaffold and check plugins
// against the SAME classic loader the running TUI uses (PluginManager wraps
// discoverPlugins from @goodvibes-jev/engine/platform/platform/plugins). The pass/fail
// verdict is the real loader's acceptance: we run discoverPlugins against the
// target directory (isolated from the operator's own plugin folders) and check
// whether it accepts the directory. Reasons for a rejected manifest are sourced
// from the platform's validateManifestV2 (string|null) plus observable file facts,
// no second manifest schema is defined here.
// ---------------------------------------------------------------------------

interface PluginValidation {
  readonly ok: boolean;
  readonly path: string;
  readonly reasons: readonly string[];
  readonly manifestName?: string;
  readonly manifestVersion?: string;
}

/** A base directory whose standard plugin folders do not exist, so discoverPlugins
 * only considers the target's parent (passed via additionalDirectories). */
function isolatedBase(): string {
  return join(tmpdir(), '__goodvibes_plugin_validate_isolate__');
}

function validatePluginDirectory(dirPath: string): PluginValidation {
  const resolved = resolve(dirPath);
  if (!existsSync(resolved)) {
    return { ok: false, path: resolved, reasons: ['directory not found.'] };
  }
  const manifestPath = join(resolved, 'manifest.json');

  // Authoritative verdict: the real classic loader's discovery scan.
  const base = isolatedBase();
  const discovered = discoverPlugins({
    cwd: base,
    homeDir: base,
    additionalDirectories: [dirname(resolved)],
  });
  const match = discovered.find((plugin) => resolve(plugin.pluginDir) === resolved);
  if (match) {
    return {
      ok: true,
      path: resolved,
      reasons: [],
      manifestName: match.manifest.name,
      manifestVersion: match.manifest.version,
    };
  }

  // Rejected, explain why, delegating field checks to the platform validator.
  const reasons: string[] = [];
  if (!existsSync(manifestPath)) {
    reasons.push('manifest.json not found in the plugin directory.');
    return { ok: false, path: resolved, reasons };
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  } catch (error) {
    reasons.push(`manifest.json is not valid JSON; ${summarizeError(error)}`);
    return { ok: false, path: resolved, reasons };
  }
  const fieldReason = validateManifestV2(manifest);
  if (fieldReason) {
    reasons.push(fieldReason);
  } else {
    reasons.push('the plugin loader did not accept this directory; if "main" is set it must be a relative path.');
  }
  return { ok: false, path: resolved, reasons };
}

/**
 * Whether the apps load a plugin from this folder: the loader reads only the
 * folders directly inside its search directories (the project's
 * `.goodvibes/plugins`, searched when an app runs in this project, and the
 * user's `~/.goodvibes/plugins`).
 */
interface PluginPlacement {
  readonly searched: boolean;
  readonly searchDirectories: readonly string[];
}

function pluginPlacement(pluginDir: string, runtime: CliCommandRuntime): PluginPlacement {
  const searchDirectories = getPluginDirectories({ cwd: runtime.workingDirectory, homeDir: runtime.homeDirectory }).map((dir) => resolve(dir));
  return { searched: searchDirectories.includes(dirname(resolve(pluginDir))), searchDirectories };
}

function placementLines(placement: PluginPlacement, name: string | undefined): string[] {
  if (!placement.searched) {
    return [
      `  NOT LOADED  no app loads a plugin from this folder: plugins are read only from folders directly inside ${placement.searchDirectories.join(' or ')}.`,
      '  Move the folder into one of them, then enable it.',
    ];
  }
  return [`  next: a plugin starts disabled. In the terminal app or the Agent run /plugin enable ${name ?? '<name>'} (no restart needed).`];
}

function renderValidation(result: PluginValidation, json: boolean, placement: PluginPlacement): CliCommandOutput {
  if (json) {
    return { output: JSON.stringify({ ...result, loadedFromHere: placement.searched, searchDirectories: placement.searchDirectories }, null, 2), exitCode: result.ok ? 0 : 1 };
  }
  const lines = ['GoodVibes plugin validation', `  path: ${result.path}`];
  if (result.ok) {
    lines.push(`  PASS  ${result.manifestName} v${result.manifestVersion}: the plugin loader accepts this manifest and entry.`);
    lines.push(...placementLines(placement, result.manifestName));
  } else {
    lines.push('  FAIL  the plugin loader rejects this directory:');
    for (const reason of result.reasons) lines.push(`    - ${reason}`);
  }
  return { output: lines.join('\n'), exitCode: result.ok ? 0 : 1 };
}

const ENTRY_FILE_CONTENTS = `// Minimal GoodVibes plugin entry point.
// The loader calls init(api) once after the plugin is loaded.
export function init(api) {
  // Register commands, tools, or hooks through the sandboxed api here. A tool,
  // provider or hook needs "capabilities" in manifest.json (e.g. "register.tool")
  // and the limited trust tier: goodvibes plugin trust <name> limited.
  void api;
}
`;

function handlePluginInit(runtime: CliCommandRuntime): CliCommandOutput {
  const json = runtime.cli.flags.outputFormat === 'json';
  const name = runtime.cli.commandArgs[1];
  if (!name) {
    return { output: 'Usage: goodvibes plugin init <name> [directory]', exitCode: 2 };
  }
  // The same rule the loader applies, checked before anything is written so a
  // scaffold is never created that the loader would then ignore.
  const nameProblem = validateManifestV2({ name, version: '0.1.0', description: '' });
  if (nameProblem) {
    return {
      output: json
        ? JSON.stringify({ ok: false, reason: nameProblem }, null, 2)
        : `Cannot create the plugin: ${nameProblem}.`,
      exitCode: 2,
    };
  }
  const dirArg = runtime.cli.commandArgs[2];
  const targetDir = dirArg
    ? resolve(dirArg)
    : join(runtime.workingDirectory, '.goodvibes', 'plugins', name);
  const manifestPath = join(targetDir, 'manifest.json');
  const placement = pluginPlacement(targetDir, runtime);
  if (existsSync(manifestPath)) {
    return {
      output: json
        ? JSON.stringify({ ok: false, path: targetDir, reason: 'a plugin already exists here' }, null, 2)
        : `A plugin already exists at ${targetDir} (manifest.json present). Choose another name or directory.`,
      exitCode: 1,
    };
  }

  const manifest = {
    name,
    version: '0.1.0',
    description: `${name} plugin`,
    main: 'index.js',
  };
  try {
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
    writeFileSync(join(targetDir, 'index.js'), ENTRY_FILE_CONTENTS, 'utf-8');
  } catch (error) {
    return {
      output: json
        ? JSON.stringify({ ok: false, path: targetDir, reason: summarizeError(error) }, null, 2)
        : `Failed to scaffold plugin at ${targetDir}; ${summarizeError(error)}`,
      exitCode: 1,
    };
  }

  // Prove the freshly scaffolded plugin passes our own validation path.
  const validation = validatePluginDirectory(targetDir);
  if (json) {
    return {
      output: JSON.stringify({ ok: validation.ok, path: targetDir, created: ['manifest.json', 'index.js'], validation, loadedFromHere: placement.searched, searchDirectories: placement.searchDirectories }, null, 2),
      exitCode: validation.ok ? 0 : 1,
    };
  }
  const lines = [
    `Scaffolded plugin "${name}" at ${targetDir}`,
    '  created: manifest.json, index.js',
    validation.ok
      ? '  validation: PASS; the plugin loader accepts this manifest and entry.'
      : `  validation: FAIL; ${validation.reasons.join('; ')}`,
    ...(validation.ok ? placementLines(placement, name) : []),
  ];
  return { output: lines.join('\n'), exitCode: validation.ok ? 0 : 1 };
}

/**
 * `goodvibes plugin trust|verify|capabilities`: the same lines as `/plugin` in
 * the terminal and agent apps, for a machine run without them (a daemon host).
 * No plugin is loaded; the tier goes to the trust file every app shares, and
 * each app applies it the next time it starts the plugin.
 */
async function handlePluginTrustCli(runtime: CliCommandRuntime, args: readonly string[]): Promise<CliCommandOutput> {
  const goodvibesHome = join(runtime.homeDirectory, '.goodvibes');
  const stateFilePath = join(goodvibesHome, GOODVIBES_TUI_SURFACE_ROOT, 'plugins.json');
  const manager = new PluginManager({
    pathOptions: { cwd: runtime.workingDirectory, homeDir: runtime.homeDirectory },
    stateFilePath,
    trustFilePath: join(goodvibesHome, 'plugin-trust.json'),
  });
  // The publisher keys saved with /plugin trust-key, read without loading (or rewriting) that app's state.
  const savedKey = (name: string): string | undefined => {
    try {
      const keys = (JSON.parse(readFileSync(stateFilePath, 'utf-8')) as { publisherKeys?: Record<string, unknown> }).publisherKeys;
      const key = keys?.[name];
      return typeof key === 'string' ? key : undefined;
    } catch {
      return undefined;
    }
  };
  const controls: PluginTrustControls = {
    list: () => manager.list(),
    capabilities: (name) => manager.capabilities(name),
    verify: (name, key = savedKey(name)) => manager.verify(name, key),
    trust: (name, tier, note) => manager.trust(name, tier, note),
    trustSigned: (name, key = savedKey(name)) => manager.trustSigned(name, key),
    setPublisherKey: () => ({ ok: false, error: 'save a publisher key from the terminal or agent app: /plugin trust-key <name> <key.pem>' }),
  };
  const question = pluginTrustConfirmation(controls, args);
  if (question && !runtime.cli.flags.yes) {
    return { output: `${question.title.replace(/\?$/, '')}: not done. ${question.detail}\nRun the same line with --yes to confirm it.`, exitCode: 2 };
  }
  const lines: string[] = [];
  try {
    const handled = await runPluginTrustSubcommand(controls, args, (text) => lines.push(text));
    if (!handled) return { output: 'Usage: goodvibes plugin trust <name> <untrusted|limited|trusted> [note] | verify <name> | capabilities <name>', exitCode: 2 };
  } catch (error) {
    if (!(error instanceof RefusalError)) throw error;
    return { output: formatRefusal(error.refusal).split('/plugin ').join('goodvibes plugin '), exitCode: error.refusal.code === 'USAGE' ? 2 : 1 };
  }
  return { output: lines.join('\n'), exitCode: 0 };
}

export async function handlePluginCommand(runtime: CliCommandRuntime): Promise<CliCommandOutput> {
  const json = runtime.cli.flags.outputFormat === 'json';
  const [sub] = runtime.cli.commandArgs;
  if (sub === 'init') {
    return handlePluginInit(runtime);
  }
  if (sub === 'validate') {
    const target = runtime.cli.commandArgs[1];
    if (!target) {
      return { output: 'Usage: goodvibes plugin validate <path>', exitCode: 2 };
    }
    return renderValidation(validatePluginDirectory(target), json, pluginPlacement(target, runtime));
  }
  if (sub === 'bundles') {
    return handlePluginBundlesCommand(runtime, runtime.cli.commandArgs.slice(1), {
      binary: 'goodvibes',
      confirmed: runtime.cli.flags.yes,
      rollbackHint: (receipt) => `/marketplace rollback ${receipt.kind} ${receipt.entry.id} ${receipt.scope}`,
    });
  }
  if (sub === 'trust' || sub === 'verify' || sub === 'capabilities') {
    return handlePluginTrustCli(runtime, runtime.cli.commandArgs);
  }
  return { output: 'Usage: goodvibes plugin [init <name> [directory]|validate <path>|bundles browse|install|uninstall|list|trust <name> <tier>|verify <name>|capabilities <name>]', exitCode: 2 };
}
