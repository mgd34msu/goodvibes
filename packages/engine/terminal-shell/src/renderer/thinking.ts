import { type Line } from '@goodvibes-jev/engine/sdk/platform/types';
import { BORDERS } from './layout.js';
import { renderConversationNotice } from './conversation-surface.js';
import { activeUiTones } from './theme.js';

export function renderThinkingBlock(text: string, width: number): Line[] {
  // Thinking notices paint the ▌ marker and italic body on the TRANSPARENT
  // terminal background (renderConversationNotice passes no bodyBg), so both
  // colors resolve per-render through activeUiTones() to stay legible on a
  // light terminal. Dark values are byte-identical to the prior static reads
  // (state.reasoning for the accent, chrome.faint, which equals fg.dim, for
  // the body text).
  const t = activeUiTones();
  return renderConversationNotice(
    text,
    width,
    {
      accent: t.state.reasoning,
      text: t.chrome.faint,
      italic: true,
    },
    BORDERS.THINKING.char,
  );
}
