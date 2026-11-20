/** Explicit serving composition. There is deliberately no substitute inbox. */
import { writeSync } from 'node:fs';
import {
  applyRuntimeConfigOverrides, applyRuntimeConfigValue, applyRuntimeEndpointFlagOverrides,
  applyRuntimeFeatureFlagOverrides, resolveRuntimeEndpointBinding,
} from '@goodvibes/engine/terminal-shell';
import { describeDerivedBindMismatch, readControlPlaneBinding } from '@goodvibes/engine/platform/platform/config';
import { resolveHostBinding } from '@goodvibes/engine/platform/platform/daemon';
import { getModelIdFromProviderModel, getProviderIdFromModel } from '@goodvibes/engine/platform/platform/providers';
import { createRuntimeStore } from '@goodvibes/engine/platform/platform/runtime/store';
import { getOrCreateCompanionToken, pairingOriginUsesStableHost, refreshStableHostInputs } from '@goodvibes/engine/platform/platform/pairing';
import { RuntimeEventBus, runtimeEventBusOptionsFrom } from '@goodvibes/engine/platform/platform/runtime/state';
import { publishDaemonRuntimeRecord, type PublishedDaemonRuntimeRecord } from '@goodvibes/engine/platform/platform/runtime/operations';
import { isKnownConfigKey } from '../config/config-key-guard.js';
import { getPackageVersion, renderDaemonBoundEndpoint, renderDaemonStartupBanner } from './help.js';
import { createDaemonHost, type DaemonHostSnapshot } from '../runtime/daemon-host.js';
import { writeDaemonSetting } from '@goodvibes/engine/platform/platform/workspace/daemon-home';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { resolveInstalledDaemonUpdateArtifact } from '../daemon/lifecycle.js';
import type { RuntimeServicesOptions } from '../runtime/services.js';
import { runDaemonProcess, type DaemonProcessHandle, type DaemonProcessOptions } from '../daemon/process-lifecycle.js';
import type { DaemonCliConfiguration } from './configuration.js';
import type { DaemonCliFlags } from './types.js';
import { persistDaemonStartupPublicUrl, pruneDaemonStartupTokens, sweepDaemonWorktrees } from './startup-maintenance.js';
import { renderDaemonStartupPairing } from './startup-pairing.js';

/** How long a working-directory move waits for the answer to the request that asked for it to reach the caller. */
const MOVE_ANSWER_GRACE_MS = 100;
/** How often a move that found a turn running (or could not tell) looks again before it stops the host. */
const MOVE_IDLE_POLL_MS = 1_000;

/** The launcher supplies real inbox composition and explicitly chooses host-only capabilities. */
export type DaemonCliRuntime = Pick<RuntimeServicesOptions,
  'inboxFactory' | 'localUserAuthManager' | 'observeExternalAgents' | 'powerSeam' | 'provisionWakeModelsAtBoot' | 'capturedBunRuntimeExecutable'>;

export function prepareDaemonCliServe(config: DaemonCliConfiguration['config'], flags: DaemonCliFlags): readonly string[] {
  const errors = [...applyRuntimeConfigOverrides(config, flags.configOverrides)];
  if (errors.length) return errors;
  errors.push(...applyRuntimeFeatureFlagOverrides(config, flags));
  if (errors.length) return errors;
  if (flags.provider !== undefined || flags.model !== undefined) {
    const current = config.get('provider.model');
    const provider = (flags.provider ?? getProviderIdFromModel(current)).trim();
    const supplied = flags.model?.trim();
    // Only `provider:model` carries a provider; a slash belongs to the model name
    // (`meta-llama/Llama-3.1-8B`), so such an id keeps the configured provider.
    const model = supplied === undefined ? getModelIdFromProviderModel(current) : getModelIdFromProviderModel(supplied);
    if (!provider || supplied === '' || !model) return ['Provider and model identifiers must be nonempty'];
    // formatProviderModel intentionally preserves qualified input, which would
    // override the CLI's explicit-provider-wins rule when a model contains ':'.
    applyRuntimeConfigValue(config, 'provider.model', `${provider}:${model}`);
  }
  errors.push(...applyRuntimeEndpointFlagOverrides(config, 'controlPlane', flags));
  if (!resolveRuntimeEndpointBinding(config, 'controlPlane').recognized) errors.push('Unrecognized control-plane host mode');
  return errors;
}

