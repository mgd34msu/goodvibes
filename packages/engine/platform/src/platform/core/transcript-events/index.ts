import { transcriptEventsOf, type TranscriptReadingOptions } from './classify.js';
import { groupTranscriptEvents } from './grouping.js';
import type { ConversationMessageSnapshot } from '../conversation.js';

export { classifyTranscriptMessages, transcriptEventsOf, TranscriptReadingLifetime, TranscriptReadingUnsettledError, TranscriptSourceChangedError, type TranscriptReadingOptions } from './classify.js';
export { groupTranscriptEvents } from './grouping.js';
export type { TranscriptEvent, TranscriptEventKind } from './types.js';
export type { TranscriptEventGroup } from './grouping.js';

export async function buildTranscriptEventIndex(messages: readonly ConversationMessageSnapshot[], options: TranscriptReadingOptions = {}) {
  options.signal?.throwIfAborted();
  const events = transcriptEventsOf(messages);
  options.assertCurrent?.();
  return { events, groups: groupTranscriptEvents(events) };
}
