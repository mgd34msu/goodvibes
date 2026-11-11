/** Diagnostic only: no retries, asset downloads, installation or qualification.
 * GitHub's documented rate-limit evidence:
 * https://docs.github.com/en/rest/using-the-rest-api/troubleshooting-the-rest-api#rate-limit-errors
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const releaseMetadataUrl = 'https://api.github.com/repos/mgd34msu/goodvibes/releases/tags/v3.1.2';
const numericHeaders = ['x-ratelimit-limit', 'x-ratelimit-remaining', 'x-ratelimit-used', 'x-ratelimit-reset', 'retry-after'];
function numeric(value) {
  if (typeof value !== 'string' || !/^\d{1,16}$/.test(value)) return undefined;
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : undefined;
}

export function classifyGithubReleaseResponse(status, headers, body) {
  if (status >= 200 && status <= 299) return 'http-success';
  if ((status === 403 || status === 429) && headers['x-ratelimit-remaining'] === 0) return 'primary-rate-limit';
  let message;
  try { const value = JSON.parse(body); if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.message === 'string') message = value.message; }
  catch { return 'unclassified-http-error'; }
  if (status === 403 || status === 429) {
    if (message === 'API rate limit exceeded' || message?.startsWith('API rate limit exceeded for ')) return 'primary-rate-limit-message';
    if (message?.startsWith('You have exceeded a secondary rate limit.')) return 'secondary-rate-limit';
  }
  if (status === 401 && message === 'Bad credentials') return 'bad-credentials';
  if (status === 401 && message === 'Requires authentication') return 'authentication-required';
  if (status === 403 && (message === 'Resource not accessible by integration' || message === 'Resource not accessible by personal access token')) return 'resource-not-accessible';
  if (status === 404 && message === 'Not Found') return 'not-found';
  return 'unclassified-http-error';
}

async function request(mode, token, fetchImpl) {
  const signal = AbortSignal.timeout(60_000);
  const result = { mode, status: null, rateLimit: {}, kind: 'request-failed' };
  try {
    // The unauthenticated request exactly shares acceptance's default fetch
    // headers. A credential is supplied only to the explicit comparison.
    const response = await fetchImpl(releaseMetadataUrl, { signal, redirect: 'error',
      ...(token ? { headers: { authorization: `Bearer ${token}` } } : {}) });
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) result.status = response.status;
    for (const name of numericHeaders) {
      const value = numeric(response.headers.get(name));
      if (value !== undefined) result.rateLimit[name] = value;
    }
    const reader = response.body?.getReader();
    let body = '';
    try {
      // Successful metadata bytes are irrelevant to this HTTP diagnosis.
      if (response.status < 200 || response.status > 299) {
        const chunks = []; let size = 0;
        for (;;) {
          const next = await reader?.read(); if (!next || next.done) break;
          size += next.value.byteLength;
          if (size > 16_384) { result.body = 'exceeds-bound'; break; }
          chunks.push(next.value);
        }
        if (!result.body) body = Buffer.concat(chunks).toString('utf8');
      }
      result.kind = classifyGithubReleaseResponse(response.status, result.rateLimit, body);
    } finally { await reader?.cancel(); }
  } catch {
    result.kind = signal.aborted ? 'request-timeout' : result.status === null ? 'request-failed' : 'response-read-failed';
  }
  return result;
}

export async function diagnoseGithubReleaseHttp({ token, fetchImpl = fetch } = {}) {
  const results = [await request('unauthenticated', undefined, fetchImpl)];
  if (token) results.push(await request('authenticated-comparison', token, fetchImpl));
  return { schema: 1, diagnosticOnly: true, endpoint: 'public-release-v3.1.2', results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error();
    const result = await diagnoseGithubReleaseHttp({ token: process.env.GITHUB_TOKEN });
    const safe = JSON.stringify(result, null, 2) + '\n';
    writeFileSync(process.argv[2], safe, { mode: 0o600, flag: 'wx' });
    process.stdout.write(safe);
  } catch { process.stderr.write('GitHub metadata diagnostic could not complete.\n'); process.exitCode = 1; }
}
