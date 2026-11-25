/**
 * own-certificate.ts, a certificate the person made (or got elsewhere) and
 * gave the daemon as two files: the certificate (with its chain) and its
 * private key. Checked when given and each time it is read: the key belongs
 * to the certificate, which names it covers, when it ends. The files are
 * read, never written; the key is never logged or returned.
 *
 * Read again when the files change: their size and modification time are
 * compared when the https listener starts (every daemon start and listener
 * bind) and, once the certificate in memory has ended (when browsers start
 * refusing it), at each daemon heartbeat. No file watcher.
 */
import { createHash, createPrivateKey, createPublicKey, X509Certificate } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

export interface OwnCertificateFiles {
  readonly certFile: string;
  readonly keyFile: string;
}

/** The facts of a pair that was read; `problem` set when it cannot be served. */
export interface OwnCertificateCheck {
  readonly ok: boolean;
  /** Plain words: why it cannot be served (absent when ok). */
  readonly problem?: string | undefined;
  /** DNS names and addresses the certificate covers. */
  readonly names: readonly string[];
  readonly notBefore?: number | undefined;
  readonly notAfter?: number | undefined;
  readonly fingerprint?: string | undefined;
  /** Size and modification time of both files, to tell when they changed. */
  readonly stamp: string;
}

/** A pair ready to serve: the check, and the PEM text the listener hands to TLS. */
export interface OwnCertificate extends OwnCertificateCheck {
  readonly certPem: string;
  readonly keyPem: string;
}

/** Size and modification time of both files ('' when either cannot be read). */
export function ownCertificateStamp(files: OwnCertificateFiles): string {
  try {
    const cert = statSync(files.certFile);
    const key = statSync(files.keyFile);
    return `${cert.size}:${cert.mtimeMs}/${key.size}:${key.mtimeMs}`;
  } catch { return ''; }
}

/** The names a certificate covers: its subject alternative names (DNS names and addresses). */
export function certificateNames(certificate: X509Certificate): string[] {
  const alt = certificate.subjectAltName ?? '';
  return alt.split(',').map((part) => part.trim()).flatMap((part) => {
    if (part.startsWith('DNS:')) return [part.slice(4).toLowerCase()];
    if (part.startsWith('IP Address:')) return [part.slice(11)];
    return [];
  });
}

/** Whether `name` is covered by `names` (a wildcard covers exactly one label). */
export function nameCovered(name: string, names: readonly string[]): boolean {
  const wanted = name.toLowerCase().replace(/\.$/, '');
  return names.some((candidate) => {
    if (candidate === wanted) return true;
    if (!candidate.startsWith('*.')) return false;
    const rest = candidate.slice(2);
    const dot = wanted.indexOf('.');
    return dot > 0 && wanted.slice(dot + 1) === rest;
  });
}

const DAY_MS = 86_400_000;

function when(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Read and check a certificate and key held as PEM text: the key must belong
 * to the first certificate, and it must be in force now. `stamp` is carried
 * through to the result.
 */
export function checkCertificatePair(certText: string, keyText: string, stamp: string, now = Date.now()): OwnCertificate {
  const blank = { ok: false, names: [] as string[], stamp, certPem: '', keyPem: '' };
  const blocks = certText.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  if (blocks.length === 0) return { ...blank, problem: 'The certificate file holds no certificate (a PEM block beginning "-----BEGIN CERTIFICATE-----").' };
  let leaf: X509Certificate;
  try { leaf = new X509Certificate(blocks[0]!); } catch { return { ...blank, problem: 'The certificate file could not be read as a certificate.' }; }
  let keyMatches = false;
  try {
    const key = createPrivateKey(keyText);
    const fromKey = createPublicKey(key).export({ type: 'spki', format: 'der' });
    const fromCert = leaf.publicKey.export({ type: 'spki', format: 'der' });
    keyMatches = Buffer.compare(fromKey, fromCert) === 0;
  } catch {
    return { ...blank, problem: 'The key file could not be read as a private key (a PEM block beginning "-----BEGIN PRIVATE KEY-----" or "-----BEGIN EC PRIVATE KEY-----"), or it is protected by a passphrase, which the daemon cannot type.' };
  }
  const names = certificateNames(leaf);
  const notBefore = Date.parse(leaf.validFrom);
  const notAfter = Date.parse(leaf.validTo);
  const fingerprint = createHash('sha256').update(leaf.raw).digest('hex');
  const facts = { names, notBefore, notAfter, fingerprint, stamp };
  if (!keyMatches) return { ...blank, ...facts, problem: 'The key does not belong to this certificate: they are not a pair. Give the key file that was made with this certificate.' };
  if (names.length === 0) return { ...blank, ...facts, problem: 'The certificate covers no name or address (it has no subject alternative names), so no browser accepts it for any address.' };
  if (notAfter <= now) return { ...blank, ...facts, problem: `The certificate ended on ${when(notAfter)}: browsers refuse it. Put a renewed certificate and its key in the same files (they are read again at the next start, or once the old one has ended) or give new files.` };
  if (notBefore > now + DAY_MS) return { ...blank, ...facts, problem: `The certificate is not valid until ${when(notBefore)}.` };
  return { ok: true, ...facts, certPem: blocks.join('\n') + '\n', keyPem: keyText };
}

/** Read the two files and check them. Never throws. */
export function readOwnCertificate(files: OwnCertificateFiles, now = Date.now()): OwnCertificate {
  const stamp = ownCertificateStamp(files);
  const blank = { ok: false, names: [] as string[], stamp, certPem: '', keyPem: '' };
  if (!files.certFile || !files.keyFile) return { ...blank, problem: 'Give both files: the certificate (with its chain) and its private key.' };
  let certText: string;
  let keyText: string;
  try { certText = readFileSync(files.certFile, 'utf8'); } catch (error) { return { ...blank, problem: `The certificate file ${files.certFile} could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'}).` }; }
  try { keyText = readFileSync(files.keyFile, 'utf8'); } catch (error) { return { ...blank, problem: `The key file ${files.keyFile} could not be read (${(error as NodeJS.ErrnoException).code ?? 'error'}).` }; }
  return checkCertificatePair(certText, keyText, stamp, now);
}

/** The check without the key text: what a status answer may carry. */
export function publicCheck(certificate: OwnCertificateCheck): OwnCertificateCheck {
  return {
    ok: certificate.ok,
    ...(certificate.problem ? { problem: certificate.problem } : {}),
    names: certificate.names,
    ...(certificate.notBefore !== undefined ? { notBefore: certificate.notBefore } : {}),
    ...(certificate.notAfter !== undefined ? { notAfter: certificate.notAfter } : {}),
    ...(certificate.fingerprint ? { fingerprint: certificate.fingerprint } : {}),
    stamp: certificate.stamp,
  };
}
