/**
 * Composer grammar of the TUI: the leading `@model:<id>` directives. The memory
 * markers (`!# <text>` pins and sends, `# <text>` saves a note and sends
 * nothing) and the `!` shell marker are read by the shared submission router,
 * the same way in both terminal apps.
 */
export {
  applyComposerCapture,
  shouldSendAfterCapture,
  type ComposerCaptureDeps,
  type ComposerCaptureResult,
} from '@goodvibes-jev/engine/terminal-shell/submission-router';

// Directives are only honoured at the start of the submission, so pasted text that
// merely contains "@model:x" (a log, a diff) never changes the selected model.
const LEADING_AT_MODEL_PATTERN = /^\s*@model:(\S+)/;

/**
 * Split the leading `@model:<id>` directives off a composer submission. The
 * caller switches to each through `/model <id>`, the one switch path, so the
 * label, the reasoning effort and the missing-key capture are the ones a
 * `/model` switch gets.
 */
export function splitAtModelDirectives(input: string): { readonly models: readonly string[]; readonly text: string } {
  const models: string[] = [];
  let text = input;
  for (let match = LEADING_AT_MODEL_PATTERN.exec(text); match !== null; match = LEADING_AT_MODEL_PATTERN.exec(text)) {
    models.push(match[1]!);
    text = text.slice(match[0].length);
  }
  return { models, text: models.length > 0 ? text.trim() : input };
}
