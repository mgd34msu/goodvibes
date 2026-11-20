/**
 * The space a vector was embedded in.
 *
 * Two vectors are comparable only when the same provider and model made them
 * with the same number of dimensions; two providers of equal dimension still
 * make vectors that cannot be compared. A stored vector records its space,
 * every search filters on the current space in the same statement, and an
 * index counts as current only when no row of another space is left in it.
 */

export interface EmbeddingSpace {
  /** `<provider>:<model>:<dimensions>`: what a row stores and a search filters on. */
  readonly id: string;
  readonly providerId: string;
  readonly model: string;
  readonly dimensions: number;
}

/** The space of an embedding provider; `model` is the provider's own model name (its id when it has one model). */
export function embeddingSpaceOf(provider: { readonly id: string; readonly model: string; readonly dimensions: number }): EmbeddingSpace {
  return Object.freeze({
    id: `${provider.id}:${provider.model}:${provider.dimensions}`,
    providerId: provider.id,
    model: provider.model,
    dimensions: provider.dimensions,
  });
}

/** True when a row stamped `rowSpace` can be compared with vectors of `current`. */
export function sameEmbeddingSpace(rowSpace: string | null | undefined, current: EmbeddingSpace): boolean {
  return rowSpace === current.id;
}
