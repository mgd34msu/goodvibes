/** Owned configured daemon host; native lifecycle requires an installed caller. */
import { DaemonServer, HttpListener, createSafeHostServeFactory, type DaemonUpdateArtifact } from '@goodvibes-jev/engine/platform/platform/daemon';
import { loadPersistedProviders } from '@goodvibes-jev/engine/platform/platform/discovery';
import { createAsyncDisposalScope } from '@goodvibes-jev/engine/platform/platform/runtime/disposal';
import { createDaemonProviderDiscovery, type DaemonProviderDiscoveryDependencies } from './provider-discovery.js';
import { createDaemonBootOperations } from './boot-composition.js';
import type { DaemonBootSnapshot } from './boot-tasks.js';
import { createHostedSessionOptions } from './hosted-session-composition.js';
import { createRuntimeServices, type RuntimeServices, type RuntimeServicesOptions } from './services.js';
import { observeNativeStartupPhase } from './startup-observation.js';
import { createNativeDataWriteOwner, createInstalledReaderCohort } from '@goodvibes-jev/engine/platform/platform/runtime/self-update';
import { drainOwned } from '@goodvibes-jev/judgment';
import { defineLifecycle, logger } from '@goodvibes-jev/engine/platform/platform/utils';

export interface DaemonHostBinding {
  readonly host?: string;
  readonly port?: number;
  readonly token?: string;
  /** The shared safe-request boundary always wraps this transport. */
  readonly serveFactory?: typeof Bun.serve;
}

export interface DaemonHostOptions {
  /** Config/home ownership has already been resolved by the caller. */
  readonly runtime: Omit<RuntimeServicesOptions, 'createBootOperations'>;
  readonly daemon?: DaemonHostBinding;
  /** Absent for source/embedded hosts; the native CLI supplies a verified installation. */
  readonly updateArtifact?: DaemonUpdateArtifact;
  readonly hasOverriddenHome?: boolean;
  /** Explicit opt-in; an absent binding constructs no secondary listener. */
  readonly httpListener?: DaemonHostBinding;
}

export type DaemonHostServer = Pick<DaemonServer, 'enable' | 'start' | 'completeHostStartup' | 'stop' | 'fenceRestartAdmission' | 'waitForRestart' | 'isRunning' | 'boundHost' | 'boundPort' | 'boundScheme'>;
export type DaemonHostListener = Pick<HttpListener, 'enable' | 'start' | 'stop' | 'fenceRestartAdmission' | 'waitForRestart' | 'isRunning'>;

/** Narrow construction seams also permit held-acquisition lifecycle tests. */
export interface DaemonHostFactories {
  readonly providerDiscovery?: DaemonProviderDiscoveryDependencies;
  readonly createRuntime?: typeof createRuntimeServices;
  readonly createServer?: (config: ConstructorParameters<typeof DaemonServer>[0]) => DaemonHostServer;
  readonly createListener?: (config: ConstructorParameters<typeof HttpListener>[0]) => DaemonHostListener;
}

export type DaemonHostState = 'idle' | 'starting' | 'ready' | 'degraded' | 'handover' | 'closing' | 'closed' | 'failed';

export interface DaemonHostSnapshot {
  readonly state: DaemonHostState;
  readonly boot?: DaemonBootSnapshot;
}

/**
 * Every host state and the states it may move to. `failed` is entered as soon as a start fails,
 * so a failed host never reads `starting`; close() then drains it (`closing`) and settles it as
 * `failed` when the start failed or the cleanup did, `closed` otherwise.
 */
export const daemonHostLifecycle = defineLifecycle<DaemonHostState>('daemon host', {
  idle: ['starting', 'closing'],
  starting: ['ready', 'degraded', 'handover', 'failed', 'closing'],
  ready: ['closing'],
  degraded: ['closing'],
  handover: ['closing'],
  failed: ['closing'],
  closing: ['closed', 'failed'],
  closed: [],
});

/**
 * The start phase named in a startup failure ("Daemon host <phase> failed"). These are the
 * human-readable names of the steps in run(); they are not NativeStartupPhase, whose kebab-case
 * values are fixed observation tokens for the native execution consumer and cover a different,
 * finer-grained set (device sweeps, base-runtime sub-steps) that this host does not report.
 */
export type DaemonHostPhase =
  | 'runtime acquisition'
  | 'provider preload'
  | 'server construction'
  | 'HTTP listener construction'
  | 'cluster startup'
  | 'device housekeeping'
  | 'server startup'
  | 'native startup handover'
  | 'HTTP listener startup'
  | 'boot startup'
  | 'native lifecycle activation';

