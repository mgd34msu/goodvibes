export function parseMarkdownFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const result: Record<string, string> = {};
  for (const line of match[1]!.split('\n')) {
    const [key, ...rest] = line.split(':');
    if (key && rest.length > 0) {
      result[key.trim()] = rest.join(':').trim();
    }
  }
  return result;
}
export function stripMarkdownFrontmatter(content: string, trim = true): string {
  const body = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return trim ? body.trim() : body;
}
