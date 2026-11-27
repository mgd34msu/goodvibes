/**
 * schema-domain-secure-address.ts, which certificate the daemon's https
 * address uses (`secureAddress.*`), shown as the "Secure address" section of
 * Settings in every program.
 *
 * `controlPlane.lanHttps.enabled` stays the switch that turns the https
 * listener on or off (and `controlPlane.lanHttps.port` its port), as in 3.5.0;
 * `secureAddress.certificate` is the one setting that says which certificate
 * that listener serves (daemon/lan-https/certificate-source.ts reads it, and
 * nothing else decides it). A 3.5.0 daemon reading a home that has these keys
 * does not know the section and ignores it without a notice (an unknown
 * top-level section is not reported); with https on it serves its own local
 * authority's certificate on the same port, as 3.5.0 always did.
 */
import { LETS_ENCRYPT_DIRECTORY, SECURE_ADDRESS_CHOICES, SECURE_ADDRESS_INTRO, secureAddressChoiceParagraph } from '../daemon/lan-https/secure-address-words.js';
import type { ConfigSettingDefinition } from './schema-shared.js';

export type SecureAddressCertificate = 'local-authority' | 'own-files' | 'lets-encrypt';

/** `secureAddress.*`. */
export interface SecureAddressConfig {
  certificate: SecureAddressCertificate;
  domain: string;
  dnsProvider: 'cloudflare';
  acmeDirectory: string;
  certFile: string;
  keyFile: string;
}

export const secureAddressConfigDefaults: { secureAddress: SecureAddressConfig } = {
  secureAddress: {
    certificate: 'local-authority',
    domain: '',
    dnsProvider: 'cloudflare',
    acmeDirectory: LETS_ENCRYPT_DIRECTORY,
    certFile: '',
    keyFile: '',
  },
};

const choice = (id: string): string => {
  const words = SECURE_ADDRESS_CHOICES.find((entry) => entry.id === id);
  return words ? secureAddressChoiceParagraph(words) : '';
};

export const secureAddressConfigSettings: ConfigSettingDefinition[] = [
  {
    key: 'secureAddress.certificate',
    label: 'Certificate the https address uses',
    type: 'enum',
    enumValues: ['local-authority', 'own-files', 'lets-encrypt'],
    description: `${SECURE_ADDRESS_INTRO} The https address is switched on by controlPlane.lanHttps.enabled ("Serve the web UI over https on your network"); this setting says which certificate it serves. lets-encrypt: ${choice('lets-encrypt')} own-files: ${choice('own-files')} local-authority (the default, as in 3.5.0): ${choice('local-authority')} The fourth way, Tailscale, is not a certificate this daemon serves: ${choice('tailscale')} (Settings, Network, Tailscale). In a machine group, the machine that set this up provides it to every machine that joined; a machine that joined shows what it received and has nothing to set.`,
  },
  {
    key: 'secureAddress.domain',
    label: 'Your name for the https address (Let\'s Encrypt)',
    type: 'string',
    description: 'The name under a domain you own that phones open, for example gv.example.com (used when secureAddress.certificate is lets-encrypt). The certificate covers it and every name directly under it, so the machines of a group each get their own name (<machine>.gv.example.com). Let\'s Encrypt publishes it in public logs: pick a name that says nothing about you. The DNS provider\'s token is the Cloudflare API token (cloudflare.apiTokenRef), with Zone, DNS, Edit on the zone that holds the name.',
    validate: (value) => value === '' || (typeof value === 'string' && /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i.test(value)),
    validationHint: 'a DNS name with at least two labels, such as gv.example.com (no scheme, no port, no *)',
  },
  {
    key: 'secureAddress.dnsProvider',
    label: 'DNS provider the daemon writes records with',
    type: 'enum',
    enumValues: ['cloudflare'],
    description: 'The DNS service whose API the daemon uses for the Let\'s Encrypt proof record and the address record. Cloudflare is the one supported now.',
  },
  {
    key: 'secureAddress.acmeDirectory', valueKind: 'endpoint',
    label: 'Certificate authority address (ACME)',
    type: 'string',
    description: `Where the certificate is asked for: an ACME directory. Leave it as ${LETS_ENCRYPT_DIRECTORY} (Let's Encrypt). Another ACME authority that offers DNS proofs works the same way.`,
    validate: (value) => typeof value === 'string' && /^https?:\/\/\S+$/.test(value),
    validationHint: 'an http(s) address of an ACME directory',
  },
  {
    key: 'secureAddress.certFile', valueKind: 'path',
    label: 'Your certificate file',
    type: 'string',
    description: 'Path of the certificate (PEM, with its chain) served when secureAddress.certificate is own-files. Read on this computer, checked when given and again when the file changes; never sent anywhere.',
  },
  {
    key: 'secureAddress.keyFile', valueKind: 'path',
    label: 'Your certificate\'s key file',
    type: 'string',
    description: 'Path of the certificate\'s private key (PEM, not passphrase-protected) for own-files. The setting holds the path, never the key; the key is read on this computer and never logged or sent, except sealed to the machines of your group when this computer leads one.',
  },
];
