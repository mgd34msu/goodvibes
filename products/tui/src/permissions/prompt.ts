import type { TerminalAskContext } from '@goodvibes/engine/terminal-shell/permission-prompt-facts';
import { cardAwaitsTab } from '@goodvibes/engine/terminal-shell/blocking-permission-input';
import type { SurfaceLayer } from '../renderer/surface-kit.ts';
import type { HunkSelectionState } from './hunk-selection.ts';
import { renderPermissionCard, type PermissionCardState } from './prompt-card.ts';
export { buildPendingPermissionExtras } from './hunk-selection.ts';
export type { PermissionCardState } from './prompt-card.ts';

import type {
  PermissionPromptRequest,
  PermissionPromptDecision,
  PermissionRequestHandler,
  PermissionRequest,
} from '@goodvibes/engine/platform/platform/permissions';
export type { PermissionPromptRequest, PermissionPromptDecision, PermissionRequestHandler, PermissionRequest };

/** The pending-permission fields the card reads (see shell/blocking-input.ts PendingPermissionState). */
export interface PendingPromptView {
  readonly callId: string;
  readonly hunkState?: HunkSelectionState | undefined;
  readonly detailsExpanded?: boolean | undefined;
  readonly replyMode?: 'deny-reason' | 'exec-answer' | undefined;
  readonly replyBuffer?: string | undefined;
  readonly choice?: number | undefined;
  readonly submenuOpen?: boolean | undefined;
  readonly submenuIndex?: number | undefined;
  readonly scroll?: number | undefined;
  /** The person has addressed the card (a key after a pause, or Tab). */
  readonly addressed?: boolean | undefined;
}

/**
 * PermissionPromptUI, the approval card (terminal-shell renderer/ask-card.ts
 * draws it; its keys are terminal-shell ask-card-input.ts, through
 * shell/blocking-input.ts).
 */
export class PermissionPromptUI {
  /**
   * The honest count of OTHER asks waiting in the broker (coalesced asks share
   * one record, so they are never double-counted).
   */
  static queueCount(
    pending: { readonly callId: string },
    broker?: { listApprovals(limit?: number): ReadonlyArray<{ readonly callId: string; readonly status: string }> } | null,
  ): number {
    try {
      return broker?.listApprovals().filter((record) => (record.status === 'pending' || record.status === 'claimed') && record.callId !== pending.callId).length ?? 0;
    } catch {
      return 0; // an unreadable broker never blocks the card
    }
  }

  /** The approval card as a modal layer. */
  static renderPromptModal(
    screenWidth: number,
    screenHeight: number,
    request: PermissionRequest,
    pending: PendingPromptView,
    broker: Parameters<typeof PermissionPromptUI.queueCount>[1],
    composerEmpty: boolean,
    context: TerminalAskContext,
    /** Local asks waiting for this card's slot (an ask the broker has not seen yet is counted here). */
    localWaiting = 0,
  ): SurfaceLayer {
    const state: PermissionCardState = {
      hunkState: pending.hunkState,
      detailsExpanded: pending.detailsExpanded,
      replyMode: pending.replyMode,
      replyBuffer: pending.replyBuffer,
      // The same ask can be both a broker record and a local card: the larger count, never the sum.
      queueCount: Math.max(this.queueCount(pending, broker), localWaiting),
      choice: pending.choice,
      submenuOpen: pending.submenuOpen,
      submenuIndex: pending.submenuIndex,
      scroll: pending.scroll,
      awaitingTab: cardAwaitsTab(pending, composerEmpty),
    };
    return renderPermissionCard(request, state, screenWidth, screenHeight, context);
  }
}
