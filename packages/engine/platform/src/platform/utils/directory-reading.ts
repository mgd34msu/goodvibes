/** Exact directory identity, relative to the walk root. Contents are not read. */
export interface WalkDirectoryCandidate {
  readonly name: string;
  readonly relativePath: string;
}
