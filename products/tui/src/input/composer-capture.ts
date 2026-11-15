/**
 * Composer capture intents, leading markers in the composer that write to
 * memory instead of (or in addition to) sending a turn.
 *
 *   `!# <text>`  pins <text> to session memory AND sends it as a normal prompt
 *                (pre-existing behavior).
 *   `# <text>`   captures <text> as a session-memory note and does NOT send a
 *                turn, a pure "jot this down" gesture. A single leading `#`
 *                followed by a space, on a single line only; `#482 ...` (an
 *                issue number), `##...` (markdown headings) and multi-line
 *                text are left alone so they are sent as an ordinary prompt.
 *
 * Both write through the existing session memory machinery
 * (SessionMemoryStore.add) and surface a visible confirmation naming what was
 * written and where.
 */
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

export interface ComposerCaptureDeps {
  readonly sessionMemoryStore: { add(text: string): string };
  /** Surfaces the confirmation / usage message (a system message the shell renders). */
  readonly notify: (message: string) => void;
}

export interface ComposerCaptureResult {
  /** Text the caller should continue submission with (empty when nothing should be sent). */
  readonly text: string;
  /** Whether a capture marker was recognized and handled. */
  readonly captured: boolean;
}

function truncateForChip(text: string): string {
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

/**
 * Interpret composer capture markers. Returns the (possibly emptied) text to
 * continue with and whether a marker was handled. When `captured` is true and
 * the returned `text` is empty, the caller should not send a turn.
 */
export function applyComposerCapture(input: string, deps: ComposerCaptureDeps): ComposerCaptureResult {
  // `!#`, pin to session memory and continue to send as a prompt.
  if (input.startsWith('!#')) {
    const memoryText = input.slice(2).trim();
    if (!memoryText) {
      deps.notify('[Memory] Usage: !# <text to pin as session memory>');
      return { text: '', captured: true };
    }
    const id = deps.sessionMemoryStore.add(memoryText);
    deps.notify(`[Memory] Pinned: "${memoryText}" (${id})`);
    return { text: memoryText, captured: true };
  }

  // `# ` (a hash and a space), capture a note to session memory; do not send. A note
  // is one line, and the space keeps `#482 is failing` (an issue number) and
  // `##` headings as prompts.
  const leading = input.replace(/^\s+/, '');
  if ((leading === '#' || leading.startsWith('# ')) && !leading.trimEnd().includes('\n')) {
    const noteText = leading.slice(1).trim();
    if (!noteText) {
      deps.notify('[Note] Usage: # <text to save as a session-memory note>');
      return { text: '', captured: true };
    }
    const id = deps.sessionMemoryStore.add(noteText);
    // Confirmation chip: names WHAT was written and WHERE it went.
    deps.notify(`✓ Note saved → session memory: "${truncateForChip(noteText)}" (${id})`);
    return { text: '', captured: true };
  }

  return { text: input, captured: false };
}

/**
 * Whether a submission goes out after capture markers were handled. A handled marker
 * that left no text (a saved note, a usage hint) consumes the whole submission, so
 * attached content is not sent on its own with the note text removed.
 */
export function shouldSendAfterCapture(capture: ComposerCaptureResult, hasContent: boolean): boolean {
  if (capture.captured && capture.text === '') return false;
  return capture.text !== '' || hasContent;
}
