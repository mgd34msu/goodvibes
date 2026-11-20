/**
 * notification-surfaces.ts, where the main conversation's system notices are
 * seen.
 *
 * The transcript draws no row for a system notice (core/notices.ts), and
 * nothing is drawn over the conversation: each one is an entry, full text, in
 * the notification history, counted on the status bar while unread and opened
 * with ctrl+n or /notifications as a kit modal.
 */

import type { CommandContext } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';
import { NotificationsModal } from '../input/notifications-modal.ts';
import { getSharedNotificationFeed } from '../core/notifications-feed.ts';

export interface NotificationSurfaceOptions {
  readonly commandContext: CommandContext;
  readonly input: InputHandler;
  readonly render: () => void;
}

export function wireNotificationSurfaces(options: NotificationSurfaceOptions): void {
  const { commandContext, input, render } = options;

  commandContext.openNotifications = () => {
    const open = input.surfaceModals.modals().find((modal) => modal instanceof NotificationsModal);
    input.surfaceModals.push(open ?? new NotificationsModal({
      feed: getSharedNotificationFeed(),
      // Agent and chain notices are about what Your agents shows.
      resolveSubject: (subject) => (subject === 'agents' && commandContext.openAgents
        ? () => { commandContext.openAgents?.(); }
        : null),
    }));
    render();
  };
}
