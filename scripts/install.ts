import { randomUUID } from 'node:crypto';
import { parseDecisionModelPolicy, type DecisionModelPolicy } from '../packages/engine/errors/src/decision-policy.js';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { PAIRING_DEFERRED_EXIT } from '../products/tui/scripts/pairing-exit.ts';
import { COMMANDS, CommandError, PACKAGE, assertOwnedFiles, atomicWrite, contained, dataOwner, discardAbandonedFirstInstall, isReleaseInUse, readDaemonService, readDaemonSetting, recordFirstInstallStaging, stagingRecordPath, plainPath, present, quote, readDataId, readInstallation, receiptPath, recoverInterruptedUpdate, recoverPendingService, recoverPendingSettings, run, serviceUnit, stopService, switchRelease, unitPath, validateLayout, withLock, type Installation, type PendingSetting, type Run, type ServiceLayout } from './installation.ts';

/**
 * `portStated` and `serviceStated` say whether --port and --service/--no-service were given. On an update a
 * choice not stated is the daemon's own current setting (read by {@link install}), never the receipt's record.
 */
export interface Options extends ServiceLayout { port: number; service: boolean; portStated: boolean; serviceStated: boolean; runtimeDir: string; nodePath?: string; workspace?: string; decisionPolicy?: DecisionModelPolicy }
const ROOT = resolve(import.meta.dir, '..');
export function parseOptions(args: string[], home = realpathSync(process.env.HOME ?? ''), runtime = {
  bunPath: process.execPath, findNode: (): string | null => Bun.which('node'),
}): Options {
  const values: Record<string, string> = {};
  let service: boolean | undefined;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === '--no-service') service = false;
    else if (flag === '--service') service = true;
    else if (['--prefix', '--bin-dir', '--data-dir', '--port', '--runtime-dir', '--workspace', '--decision-policy'].includes(flag) && args[i + 1] && !args[i + 1]!.startsWith('--')) values[flag] = args[++i]!;
    else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  const prefix = resolve(values['--prefix'] ?? join(home, '.local/share/goodvibes'));
  const old = readInstallation(prefix);
  const runtimeDir = resolve(values['--runtime-dir'] ?? dirname(runtime.bunPath));
  const adjacentNode = join(runtimeDir, 'node');
  const nodePath = values['--runtime-dir'] || existsSync(adjacentNode) ? adjacentNode : resolve(runtime.findNode() ?? adjacentNode);
  const options = { home, prefix, binDir: resolve(values['--bin-dir'] ?? old?.binDir ?? join(home, '.local/bin')),
    dataDir: resolve(values['--data-dir'] ?? old?.dataDir ?? join(home, '.local/share/goodvibes-data')),
    port: Number(values['--port'] ?? old?.port ?? 3421), service: service ?? old?.service ?? true,
    portStated: values['--port'] !== undefined, serviceStated: service !== undefined,
    workspace: realpathSync(resolve(values['--workspace'] ?? old?.workspace ?? ROOT)),
    runtimeDir, nodePath, ...(values['--decision-policy'] === undefined ? {} : { decisionPolicy: parseDecisionModelPolicy(values['--decision-policy']) }) };
  validateLayout(options);
  if (!statSync(options.workspace).isDirectory()) throw new Error('--workspace must name a project directory.');
  if (options.workspace === home || options.workspace === '/' || contained(options.dataDir, options.workspace) || contained(options.prefix, options.workspace)) throw new Error('--workspace must name a project directory outside installation data.');
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) throw new Error('--port must be an integer between 1024 and 65535.');
  if (old && (old.home !== home || old.binDir !== options.binDir || old.dataDir !== options.dataDir)) throw new Error('Keep existing command/data paths when updating, or uninstall first.');
  return options;
}
export function preflight(options: Options, old: Installation | undefined, execute: Run = run): void {
  validateLayout(options);
  if (contained(options.prefix, ROOT) || contained(ROOT, options.prefix) || contained(options.dataDir, ROOT)) throw new Error('Install programs and data outside the source checkout.');
  if (old) assertOwnedFiles(old);
  else {
    if (present(options.prefix) && readdirSync(options.prefix).length) throw new Error(`Program directory ${options.prefix} is not empty and has no GoodVibes installation receipt, so this installer does not own it; nothing was changed. Choose another --prefix, or remove it if nothing you need is there: rm -rf -- ${quote(options.prefix)}`);
    for (const name of COMMANDS) if (present(join(options.binDir, name))) throw new Error(`Command already exists: ${join(options.binDir, name)}; nothing was changed. Choose --bin-dir, or uninstall the installation that owns it first.`);
    if (present(unitPath(options))) throw new Error(`A service definition this installer does not own already exists at ${unitPath(options)}; nothing was changed. Install with --no-service, or remove it after stopping it: systemctl --user disable --now ${serviceUnit(options)} && rm -- ${quote(unitPath(options))}`);
    if (present(options.dataDir) && readdirSync(options.dataDir).length && !readDataId(options)) throw new Error('Data directory is not empty and is not owned by the GoodVibes installer. Choose --data-dir.');
  }
  if (options.service || old?.service) {
    try { execute('systemctl', ['--user', 'show-environment'], { capture: true }); }
    catch (error) {
      if (!(error instanceof CommandError)) throw error;
      throw new Error(`No systemd user service manager is reachable from this session (${error.message}); nothing was changed. Re-run with --no-service, or log in to a session with a user manager (systemctl --user), then retry.`);
    }
    const fragment = execute('systemctl', ['--user', 'show', serviceUnit(options), '--property=FragmentPath', '--value'], { capture: true });
    if (fragment && (!old?.service || fragment !== unitPath(options))) throw new Error(`Another ${serviceUnit(options)} is already loaded.`);
  }
}
export function wrapper(options: Options, name: typeof COMMANDS[number], arch = process.arch): string {
  const current = join(options.prefix, 'current');
  const header = '#!/bin/sh\nset -eu\n# Managed by the GoodVibes installer.\n';
  // An update moves current. Keep each process and its admitted runtime on the
  // same physical release for its entire lifetime, including subsequent execs.
  // The release's private bun and node are named by GOODVIBES_SUITE_RUNTIME for
  // the suite's own needs; PATH stays the user's, so project commands run with
  // the runtimes the user's shell resolves.
  const pinRelease = `goodvibes_release=$(CDPATH= cd ${quote(current)} && pwd -P)\n`;
  if (name === 'goodvibes-uninstall') return `${header}${pinRelease}exec "$goodvibes_release/runtime/bun" "$goodvibes_release/uninstall.js" --prefix ${quote(options.prefix)} "$@"\n`;
  const product = name === 'goodvibes' ? 'tui' : name === 'goodvibes-agent' ? 'agent' : 'daemon';
  return `${header}if [ -f ${quote(join(options.dataDir, 'environment'))} ]; then\n  set -a\n  . ${quote(join(options.dataDir, 'environment'))}\n  set +a\nfi\n${pinRelease}export GOODVIBES_HOME=${quote(options.dataDir)}\nexport GOODVIBES_DAEMON_HOME=${quote(join(options.dataDir, '.goodvibes/daemon'))}\nexport GOODVIBES_SUITE_RUNTIME="$goodvibes_release/runtime"\nexec "$goodvibes_release/${product}/${name}-linux-${arch}" "$@"\n`;
}
export async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((yes, no) => {
    const server = createServer();
    server.once('error', () => no(new Error(`Port ${port} is already in use. Choose --port; no other service will be stopped.`)));
    server.listen(port, '127.0.0.1', () => server.close(error => error ? no(error) : yes()));
  });
}
export interface ReadyTiming { now: () => number; sleep: (milliseconds: number) => Promise<void>; timeoutMs: number }
const REAL_TIMING: ReadyTiming = { now: Date.now, sleep: milliseconds => Bun.sleep(milliseconds), timeoutMs: 90_000 };
/**
 * The operator token the installed daemon serves, taken the way it takes it:
 * GOODVIBES_DAEMON_TOKEN from the installation's environment file (the launcher
 * sources it last, so it wins), else from this shell (the service definition
 * carries it when it was set here), else undefined so the token file is read.
 * A set-but-blank value is not a token.
 */
