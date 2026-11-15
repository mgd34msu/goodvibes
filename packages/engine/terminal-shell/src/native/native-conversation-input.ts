import { existsSync } from 'node:fs';
import type { ContentPart } from '@goodvibes-jev/engine/platform/platform/providers';
import { resolveAndValidatePath } from '@goodvibes-jev/engine/platform/platform/utils';
import type { NativeConversationIntakeUnsupportedSource } from '@goodvibes-jev/engine/platform/platform/workflow/work-ledger/native-intake-client';

/** Source text is captured before trim, expansion, model directives or shell context. */
export interface NativeConversationInput {
  readonly text: string;
  readonly unsupportedSources: readonly NativeConversationIntakeUnsupportedSource[];
}
export interface ProductInputContext {
  readonly source?: NativeConversationInput;
  readonly spokenOutput?: boolean;
}

const CONTEXT_TRAILING_PUNCTUATION = /[),.;:!?]+$/;

/**
 * Only an `@` token the prompt expander would actually expand is a context
 * source: an existing path under the project or a URL. Ordinary prose such as
 * `@alice`, `@Override` or `@model:x` is plain text and must not block intake.
 */
function isExpandableContextReference(raw: string, projectRoot: string): boolean {
  if (raw.startsWith('model:')) return false;
  const core = raw.replace(CONTEXT_TRAILING_PUNCTUATION, '');
  if (!core || core.startsWith('@')) return false;
  if (/^https?:\/\/\S+$/i.test(core)) return true;
  try {
    return existsSync(resolveAndValidatePath(core, projectRoot));
  } catch {
    return false;
  }
}

/** References are declared even when their expansion fails; they are never silent text authority. */
export function captureNativeConversationInput(
  text: string,
  content?: readonly ContentPart[],
  projectRoot: string = process.cwd(),
): NativeConversationInput {
  const sources: NativeConversationIntakeUnsupportedSource[] = [];
  const add = (kind: NativeConversationIntakeUnsupportedSource['kind'], label: string) => {
    sources.push({ kind, label: label.slice(0, 200) });
  };
  for (const match of text.matchAll(/\[(TEXT|IMAGE): [^\]]+\]/g)) add(match[1] === 'IMAGE' ? 'image' : 'context', match[0]);
  for (const match of text.matchAll(/(?:^|\s)(!@|@)(\S+)/g)) {
    if (match[1] === '!@') add('file', match[0].trim());
    else if (isExpandableContextReference(match[2] ?? '', projectRoot)) add('context', match[0].trim());
  }
  if (content?.some(part => part.type !== 'text')) add('image', 'attached-content');
  return Object.freeze({ text, unsupportedSources: Object.freeze(sources.map(source => Object.freeze(source))) });
}
