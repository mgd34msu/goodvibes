/** A non-2xx from the host, carrying the status and the host's code so callers can classify it. */
export class ConnectedHostVerbError extends Error {
  readonly status: number;
  /** The code the host's error body named, when it named one. */
  readonly code: string | undefined;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'ConnectedHostVerbError';
    this.status = status;
    this.code = code;
  }
}
