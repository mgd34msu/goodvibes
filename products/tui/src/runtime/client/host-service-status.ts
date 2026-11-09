import { pendingHostServiceStatus, formatHostServiceBaseUrl } from '@goodvibes-jev/engine/terminal-shell/host-service-status';
export {
  formatHostServiceBaseUrl,
  hostServiceIsActive,
  hostServiceIsBlocked,
} from '@goodvibes-jev/engine/terminal-shell/host-service-status';
/**
 * host-service-status.ts, reading a background service's posture.
 *
 * Three questions the composition root asks about the daemon and the webhook
 * listener, none of which need anything from the composition itself: what URL
 * a configured host/port is reachable at, what to report before the discovery
 * probe has finished, and whether a given verdict means "usable" or "the port
 * is held and this terminal cannot have it".
 */

import type { HostServiceStatus } from '@/runtime/index.ts';
import type { ConfigManager } from '@goodvibes-jev/engine/platform/platform/config';

/** Which of the two background services a question is about. */
import type { HostServiceName } from '@goodvibes-jev/engine/terminal-shell/host-service-status';
export type { HostServiceName } from '@goodvibes-jev/engine/terminal-shell/host-service-status';

/**
 * The URL a configured host/port is actually reachable at. A wildcard bind is
 * not an address anything can connect to, so `0.0.0.0` and `::` resolve to the
 * loopback address of their family; a bare IPv6 literal is bracketed.
 */

/**
 * What to report about a service before the discovery probe has answered:
 * where it WOULD be, and the honest reason nothing is known about it yet.
 */
export function createPendingServiceStatus(configManager: Pick<ConfigManager, 'get'>, service: HostServiceName): HostServiceStatus {
  return pendingHostServiceStatus(configManager, service, {
    url: formatHostServiceBaseUrl,
    reason: 'Background service startup has not completed yet',
  });
}

/**
 * A service this terminal can actually use. Called for both the daemon and the
 * HTTP listener (see bootstrap.ts), so the 'embedded' arm stays live: the platform
 * always reports its in-process HTTP listener as 'embedded', even though this
 * product's daemon status can never carry that mode (adoptOnly is hardcoded on
 * every host-services call this app makes).
 */

/**
 * The configured port is held and unusable by this terminal, either by an
 * unverified process ('blocked') or by a GoodVibes daemon this build refused to
 * adopt ('incompatible': a wire-version mismatch, or a daemon below this
 * build's own floor).
 */
