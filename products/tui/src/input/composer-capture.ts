/**
 * Composer capture intents, leading markers in the composer that write to
 * memory instead of (or in addition to) sending a turn.
 *
 *   `!# <text>`  pins <text> to session memory AND sends it as a normal prompt
 *                (pre-existing behavior).
 *   `# <text>`   captures <text> as a session-memory note and does NOT send a
 *                turn, a pure "jot this down" gesture. A single leading `#`
 *                on a single line only; `##...` (markdown headings) and
 *                multi-line text are left alone so they can be sent as an
 *                ordinary prompt.
 *
 * Both write through the existing session memory machinery
 * (SessionMemoryStore.add) and surface a visible confirmation naming what was
 * written and where.
 */
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';

/** The provider-registry surface the `@model:` directive needs. */
export interface AtModelRegistry {
  setCurrentModel(reference: string): void;
  getCurrentModel(): { id: string; provider: string; registryKey: string; displayName: string };
}

export interface AtModelDeps {
  readonly providerRegistry: AtModelRegistry;
  /** Session runtime whose model/provider labels follow an explicit switch. */
  readonly runtime: { model: string; provider: string };
  readonly configManager: { set(key: string, value: unknown): void };
  /** Surfaces the switch confirmation / unknown-model message. */
  readonly notify: (message: string) => void;
}

// Directives are only honoured at the start of the submission, so pasted text that
// merely contains "@model:x" (a log, a diff) never changes the selected model.
const LEADING_AT_MODEL_PATTERN = /^\s*@model:(\S+)/;

/**
 * Apply every leading `@model:<id>` directive in a composer submission and
 * return the text with those directives stripped.
 *
 * The switch is a real, persisted selection (config `provider.model`), not a
 * per-turn override, so the runtime labels are updated alongside it and each
 * one is announced. An unknown id is reported as unknown rather than silently
 * dropped, the user asked for a specific backend and did not get it. A switch
 * whose persistence fails is rolled back so the registry, the runtime labels
 * and the config never disagree.
 */
export function applyAtModelDirective(input: string, deps: AtModelDeps): string {
  let text = input;
  for (let match = LEADING_AT_MODEL_PATTERN.exec(text); match !== null; match = LEADING_AT_MODEL_PATTERN.exec(text)) {
    const modelId = match[1]!;
    text = text.slice(match[0].length);
    let previous: ReturnType<AtModelRegistry['getCurrentModel']> | undefined;
    try { previous = deps.providerRegistry.getCurrentModel(); } catch { /* nothing selected yet: nothing to roll back to */ }
    try {
      deps.providerRegistry.setCurrentModel(modelId);
    } catch {
      deps.notify(`[Model] Unknown model: ${modelId}`);
      continue;
    }
    try {
      const def = deps.providerRegistry.getCurrentModel();
      deps.runtime.model = def.id;
      deps.runtime.provider = def.provider;
      deps.configManager.set('provider.model', def.registryKey);
      deps.notify(`[Model] Switched to ${def.displayName} (${def.provider}) via @model:`);
    } catch (error) {
      let kept = 'the previous model could not be restored';
      if (previous) {
        try {
          deps.providerRegistry.setCurrentModel(previous.registryKey);
          deps.runtime.model = previous.id;
          deps.runtime.provider = previous.provider;
          kept = `kept ${previous.displayName} (${previous.provider})`;
        } catch { /* reported above as not restored */ }
      }
      deps.notify(`[Model] Could not switch to ${modelId}: ${summarizeError(error)}; ${kept}.`);
    }
  }
  return text.trim();
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

  // `#` (single, not `##`), capture a note to session memory; do not send. A note is
  // one line: a pasted prompt that opens with a markdown heading or an issue
  // reference spans several lines and is sent as the prompt it is.
  const leading = input.replace(/^\s+/, '');
  if (leading.startsWith('#') && !leading.startsWith('##') && !leading.trimEnd().includes('\n')) {
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
