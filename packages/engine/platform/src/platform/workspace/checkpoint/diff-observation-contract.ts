/** Read preconditions only. Stored older intake keeps its original digest-shaped label. */
export const CHECKPOINT_DIFF_REVISION_PATTERN = '^(?:[a-f0-9]{64}|checkpoint-diff:[a-p]{8}-[a-p]{4}-[a-p]{4}-[a-p]{4}-[a-p]{12}:[0-9a-z]+)$';
export const CHECKPOINT_DIFF_SOURCE_MAX_BYTES = 4_194_304;
