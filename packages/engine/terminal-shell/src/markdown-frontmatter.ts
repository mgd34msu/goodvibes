// Both readers accept LF and CRLF line endings; the stripped body keeps its own.
export function parseMarkdownFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1]!.split(/\r?\n/)) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length > 0) {
      result[key.trim()] = rest.join(':').trim();
    }
  }
  return result;
}
/** A discovered record's name: the frontmatter `name`, trimmed, or the file name without `.md` when that is empty. */
export function markdownRecordName(frontmatter: Readonly<Record<string, string>>, path: string): string {
  return frontmatter.name?.trim() || (path.split(/[\\/]/).pop() ?? '').replace(/\.md$/i, '');
}
export function stripMarkdownFrontmatter(content: string, trim = true): string {
  const body = content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n)?/, '');
  return trim ? body.trim() : body;
}
