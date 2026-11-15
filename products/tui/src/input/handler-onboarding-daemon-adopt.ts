/**
 * Friction fix: the onboarding wizard's "Connect to
 * this daemon now" action, wired from the Network step's `network.daemon-source`
 * = 'adopt' fields. Extracted from handler-onboarding.ts to keep that file
 * under the architecture line cap.
 */
import { homedir } from 'node:os';
import { resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { adoptedDaemonUrl } from './onboarding/onboarding-wizard-helpers.ts';
import { readConnectedDaemonToken, writeConnectedDaemonToken } from '../runtime/client/connected-daemon-credentials.ts';
import { beginOnboardingOperation, endOnboardingOperation } from './onboarding-operation.ts';
import {
  buildManagedDaemonServiceManager,
  detectLegacyUnit,
  resolveInstalledDaemonBinary,
  runLegacyDaemonMigration,
  MANAGED_SERVICE_NAME,
} from '@goodvibes-jev/engine/terminal-shell/legacy-daemon-migration';
import type { InputHandlerLike as InputHandler } from './handler-types.ts';
import {
  formatRuntimeActiveSuccessMessage,
  getRuntimeEndpointStatus,
  isRuntimeEndpointActive,
  runtimePortDiagnostic,
} from './onboarding/onboarding-runtime-status.ts';
import { runDaemonConfigMigration } from '../config/run-daemon-config-migration.ts';

/**
 * Immediately (not deferred to the final wizard Apply):
 *   1. Stores the pasted token for that host/port in the terminal's own
 *      endpoint-keyed credentials (connected-daemon-credentials.ts). The daemon
 *      home's operator-tokens.json, the local daemon's own record, is not touched.
 *   2. Points this terminal at the pasted host/port (`daemon.connectedHost.url`),
 *      leaving the control-plane bind settings, which describe only how a
 *      daemon on this machine listens, as they are. The dial address and its
 *      token are read together from these two, so they cannot disagree.
 *   3. Restarts the external-services controller and reports back, honestly,
 *      whether the daemon at that host/port was actually adopted, reusing
 *      the same `onboarding-runtime-status.ts` helpers the normal
 *      start-a-new-daemon path uses to report success/failure after Apply.
 *
 * Feedback is printed to the conversation feed (matching the existing
 * start-openai-subscription action's pattern) rather than stored as wizard
 * field state, because a 'status' field's value is recomputed fresh from the
 * step builder on every render and is not a place to durably stash an
 * out-of-band result.
 */
export async function handleConnectExistingDaemonForHandler(handler: InputHandler): Promise<void> {
  if (handler.onboardingOperation !== null) {
    beginOnboardingOperation(handler, 'Connect to existing daemon');
    return;
  }
  // An invalid host or port must stop here: the getters below would otherwise fall back to
  // 127.0.0.1 / 3421 and adopt an endpoint the user never typed.
  const fieldErrors = handler.onboardingWizard.getBlockingFieldLabels().filter(label => label.includes('Existing daemon host') || label.includes('Existing daemon port'));
  if (fieldErrors.length > 0) {
    handler.commandContext?.print?.(['Connect to existing daemon: fix these fields first.', ...fieldErrors.map(label => `  ${label}`)].join('\n'));
    return;
  }
  const host = handler.onboardingWizard.getStringFieldValue('network.adopt-daemon-host', '127.0.0.1').trim() || '127.0.0.1';
  const port = handler.onboardingWizard.getPortFieldValue('network.adopt-daemon-port', 3421);
  const token = handler.onboardingWizard.getStringFieldValue('network.adopt-daemon-token', '').trim();
  if (token.length === 0) {
    handler.commandContext?.print?.('Connect to existing daemon: paste that daemon\'s token first.');
    return;
  }

  const externalServices = handler.uiServices.platform.externalServices;
  if (!externalServices) {
    handler.commandContext?.print?.('Connect to existing daemon: background service controller is unavailable in this build.');
    return;
  }

  handler.onboardingOperation = 'Connect to existing daemon';
  handler.requestRender();
  const configManager = handler.uiServices.platform.configManager;
  const homeDirectory = handler.uiServices.environment.homeDirectory;
  const url = adoptedDaemonUrl(host, port);
  // A failed attempt puts back this terminal's own address and the token it held
  // for that address; nothing shared with the local daemon was changed.
  const previous = {
    url: configManager.get('daemon.connectedHost.url'),
    token: readConnectedDaemonToken(homeDirectory, url),
  };
  const restorePrevious = async (): Promise<string> => {
    try {
      configManager.setDynamic('daemon.connectedHost.url', previous.url);
      writeConnectedDaemonToken(homeDirectory, url, previous.token);
    } catch (restoreError) {
      return `The previous daemon address could not be restored (${summarizeError(restoreError)}); check daemon.connectedHost.url.`;
    }
    // The failed attempt's restart already moved the live connection to the new endpoint, so it has to move back too.
    try {
      await externalServices.restart();
      return 'The previous daemon address was restored and the connection was restarted on it.';
    } catch (restartError) {
      return `The previous daemon address was restored, but restarting the connection on it failed (${summarizeError(restartError)}); the live connection may still be on the failed endpoint until the TUI restarts.`;
    }
  };
  try {
    writeConnectedDaemonToken(homeDirectory, url, token);
    // The dial target is this terminal's own setting; the daemon-owned bind
    // settings (controlPlane.*) are not this terminal's to move.
    configManager.setDynamic('daemon.connectedHost.url', url);

    const state = await externalServices.restart();
    const binding = { label: 'GoodVibes daemon', host, port };
    if (isRuntimeEndpointActive(state, 'daemon')) {
      handler.commandContext?.print?.([
        'Connect to existing daemon: succeeded.',
        `  ${formatRuntimeActiveSuccessMessage('daemon', state)}`,
        '  This host/port and token are applied now and stay in place; they are not rolled back if you leave the wizard.',
      ].join('\n'));
    } else {
      const status = getRuntimeEndpointStatus(state, 'daemon');
      handler.commandContext?.print?.([
        'Connect to existing daemon: could not verify a connection.',
        `  ${runtimePortDiagnostic(binding, undefined, status)}`,
        `  ${await restorePrevious()}`,
        '  Check the host, port, and token, then try again.',
      ].join('\n'));
    }
  } catch (error) {
    handler.commandContext?.print?.(`Connect to existing daemon failed: ${summarizeError(error)}\n  ${await restorePrevious()}`);
  } finally {
    endOnboardingOperation(handler);
    handler.requestRender();
  }
}

/**
 * The guided UX entry point for migrating a legacy
 * `goodvibes-daemon.service` unit (an earlier release shipped detect+disclose only; this
 * closes that inheritance). This is a thin wrapper over
 * `detectLegacyUnit` + `runLegacyDaemonMigration`
 * (the shared `legacy-daemon-migration` engine), the actual migration mechanics
 * (never auto-migrate, new-up-then-old-down with a health check before the
 * legacy unit is touched, adopt-or-warn for an unrecognized process on the
 * port) live there and are exercised against fakes in
 * `src/test/daemon/service-commands.test.ts`; this function only builds the
 * same `PlatformServiceManager` the daemon CLI's `migrate-service` subcommand
 * builds (via the shared `buildManagedDaemonServiceManager`, so a migration
 * triggered from either surface installs the identical unit) and prints the
 * honest result lines to the conversation feed, mirroring
 * `handleConnectExistingDaemonForHandler`'s pattern above.
 *
 * This lives in `src/input/` rather than importing
 * `../daemon/service-commands.ts` directly because the architecture gate's
 * `input-no-entrypoints` rule forbids `src/input/**` from depending on
 * `src/daemon/**` (input must stay a pure event-handling layer), the shared
 * engine lives in the entrypoint-agnostic `src/runtime/` layer instead.
 *
 * `confirm` is caller-supplied rather than read from a fixed field name here
 * so this stays reusable from any surface: the onboarding wizard's Network
 * step (`onboarding-wizard-network-adopt.ts`'s `pushLegacyDaemonMigrationFields`,
 * dispatched from `handler-onboarding.ts`'s `migrate-legacy-daemon-service`
 * action) reads its own `network.migrate-legacy-daemon-confirm` checklist
 * toggle and passes it through as this parameter, unchecked previews the
 * dry-run plan (`confirm: false`), checked executes the real migration
 * (`confirm: true`).
 */
export async function handleMigrateLegacyDaemonServiceForHandler(handler: InputHandler, confirm: boolean): Promise<void> {
  if (!beginOnboardingOperation(handler, 'Migrate install-script daemon service')) return;
  handler.requestRender();
  try {
    const homeDirectory = handler.uiServices.environment.homeDirectory;
    const configManager = handler.uiServices.platform.configManager;
    const host = String(configManager.get('controlPlane.host') ?? '127.0.0.1');
    const port = Number(configManager.get('controlPlane.port') ?? 3421);
    const binaryPath = resolveInstalledDaemonBinary({ moduleUrl: import.meta.url });

    // The daemon's settings are brought to the current shape before the unit is rendered from them.
    runDaemonConfigMigration(homeDirectory);
    const unitHomeDir = homedir();
    const manager = buildManagedDaemonServiceManager({
      binaryPath, homeDir: homeDirectory, unitHomeDir, daemonHomeDirectory: resolveGoodVibesDaemonHome(homeDirectory), host, port,
    });
    const legacy = detectLegacyUnit({ unitHomeDir });
    const result = await runLegacyDaemonMigration(
      { host, port, trackedServiceName: MANAGED_SERVICE_NAME, confirmMigration: confirm },
      manager,
      legacy,
    );
    handler.commandContext?.print?.(
      ['Migrate install-script daemon service:', ...result.lines.map((line: string) => `  ${line}`)].join('\n'),
    );
  } catch (error) {
    handler.commandContext?.print?.(`Migrate install-script daemon service failed: ${summarizeError(error)}`);
  } finally {
    endOnboardingOperation(handler);
    handler.requestRender();
  }
}
