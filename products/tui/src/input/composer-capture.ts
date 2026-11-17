/**
 * Composer grammar of the TUI. The `@model:<id>` switch (a whole token at the
 * start or the end), the memory markers (`!# <text>` pins and sends, `# <text>`
 * saves a note and sends nothing) and the `!` shell marker are read by the
 * shared submission router, the same way in both terminal apps.
 */
export {
  applyComposerCapture,
  shouldSendAfterCapture,
  splitAtModelDirectives,
  type ComposerCaptureDeps,
  type ComposerCaptureResult,
} from '@goodvibes-jev/engine/terminal-shell/submission-router';
