import { assertSynchronousJudgmentGuard } from '@goodvibes/judgment/decisions';
import { JudgmentInputError, snapshotJudgmentInput } from '../gate/judgment-input.js';
import type { CallOptions } from '@goodvibes/judgment';
import { judgmentPort } from '@goodvibes/engine/errors';
import { credentialHeader } from './batteries/credential-header.js';
import { decisionOrClassic } from '../runtime/decision-policy.js';
import { judge } from '../runtime/judge.js';

/**
 * Request headers HTTP defines as describing the request or its content. They
 * never carry a credential, so code answers for them under every policy and
 * no model is asked.
 */
const PUBLIC_REQUEST_HEADERS: ReadonlySet<string> = new Set(['accept', 'accept-language', 'accept-encoding', 'content-type', 'content-length',
  'user-agent', 'cache-control', 'if-none-match', 'if-modified-since', 'range']);

/** Whether HTTP defines this header as public request metadata. */
export function isPublicRequestHeader(header: string): boolean {
  return PUBLIC_REQUEST_HEADERS.has(header.toLowerCase());
}

/** Name-only credential classification. Null means no acting reading; failures propagate. */
export async function readCredentialHeader(
  header: string,
  options: CallOptions = {},
): Promise<boolean | null> {
  if (isPublicRequestHeader(header)) {
    options.signal?.throwIfAborted();
    return false;
  }
  return decisionOrClassic(() => readDecisionCredentialHeader(header, options), () => {
    options.signal?.throwIfAborted(); assertSynchronousJudgmentGuard(() => options.beforeAttempt?.());
    // Unknown names receive credential handling. A missing semantic answer must
    // never clear a custom header's contents for unprotected transmission.
    return true;
  });
}

async function readDecisionCredentialHeader(header: string, options: CallOptions): Promise<boolean | null> {
  const captured = snapshotJudgmentInput(header);
  if (typeof captured !== 'string') throw new JudgmentInputError('unsupported-input');
  const site = options.site ?? 'tools.credential-header';
  options.signal?.throwIfAborted();
  const run = await credentialHeader.run(judgmentPort(site), { header: captured }, { ...options, site });
  options.signal?.throwIfAborted();
  const { verdict, outcome } = run.readings.credential;
  const credential = outcome === 'act' && verdict !== 'uncertain' ? verdict === 'yes' : null;
  run.recordAction(credential === null ? 'credential classification withheld' : credential ? 'classified credential header' : 'classified noncredential header');
  return credential;
}

/**
 * Whether a header must be treated as a credential, decided at once. Public
 * request metadata is not; any other name is read from its name alone, the
 * answer kept for the process (it depends only on the lower-cased name), and
 * a reading that is unsure, late, unavailable or switched off counts the
 * header as a credential. Rejects only when `signal` is aborted.
 */
export async function headerIsCredential(header: string, options: { readonly site: string; readonly signal?: AbortSignal | undefined }): Promise<boolean> {
  const name = header.toLowerCase();
  if (PUBLIC_REQUEST_HEADERS.has(name)) return false;
  let captured: unknown;
  try { captured = snapshotJudgmentInput(header); } catch { return true; }
  if (typeof captured !== 'string') return true;
  const { value } = await judge({
    site: options.site,
    battery: credentialHeader,
    state: { header: captured },
    cache: { key: name, scope: 'process' },
    settle: ({ credential }) => credential.outcome === 'act' && credential.verdict !== 'uncertain' ? credential.verdict === 'yes' : undefined,
    fallback: () => true,
    describe: (credential) => credential ? 'classified credential header' : 'classified noncredential header',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  return value;
}
