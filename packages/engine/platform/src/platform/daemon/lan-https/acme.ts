/**
 * acme.ts, the daemon's own ACME client (RFC 8555): the protocol Let's Encrypt
 * speaks, with no separate program. It proves control of a name by a DNS
 * record (dns-01), the only proof that works for an address on a home network
 * (Let's Encrypt cannot reach the machine) and the only one a wildcard name
 * accepts.
 *
 * One order: make or find the account (its key is this machine's, kept in the
 * secret store by the caller), ask for the names, write one proof record per
 * name through the DNS provider, tell the authority to check, wait for its
 * answer, send a certificate request for a new key, and download the chain.
 * The proof records are removed whatever happens.
 *
 * Waiting: the protocol has no push. After the proof is written, and after the
 * request is sent, the authority's status is asked again as its Retry-After
 * header says (2 s when it says nothing, at most 10 s), at most 60 times; the
 * waits end with the order, so nothing keeps running. What is sent where: to
 * the ACME directory, the account's public key, the names, the certificate
 * request (public key and names); to the DNS provider, the proof value (a
 * digest of the challenge and the account key's thumbprint).
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, X509Certificate, type KeyObject } from 'node:crypto';
import { createCertificateRequest } from './csr.js';
import type { DnsProofRecord, DnsProvider } from './dns-provider.js';

export { LETS_ENCRYPT_DIRECTORY } from './secure-address-words.js';

/** The ACME account this machine holds, as kept in the secret store (the key is the secret). */
export interface AcmeAccount {
  readonly version: 1;
  readonly directory: string;
  readonly keyPem: string;
  /** The account URL the authority gave (the JWS `kid`). */
  readonly url: string;
}

/** An issued certificate: the chain, and the key made for it (the secret). */
export interface AcmeCertificate {
  readonly certPem: string;
  readonly keyPem: string;
  readonly names: readonly string[];
  readonly notAfter: number;
}

/** The authority or the DNS service refused; `message` is the person's words. */
export class AcmeOrderError extends Error {
  constructor(message: string, readonly acmeType?: string | undefined) {
    super(message);
    this.name = 'AcmeOrderError';
  }
}

interface Directory {
  readonly newNonce: string;
  readonly newAccount: string;
  readonly newOrder: string;
  readonly meta?: { readonly termsOfService?: string } | undefined;
}

interface AcmeProblem { readonly type?: string; readonly detail?: string; readonly subproblems?: readonly AcmeProblem[] }

const b64u = (data: Buffer | string): string => Buffer.from(data).toString('base64url');

function publicJwk(key: KeyObject): { crv: string; kty: string; x: string; y: string } {
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { crv?: string; kty?: string; x?: string; y?: string };
  return { crv: jwk.crv ?? 'P-256', kty: jwk.kty ?? 'EC', x: jwk.x ?? '', y: jwk.y ?? '' };
}

/** RFC 7638 thumbprint of the account key, part of every proof value. */
export function accountThumbprint(keyPem: string): string {
  const jwk = publicJwk(createPrivateKey(keyPem));
  return b64u(createHash('sha256').update(JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })).digest());
}

/** The TXT value for a dns-01 challenge `token`. */
export function dnsProofValue(token: string, keyPem: string): string {
  return b64u(createHash('sha256').update(`${token}.${accountThumbprint(keyPem)}`).digest());
}

