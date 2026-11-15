import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A throwaway self-signed certificate for 127.0.0.1, written under `root`. Node
 * and Bun cannot mint certificates, so the `openssl` binary does it; a host
 * without it fails here with that cause rather than a bare spawn error.
 */
export function loopbackCertificate(root: string, name: string): { certPath: string; keyPath: string; cert: string; key: string } {
  const certPath = join(root, `${name}-cert.pem`);
  const keyPath = join(root, `${name}-key.pem`);
  const result = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath,
    '-days', '1', '-subj', '/CN=127.0.0.1', '-addext', 'subjectAltName=IP:127.0.0.1'], { stdio: 'ignore', timeout: 10_000 });
  if (result.error || result.status !== 0) {
    throw new Error(`These tests need the openssl command to create a loopback TLS certificate: ${result.error?.message ?? `openssl exited with status ${result.status}`}`);
  }
  return { certPath, keyPath, cert: readFileSync(certPath, 'utf8'), key: readFileSync(keyPath, 'utf8') };
}
