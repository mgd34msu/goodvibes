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
import {
  controlPlaneOriginUsesStableHost, explicitPublicBaseUrl, getOrCreateCompanionToken, getOrCreateHttpListenerToken,
  pairingOriginUsesStableHost, refreshStableHostInputs,
} from '@goodvibes/engine/platform/platform/pairing';
import { RuntimeEventBus, runtimeEventBusOptionsFrom } from '@goodvibes/engine/platform/platform/runtime/state';
import { publishDaemonRuntimeRecord, type PublishedDaemonRuntimeRecord } from '@goodvibes/engine/platform/platform/runtime/operations';
import { isKnownConfigKey } from '../config/config-key-guard.js';
import { getPackageVersion, renderDaemonBoundEndpoint, renderDaemonStartupBanner } from './help.js';
import { createDaemonHost, type DaemonHostSnapshot } from '../runtime/daemon-host.js';
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { resolveInstalledDaemonUpdateArtifact } from '../daemon/lifecycle.js';
import type { RuntimeServicesOptions } from '../runtime/services.js';
import { runDaemonProcess, type DaemonProcessHandle, type DaemonProcessOptions } from '../daemon/process-lifecycle.js';
import type { DaemonCliConfiguration } from './configuration.js';
import type { DaemonCliFlags } from './types.js';
import { clearDerivedPublicBaseUrl, pruneDaemonStartupTokens, sweepDaemonWorktrees } from './startup-maintenance.js';
import { renderDaemonStartupPairing } from './startup-pairing.js';
import { readEnvDaemonToken, readEnvHttpListenerToken } from './daemon-tokens.js';
import { registerDaemonAcpAgentCommand } from './self-acp-command.js';

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
) {
  // The remote runners this daemon starts are the terminal app run as an ACP agent.
  registerDaemonAcpAgentCommand();
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
    let pairingShown = false;

    /**
     * The webhook listener's token: GOODVIBES_HTTP_TOKEN, else the listener's
     * own token file in the daemon home, created on first use. A new token is
     * shown once on an interactive terminal; afterwards it is read from its file.
     */
    const resolveListenerToken = (daemonHomeDirectory: string): string => {
      const fromEnv = readEnvHttpListenerToken(env);
      if (fromEnv !== undefined) return fromEnv;
      const stored = getOrCreateHttpListenerToken({ daemonHomeDir: daemonHomeDirectory });
      if (stored.quarantined) {
        stderr(`[goodvibes-daemon] the webhook listener token file was unreadable (${stored.quarantined.reason}); a new token was created, so every webhook sender must be given it.`);
      }
      if (stored.created) {
        pairingOutput?.(`Webhook listener token (the bearer token webhook senders use; it is kept in ${stored.path}, and goodvibes-daemon listener token --show prints it again): ${stored.token}`);
      }
      return stored.token;
    };

    async function serveAt(selected: DaemonCliConfiguration): Promise<DaemonHostSnapshot | typeof handedOver | undefined> {
      const { config, homeDirectory, daemonHomeDirectory, workingDirectory, isOverridden } = selected;
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
      const token = readEnvDaemonToken(env) ?? companion.token;
      // The webhook listener has its own secret: a webhook sender never holds the operator token.
      const listenerToken = config.get('danger.httpListener') ? resolveListenerToken(daemonHomeDirectory) : undefined;
      // The Tailscale and `.local` rungs of the pairing origin are slow facts
      // gathered asynchronously. Start them now, overlapping host startup, so
      // the boot banner and every pairing link this daemon builds offer the
      // stable name from the first one, and a saved web.publicBaseUrl can be
      // compared with the origin this daemon derives. Bounded and never
      // rejects; the cache then refreshes itself in the background.
      const stableHostFacts = pairingOriginUsesStableHost(config)
        || (explicitPublicBaseUrl(config) !== '' && controlPlaneOriginUsesStableHost(config)) ? refreshStableHostInputs() : undefined;
      host = createHost({
        runtime: {
          ...runtime, configManager: config, homeDirectory, daemonHomeDirectory, workingDir: workingDirectory,
          runtimeBus: new RuntimeEventBus(runtimeEventBusOptionsFrom((key) => config.get(key))),
          runtimeStore: createRuntimeStore(),
        },
        daemon: { token },
        hasOverriddenHome: isOverridden,
        ...(updateArtifact ? { updateArtifact } : {}),
        ...(listenerToken !== undefined ? { httpListener: { token: listenerToken } } : {}),
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
      try {
        const cleared = clearDerivedPublicBaseUrl(selected, actual);
        if (cleared !== null) stdout(`[goodvibes-daemon] web.publicBaseUrl held ${cleared}, an address this daemon derives itself; it is cleared so links follow the daemon's current address.`);
      } catch (error) {
        stderr(`[goodvibes-daemon] warning: web.publicBaseUrl could not be checked at start (${summarizeError(error)}).`);
      }
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
        return serveAt(selected);
      },
      async close() {
        closed = true;
        maintenance.abort();
        // Fence the live host synchronously, then drain both original owners.
        const closing = host?.close() ?? Promise.resolve();
        const results = await Promise.allSettled([configurationWork ?? Promise.resolve(), closing, worktreeSweep ?? Promise.resolve()]);
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
