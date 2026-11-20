import { type Line } from '@goodvibes/engine/platform/platform/types';
import { BORDERS } from './layout.js';
import { renderConversationNotice } from './conversation-surface.js';
import { activeUiTones } from './theme.js';

/** Exported for use by typeOverride callers and tests. */
export type SystemMessageType = 'error' | 'warning' | 'info';

/**
 * Render a system message with a colored left border. Its colour is the level
 * its writer stored on the message (`typeOverride`); no model reads the text.
 */
export function renderSystemMessage(
  content: string,
  width: number,
  typeOverride?: SystemMessageType,
  unclassifiedAccent: 'muted' | 'info' = 'muted',
): Line[] {
  const msgType = typeOverride;
  // System-message notices paint the ▌ marker and body text on the TRANSPARENT
  // terminal background (renderConversationNotice passes no bodyBg), so the
  // accent and dim text resolve per-render through activeUiTones() to stay
  // legible on a light terminal. Dark values are byte-identical to the prior
  // static reads (chrome.bad == state.bad, chrome.warn == state.warn,
  // state.info unchanged, chrome.faint == fg.dim). The ▌ marker glyph is still
  // sourced from the BORDERS table.
  const t = activeUiTones();
  const border = msgType === 'error' ? BORDERS.ERROR
    : msgType === 'warning' ? BORDERS.WARNING
    : BORDERS.INFO;
  const accent = msgType === 'error' ? t.chrome.bad
    : msgType === 'warning' ? t.chrome.warn
    : msgType === 'info' || unclassifiedAccent === 'info' ? t.state.info : t.chrome.faint;
  const textColor = msgType === 'info' || msgType === undefined ? t.chrome.faint : accent;
  return renderConversationNotice(content, width, {
    accent,
    text: textColor,
  }, border.char);
}
