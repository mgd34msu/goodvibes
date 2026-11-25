/**
 * notification-surfaces.ts, where the main conversation's system notices are
 * seen.
 *
 * The transcript draws no row for a system notice (core/notices.ts), and
 * nothing is drawn over the conversation: each one is an entry, full text, in
 * the System place's Notices list (terminal-shell places/system-place.ts),
 * counted on the status bar while unread and opened with ctrl+n.
 */

import type { CommandContext } from '../input/command-registry.ts';
import type { InputHandler } from '../input/handler.ts';

export interface NotificationSurfaceOptions {
  readonly commandContext: CommandContext;
  readonly input: InputHandler;
  readonly render: () => void;
}

export function wireNotificationSurfaces(options: NotificationSurfaceOptions): void {
  const { commandContext } = options;
  commandContext.openNotifications = () => { commandContext.openPlace?.('system', { list: 'notices' }); };
}
