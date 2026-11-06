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
export function resolveSessionExportRequest<Session extends { readonly name: string }>(
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
  const found = list().find((session) => session.name === sessionId || session.name.startsWith(sessionId));
  return { target, format, sessionId, found };
}
