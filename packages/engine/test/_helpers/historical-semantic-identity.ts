/** Actual historical fixture recipe only; production adopts full saved rows. */
import { createHash } from 'node:crypto';
import { normalizeKnowledgeSpaceId } from '../../platform/src/platform/knowledge/spaces.js';
import { normalizeWhitespace, uniqueStrings } from '../../platform/src/platform/knowledge/semantic/utils.js';
function semanticHash(...parts: readonly unknown[]): string { const hash = createHash('sha256'); for (const part of parts) { hash.update(String(part ?? '')); hash.update('\0'); } return hash.digest('hex').slice(0, 16); }
export function historicalSemanticFactId(input: {
  readonly spaceId: string;
  readonly kind: string;
  readonly title: string;
  readonly value?: string | undefined;
  readonly summary?: string | undefined;
  readonly subjectIds?: readonly string[] | undefined;
  readonly fallbackScope?: string | undefined;
}): string {
  const subjectScope = uniqueStrings(input.subjectIds ?? []).sort().join('|');
  const scope = subjectScope || normalizeWhitespace(input.fallbackScope ?? '');
  return `sem-fact-${semanticHash(
    normalizeKnowledgeSpaceId(input.spaceId),
    input.kind,
    canonicalFactText(input.title),
    canonicalFactText(input.value ?? input.summary ?? ''),
    scope,
  )}`;
}

function canonicalFactText(value: string): string {
  return normalizeWhitespace(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/^(?:the|this|these|a|an)\s+/, '')
    .trim();
}
