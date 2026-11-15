/**
 * Friction fix: the onboarding wizard's "Connect to
 * this daemon now" action, wired from the Network step's `network.daemon-source`
 * = 'adopt' fields. Extracted from handler-onboarding.ts to keep that file
 * under the architecture line cap.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { resolveGoodVibesDaemonHome } from '@goodvibes-jev/engine/platform/platform/config';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { resolveDaemonCompanionToken } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import { isLoopbackAddress } from './onboarding/onboarding-wizard-helpers.ts';
import {
  buildManagedDaemonServiceManager,
  detectLegacyUnit,
  resolveInstalledDaemonBinary,
  runLegacyDaemonMigration,
  MANAGED_SERVICE_NAME,
} from '../runtime/legacy-daemon-migration.ts';
import type { InputHandlerLike as InputHandler } from './handler-types.ts';
import {
  formatRuntimeActiveSuccessMessage,
  getRuntimeEndpointStatus,
  isRuntimeEndpointActive,
  runtimePortDiagnostic,
} from './onboarding/onboarding-runtime-status.ts';
import { GOODVIBES_TUI_SURFACE_ROOT } from '../config/surface.ts';

/**
 * Immediately (not deferred to the final wizard Apply):
 *   1. Installs the pasted token into <homeDirectory>/.goodvibes/daemon/operator-tokens.json
 *      via `resolveDaemonCompanionToken`, the same durable-persistence logic
 *      the `GOODVIBES_DAEMON_TOKEN` non-interactive override uses.
 *   2. Points `controlPlane.host`/`controlPlane.port` at the pasted host/port.
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
  if (handler.onboardingApplyPending) return;
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

  handler.onboardingApplyPending = true;
  handler.requestRender();
  const configManager = handler.uiServices.platform.configManager;
  const daemonHomeDir = resolveGoodVibesDaemonHome(handler.uiServices.environment.homeDirectory);
  const tokenFile = join(daemonHomeDir, 'operator-tokens.json');
  // What the attempt changes is written before the daemon is known to be reachable,
  // so a failed attempt puts it back instead of leaving the TUI on a dead endpoint.
  const previous = {
    hostMode: configManager.get('controlPlane.hostMode'),
    host: configManager.get('controlPlane.host'),
    port: configManager.get('controlPlane.port'),
    tokenFile: existsSync(tokenFile) ? readFileSync(tokenFile) : undefined,
  };
  const restorePrevious = async (): Promise<string> => {
    try {
      configManager.setDynamic('controlPlane.hostMode', previous.hostMode);
      configManager.setDynamic('controlPlane.host', previous.host);
      configManager.setDynamic('controlPlane.port', previous.port);
      if (previous.tokenFile === undefined) rmSync(tokenFile, { force: true });
      else writeFileSync(tokenFile, previous.tokenFile, { mode: 0o600 });
    } catch (restoreError) {
      return `The previous host, port and token could not be restored (${summarizeError(restoreError)}); check controlPlane.host, controlPlane.port and operator-tokens.json.`;
    }
    // The failed attempt's restart already moved the live connection to the new endpoint, so it has to move back too.
    try {
      await externalServices.restart();
      return 'The previous host, port and token were restored and the connection was restarted on them.';
    } catch (restartError) {
      return `The previous host, port and token were restored, but restarting the connection on them failed (${summarizeError(restartError)}); the live connection may still be on the failed endpoint until the TUI restarts.`;
    }
  };
  try {
    resolveDaemonCompanionToken(daemonHomeDir, GOODVIBES_TUI_SURFACE_ROOT, token);
    // hostMode has to move with the host. The control-plane URL is DERIVED from
    // hostMode/host/port, and 'local' pins the dial target to 127.0.0.1 no
    // matter what host is stored, so adopting a daemon on another machine
    // while leaving hostMode alone would derive a loopback URL for a remote
    // daemon. Adopting a loopback address stays 'local'.
    configManager.setDynamic(
      'controlPlane.hostMode',
      isLoopbackAddress(host) ? 'local' : 'custom',
    );
    configManager.setDynamic('controlPlane.host', host);
    configManager.setDynamic('controlPlane.port', port);

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
    handler.onboardingApplyPending = false;
    handler.requestRender();
  }
}

/**
 * The guided UX entry point for migrating a legacy
 * `goodvibes-daemon.service` unit (an earlier release shipped detect+disclose only; this
 * closes that inheritance). This is a thin wrapper over
 * `detectLegacyUnit` + `runLegacyDaemonMigration`
 * (`../runtime/legacy-daemon-migration.ts`), the actual migration mechanics
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
  if (handler.onboardingApplyPending) return;

  handler.onboardingApplyPending = true;
  handler.requestRender();
  try {
    const homeDirectory = handler.uiServices.environment.homeDirectory;
    const configManager = handler.uiServices.platform.configManager;
    const host = String(configManager.get('controlPlane.host') ?? '127.0.0.1');
    const port = Number(configManager.get('controlPlane.port') ?? 3421);
    const binaryPath = resolveInstalledDaemonBinary({ moduleUrl: import.meta.url });

    const manager = buildManagedDaemonServiceManager({ binaryPath, homeDir: homeDirectory, host, port });
    const legacy = detectLegacyUnit({ homeDir: homeDirectory });
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
    handler.onboardingApplyPending = false;
    handler.requestRender();
  }
}
