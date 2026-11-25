/**
 * tool-ask-words.ts, the words of an ask for a tool whose arguments only the
 * program that registered it can word (`capability_run`: which capability,
 * and what each of its inputs is). The program registers a presenter for its
 * tool; the ask's question and subject lines are then the presenter's, on
 * every surface the ask is shown, instead of the call's arguments as JSON.
 */

/** An ask's question and the lines under it, for one call of a tool. */
export interface ToolAskWords {
  readonly question: string;
  readonly lines: readonly string[];
}

export type ToolAskPresenter = (args: Readonly<Record<string, unknown>>) => ToolAskWords | undefined;

const presenters = new Map<string, ToolAskPresenter>();

/** Word the asks for calls of `tool` with `presenter`; returns the unregister. The last registered presenter of a tool is used. */
export function presentToolAskWith(tool: string, presenter: ToolAskPresenter): () => void {
  presenters.set(tool, presenter);
  return () => { if (presenters.get(tool) === presenter) presenters.delete(tool); };
}

/** The registered words for a call, when its tool has a presenter and the presenter can word this call. */
export function toolAskWords(tool: string, args: Readonly<Record<string, unknown>>): ToolAskWords | undefined {
  const presenter = presenters.get(tool);
  if (!presenter) return undefined;
  try {
    return presenter(args);
  } catch {
    return undefined;
  }
}
