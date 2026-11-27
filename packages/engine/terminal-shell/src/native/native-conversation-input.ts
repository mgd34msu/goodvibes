import { existsSync } from 'node:fs';
import type { ContentPart } from '@goodvibes/engine/platform/platform/providers';
import { resolveAndValidatePath } from '@goodvibes/engine/platform/platform/utils';
import { isImageFile } from '../input-content.js';
import type { NativeConversationIntakeUnsupportedSource } from '@goodvibes/engine/platform/platform/workflow/work-ledger/native-intake-client';

/** Source text is captured before trim, expansion, model directives or shell context. */
export interface NativeConversationInput {
  readonly text: string;
  readonly unsupportedSources: readonly NativeConversationIntakeUnsupportedSource[];
  /**
   * Files sent with the message (an image the person attached), uploaded first to the daemon's artifact store
   * (`artifacts.create`): the host's turn gives them to the model as a chat message's are.
   */
  readonly attachments?: readonly { readonly artifactId: string; readonly label?: string | undefined }[] | undefined;
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

/** A typed reference to an image file is an image source, as a pasted image is: the composer sends it as an image. */
function isImageReference(raw: string, projectRoot: string): boolean {
  const core = raw.replace(CONTEXT_TRAILING_PUNCTUATION, '');
  if (!core || core.startsWith('model:')) return false;
  try {
    return isImageFile(resolveAndValidatePath(core, projectRoot));
  } catch {
    return false;
  }
}

/**
 * What the user sent, as the native intake receives it. A collapsed paste is
 * display only: each `[TEXT: pN, ...]` marker whose paste is in `pastes` is
 * replaced by the pasted text, so a long paste is complete typed text. Images,
 * `!@file` and expandable `@path`/URL references in the typed text (never
 * inside a paste) are declared as sources the intake cannot carry.
 */
export function captureNativeConversationInput(
  text: string,
  content?: readonly ContentPart[],
  projectRoot: string = process.cwd(),
  pastes?: ReadonlyMap<string, string>,
): NativeConversationInput {
  const sources: NativeConversationIntakeUnsupportedSource[] = [];
  const add = (kind: NativeConversationIntakeUnsupportedSource['kind'], label: string) => {
    sources.push({ kind, label: label.slice(0, 200) });
  };
  const pasteId = (marker: string): string | undefined => /^\[TEXT: (p\d+), \d+ lines\]$/.exec(marker)?.[1];
  for (const match of text.matchAll(/\[(TEXT|IMAGE): [^\]]+\]/g)) {
    if (match[1] === 'TEXT' && pastes?.has(pasteId(match[0]) ?? '')) continue;
    add(match[1] === 'IMAGE' ? 'image' : 'context', match[0]);
  }
  for (const match of text.matchAll(/(?:^|\s)(!@|@)(\S+)/g)) {
    if (isImageReference(match[2] ?? '', projectRoot)) add('image', match[0].trim());
    else if (match[1] === '!@') add('file', match[0].trim());
    else if (isExpandableContextReference(match[2] ?? '', projectRoot)) add('context', match[0].trim());
  }
  if (content?.some(part => part.type !== 'text')) add('image', 'attached-content');
  const sent = pastes && pastes.size > 0
    ? text.replace(/\[TEXT: (p\d+), \d+ lines\]/g, (marker, id: string) => pastes.get(id) ?? marker)
    : text;
  return Object.freeze({ text: sent, unsupportedSources: Object.freeze(sources.map(source => Object.freeze(source))) });
}
