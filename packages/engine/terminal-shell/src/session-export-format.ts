import { findSessionCandidates } from '@goodvibes-jev/engine/platform/platform/sessions';
/** Transcript formatting is shared independently of product redaction and source-lifetime policy. */
export function formatSessionExport<Message>(
  sessionId: string,
  title: string,
  messages: readonly Message[],
  format: string,
  view: {
    readonly role: (message: Message) => string;
    readonly content: (message: Message) => string;
    readonly tool: (message: Message) => string;
  },
): string {
  const lines: string[] = [];
  if (format === 'markdown') {
    lines.push(`# Session: ${title || sessionId}`, '');
  }
  for (const message of messages) {
    const role = view.role(message),
      content = view.content(message);
    if (!content.trim()) continue;
    if (format !== 'markdown') {
      lines.push(`[${role.toUpperCase()}]`, content, '');
      continue;
    }
    if (role === 'user' || role === 'assistant') lines.push(role === 'user' ? '## User' : '## Assistant', '', content, '');
    else if (role === 'tool')
      lines.push(
        `## Tool Result: ${view.tool(message)}`,
        '',
        '```',
        content.slice(0, 2000) + (content.length > 2000 ? '\n...(truncated)' : ''),
        '```',
        '',
      );
  }
  return lines.join('\n');
}
export function resolveSessionExportRequest<Session extends { readonly name: string; readonly title: string }>(
  args: readonly string[],
  currentId: string,
  list: () => readonly Session[],
  print: (text: string) => void,
) {
  const target = args[1];
  if (!target) {
    print('Usage: /session export <session-id> [markdown|text]\nUse /session export . to export the current session.');
    return undefined;
  }
  const format = (args[2] || 'markdown').toLowerCase();
  const sessionId = target === '.' ? currentId : target;
  // The current session is matched by its exact id only: a prefix or title
  // match could pick another session's transcript for `.`.
  const sessions = list();
  const candidates = target === '.' ? sessions.filter((session) => session.name === sessionId) : findSessionCandidates(sessions, sessionId);
  if (candidates.length > 1) {
    print(`Ambiguous session: ${sessionId}. Use an exact ID: ${candidates.map((session) => session.name).join(', ')}`);
    return undefined;
  }
  const found = candidates[0];
  return { target, format, sessionId, found };
}
