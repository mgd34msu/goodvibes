/** Internal fail-closed marker; never a wire field or a public gate option. */
export class OwnedClusterDrainError extends Error {
  constructor() { super('An owned cluster consumer did not drain'); this.name = 'OwnedClusterDrainError'; }
}

/** Internal marker: a non-owned consumer's stop failed, so it may still be reading. */
export class ClusterConsumerStopError extends Error {
  constructor() { super('A cluster consumer did not stop cleanly'); this.name = 'ClusterConsumerStopError'; }
}
