/**
 * occasion-announcements.ts, hearing from the host that a reminder is waiting.
 *
 * The host's occasions sweep publishes `DELIVERY_WAITING` (job `occasions`,
 * surface `agent`) on the `deliveries` event domain when it raises something
 * and `occasions.nudgeChannel` names the agent. The frame carries no text: the
 * caller reads what is outstanding through `occasions.pending`, the same read
 * the turn-end and idle pulls make.
 *
 * The stream reconnects on its own after a drop. When it cannot be opened (no
 * host, a refused credential) or ends for good, the caller keeps its turn-end
 * and idle pulls, which cover the same items later, and opens it again on its
 * next idle pass.
 */

import { buildUrl } from '@goodvibes-jev/engine/transport-http/paths';
import { openRawServerSentEventStream } from '@goodvibes-jev/engine/transport-http/sse-stream';
import { logger, summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

export interface OccasionAnnouncementWatch {
  close(): void;
}

export interface WatchOccasionAnnouncementsOptions {
  readonly baseUrl: string;
  readonly token: string;
  /** Called once per announcement. */
  readonly onWaiting: () => void;
  /** Called once when an opened stream ends; not called for `close()`. */
  readonly onEnded: () => void;
  readonly fetchImpl?: typeof fetch | undefined;
}

/** Whether one `deliveries` frame says an occasion reminder waits for the Agent. */
export function isOccasionWaitingFrame(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false;
  const frame = payload as { readonly type?: unknown; readonly payload?: unknown };
  if (frame.type !== 'DELIVERY_WAITING') return false;
  const body = frame.payload;
  if (typeof body !== 'object' || body === null) return false;
  const fields = body as { readonly jobId?: unknown; readonly surface?: unknown };
  return fields.jobId === 'occasions' && fields.surface === 'agent';
}

/** Open the subscription; null when it could not be opened. */
export async function watchOccasionAnnouncements(options: WatchOccasionAnnouncementsOptions): Promise<OccasionAnnouncementWatch | null> {
  const url = new URL(buildUrl(options.baseUrl, '/api/control-plane/events'));
  url.searchParams.set('domains', 'deliveries');
  let closed = false;
  const ended = (): void => { if (!closed) { closed = true; options.onEnded(); } };
  try {
    const close = await openRawServerSentEventStream(options.fetchImpl ?? globalThis.fetch, url.toString(), {
      onEvent: ({ name: domain, payload }) => {
        if (domain === 'deliveries' && isOccasionWaitingFrame(payload)) options.onWaiting();
      },
      // An announcement may have been dropped: say a reminder may be waiting, so it is read now.
      onGap: () => { if (!closed) options.onWaiting(); },
      onEnd: (end) => { if (end.kind !== 'closed') ended(); },
    }, { getAuthToken: () => options.token, reconnect: { enabled: true } });
    return { close: (): void => { if (closed) return; closed = true; close(); } };
  } catch (error) {
    logger.debug('[occasions] the reminder announcement stream could not be opened; reminders arrive at turn end and idle checks', {
      error: summarizeError(error),
    });
    return null;
  }
}
