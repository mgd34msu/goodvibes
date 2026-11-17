/** Declared provenance shared by one runtime occurrence and all its notice/replay deliveries. */
export interface RuntimeEventProvenance {
  readonly type: string;
  /** Missing on legacy events. Never derive this from entity ids, text, trace ids or time. */
  readonly occurrenceId?: string | undefined;
  /**
   * For an event whose notice depends on one payload field (a check's result,
   * a commit's status, a gate's outcome), that field's value, kept with a
   * stored line so it is shown the same way after a restore.
   */
  readonly variant?: string | undefined;
}
