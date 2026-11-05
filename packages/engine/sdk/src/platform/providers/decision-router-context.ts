import type { ProviderMessage } from './interface.js';

/** Host-owned turn identity and small routing hints; never serialized to answer providers. */
export interface DecisionRoutingContext {
  readonly turnId: string;
  readonly sessionId?: string;
  readonly prompt?: string;
  readonly activeTask?: string;
  readonly selectedFiles?: readonly string[];
}
export interface RoutingTextPreview {
  readonly text: string;
  readonly omittedChars: number;
}
export interface DecisionRoutingPreview {
  readonly request: RoutingTextPreview;
  readonly activeTask: RoutingTextPreview;
  readonly selectedFiles: readonly string[];
  readonly recent: readonly { readonly role: 'user' | 'assistant'; readonly content: RoutingTextPreview }[];
  readonly omittedMessages: number;
  readonly expanded: boolean;
}

export function routingMessageText(message: ProviderMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.map(part => part.type === 'text' ? part.text : '[Image attached]').join('\n');
}

function preview(text: string, budget: number): RoutingTextPreview {
  if (text.length <= budget) return { text, omittedChars: 0 };
  const take = Math.max(0, budget - 28), head = Math.ceil(take * 0.6), tail = take - head;
  return { text: text.slice(0, head) + '\n[... routing preview ...]\n' + (tail ? text.slice(-tail) : ''), omittedChars: text.length - take };
}

/** Routing reads bounded previews. Answering and stored history use their original messages. */
export function buildDecisionRoutingPreview(
  messages: readonly ProviderMessage[], hints: DecisionRoutingContext | undefined,
  rememberedTask: string | undefined, maxChars: number, expanded: boolean,
): DecisionRoutingPreview {
  const lastUser = messages.findLastIndex(message => message.role === 'user');
  const latest = lastUser < 0 ? undefined : messages[lastUser];
  const request = preview(hints?.prompt ?? (latest ? routingMessageText(latest) : ''), Math.floor(maxChars * 0.55));
  const activeTask = preview(hints?.activeTask ?? rememberedTask ?? '', Math.floor(maxChars * 0.15));
  const selectedFiles: string[] = [];
  let fileBudget = Math.floor(maxChars * 0.1);
  for (const file of hints?.selectedFiles ?? []) {
    // A partial file identity can name another file. Omit it rather than clip it.
    if (selectedFiles.length >= 20 || file.length > fileBudget) continue;
    selectedFiles.push(file); fileBudget -= file.length;
  }
  const history = messages.slice(0, Math.max(0, lastUser)).filter((message): message is Extract<ProviderMessage, { role: 'user' | 'assistant' }> =>
    message.role === 'user' || message.role === 'assistant');
  const selected = history.slice(expanded ? -6 : -2);
  const perMessage = Math.floor(maxChars * 0.2 / Math.max(1, selected.length));
  return {
    request, activeTask, selectedFiles,
    recent: selected.map(message => ({ role: message.role, content: preview(routingMessageText(message), perMessage) })),
    omittedMessages: messages.length - selected.length - (latest ? 1 : 0), expanded,
  };
}

/** A bounded routing hint survives a lookup interruption without retaining the entire task. */
export function rememberRoutingTask(prompt: string): string {
  return preview(prompt, 1000).text;
}

/** Exact selected file headers only; hunk contents stay in answering context. */
export function selectedRoutingFiles(unifiedDiff: string | undefined): readonly string[] {
  return unifiedDiff?.split('\n').filter(line => line.startsWith('--- ') || line.startsWith('+++ ')).map(line => line.slice(4)) ?? [];
}
