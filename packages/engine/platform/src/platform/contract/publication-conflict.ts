const NAMED_PATHS = 5;

function conflictMessage(paths: readonly string[]): string {
  if (paths.length === 0) return 'the accepted result does not fit your current files';
  const named = paths.slice(0, NAMED_PATHS).join(', ');
  const rest = paths.length - NAMED_PATHS;
  return `the accepted result and your current files both changed ${named}${rest > 0 ? ` and ${rest} more` : ''}`;
}

/** The accepted result cannot be applied because the owner changed the same files. */
export class ContractPublicationConflictError extends Error {
  override readonly name = 'ContractPublicationConflictError';
  constructor(readonly paths: readonly string[], options?: ErrorOptions) {
    super(conflictMessage(paths), options);
  }
}
