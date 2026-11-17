/**
 * The models.dev snapshot the model catalog is read from: one commit of the
 * repository and the SHA-256 of that commit's archive, shipped with the build.
 * Prices, limits and the canonical ids failover joins models by come from
 * this snapshot only; an archive whose bytes do not match is refused and the
 * cached catalog is kept.
 *
 * `bun packages/engine/scripts/model-catalog-pin.ts` writes both values from
 * the repository's current development head; it is run when a release is cut,
 * and the pin moves only then. Between releases a build keeps its snapshot: the
 * archive at a commit never changes, so once it is cached no catalog request is
 * made at all, and models released upstream since show as unpriced until the
 * next release moves the pin (their live provider listings still show them).
 * While no pin is set the catalog reads the moving head, unverified, checked
 * daily with a conditional request, and says so in its log.
 */
export interface ModelCatalogPin {
  /** Full 40-character commit id in anomalyco/models.dev. */
  readonly commit: string;
  /** Lowercase hex SHA-256 of `codeload.github.com/anomalyco/models.dev/tar.gz/<commit>`. */
  readonly sha256: string;
}

export const MODEL_CATALOG_PIN: ModelCatalogPin | null = {
  commit: 'e55f4b9fb271ca84031920de389eae88dbf7fd86',
  sha256: 'd50488d4e0c801bbf4f81afdffb89c4bb8fadefd322cde78d34bbbfa64cc699d',
};
