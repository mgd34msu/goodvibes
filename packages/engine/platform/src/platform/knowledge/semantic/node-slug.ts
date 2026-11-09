import type { KnowledgeStore } from '../store.js';
import type { KnowledgeNodeUpsertInput } from '../types.js';

/** Generated IDs are source/subject scoped; their human-readable slugs must not replace another identity. */
export function createSemanticNodeSlugPlanner(store: KnowledgeStore) {
  const reserved = new Map<string, string>();
  return <T extends KnowledgeNodeUpsertInput>(input: T): T => {
    if (!input.id) return input;
    const existing = store.getNode(input.id);
    // The actual stored URL is already the identity's durable choice, including
    // older hash-suffixed URLs. Rebuilding a digest cannot improve that fact.
    let slug = existing?.kind === input.kind ? existing.slug : input.slug;
    for (let suffix = 2; ; suffix += 1) {
      const occupant = reserved.get(`${input.kind}:${slug}`) ?? store.getNodeByKindAndSlug(input.kind, slug)?.id;
      if (!occupant || occupant === input.id) break;
      // This is display disambiguation, not a content commitment. Reserve the
      // first free readable suffix in this plan; the store enforces uniqueness.
      slug = `${input.slug}-${suffix}`;
    }
    reserved.set(`${input.kind}:${slug}`, input.id);
    return slug === input.slug ? input : { ...input, slug };
  };
}
