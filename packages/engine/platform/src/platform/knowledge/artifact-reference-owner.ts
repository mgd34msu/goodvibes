/** Host-local closed reference owner. SQL and database images never escape. */
export interface KnowledgeArtifactReferenceOwner {
  readonly path: string;
  subscribeClean?(listener: () => void): () => void;
  withReads<T>(ids: readonly string[], operation: (referenced: readonly string[], assertCurrent: () => void) => Promise<T>): Promise<{ readonly kind: 'local-changes' } | { readonly kind: 'completed'; readonly value: T }>;
}
