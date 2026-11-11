export const releaseMetadataUrl: string;
export type GithubHttpKind = 'http-success' | 'primary-rate-limit' | 'primary-rate-limit-message' | 'secondary-rate-limit'
  | 'bad-credentials' | 'authentication-required' | 'resource-not-accessible' | 'not-found' | 'unclassified-http-error'
  | 'request-timeout' | 'request-failed' | 'response-read-failed';
export interface GithubHttpObservation {
  mode: 'unauthenticated' | 'authenticated-comparison';
  status: number | null;
  rateLimit: Record<string, number>;
  kind: GithubHttpKind;
  body?: 'exceeds-bound';
}
export function classifyGithubReleaseResponse(status: number, headers: Record<string, number>, body: string): GithubHttpKind;
export function diagnoseGithubReleaseHttp(input?: { token?: string; fetchImpl?: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch> }): Promise<{
  schema: 1; diagnosticOnly: true; endpoint: 'public-release-v3.1.2'; results: GithubHttpObservation[];
}>;