function environmentDaemonToken(options: Options, execute: Run): string | undefined {
  const nonBlank = (value: string | undefined): string | undefined => (value?.trim() ? value : undefined);
  const environment = join(options.dataDir, 'environment');
  if (existsSync(environment)) {
    const fromFile = nonBlank(execute('sh', ['-c', 'set -a; . "$1"; set +a; printf %s "${GOODVIBES_DAEMON_TOKEN-}"', 'daemon-token', environment],
      { cwd: options.dataDir, capture: true }));
    if (fromFile !== undefined) return fromFile;
  }
  return nonBlank(process.env.GOODVIBES_DAEMON_TOKEN);
}
/** The installed daemon's web UI state (`goodvibes-daemon webui status --json`): whether it serves the bundle, and the directory configured. */
function readWebuiState(execute: Run, daemon: string, dataDir: string): { serve: boolean; bundleDir: string } {
  const output = execute(daemon, ['webui', 'status', '--json'], { cwd: dataDir, capture: true });
  let parsed: { schema?: unknown; serve?: unknown; bundleDir?: unknown };
  try { parsed = JSON.parse(output) as typeof parsed; } catch { parsed = {}; }
  if (parsed.schema !== 'goodvibes.daemon.webui-binding' || typeof parsed.serve !== 'boolean' || typeof parsed.bundleDir !== 'string') {
    throw new Error(`${daemon} webui status --json did not report the web UI state.`);
  }
  return { serve: parsed.serve, bundleDir: parsed.bundleDir };
}
export async function ready(options: Options, html: string, execute: Run, timing: ReadyTiming = REAL_TIMING): Promise<void> {
  const environmentToken = environmentDaemonToken(options, execute);
  const deadline = timing.now() + timing.timeoutMs;
  while (timing.now() < deadline) {
    const state = execute('systemctl', ['--user', 'show', serviceUnit(options), '--property=ActiveState', '--value'], { capture: true });
    if (state === 'failed' || state === 'inactive') throw new Error(`Daemon stopped during startup. Inspect: journalctl --user -u ${serviceUnit(options)}`);
    if (state === 'active') {
      try {
        const response = await fetch(`http://127.0.0.1:${options.port}/`, { signal: AbortSignal.timeout(1500), redirect: 'error' });
        if (response.ok && await response.text() === html) {
          const tokenPath = join(options.dataDir, '.goodvibes/daemon/operator-tokens.json');
          const token = environmentToken ?? (JSON.parse(readFileSync(tokenPath, 'utf8')) as { token?: unknown }).token;
          if (typeof token === 'string') {
            const health = await fetch(`http://127.0.0.1:${options.port}/api/health`, {
              headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(1500), redirect: 'error',
            });
            const value = await health.json() as { network?: { controlPlane?: { ready?: boolean } } };
            if (health.ok && value.network?.controlPlane?.ready === true) return;
          }
        }
      } catch { /* Listener may still be starting. */ }
    }
    await timing.sleep(500);
  }
  throw new Error(`Daemon/WebUI did not become ready in ${Math.round(timing.timeoutMs / 1000)} seconds. Inspect: journalctl --user -u ${serviceUnit(options)}`);
}
export async function build(root: string, execute: Run): Promise<string> {
  const git = (...args: string[]) => execute('git', args, { cwd: root, capture: true });
  const commit = git('rev-parse', 'HEAD');
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Install from a Git checkout with an exact commit.');
  const assertClean = (when: string): void => {
    try { git('diff', '--quiet', 'HEAD'); }
    catch (error) {
      if (!(error instanceof CommandError) || error.status !== 1) throw error;
      throw new Error(`Tracked files differ from commit ${commit} ${when}, so the build would not match its recorded commit. ${when === 'before the build' ? 'Commit or stash tracked changes' : 'A build step rewrote a tracked file; inspect it with git status, restore it with git checkout -- <file>'}, then re-run the installer.`);
    }
  };
  assertClean('before the build');
  console.log(`Building GoodVibes from ${commit}...`);
  execute('bun', ['install', '--frozen-lockfile'], { cwd: root });
  execute('bun', ['packages/engine/scripts/build.ts'], { cwd: root });
  for (const [product, script] of [['daemon', 'build:binary'], ['tui', 'build'], ['agent', 'build:binary'], ['webui', 'build']]) {
    execute('bun', ['run', script!], { cwd: join(root, 'products', product!) });
  }
  if (git('rev-parse', 'HEAD') !== commit) throw new Error('Checkout changed during the build; re-run installation.');
  assertClean('after the build');
  execute('bun', ['scripts/ci-artifact.ts', 'record', commit, commit], { cwd: join(root, 'products/daemon') });
  return commit;
}
export async function stage(root: string, release: string, options: Options, commit: string, execute: Run): Promise<void> {
  const target = `linux-${process.arch}`;
  execute('bun', ['scripts/install-native.ts', 'install', '--artifact-root', join(root, 'products/daemon'), '--prefix', join(release, 'daemon'),
    '--source-commit', commit, '--head-commit', commit], { cwd: join(root, 'products/daemon') });
  for (const [product, binary] of [['tui', 'goodvibes'], ['agent', 'goodvibes-agent']]) {
    const dest = join(release, product!); mkdirSync(dest, { recursive: true });
    for (const suffix of ['', '.bun', '.bun.json', '.bun.LICENSE.md']) {
      copyFileSync(join(root, 'products', product!, 'dist', `${binary}-${target}${suffix}`), join(dest, `${binary}-${target}${suffix}`));
    }
    cpSync(join(root, 'products', product!, 'dist/lib'), join(dest, 'lib'), { recursive: true, dereference: true });
  }
  const require = createRequire(join(root, 'packages/engine/package.json'));
  const driver = dirname(require.resolve('playwright-core/package.json'));
  // The daemon and clients can all execute browser tools; each resolves beside its executable.
  for (const product of ['daemon', 'tui', 'agent']) cpSync(driver, join(release, product, 'playwright-core'), { recursive: true, dereference: true });
  cpSync(join(root, 'products/webui/dist'), join(release, 'webui'), { recursive: true, dereference: true });
  if (!existsSync(join(release, 'webui/index.html'))) throw new Error('WebUI build did not produce index.html.');
  mkdirSync(join(release, 'runtime'));
  for (const binary of ['bun', 'node']) {
    copyFileSync(binary === 'node' && options.nodePath ? options.nodePath : join(options.runtimeDir, binary), join(release, 'runtime', binary));
    chmodSync(join(release, 'runtime', binary), 0o755);
  }
  copyFileSync(join(release, 'daemon', `goodvibes-daemon-${target}.bun.LICENSE.md`), join(release, 'runtime/BUN-LICENSE.md'));
  for (const product of ['daemon', 'tui', 'agent', 'webui']) copyFileSync(join(root, 'products', product, 'LICENSE'), join(release, product, 'LICENSE'));
  execute('bun', ['build', join(ROOT, 'scripts/uninstall.ts'), '--target=bun', '--outfile', join(release, 'uninstall.js')]);
  for (const [product, binary] of [['daemon', 'goodvibes-daemon'], ['tui', 'goodvibes'], ['agent', 'goodvibes-agent']]) {
    execute(join(release, product!, `${binary}-${target}`), ['--version'], { capture: true });
  }
}
export interface InstallHooks {
  isReleaseInUse?: typeof isReleaseInUse;
  execute?: Run;
  build?: typeof build;
  stage?: typeof stage;
  ready?: typeof ready;
  /** Stands in for `goodvibes-daemon refresh-service` (which needs the built daemon): the unit text it would write. */
  renderUnit?: (options: Options) => Promise<string>;
  /** Replaces the installed-host pairing step (the real one needs a live daemon). */
  pairHost?: Run;
}
/** Recovery for the install currently in flight; the failure path and the signal path both run exactly this. */
let activeRecovery: (() => void) | undefined;
/** Roll the interrupted install back and return the conventional exit code (128 + signal). Locks end with the process. */
export function interruptInstall(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): number {
  const recover = activeRecovery; activeRecovery = undefined;
  try { recover?.(); }
  catch (error) {
    console.error(`Install interrupted and automatic recovery was incomplete; inspect the daemon's systemd user service (systemctl --user list-units 'goodvibes*') before retrying. ${error instanceof Error ? error.message : String(error)}`);
  }
  return signal === 'SIGINT' ? 130 : signal === 'SIGHUP' ? 129 : 143;
}
export async function install(options: Options, hooks: InstallHooks = {}): Promise<void> {
  const execute = hooks.execute ?? run;
  await withLock(options.prefix, () => withLock(options.dataDir, async () => {
    const old = readInstallation(options.prefix);
    // A stand-in stage hook means no release holds a real daemon to ask or configure.
    const realDaemon = !hooks.stage;
    // A first install stopped between writing its receipt and dropping its staging record leaves the record behind.
    if (old) { recoverInterruptedUpdate(old); recoverPendingSettings(old, execute); recoverPendingService(old, 'update', execute); rmSync(stagingRecordPath(options.prefix), { force: true }); }
    else discardAbandonedFirstInstall(options.prefix);
    if (old?.serviceName !== undefined) options.serviceName = old.serviceName;
    // The port the installed daemon listens on: its own setting, which the owner may have changed since the receipt.
    let installedPort = old?.port;
    if (old && realDaemon) {
      // On an update the daemon's settings are the owner's choice; a flag states a new one.
      const installed = join(options.prefix, 'commands/goodvibes-daemon');
      const port = readDaemonSetting(execute, installed, options.dataDir, 'controlPlane.port');
      if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535) throw new Error(`The installed daemon reports controlPlane.port ${JSON.stringify(port)}, which this installer cannot use; nothing was changed. Re-run with --port.`);
      installedPort = port as number;
      if (!options.portStated) options.port = installedPort;
      if (!options.serviceStated) options.service = readDaemonSetting(execute, installed, options.dataDir, 'service.enabled') === true;
    }
    preflight(options, old, execute);
    // A port held by anything but this installation's own service is refused
    // before the build, not after it; the installed service's own port is
    // checked again once that service has stopped.
    if (options.service && (!old?.service || installedPort !== options.port)) await assertPortFree(options.port);
    const commit = await (hooks.build ?? build)(ROOT, execute);
    // Check again after a potentially long build, before touching live files.
    preflight(options, old, execute);
    const id = old?.id ?? readDataId(options) ?? randomUUID();
    const releaseName = `${commit}-${randomUUID()}`;
    const release = join(options.prefix, 'releases', releaseName);
    // A first install names what it stages before staging it, so a run killed now leaves a record of exactly what
    // a later run may remove; an update is covered by its receipt.
    if (!old) recordFirstInstallStaging(options.prefix, releaseName);
    mkdirSync(release, { recursive: true, mode: 0o700 });
    let published = false;
    let stopAttempted = false;
    let wasRunning = false;
    let serviceAttempted = false;
    let pendingServiceWritten = false;
    // The settings an update is about to write, recorded in the receipt first (see recoverPendingSettings).
    let pendingSettings: PendingSetting[] | undefined;
    const settingsPaths = ['daemon', 'tui', 'shared'].map(surface => join(options.dataDir, '.goodvibes', surface, 'settings.json'));
    const metadataPaths = [dataOwner(options), join(options.dataDir, 'environment')];
    const previousMetadata = new Map(metadataPaths.map(path => { plainPath(path); return [path, present(path) ? readFileSync(path, 'utf8') : undefined] as const; }));
    let metadataTouched = false;
    const previousSettings = new Map<string, string | undefined>();
    const previousUnitPath = unitPath(options);
    const previousUnit = present(previousUnitPath) ? readFileSync(previousUnitPath, 'utf8') : undefined;
    const previousWrappers = new Map(COMMANDS.map(name => [name, old && present(join(options.prefix, 'commands', name)) ? readFileSync(join(options.prefix, 'commands', name), 'utf8') : undefined]));
    // One recovery, used by both a failure and an interrupt. It runs at most once.
    let recovered = false;
    let committed = false;
    const recover = (): void => {
      if (recovered || committed) return;
      recovered = true;
      // Do not delete binaries that a failed service stop might still be using.
      if (serviceAttempted) {
        execute('systemctl', ['--user', 'stop', serviceUnit(options)]);
        const state = execute('systemctl', ['--user', 'show', serviceUnit(options), '--property=ActiveState', '--value'], { capture: true });
        if (!['inactive', 'failed'].includes(state)) throw new Error('Replacement service did not stop.');
        if (!old?.service || serviceUnit(options) !== serviceUnit(old)) execute('systemctl', ['--user', 'disable', serviceUnit(options)]);
      }
      if (published) {
        if (old) switchRelease(options.prefix, old.release);
        else rmSync(join(options.prefix, 'current'), { force: true });
        for (const name of COMMANDS) {
          const previous = previousWrappers.get(name);
          if (previous !== undefined) atomicWrite(join(options.prefix, 'commands', name), previous, 0o755);
          else { rmSync(join(options.prefix, 'commands', name), { force: true }); rmSync(join(options.binDir, name), { force: true }); }
        }
        for (const [path, contents] of previousSettings) {
          if (contents !== undefined) atomicWrite(path, contents);
          else rmSync(path, { force: true });
        }
      }
      if (metadataTouched) {
        for (const [path, contents] of previousMetadata) {
          // A failed first launch can already have created user data. Preserve
          // its new ownership so a retry can adopt it; restore existing owners.
          if (published && previousMetadata.get(dataOwner(options)) === undefined && contents === undefined) continue;
          if (contents !== undefined) atomicWrite(path, contents);
          else rmSync(path, { force: true });
        }
      }
      if (options.service || old?.service) {
        if (previousUnit !== undefined) atomicWrite(previousUnitPath, previousUnit, 0o644);
        else rmSync(previousUnitPath, { force: true });
        // A unit the daemon wrote under another name (service.serviceName changed) is this run's own.
        if (unitPath(options) !== previousUnitPath) rmSync(unitPath(options), { force: true });
        execute('systemctl', ['--user', 'daemon-reload']);
        if (stopAttempted && wasRunning && old?.service) { execute('systemctl', ['--user', 'enable', serviceUnit(old)]); execute('systemctl', ['--user', 'start', serviceUnit(old)]); }
      }
      // The unit and settings are back as they were, so the receipt no longer says a change is under way.
      if (old && (pendingServiceWritten || pendingSettings)) atomicWrite(receiptPath(options), JSON.stringify(old, null, 2) + '\n');
      if (old) rmSync(release, { recursive: true, force: true });
      else rmSync(options.prefix, { recursive: true, force: true });
    };
    activeRecovery = recover;
    try {
      await (hooks.stage ?? stage)(ROOT, release, options, commit, execute);
      // The unit is the daemon's own (`goodvibes-daemon refresh-service`, below):
      // the one definition every installer and service command writes, so the
      // daemon's service commands and doctor recognise it. Its text is recorded
      // in the receipt once written.
      let unit = '';
      if (old?.service) {
        const state = execute('systemctl', ['--user', 'show', serviceUnit(old), '--property=ActiveState', '--value'], { capture: true });
        wasRunning = !['inactive', 'failed'].includes(state);
        stopAttempted = true;
        // A first install killed before it wrote the unit left nothing loaded to stop.
        if (wasRunning || present(unitPath(old))) stopService(old, execute);
      }
      if (options.service) await assertPortFree(options.port);
      for (const path of settingsPaths) {
        plainPath(path); previousSettings.set(path, present(path) ? readFileSync(path, 'utf8') : undefined);
      }
      mkdirSync(options.dataDir, { recursive: true, mode: 0o700 }); chmodSync(options.dataDir, 0o700);
      metadataTouched = true;
      atomicWrite(dataOwner(options), JSON.stringify({ package: PACKAGE, id, dataDir: options.dataDir, prefix: options.prefix }) + '\n');
      const environment = join(options.dataDir, 'environment'); plainPath(environment);
      if (present(environment)) {
        const key = process.env.TYPESAFE_API_KEY;
        if (key && !/^\s*(export\s+)?TYPESAFE_API_KEY=/m.test(readFileSync(environment, 'utf8'))) {
          console.warn(`TYPESAFE_API_KEY is set in this shell but ${environment} already exists and has no key, so the file was kept unchanged. Add the key there to authenticate Jev.`);
        }
      } else {
        // TYPESAFE_API_KEY is classified daemon-needed by credential-scope-registry.ts.
        const key = process.env.TYPESAFE_API_KEY;
        if (key?.includes('\n') || key?.includes('\r') || key?.includes('\0')) throw new Error('TYPESAFE_API_KEY must be a single line.');
        atomicWrite(environment, '# Private shell environment for GoodVibes.\n' + (key ? `TYPESAFE_API_KEY=${quote(key)}\n` : '# TYPESAFE_API_KEY=your-key\n'));
      }
      const wrappers: Record<string, string> = Object.fromEntries(COMMANDS.map(name => [name, wrapper(options, name)]));
      const { runtimeDir: _runtimeDir, nodePath: _nodePath, portStated: _portStated, serviceStated: _serviceStated, ...installedOptions } = options;
      const receipt: Installation = { ...installedOptions, schema: 2, package: PACKAGE, id, release: releaseName, sourceCommit: commit,
        service: options.service, unit, wrappers };
      // A first install owns everything it is about to publish from here on, so a run killed outright leaves an
      // ordinary receipt-owned installation that uninstall removes and a re-run updates. An update keeps the
      // previous receipt until the new release is ready; `current` naming another release marks it interrupted.
      // It records no service yet: the service is recorded once its unit is in place (see pendingService below).
      const firstReceipt: Installation = { ...receipt, service: false, unit: '' };
      if (!old) { atomicWrite(receiptPath(options), JSON.stringify(firstReceipt, null, 2) + '\n'); rmSync(stagingRecordPath(options.prefix), { force: true }); }
      switchRelease(options.prefix, releaseName); published = true;
      mkdirSync(options.binDir, { recursive: true });
      for (const name of COMMANDS) {
        atomicWrite(join(options.prefix, 'commands', name), wrappers[name]!, 0o755);
        const link = join(options.binDir, name);
        if (!present(link)) symlinkSync(join(options.prefix, 'commands', name), link);
      }
      const daemon = join(options.prefix, 'commands/goodvibes-daemon');
      // A first install writes the port, the loopback posture and the service choice; an update writes only what a
      // flag stated, so the owner's later settings (webui enable --lan, another port, uninstall-service) stand.
      const writes: [key: string, value: string | number | boolean][] = [];
      if (options.decisionPolicy !== undefined) writes.push(['judgment.policy', options.decisionPolicy]);
      if (!old || options.portStated) writes.push(['controlPlane.port', options.port]);
      // Whether this machine has a daemon service, where the daemon (before it
      // would install itself as a service) and doctor read it.
      if (!old || options.serviceStated) writes.push(['service.enabled', options.service]);
      const webuiBundle = join(options.prefix, 'current/webui');
      // The owner's web UI choice stands: with a bundle directory configured and serving off (`webui disable`),
      // only the directory moves to this release's bundle. `--loopback` is written only when no web UI was
      // configured yet, so a later install keeps the posture the owner chose.
      const webuiState = realDaemon ? readWebuiState(execute, daemon, options.dataDir) : undefined;
      const webuiLeftOff = webuiState !== undefined && webuiState.bundleDir !== '' && !webuiState.serve;
      const webuiFirst = webuiState === undefined ? !old : webuiState.bundleDir === '';
      if (old && realDaemon) {
        // `webui enable` turns serving on; record those two beside the explicit writes (or the directory alone when left off).
        const recorded: [string, unknown][] = webuiLeftOff ? [...writes, ['controlPlane.webui.bundleDir', webuiBundle]]
          : [...writes, ['controlPlane.webui.serve', true], ['web.enabled', true]];
        pendingSettings = recorded.map(([key, written]) => ({ key, previous: readDaemonSetting(execute, daemon, options.dataDir, key), written }));
        atomicWrite(receiptPath(options), JSON.stringify({ ...old, pendingSettings }, null, 2) + '\n');
      }
      for (const [key, value] of writes) execute(daemon, ['config', 'set', key, String(value)], { cwd: options.dataDir, capture: true });
      let webuiUrl: string | undefined;
      if (webuiLeftOff) {
        execute(daemon, ['config', 'set', 'controlPlane.webui.bundleDir', webuiBundle], { cwd: options.dataDir, capture: true });
        console.log(`Web UI: left off (you turned it off). Turn it on: ${join(options.binDir, 'goodvibes-daemon')} webui enable`);
      } else {
        const webuiOutput = execute(daemon, ['webui', 'enable', ...(webuiFirst ? ['--loopback'] : []), '--bundle-dir', webuiBundle], { cwd: options.dataDir, capture: true });
        // The URL the daemon reported in its own receipt: the command that wrote the settings knows where the bundle is served.
        webuiUrl = /^\s*(https?:\/\/\S+)/m.exec(webuiOutput)?.[1];
      }
      if (!hooks.stage) {
        console.log('Verifying the Jev connection...');
        try {
          execute('sh', ['-c', 'set -a; . "$1"; set +a; exec "$2" "$3" "$4"', 'jev-setup', environment,
            join(release, 'runtime/bun'), join(ROOT, 'scripts/check-judgment.ts'), options.dataDir], { cwd: options.dataDir });
        } catch {
          // Account setup and upstream availability do not determine whether
          // the software can be installed or updated. Keep the check's exact
          // diagnostic visible; local service readiness is still required.
          console.warn('Jev connection check failed; continuing software installation. Resolve the account or connection problem reported above to use Jev.');
        }
      }
      // Receipt first: before the unit is written or removed, the receipt on disk says a service change is under way,
      // so a run stopped before the final receipt is put back by the next one instead of refusing a unit it wrote.
      if (options.service || old?.service) {
        atomicWrite(receiptPath(options), JSON.stringify({ ...(old ?? firstReceipt), ...(pendingSettings ? { pendingSettings } : {}), pendingService: { service: options.service } }, null, 2) + '\n');
        pendingServiceWritten = true;
      }
      if (options.service) {
        if (hooks.renderUnit) atomicWrite(unitPath(options), await hooks.renderUnit(options), 0o644);
        // Writes the definition (through the installed launcher, which pins the
        // release and loads the private environment file) and reloads systemd.
        else {
          execute(daemon, ['refresh-service', '--working-dir', options.workspace ?? ROOT], { cwd: options.dataDir, capture: true });
          // The unit is named by the daemon's service.serviceName; manage the one it wrote.
          const written = readDaemonService(execute, daemon, options.dataDir);
          options.serviceName = written.serviceName;
          if (written.path !== unitPath(options)) throw new Error(`The daemon wrote its service definition at ${written.path}, not ${unitPath(options)}, where this installer manages it.`);
        }
        if (options.serviceName !== undefined) receipt.serviceName = options.serviceName;
        unit = readFileSync(unitPath(options), 'utf8');
        receipt.unit = unit;
        serviceAttempted = true;
        execute('systemctl', ['--user', 'daemon-reload']);
        execute('systemctl', ['--user', 'enable', serviceUnit(options)]);
        execute('systemctl', ['--user', 'restart', serviceUnit(options)]);
        await (hooks.ready ?? ready)(options, readFileSync(join(release, 'webui/index.html'), 'utf8'), execute);
        if (hooks.pairHost || !hooks.stage) {
          const pairArguments = [join(ROOT, 'products/tui/scripts/pair-installed-host.ts'), options.prefix, options.dataDir, String(options.port), options.workspace ?? ROOT];
          try { (hooks.pairHost ?? execute)(join(release, 'runtime/bun'), pairArguments, { cwd: options.dataDir }); }
          catch (error) {
            // Exit 75 means a pairing attempt was recorded and left unresolved. The store has no reset (a token may
            // already be minted), so a retry cannot succeed until the owner clears it, and failing here would roll
            // back an install that is otherwise complete and running. The pairing script has already printed what
            // happened and how to clear it; finish the install and name the one command that pairs later.
            if (!(error instanceof CommandError) || error.status !== PAIRING_DEFERRED_EXIT) throw error;
            console.warn(`TUI pairing was skipped (it needs the owner's attention, see above); the installation itself is complete and the daemon is running.\nAfter clearing the recorded attempt, pair with: ${[quote(join(options.prefix, 'current/runtime/bun')), ...pairArguments.map(quote)].join(' ')}`);
          }
        }
      } else if (old?.service && present(unitPath(old))) {
        // Absent when the owner already removed it (goodvibes-daemon uninstall-service).
        execute('systemctl', ['--user', 'disable', serviceUnit(old)]);
        rmSync(unitPath(old)); execute('systemctl', ['--user', 'daemon-reload']);
      }
      if (old || options.service) atomicWrite(receiptPath(options), JSON.stringify(receipt, null, 2) + '\n');
      // The receipt names the new release from here on; a rollback now would leave it pointing at a deleted one.
      committed = true; activeRecovery = undefined;
      // A unit the previous release ran under another name (service.serviceName changed since) is replaced by the new one.
      if (old?.service && options.service && unitPath(old) !== unitPath(options) && present(unitPath(old))) {
        try {
          execute('systemctl', ['--user', 'disable', serviceUnit(old)]);
          rmSync(unitPath(old), { force: true }); execute('systemctl', ['--user', 'daemon-reload']);
        } catch (error) {
          console.warn(`Update succeeded; the previous service ${serviceUnit(old)} could not be removed (${error instanceof Error ? error.message : String(error)}). Remove it: systemctl --user disable --now ${serviceUnit(old)} && rm -- ${quote(unitPath(old))}`);
        }
      }
      // Keep every earlier release until all publication and readiness checks pass, then drop the ones nothing runs from.
      // A release kept for a running terminal on one update is reconsidered on the next.
      for (const earlier of readdirSync(join(options.prefix, 'releases'))) {
        if (earlier === releaseName) continue;
        const path = join(options.prefix, 'releases', earlier);
        try {
          if ((hooks.isReleaseInUse ?? isReleaseInUse)(path)) console.log('A previous release is retained for a running terminal or agent. Reopen it to use the update.');
          else rmSync(path, { recursive: true, force: true });
        }
        catch { console.warn(`Update succeeded; an unused previous release remains at ${path}.`); }
      }
      console.log(`Installed GoodVibes (${commit.slice(0, 12)}). Commands: ${options.binDir}`);
      if (options.service) console.log(`Workspace: ${options.workspace ?? ROOT}`);
      if (webuiUrl) console.log(`WebUI: ${webuiUrl}\nSign in: run ${join(options.binDir, 'goodvibes')} pair (or ${join(options.binDir, 'goodvibes-daemon')} pair) and open the link it prints, or scan its QR`);
      console.log(options.service ? `Service: systemctl --user status ${serviceUnit(options)}` : `Start the daemon: ${join(options.binDir, 'goodvibes-daemon')} serve`);
      console.log(`Credentials: ${environment}\nUninstall: ${join(options.binDir, 'goodvibes-uninstall')} (add --purge to remove data)`);
      if (!(process.env.PATH ?? '').split(':').includes(options.binDir)) console.log(`Add commands to your shell PATH: export PATH=${quote(options.binDir)}:"$PATH"`);
      if (options.service) console.log('For startup before login and after logout: loginctl enable-linger "$USER"');
    } catch (error) {
      try { recover(); } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], `Install failed and automatic recovery was incomplete. Files retained at ${options.prefix}; inspect ${serviceUnit(options)} before retrying.`);
      }
      throw error;
    } finally {
      if (activeRecovery === recover) activeRecovery = undefined;
    }
  }));
}
if (import.meta.main) {
  try {
    if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch)) throw new Error('Supported hosts: Linux x64/arm64.');
    if (process.getuid?.() === 0) throw new Error('Run as your regular user, without sudo.');
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(signal, () => { process.exit(interruptInstall(signal)); });
    await install(parseOptions(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    if (error instanceof AggregateError) for (const cause of error.errors) console.error(cause instanceof Error ? cause.message : String(cause));
    process.exitCode = 1;
  }
}
