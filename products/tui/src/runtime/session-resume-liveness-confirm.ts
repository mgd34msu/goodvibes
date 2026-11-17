/**
 * session-resume-liveness-confirm.ts, the "this session is open somewhere
 * else" check for the session-browser resume seam.
 *
 * `/session resume <id>` refuses to resume a session another running terminal
 * holds open (its session lock, runtime/session-open-lock.ts) and tells the
 * operator to re-run with `--force`. The session-browser seam has no argv to
 * carry a `--force`, so it asks the same question as a modal instead.
 *
 * The answer is the same fact the text command reads: a lock the kernel
 * releases when its holder exits, so a crashed terminal never reads as open.
 * This process's own hold does not count; re-resuming the session already open
 * here is not a fork.
 */
import { isSessionOpenElsewhere } from '@goodvibes-jev/engine/platform/platform/runtime/operations';
import type { SessionSurface } from '@/runtime/index.ts';
import type { SelectionItem, SelectionResult } from '../input/selection-modal.ts';
import type { ConfirmOptions } from '../input/confirm-dialog.ts';

export type LiveResumeSelectionOpener = (
  title: string,
  items: SelectionItem[],
  opts: { preSelectId?: string; allowSearch?: boolean; primaryVerbLabel?: string } | undefined,
  callback: (result: SelectionResult | null) => void,
) => void;

/**
 * The confirm modal's title. Short by necessity: the selection overlay
 * truncates its title to the box width (selection-modal-overlay.ts), so
 * anything the operator must actually read, what resuming would do, belongs in
 * a row's `detail`, which that overlay wraps instead.
 */
export const LIVE_RESUME_CONFIRM_TITLE = 'Session open elsewhere';

const LIVE_RESUME_DETAIL = 'This session is open in another running terminal; resuming will fork its live state. Both terminals would hold their own copy of the conversation from this point on.';

export function buildLiveResumeConfirmItems(): SelectionItem[] {
  return [
    {
      id: 'resume',
      label: 'Resume anyway',
      detail: LIVE_RESUME_DETAIL,
      primaryAction: 'select',
    },
    {
      id: 'cancel',
      label: 'Cancel',
      detail: 'Leave the session to the terminal that already has it open.',
      primaryAction: 'select',
    },
  ];
}

export interface ConfirmLiveResumeDeps {
  readonly surface: SessionSurface;
  /** Late-bound: the shell builds its selection opener after the resume handler exists. */
  readonly openSelection: () => LiveResumeSelectionOpener | undefined;
  /** Late-bound confirm dialog; preferred over the selection list when the shell has one. */
  readonly confirm?: () => ((options: ConfirmOptions) => Promise<boolean>) | undefined;
}

/**
 * Resolve true when the resume should proceed. Proceeds without asking when no
 * other running terminal has the session open, or when no selection surface
 * exists to ask through (headless hosts keep the pre-existing behavior rather
 * than silently refusing).
 *
 * A dismissed modal resolves false: the safe answer to an unanswered "should
 * I fork another terminal's state?" is no.
 */
export async function confirmLiveResume(sessionId: string, deps: ConfirmLiveResumeDeps): Promise<boolean> {
  if (!isSessionOpenElsewhere(deps.surface, sessionId)) return true;
  const confirm = deps.confirm?.();
  if (confirm) {
    return confirm({
      title: `${LIVE_RESUME_CONFIRM_TITLE}?`,
      body: LIVE_RESUME_DETAIL,
      confirmLabel: 'Resume anyway',
      tone: 'warning',
    });
  }
  const open = deps.openSelection();
  if (!open) return true;
  return new Promise<boolean>((resolve) => {
    open(
      LIVE_RESUME_CONFIRM_TITLE,
      buildLiveResumeConfirmItems(),
      { allowSearch: false, primaryVerbLabel: 'Choose' },
      (result) => resolve(result?.item.id === 'resume'),
    );
  });
}
