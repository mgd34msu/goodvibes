export function cleanInline(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
export function sourceLabel(source: {
  readonly id?: string | undefined;
  readonly sourceType?: string | undefined;
  readonly title?: string | undefined;
  readonly canonicalUri?: string | undefined;
  readonly sourceUri?: string | undefined;
  readonly summary?: string | undefined;
  readonly status?: string | undefined;
}): string {
  const title =
    cleanInline(source.title) || cleanInline(source.canonicalUri) || cleanInline(source.sourceUri) || cleanInline(source.id) || 'untitled';
  const type = cleanInline(source.sourceType) || 'source';
  const status = cleanInline(source.status);
  const summary = cleanInline(source.summary);
  const suffix = status ? `/${status}` : '';
  return summary ? `[${type}${suffix}] ${title} - ${summary}` : `[${type}${suffix}] ${title}`;
}
export function createKnowledgeLabels(confidenceSeparator: string) {
  function nodeLabel(node: {
    readonly kind?: string | undefined;
    readonly title?: string | undefined;
    readonly summary?: string | undefined;
    readonly confidence?: number | undefined;
  }): string {
    const kind = cleanInline(node.kind) || 'node';
    const title = cleanInline(node.title) || 'untitled';
    const summary = cleanInline(node.summary);
    const confidence = typeof node.confidence === 'number' ? `${confidenceSeparator}${node.confidence}` : '';
    return summary ? `[${kind}] ${title}${confidence} - ${summary}` : `[${kind}] ${title}${confidence}`;
  }
  return { nodeLabel };
}
