import { slugify } from './shared.js';

/**
 * The one slug of a topic node: a tag or heading in a space. Every producer
 * (memory mirror, source tags, document headings) uses it, so the same tag on a
 * memory and on a document joins them through one topic.
 */
export function knowledgeTopicSlug(spaceId: string, label: string): string {
  return slugify(`${spaceId}-${label}`);
}