export function runConfiguredDaemonCli(
  configuration: DaemonCliConfiguration,
  runtime: DaemonCliRuntime,
  env: NodeJS.ProcessEnv,
  processOptions?: DaemonProcessOptions,
  stderr: (message: string) => void = (message) => { writeSync(2, `${message}\n`); },
  stdout: (message: string) => void = (message) => { writeSync(1, `${message}\n`); },
  pairingOutput: ((message: string) => void) | undefined = process.stdout.isTTY === true
    ? (message) => { writeSync(1, `${message}\n`); } : undefined,
  activateConfiguration?: ((signal: AbortSignal) => Promise<DaemonCliConfiguration | null>) | undefined,
  createHost: typeof createDaemonHost = createDaemonHost,
  sweepWorktrees: typeof sweepDaemonWorktrees = sweepDaemonWorktrees,
  /**
   * The serving configuration for another working directory, with the same
   * homes and command-line settings. Given, the daemon moves in this process
   * when its working directory is changed: the host stops and every service
   * starts again on the new root. Absent, a change applies at the next start.
   */
  configureAt?: ((workingDirectory: string) => DaemonCliConfiguration) | undefined,
) {
  // runDaemonProcess constructs its owner even when shutdown won admission.
  // Keep token and graph acquisition inside start, after that admission fence.
  const restarted = Symbol('native suite replacement completed');
  // Startup handed the runtime to a managed replacement, or stopped it for a
  // rollback or promotion that could not finish. Either way nothing serves in
  // this process any more, and a process idling without a listener is never
  // restarted by its supervisor. (An incomplete handover ends the process
  // with status 1 through onIncompleteHandover below.)
  const handedOver = Symbol('native startup handover settled');
  let processHandle: DaemonProcessHandle;
  processHandle = runDaemonProcess(() => {
    let host: ReturnType<typeof createDaemonHost> | undefined;
    // Where this daemon actually listens, for surfaces that resolve its address (a one-run port included).
    let published: PublishedDaemonRuntimeRecord | null = null;
    let closed = false;
    const maintenance = new AbortController();
    let configurationWork: Promise<DaemonCliConfiguration | null> | undefined;
    let worktreeSweep: Promise<void> | undefined;
    // The configuration the serving host was built from, and a working-directory move in progress.
    let active: DaemonCliConfiguration | undefined;
    let moveTarget: string | undefined;
    let moving: Promise<void> | undefined;
    let pairingShown = false;

    const moveWorkspace = (workingDirectory: string): void => {
      moveTarget = workingDirectory;
      // Begins once the request that asked has been answered: stopping the
      // listener closes its open connections, the asking one included.
      moving ??= new Promise<void>((resolve) => { setTimeout(resolve, MOVE_ANSWER_GRACE_MS); })
        .then(runMoves)
        .catch((error: unknown) => { stderr(`[goodvibes-daemon] the working-directory move stopped: ${summarizeError(error)}`); void processHandle.shutdown(true); })
        .finally(() => { moving = undefined; });
    };

    /** Stop the serving host and what it published, so another can take its address. */
    async function retireHost(): Promise<void> {
      const retiring = host;
      host = undefined;
      try { await retiring?.close(); }
      finally {
        published?.remove();
        published = null;
        await (worktreeSweep ?? Promise.resolve());
        worktreeSweep = undefined;
      }
    }

    async function runMoves(): Promise<void> {
      while (moveTarget !== undefined && !closed && active) {
        const target = moveTarget;
        moveTarget = undefined;
        const from = active;
        let next: DaemonCliConfiguration;
        try {
          next = configureAt!(target);
        } catch (error) {
          const reason = `the settings for '${target}' could not be read (${summarizeError(error)})`;
          stderr(`[goodvibes-daemon] not moving to ${target}: ${reason}; still serving ${from.workingDirectory}.`);
          host?.services?.workspaceSwap?.abandonMove(reason);
          continue;
        }
        // A turn that started during the grace period is not cut off: the host
        // stops only once the probe sees no busy session (a failed probe waits).
        const swap = host?.services?.workspaceSwap;
        for (let busy = swap?.busySessions(); busy !== undefined && (busy.kind !== 'present' || busy.value > 0); busy = swap?.busySessions()) {
          if (closed) return;
          await new Promise<void>((resolveWait) => { setTimeout(resolveWait, MOVE_IDLE_POLL_MS); });
        }
        if (closed) return;
        // A newer move asked while this one waited replaces it.
        if (moveTarget !== undefined) continue;
        stdout(`goodvibes-daemon moving from ${from.workingDirectory} to ${target}`);
        await retireHost();
        if (closed) return;
        let failure: string;
        try {
          const settled = await serveAt(next);
          if (closed) return;
          if (settled === handedOver) { void processHandle.shutdown(); return; }
          if (settled && (settled.state === 'ready' || settled.state === 'degraded')) {
            active = next;
            host?.services?.workspaceSwap?.announceArrival(from.workingDirectory);
            continue;
          }
          failure = `its services did not start there (${settled?.state ?? 'stopped'})`;
        } catch (error) {
          failure = summarizeError(error);
        }
        // Back to the root it left, with the saved setting put back, so the daemon keeps serving.
        stderr(`[goodvibes-daemon] the daemon could not start in ${target}: ${failure}. Starting again in ${from.workingDirectory}.`);
        await retireHost().catch(() => undefined);
        if (closed) return;
        try { writeDaemonSetting(from.daemonHomeDirectory, 'runtime.workingDir', from.workingDirectory); }
        catch { stderr(`[goodvibes-daemon] warning: the saved working directory could not be put back to ${from.workingDirectory}; the next start uses ${target}.`); }
        const back = configureAt!(from.workingDirectory);
        const settled = await serveAt(back);
        if (closed) return;
        if (settled === handedOver) { void processHandle.shutdown(); return; }
        if (!settled || (settled.state !== 'ready' && settled.state !== 'degraded')) throw new Error(`the daemon could not start again in ${from.workingDirectory}`);
        active = back;
        host?.services?.workspaceSwap?.announceReturn(target, failure);
      }
    }

    async function serveAt(selected: DaemonCliConfiguration): Promise<DaemonHostSnapshot | typeof handedOver | undefined> {
      const { config, homeDirectory, daemonHomeDirectory, workingDirectory, workingDirectoryOverride, isOverridden } = selected;
      const version = getPackageVersion();
      const intended = resolveHostBinding(config.get('controlPlane.hostMode'), config.get('controlPlane.host'),
        config.get('controlPlane.port'), 'controlPlane');
      stdout(renderDaemonStartupBanner(version, { homeDir: homeDirectory, daemonHomeDir: daemonHomeDirectory, ...intended }));
      // Installed native artifacts select the complete suite updater. Its
      // admitted transaction owns the configured WebUI alongside programs;
      // startup serves that exact directory without a second download path.
      const updateArtifact = resolveInstalledDaemonUpdateArtifact({ isOverridden }, { signal: maintenance.signal });
      const companion = getOrCreateCompanionToken('tui', { daemonHomeDir: daemonHomeDirectory });
      if (companion.quarantined) {
        stderr('The selected daemon operator token store was unreadable. A new shared token was created; paired clients must pair again. '
          + (companion.quarantined.to ? 'The previous file was preserved beside the token store.' : 'The previous file could not be preserved.'));
      }
      if (pruneDaemonStartupTokens(selected) > 0) {
        stderr('[goodvibes-daemon] warning: some stale workspace operator-token files could not be pruned.');
      }
      // A set-but-empty override (an env template left blank) is not a token.
      const token = env.GOODVIBES_DAEMON_TOKEN?.trim() ? env.GOODVIBES_DAEMON_TOKEN : companion.token;
      // The Tailscale and `.local` rungs of the pairing origin are slow facts
      // gathered asynchronously. Start them now, overlapping host startup, so
      // the saved public URL, the boot banner and every pairing link this
      // daemon builds offer the stable name from the first one. Bounded and
      // never rejects; the cache then refreshes itself in the background.
      const stableHostFacts = pairingOriginUsesStableHost(config) ? refreshStableHostInputs() : undefined;
      host = createHost({
        runtime: {
          ...runtime, configManager: config, homeDirectory, daemonHomeDirectory, workingDir: workingDirectory,
          runtimeBus: new RuntimeEventBus(runtimeEventBusOptionsFrom((key) => config.get(key))),
          runtimeStore: createRuntimeStore(),
          ...(configureAt ? { moveWorkspace } : {}),
        },
        daemon: { token },
        hasOverriddenHome: isOverridden,
        ...(workingDirectoryOverride ? { workingDirectoryOverride } : {}),
        ...(updateArtifact ? { updateArtifact } : {}),
        ...(config.get('danger.httpListener') ? { httpListener: { token: env.GOODVIBES_HTTP_TOKEN?.trim() ? env.GOODVIBES_HTTP_TOKEN : token } } : {}),
        // A handover that stopped the runtime and then could not complete
        // leaves nothing serving: end the process with status 1 so a
        // supervisor starts whatever is installed.
        onIncompleteHandover: () => { void processHandle.shutdown(true); },
      });
      const serving = host;
      const snapshot = await serving.start();
      if (closed) return undefined;
      if (snapshot.state === 'handover') return handedOver;
      if (snapshot.state !== 'ready' && snapshot.state !== 'degraded') return undefined;
      const daemon = serving.daemon;
      if (!daemon) throw new Error('Daemon listener unavailable after startup');
      const requireRunning = () => { if (!daemon.isRunning) throw new Error('Daemon listener unavailable after startup'); };
      // Boot can overlap a config-driven restart; observe its settled listener.
      await daemon.waitForRestart();
      if (closed) return undefined;
      requireRunning();
      const actual = { host: daemon.boundHost, port: daemon.boundPort, scheme: daemon.boundScheme };
      if (stableHostFacts) {
        await stableHostFacts;
        if (closed) return undefined;
        requireRunning();
      }
      try { persistDaemonStartupPublicUrl(selected, actual); }
      catch { stderr('[goodvibes-daemon] warning: the startup public URL could not be persisted.'); }
      stdout(renderDaemonBoundEndpoint(version, actual));
      published = publishDaemonRuntimeRecord(daemonHomeDirectory, { ...actual, command: 'goodvibes-daemon serve' });
      // Background: the sweep reads git for every leftover worktree and must not delay the endpoint line.
      // close() waits for it, so the process never exits halfway through removing a worktree.
      // One journal line per item, each tagged, so a service manager's log shows every worktree removed or kept.
      worktreeSweep = sweepWorktrees(selected).then((notice) => { if (notice && !closed) for (const line of notice.split('\n')) stderr(`[goodvibes-daemon] worktrees: ${line}`); });
      const clientBinding = readControlPlaneBinding((key) => isKnownConfigKey(key, config.getSchema()) ? config.get(key) : undefined);
      if (describeDerivedBindMismatch(actual, clientBinding) !== null) {
        // The canonical helper decides drift; its raw host/URL prose is private.
        stderr('[goodvibes-daemon] warning: control-plane client binding disagrees with the bound listener (derived-bind-mismatch).');
      }
      if (pairingOutput && !pairingShown) {
        pairingShown = true;
        // Only an interactive terminal or an explicitly supplied local sink
        // receives credentials. Service/redirected diagnostics stay private.
        // Once the shared token was revoked, the value served is this machine's
        // own replacement and goes in no link; a device gets its own token.
        pairingOutput(serving.services?.pairingTokens.isLegacyRevoked() === true
          ? 'Device pairing: the shared token was revoked and replaced, so no pairing link carries it. Pair a device with its own token: goodvibes-daemon pair -y'
          : renderDaemonStartupPairing(config, actual, token, version));
      }
      stdout(`goodvibes-daemon ${version} host started (${snapshot.state})`);
      return snapshot;
    }

    return {
      async start() {
        if (closed) return undefined;
        let selected = configuration;
        if (activateConfiguration) {
          configurationWork = activateConfiguration(maintenance.signal);
          const chosen = await configurationWork;
          if (closed) return undefined;
          if (chosen === null) return restarted;
          selected = chosen;
        }
        active = selected;
        return serveAt(selected);
      },
      async close() {
        closed = true;
        maintenance.abort();
        // Fence the live host synchronously, then drain both original owners.
        const closing = host?.close() ?? Promise.resolve();
        const results = await Promise.allSettled([configurationWork ?? Promise.resolve(), closing, worktreeSweep ?? Promise.resolve(),
          // A move under way sees `closed` at its next step; a host it built meanwhile is closed after it.
          (moving ?? Promise.resolve()).then(() => host?.close())]);
        published?.remove();
        // Startup's own original promise already reports its rejection. A
        // separate host cleanup failure must still fail the process drain.
        const cleanup = results[1]!;
        if (cleanup.status === 'rejected') throw cleanup.reason;
      },
    };
  }, processOptions);
  void processHandle.ready.then(value => { if (value === restarted || value === handedOver) void processHandle.shutdown(); }, () => {});
  return processHandle;
}
