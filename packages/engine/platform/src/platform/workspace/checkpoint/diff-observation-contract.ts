/** Read preconditions only. Stored older intake keeps its original digest-shaped label;
 * the owner part is a plain UUID, or the earlier a-to-p spelling of one. */
export const CHECKPOINT_DIFF_REVISION_PATTERN = '^(?:[a-f0-9]{64}|checkpoint-diff:[0-9a-p]{8}-[0-9a-p]{4}-[0-9a-p]{4}-[0-9a-p]{4}-[0-9a-p]{12}:[0-9a-z]+)$';
export const CHECKPOINT_DIFF_SOURCE_MAX_BYTES = 4_194_304;