/** A new account key, PKCS #8 PEM (ECDSA P-256). */
export function newAccountKey(): string {
  return generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/** The proof record name for a name: a wildcard is proved at its base name. */
export function proofRecordName(name: string): string {
  return `_acme-challenge.${name.replace(/^\*\./, '')}`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function retryAfterMs(response: Response): number {
  const header = response.headers.get('retry-after');
  const seconds = header ? Number(header) : NaN;
  return Math.min(10_000, Math.max(1_000, Number.isFinite(seconds) ? seconds * 1000 : 2_000));
}

/** The authority's problem document, in the person's words. */
function problemWords(problem: AcmeProblem | undefined, names: readonly string[]): AcmeOrderError {
  const type = (problem?.type ?? '').replace('urn:ietf:params:acme:error:', '');
  const detail = [problem?.detail, ...(problem?.subproblems ?? []).map((entry) => entry.detail)].filter(Boolean).join('; ') || 'no reason given';
  const name = names[0] ?? 'the name';
  const words: Record<string, string> = {
    unauthorized: `The certificate authority checked the proof record for ${name} and did not accept it (${detail}). Nothing was issued.`,
    incorrectResponse: `The certificate authority found a different value in the proof record for ${name} than GoodVibes wrote (${detail}). Nothing was issued.`,
    dns: `The certificate authority could not look up ${name} in public DNS (${detail}). Check that the name's domain is served by the DNS provider you gave. Nothing was issued.`,
    rateLimited: `The certificate authority refused for now: too many certificates were asked for this name or account recently (${detail}). Nothing was issued; it is tried again later.`,
    rejectedIdentifier: `The certificate authority will not issue for ${name} (${detail}).`,
    caa: `A CAA record on the domain does not allow this certificate authority to issue for ${name} (${detail}).`,
    badNonce: `The certificate authority refused a request as replayed (${detail}).`,
  };
  return new AcmeOrderError(words[type] ?? `The certificate authority refused (${type || 'error'}): ${detail}. Nothing was issued.`, type || undefined);
}

export interface AcmeClientOptions {
  readonly directoryUrl: string;
  readonly fetch?: typeof fetch | undefined;
}

/** One conversation with an ACME directory. */
export class AcmeClient {
  private directory: Directory | null = null;
  private nonce: string | null = null;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: AcmeClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
  }

  private async dir(): Promise<Directory> {
    if (this.directory) return this.directory;
    let response: Response;
    try { response = await this.fetchImpl(this.options.directoryUrl); } catch (error) {
      throw new AcmeOrderError(`The certificate authority at ${this.options.directoryUrl} could not be reached (${error instanceof Error ? error.message : String(error)}). Nothing was issued.`);
    }
    if (!response.ok) throw new AcmeOrderError(`The certificate authority at ${this.options.directoryUrl} answered ${response.status}. Nothing was issued.`);
    this.directory = await response.json() as Directory;
    return this.directory;
  }

  /** The authority's terms, which choosing this route agrees to (the screen links them). */
  async termsOfService(): Promise<string | undefined> {
    return (await this.dir()).meta?.termsOfService;
  }

  private async freshNonce(): Promise<string> {
    if (this.nonce) { const nonce = this.nonce; this.nonce = null; return nonce; }
    const response = await this.fetchImpl((await this.dir()).newNonce, { method: 'HEAD' });
    const nonce = response.headers.get('replay-nonce');
    if (!nonce) throw new AcmeOrderError('The certificate authority gave no request number (Replay-Nonce). Nothing was issued.');
    return nonce;
  }

  /** A signed POST; `payload` null is POST-as-GET. One retry on a refused nonce. */
  private async post(url: string, payload: unknown, account: { readonly keyPem: string; readonly kid?: string | undefined }, retried = false): Promise<Response> {
    const key = createPrivateKey(account.keyPem);
    const header = { alg: 'ES256', nonce: await this.freshNonce(), url, ...(account.kid ? { kid: account.kid } : { jwk: publicJwk(key) }) };
    const protectedPart = b64u(JSON.stringify(header));
    const payloadPart = payload === null ? '' : b64u(JSON.stringify(payload));
    const signature = sign('sha256', Buffer.from(`${protectedPart}.${payloadPart}`), { key, dsaEncoding: 'ieee-p1363' });
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/jose+json' },
      body: JSON.stringify({ protected: protectedPart, payload: payloadPart, signature: b64u(signature) }),
    });
    const next = response.headers.get('replay-nonce');
    if (next) this.nonce = next;
    if (!response.ok) {
      const problem = await response.json().catch(() => ({})) as AcmeProblem;
      if (!retried && problem.type === 'urn:ietf:params:acme:error:badNonce') return this.post(url, payload, account, true);
      throw Object.assign(problemWords(problem, []), { problem });
    }
    return response;
  }

  /** The account for `keyPem`, made when the authority has none; agrees to its terms of service. */
  async account(keyPem: string): Promise<string> {
    const response = await this.post((await this.dir()).newAccount, { termsOfServiceAgreed: true }, { keyPem });
    const url = response.headers.get('location');
    if (!url) throw new AcmeOrderError('The certificate authority made the account but gave no address for it. Nothing was issued.');
    return url;
  }

  /**
   * Order a certificate for `names`, proving each through `dns`. Returns the
   * chain and the new key. Throws AcmeOrderError (or the provider's error)
   * with the person's words; every proof record written is removed first.
   */
  async order(account: { readonly keyPem: string; readonly url: string }, names: readonly string[], dns: DnsProvider): Promise<AcmeCertificate> {
    const kid = { keyPem: account.keyPem, kid: account.url };
    const wrap = async <T>(work: () => Promise<T>): Promise<T> => {
      try { return await work(); } catch (error) {
        const problem = (error as { problem?: AcmeProblem }).problem;
        if (problem) throw problemWords(problem, names);
        throw error;
      }
    };
    const directory = await this.dir();
    const created = await wrap(() => this.post(directory.newOrder, { identifiers: names.map((value) => ({ type: 'dns', value })) }, kid));
    const orderUrl = created.headers.get('location') ?? '';
    let order = await created.json() as { status: string; authorizations: string[]; finalize: string; certificate?: string; error?: AcmeProblem };
    const written: DnsProofRecord[] = [];
    try {
      // One proof per name that is not already proved; all are written before the authority is asked to check any.
      const pending: { readonly authz: string; readonly challenge: string }[] = [];
      for (const authzUrl of order.authorizations) {
        const authz = await wrap(async () => await (await this.post(authzUrl, null, kid)).json() as { status: string; identifier: { value: string }; wildcard?: boolean; challenges: { type: string; url: string; token: string }[] });
        if (authz.status === 'valid') continue;
        const challenge = authz.challenges.find((entry) => entry.type === 'dns-01');
        if (!challenge) throw new AcmeOrderError(`The certificate authority offered no DNS proof for ${authz.identifier.value}. Nothing was issued.`);
        written.push(await dns.addProofRecord(proofRecordName(authz.identifier.value), dnsProofValue(challenge.token, account.keyPem)));
        pending.push({ authz: authzUrl, challenge: challenge.url });
      }
      for (const entry of pending) await wrap(() => this.post(entry.challenge, {}, kid));
      for (const entry of pending) {
        for (let attempt = 0; ; attempt += 1) {
          const response = await wrap(() => this.post(entry.authz, null, kid));
          const authz = await response.json() as { status: string; identifier: { value: string }; challenges: { type: string; status: string; error?: AcmeProblem }[] };
          if (authz.status === 'valid') break;
          if (authz.status !== 'pending' && authz.status !== 'processing') {
            throw problemWords(authz.challenges.find((challenge) => challenge.type === 'dns-01')?.error, [authz.identifier.value]);
          }
          if (attempt >= 60) throw new AcmeOrderError(`The certificate authority did not finish checking the proof for ${authz.identifier.value}. Nothing was issued; it is tried again later.`);
          await wait(retryAfterMs(response));
        }
      }
    } finally {
      for (const record of written) { try { await dns.removeProofRecord(record); } catch { /* a proof record left behind holds no secret; the next order writes its own */ } }
    }
    const request = createCertificateRequest(names);
    let finalized = await wrap(() => this.post(order.finalize, { csr: b64u(request.der) }, kid));
    order = await finalized.json() as typeof order;
    for (let attempt = 0; order.status !== 'valid'; attempt += 1) {
      if (order.status === 'invalid') throw problemWords(order.error, names);
      if (attempt >= 60 || !orderUrl) throw new AcmeOrderError('The certificate authority did not finish issuing the certificate. Nothing was issued; it is tried again later.');
      await wait(retryAfterMs(finalized));
      finalized = await wrap(() => this.post(orderUrl, null, kid));
      order = await finalized.json() as typeof order;
    }
    if (!order.certificate) throw new AcmeOrderError('The certificate authority finished the order but gave no certificate. Nothing was issued.');
    const download = await wrap(() => this.post(order.certificate!, null, kid));
    const certPem = await download.text();
    const leaf = certPem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/)?.[0];
    if (!leaf) throw new AcmeOrderError('The certificate authority sent something that is not a certificate. Nothing was issued.');
    return { certPem, keyPem: request.keyPem, names: [...names], notAfter: Date.parse(new X509Certificate(leaf).validTo) };
  }
}
