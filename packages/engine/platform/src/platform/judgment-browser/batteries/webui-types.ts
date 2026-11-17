/** Status tone vocabularies; the tone is always read from the status catalog, never by a model. */
export const BADGE_TONES = ['ok', 'warning', 'bad', 'neutral'] as const;
export const LIBRARY_DOT_TONES = ['ok', 'warn', 'bad', 'info', 'idle'] as const;
export type StatusValue =
  | { readonly vocabulary: 'badge'; readonly tone: typeof BADGE_TONES[number] }
  | { readonly vocabulary: 'library-dot'; readonly tone: typeof LIBRARY_DOT_TONES[number] };
