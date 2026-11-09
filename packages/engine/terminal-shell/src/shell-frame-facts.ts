import type { ContentPart } from '@goodvibes-jev/engine/platform/platform/providers';
import { captureNativeConversationInput, type ProductInputContext } from './native/native-conversation-input.js';
/** Per-frame observations shared by terminal renderers; presentation remains in each shell. */
export function readShellFrameFacts<PromptInfo>(
  processManager: {
    list(): readonly { readonly id: string }[];
    getStatus(id: string): { readonly done: boolean } | null | undefined;
  },
  input: { readonly prompt: string; getWrappedPromptInfo(width: number): PromptInfo },
  promptWidth: () => number,
  argsHint: (prompt: string) => string | undefined,
) {
  const runningProcessCount = processManager.list().filter((process) => processManager.getStatus(process.id)?.done === false).length;
  const cw = promptWidth();
  return { runningProcessCount, cw, promptInfo: input.getWrappedPromptInfo(cw), commandArgsHint: argsHint(input.prompt) };
}
/** Capture original spoken input before the product's normal transformation and admission path. */
export function createShellSubmissionPorts(
  submit: (text: string, content?: ContentPart[], options?: ProductInputContext) => void,
  stop: () => void,
  paste: () => { readonly pasted: boolean },
) {
  return {
    submitInput: submit,
    submitSpokenInput: (text: string, content?: ContentPart[]): void =>
      submit(text, content, { spokenOutput: true, source: captureNativeConversationInput(text, content) }),
    stopSpokenOutput: stop,
    pasteFromClipboard: paste,
  };
}
