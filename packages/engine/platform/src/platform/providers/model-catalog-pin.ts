/**
 * The models.dev snapshot the model catalog is read from: one commit of the
 * repository and the SHA-256 of that commit's archive, shipped with the build.
 * Prices, limits and the canonical ids failover joins models by come from
 * this snapshot only; an archive whose bytes do not match is refused and the
 * cached catalog is kept.
 *
 * `bun packages/engine/scripts/model-catalog-pin.ts` writes both values from
 * the repository's current development head. While no pin is set the catalog
 * reads that moving head, unverified, and says so in its log.
 */
export interface ModelCatalogPin {
  /** Full 40-character commit id in anomalyco/models.dev. */
  readonly commit: string;
  /** Lowercase hex SHA-256 of `codeload.github.com/anomalyco/models.dev/tar.gz/<commit>`. */
  readonly sha256: string;
}

export const MODEL_CATALOG_PIN: ModelCatalogPin | null = null;
