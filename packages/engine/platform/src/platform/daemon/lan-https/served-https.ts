/**
 * served-https.ts, what this process's https listener serves right now: its
 * port, the name phones open (when the certificate is for a name) and the
 * names it covers. Written by the listener after each sync (listener.ts) and
 * read by the pairing origin (pairing/web-origin.ts) and the browser-origin
 * rule (daemon/http/browser-origin.ts), so a pairing code and the origin check
 * follow the certificate actually served. Null in a process with no https
 * listener (a CLI command): those read the settings instead.
 */
/** The three certificates the https listener can serve (`secureAddress.certificate`). */
export type HttpsCertificateSource = 'local-authority' | 'own-files' | 'lets-encrypt';

/** Which certificate the settings ask for: the one reading of `secureAddress.certificate`. */
export function httpsCertificateSource(config: { get(key: string): unknown }): HttpsCertificateSource {
  const value = config.get('secureAddress.certificate');
  return value === 'own-files' || value === 'lets-encrypt' ? value : 'local-authority';
}

export interface ServedHttps {
  readonly port: number;
  readonly hostName?: string | undefined;
  readonly names: readonly string[];
  readonly source: HttpsCertificateSource;
}

let served: ServedHttps | null = null;

export function noteServedHttps(value: ServedHttps | null): void { served = value; }

export function servedHttps(): ServedHttps | null { return served; }
