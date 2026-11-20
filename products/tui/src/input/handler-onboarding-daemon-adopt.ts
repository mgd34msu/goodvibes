/**
 * Friction fix: the onboarding wizard's "Connect to
 * this daemon now" action, wired from the Network step's `network.daemon-source`
 * = 'adopt' fields. Extracted from handler-onboarding.ts to keep that file
 * under the architecture line cap.
 */
import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import { adoptedDaemonUrl } from './onboarding/onboarding-wizard-helpers.ts';
import { parseDaemonOrigin } from '@goodvibes/engine/platform/platform/config';
import { readConnectedDaemonToken, writeConnectedDaemonToken } from '@goodvibes/engine/platform/platform/runtime/client/daemon-credentials';
import { beginOnboardingOperation, endOnboardingOperation } from './onboarding-operation.ts';
import type { InputHandlerLike as InputHandler } from './handler-types.ts';
import {
  formatRuntimeActiveSuccessMessage,
  getRuntimeEndpointStatus,
  isRuntimeEndpointActive,
  runtimePortDiagnostic,
} from './onboarding/onboarding-runtime-status.ts';

/**
 * Immediately (not deferred to the final wizard Apply):
 *   1. Stores the pasted token for that host/port in the terminal's own
 *      endpoint-keyed credentials (the engine's runtime/client/daemon-credentials.ts). The daemon
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
  // The scheme of the daemon this terminal already talks to is kept: an https daemon stays https.
  const url = adoptedDaemonUrl(host, port, parseDaemonOrigin(configManager.get('daemon.connectedHost.url'))?.scheme ?? 'http');
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
