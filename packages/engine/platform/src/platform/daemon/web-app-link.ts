/**
 * Links into the web app from a message the daemon sends out (an approval
 * notice on Slack, Discord, ntfy or a webhook; the tap target of an agent's
 * reply). They open the same web app the pairing flow signs a phone into, on
 * the approval or session the message is about:
 *
 *   approval: `<origin>/?view=work#approval-action=approve&approval-id=<id>`
 *             (the Work view opens that approval for review; nothing is decided
 *             by opening the link)
 *   session:  `<origin>/?view=chat&session=<id>`
 *   neither:  `<origin>/`
 *
 * The origin is the daemon's own reachable address when it serves the web app
 * (`controlPlane.webui.serve`), otherwise the web app's address: a user-set
 * `web.publicBaseUrl`, or the declared web endpoint (`web.host`/`web.port`)
 * while `web.enabled` says a web app is served there. With none of the three
 * there is no web app to link to, and no link is built.
 */
import type { ConfigManager } from '../config/manager.js';
import { resolvePairingWebOrigin } from '../pairing/web-origin.js';
import { isLoopbackHost, resolveReachableBaseUrl } from '../utils/reachable-base-url.js';

export interface WebAppLinkTarget {
  readonly approvalId?: string | undefined;
  readonly sessionId?: string | undefined;
}

function webAppPath(target: WebAppLinkTarget): string {
  const approvalId = target.approvalId?.trim();
  if (approvalId) {
    const fragment = new URLSearchParams({ 'approval-action': 'approve', 'approval-id': approvalId });
    return `/?view=work#${fragment.toString()}`;
  }
  const sessionId = target.sessionId?.trim();
  if (sessionId) return `/?${new URLSearchParams({ view: 'chat', session: sessionId }).toString()}`;
  return '/';
}

/**
 * The link, or undefined when there is no web app to link to or no address to
 * put in it. With `reachableOffHost` (the default, for a message read on
 * another device) a loopback-only address counts as none: publishing a dead
 * link is worse than publishing none. Without it (a redirect answered by this
 * daemon) a path on this daemon is returned when the daemon serves the web app
 * itself.
 */
export function webAppLink(
  config: Pick<ConfigManager, 'get'>,
  target: WebAppLinkTarget,
  options: { readonly reachableOffHost?: boolean } = {},
): string | undefined {
  const path = webAppPath(target);
  const offHost = options.reachableOffHost !== false;
  if (config.get('controlPlane.webui.serve') === true) {
    if (!offHost) return path;
    const base = resolveReachableBaseUrl(config, 'off-host');
    return base ? `${base.replace(/\/+$/, '')}${path}` : undefined;
  }
  const resolved = resolvePairingWebOrigin(config);
  // Not served by this daemon: a web app is known only at a user-set public
  // URL, or at the declared web endpoint while web.enabled says one runs there.
  if (!resolved.fromPublicBaseUrl && config.get('web.enabled') !== true) return undefined;
  const origin = resolved.origin.replace(/\/+$/, '');
  if (offHost) {
    let host: string;
    try { host = new URL(origin).hostname; } catch { return undefined; }
    if (isLoopbackHost(host)) return undefined;
  }
  return `${origin}${path}`;
}
