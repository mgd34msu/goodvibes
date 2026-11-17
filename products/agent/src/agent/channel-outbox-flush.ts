import type { ShellPathService } from '@/runtime/index.ts';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { syncChannelDrafts, type ChannelDraftSyncReport } from './channel-draft.ts';
import { syncChannelProfileRoutes, type ChannelProfileRouteSyncReport } from './channel-profile-routing.ts';
import type { DaemonOperatorInvoke } from '@goodvibes-jev/engine/terminal-shell/agent-turn/daemon-operator-client';

/**
 * The daemon is the store of record for channel drafts and routing
 * assignments; this Agent's files hold only the rows the daemon has not taken
 * yet (saved while it was away, or an outcome it has not heard). They are
 * offered once each time the Agent attaches to a daemon, so they reach every
 * surface with no further tool call. Cost: nothing when no row is pending;
 * otherwise one request per pending row, once per attach.
 */
export async function flushPendingChannelRows(shellPaths: Pick<ShellPathService, 'resolveUserPath'>, invoke: DaemonOperatorInvoke): Promise<{
  readonly drafts: ChannelDraftSyncReport | null;
  /** Includes `withdrawFailed`, which the caller tells the operator (formatChannelProfileRouteSyncReport words it). */
  readonly routes: ChannelProfileRouteSyncReport | null;
}> {
  let drafts: ChannelDraftSyncReport | null = null;
  let routes: ChannelProfileRouteSyncReport | null = null;
  try {
    drafts = await syncChannelDrafts(shellPaths, invoke);
  } catch (error) {
    logger.debug('Pending channel drafts were not offered to the daemon', { error: summarizeError(error) });
  }
  try {
    routes = await syncChannelProfileRoutes(shellPaths, invoke);
  } catch (error) {
    logger.debug('Pending channel routing assignments were not offered to the daemon', { error: summarizeError(error) });
  }
  return { drafts, routes };
}