export interface DaemonHost {
  readonly services: RuntimeServices | undefined;
  readonly daemon: DaemonHostServer | undefined;
  readonly httpListener: DaemonHostListener | undefined;
  /** On failure cleanup begins; await close() for its result. Retry with a fresh owner. */
  start(): Promise<DaemonHostSnapshot>;
  /** Fences later phases immediately; awaits every admitted phase and owner. */
  close(): Promise<void>;
  snapshot(): DaemonHostSnapshot;
}

const INTERRUPTED = Symbol('daemon host interrupted');

/**
 * Construction is inert so a process runner can install signals first. The
 * same graph supplies boot, hosted sessions, cluster identity and payments.
 * Every resource is owned before enable/start. Source/embedded callers supply
 * no update artifact; the installed native CLI retains its installation through admission.
 */
export function createDaemonHost(options: DaemonHostOptions, factories: DaemonHostFactories = {}): DaemonHost {
  const scope = createAsyncDisposalScope('Daemon host');
  const updateArtifact = options.updateArtifact;
  const nativeGuard = updateArtifact?.assertCurrent, nativeExecPath = updateArtifact?.execPath, nativeVersion = updateArtifact?.version;
  const hasOverriddenHome = options.hasOverriddenHome;
  const retainedInstallationCurrent = (updateArtifact?.assertStarting ?? updateArtifact?.assertCurrent)?.bind(updateArtifact);
  const assertInstallationCurrent = () => {
    if (options.updateArtifact !== updateArtifact || options.hasOverriddenHome !== hasOverriddenHome) {
      throw new Error('Daemon host lifecycle ownership changed during acquisition');
    }
    retainedInstallationCurrent?.();
  };
  let services: RuntimeServices | undefined;
  let daemon: DaemonHostServer | undefined;
  let listener: DaemonHostListener | undefined;
  let state: DaemonHostSnapshot['state'] = 'idle';
  let closed = false;
  let work: Promise<void> | undefined;
  let starting: Promise<DaemonHostSnapshot> | undefined;
  let closing: Promise<void> | undefined;
  let discovery: ReturnType<typeof createDaemonProviderDiscovery> | undefined;
  let bootClosing: Promise<void> | undefined;
  let startupFailure: Error | undefined;
  let startupHandover: Exclude<Awaited<ReturnType<DaemonHostServer['start']>>, void> | undefined;
  const cleanupFailures: Error[] = [];
  let phase: DaemonHostPhase = 'runtime acquisition';

  /** The one place `state` changes. A move the table does not allow is logged, never thrown: shutdown must proceed. */
  const moveTo = (next: DaemonHostState): void => {
    const move = daemonHostLifecycle.check(state, next);
    if (!move.ok) {
      try { logger.warn('Daemon host lifecycle move outside its declared table', { from: move.from, to: move.to }); }
      catch { /* Reporting cannot change the host's state. */ }
    }
    state = next;
  };
  const snapshot = (): DaemonHostSnapshot => ({ state, ...(services?.bootTasks ? { boot: services.bootTasks.snapshot() } : {}) });
  const fence = (): void => { if (closed) throw INTERRUPTED; };
  const nativeDataWriter = updateArtifact && nativeGuard && nativeExecPath && nativeVersion ? createNativeDataWriteOwner(Object.freeze({
    execPath: nativeExecPath, version: nativeVersion,
    readerCohort: createInstalledReaderCohort({ execPath: nativeExecPath, version: nativeVersion, platform: process.platform, arch: process.arch }),
    assertCurrent() {
      fence();
      if (options.updateArtifact !== updateArtifact || updateArtifact.assertCurrent !== nativeGuard
        || updateArtifact.execPath !== nativeExecPath || updateArtifact.version !== nativeVersion) throw new Error('Native data publisher changed');
      const result: unknown = nativeGuard.call(updateArtifact);
      if (result !== undefined) { drainOwned(result); throw new Error('Native data publication requires a synchronous installation guard'); }
      fence();
    },
  })) : options.runtime.nativeDataWriter ?? options.runtime.configManager.getNativeDataWriter();
  // Never inspect, stringify or retain rejection values from external owners.
  async function bounded(label: string, action: () => void | Promise<void>): Promise<void> {
    try { await action(); } catch {
      const failure = new Error(`Daemon host ${label} failed`);
      cleanupFailures.push(failure);
      throw failure;
    }
  }
  function closeBoot(): Promise<void> | undefined {
    if (!services?.bootTasks) return undefined;
    if (!bootClosing) {
      bootClosing = bounded('boot drain', () => services!.bootTasks!.close());
      void bootClosing.catch(() => {});
    }
    return bootClosing;
  }
  function fenceRestarts(label: string, owner: DaemonHostServer | DaemonHostListener): void {
    try { owner.fenceRestartAdmission(); }
    catch { cleanupFailures.push(new Error(`Daemon host ${label} restart fence failed`)); }
  }
  function ownListener(label: string, owner: DaemonHostServer | DaemonHostListener): void {
    if (closed) fenceRestarts(label, owner);
    scope.registry.add(label, async () => {
      const failures: Error[] = [];
      // An already-admitted config restart must finish before the final stop.
      try { await bounded(`${label} restart drain`, () => owner.waitForRestart()); }
      catch { failures.push(new Error(`${label} restart drain failed`)); }
      try { await bounded(`${label} stop`, () => owner.stop()); }
      catch { failures.push(new Error(`${label} stop failed`)); }
      if (failures.length) throw new AggregateError(failures, `Daemon host ${label} cleanup failed`);
    });
  }

  async function run(): Promise<void> {
    try {
      fence();
      if (typeof options.runtime.inboxFactory !== 'function') throw new Error('Explicit inbox factory required');
      services = await (factories.createRuntime ?? createRuntimeServices)({
        ...options.runtime, nativeDataWriter, createBootOperations: createDaemonBootOperations,
      });
      const runtime = services;
      let graphClosing: Promise<void> | undefined;
      const closeRuntimeGraph = () => graphClosing ??= Promise.resolve().then(() => bounded('runtime graph close', () => runtime.close()));
      scope.registry.add('runtime graph', closeRuntimeGraph);
      if (closed) { closeBoot(); fence(); }
      if (!runtime.bootTasks) throw new Error('Daemon boot owner missing');

      phase = 'provider preload';
      observeNativeStartupPhase('provider-preload');
      // Custom providers finish their tolerant initial load first, so cached
      // discoveries cannot take their names. Host work owns this admission wait.
      await runtime.providerRegistry.ready();
      fence();
      const discovered = loadPersistedProviders({ homeDirectory: runtime.homeDirectory, surfaceRoot: runtime.surfaceRoot });
      if (discovered.length > 0) runtime.providerRegistry.registerDiscoveredProviders(discovered);
      fence();

      discovery = createDaemonProviderDiscovery(
        { homeDirectory: runtime.homeDirectory, surfaceRoot: runtime.surfaceRoot },
        (servers) => runtime.providerRegistry.registerDiscoveredProviders(servers),
        factories.providerDiscovery,
      );
      discovery.start();

      phase = 'server construction';
      observeNativeStartupPhase('listener-construction');
      const binding = options.daemon;
      assertInstallationCurrent();
      let handoverClosing: Promise<void> | undefined;
      const drainForNativeHandover = () => handoverClosing ??= Promise.resolve().then(async () => {
        const failures: Error[] = [];
        const drain = async (label: string, action: () => void | Promise<void>) => {
          try { await bounded(label, action); } catch { failures.push(new Error(`Daemon native handover ${label} failed`)); }
        };
        await drain('discovery close', async () => { await discovery?.close(); });
        const secondary = listener;
        if (secondary) {
          await drain('HTTP listener restart fence', () => secondary.fenceRestartAdmission());
          await drain('HTTP listener restart drain', () => secondary.waitForRestart());
          await drain('HTTP listener stop', () => secondary.stop());
        }
        await drain('boot close', async () => { await closeBoot(); });
        await drain('runtime graph close', closeRuntimeGraph);
        if (failures.length) throw new AggregateError(failures, 'Daemon native handover did not complete');
      });
      daemon = (factories.createServer ?? ((config) => new DaemonServer(config)))({
        host: binding?.host, port: binding?.port,
        workingDir: runtime.workingDirectory, homeDirectory: runtime.homeDirectory,
        daemonHomeDir: options.runtime.daemonHomeDirectory,
        configManager: runtime.configManager, userAuth: runtime.localUserAuthManager,
        runtimeBus: runtime.runtimeBus, runtimeServices: runtime,
        drainForNativeHandover,
        deferNativeActivationUntilHostReady: true,
        serveFactory: createSafeHostServeFactory('Configured daemon', binding?.serveFactory),
        clusterCoordinator: runtime.clusterCoordinator, clusterGroupVerbs: runtime.clusterGroup.verbs,
        paymentReplies: runtime.daemonHandlers.paymentReplies,
        hostedSessions: createHostedSessionOptions(runtime),
        ...(updateArtifact ? { updateArtifact } : {}),
        ...(hasOverriddenHome === undefined ? {} : { hasOverriddenHome }),
      });
      ownListener('daemon server', daemon);
      fence();
      assertInstallationCurrent();
      daemon.enable({ daemon: true }, binding?.token);
      fence();

      if (options.httpListener) {
        phase = 'HTTP listener construction';
        observeNativeStartupPhase('secondary-listener-construction');
        const http = options.httpListener;
        listener = (factories.createListener ?? ((config) => new HttpListener(config)))({
          host: http.host, port: http.port, configManager: runtime.configManager,
          userAuth: runtime.localUserAuthManager, hookDispatcher: runtime.hookDispatcher,
          pairingTokens: runtime.pairingTokens,
          serveFactory: createSafeHostServeFactory('Configured HTTP listener', http.serveFactory),
        });
        ownListener('HTTP listener', listener);
        fence();
        listener.enable({ httpListener: true }, http.token ?? binding?.token);
        fence();
      }

      phase = 'cluster startup';
      observeNativeStartupPhase('cluster-startup');
      await runtime.startCluster();
      fence();
      phase = 'device housekeeping';
      observeNativeStartupPhase('device-recovery');
      // Await the recovery sweep instead of detaching a startup promise.
      await runtime.devicePosture.startHousekeeping();
      fence();
      phase = 'server startup';
      observeNativeStartupPhase('listener-startup');
      assertInstallationCurrent();
      const outcome = await daemon.start();
      if (outcome && outcome.state === 'handover') {
        startupHandover = outcome;
        phase = 'native startup handover';
        if (closed) outcome.cancel();
        await outcome.drain;
        fence();
        moveTo('handover');
        return;
      }
      fence();
      // Listener startup awaits accepted backend owners. Retirement during
      // that work cannot admit a new listener or boot effects afterward.
      assertInstallationCurrent();
      if (!daemon.isRunning) throw new Error('Daemon server did not start');
      if (listener) {
        phase = 'HTTP listener startup';
        observeNativeStartupPhase('secondary-listener-startup');
        await listener.start();
        fence();
        assertInstallationCurrent();
        if (!listener.isRunning) throw new Error('HTTP listener did not start');
      }
      phase = 'boot startup';
      observeNativeStartupPhase('boot-tasks');
      const boot = await runtime.bootTasks.start();
      fence();
      phase = 'native lifecycle activation';
      // A configuration change admitted during boot may still own the socket.
      // Native activation cannot retire this graph until that rebind drains.
      await daemon.waitForRestart();
      fence();
      assertInstallationCurrent();
      if (!daemon.isRunning) throw new Error('Daemon server stopped before native lifecycle activation');
      const activated = daemon.completeHostStartup();
      if (activated && activated.state === 'handover') {
        startupHandover = activated;
        if (closed) activated.cancel();
        await activated.drain;
        fence();
        moveTo('handover');
        return;
      }
      fence();
      moveTo(boot.state === 'ready' ? 'ready' : 'degraded');
      observeNativeStartupPhase('foreground-ready');
    } catch (error) {
      if (error === INTERRUPTED) return;
      startupFailure = new Error(`Daemon host ${phase} failed`);
      // A failed start is reported as failed at once, not as `starting` until close() runs.
      if (state === 'starting') moveTo('failed');
      throw startupFailure;
    }
  }

  function close(): Promise<void> {
    if (closing) return closing;
    closed = true;
    moveTo('closing');
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    closing = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    void closing.catch(() => {});
    // Reserve the one close before abort listeners can reenter this owner.
    try { startupHandover?.cancel(); }
    catch { cleanupFailures.push(new Error('Daemon native startup handover cancellation failed')); }
    try { const pending = discovery?.close(); if (pending) void pending.catch(() => {}); }
    catch { cleanupFailures.push(new Error('Daemon host discovery close failed')); }
    // Fence restart admission before a held boot drain can yield to config writes.
    if (daemon) fenceRestarts('daemon server', daemon);
    if (listener) fenceRestarts('HTTP listener', listener);
    // Boot's own close fences notification/provider/plugin admissions now,
    // even if an accepted factory or plugin is still holding startup open.
    closeBoot();
    void (async () => {
      try { await work; } catch { /* Report startup separately, after cleanup. */ }
      try { await bounded('discovery close', async () => { await discovery?.close(); }); }
      catch { /* Retained above; independent owners must still drain. */ }
      try { await closeBoot(); } catch { /* The bounded owner failure is retained. */ }
      // Late runtime/server acquisitions have registered by this point. Their
      // dependencies survive until boot and accepted server startup drain.
      try { await scope.close(); } catch { /* Every callback retains its bounded failures. */ }
      if (cleanupFailures.length) throw new AggregateError([...cleanupFailures], 'Daemon host cleanup failed');
    })().then(() => { moveTo(startupFailure ? 'failed' : 'closed'); resolve(); }, (error: Error) => { moveTo('failed'); reject(error); });
    return closing;
  }

  function start(): Promise<DaemonHostSnapshot> {
    if (closed) return Promise.reject(new Error('Daemon host is closed'));
    if (starting) return starting;
    moveTo('starting');
    work = Promise.resolve().then(run);
    starting = work.then(snapshot, () => {
      // Surface failure before drainage: the process runner must be able to
      // start its deadline even if this cleanup never settles.
      void close();
      throw startupFailure;
    });
    void starting.catch(() => {});
    return starting;
  }

  return { get services() { return services; }, get daemon() { return daemon; }, get httpListener() { return listener; }, start, close, snapshot };
}
