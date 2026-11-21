/**
 * The one rule both target resolvers (the built-in surfaces' and the plugin
 * registry's) use to turn a name into a directory entry.
 */
import type { ChannelConversationKind, ChannelDirectoryEntry } from './types.js';

/** Whether `input` names the entry exactly (its id, handle, label, group, thread or an alias; a leading @ or # is ignored). */
export function directoryEntryNamedBy(entry: ChannelDirectoryEntry, input: string): boolean {
  const wanted = input.trim().replace(/^[@#]/, '').toLowerCase();
  const names = [entry.id, entry.handle, entry.label, entry.groupId, entry.threadId, ...(entry.aliases ?? [])];
  return names.some((name) => typeof name === 'string' && name.replace(/^[@#]/, '').toLowerCase() === wanted);
}

/** The conversation kind a directory entry is reached as. */
export function conversationKindOfDirectoryEntry(entry: ChannelDirectoryEntry): ChannelConversationKind {
  if (entry.kind === 'self' || entry.kind === 'user' || entry.kind === 'member') return 'direct';
  if (entry.kind === 'thread') return 'thread';
  if (entry.kind === 'channel') return 'channel';
  if (entry.kind === 'group') return 'group';
  return 'service';
}

/** One candidate of an ambiguous name, as a resolve result's `metadata.ambiguous` lists it. */
export interface AmbiguousDirectoryCandidate {
  readonly id: string;
  readonly kind: ChannelConversationKind;
  readonly label: string;
}

/**
 * The conversation a name resolves to, or every candidate when it names more
 * than one, or null when it names none.
 *
 * Only an exact match resolves. A name that merely contains the input is a
 * candidate for a directory listing, not the conversation the caller meant:
 * sending to it, or allow-listing it, would reach somebody else. For the same
 * reason a name shared by two conversations (a person and a channel both called
 * `ops`) resolves to neither: the caller is shown both and passes `#ops`,
 * `@ops` or a typed id.
 */
export function pickDirectoryEntry(
  entries: readonly ChannelDirectoryEntry[],
  input: string,
): { readonly entry: ChannelDirectoryEntry } | { readonly ambiguous: readonly AmbiguousDirectoryCandidate[] } | null {
  const matches = entries.filter((entry) => directoryEntryNamedBy(entry, input));
  const first = matches[0];
  if (first === undefined) return null;
  const candidates = new Map<string, AmbiguousDirectoryCandidate>();
  for (const entry of matches) {
    const kind = conversationKindOfDirectoryEntry(entry);
    candidates.set(`${kind}\u0000${entry.id}`, { id: entry.id, kind, label: entry.label });
  }
  return candidates.size === 1 ? { entry: first } : { ambiguous: [...candidates.values()] };
}
