/**
 * page.ts, what the daemon serves a phone so it can trust the LAN https listener: a page at /lan-https that says what
 * installing the certificate means and how to do it (and undo it) on iPhone and Android, and the certificate itself at
 * /lan-https/goodvibes-ca.crt.
 *
 * Neither the certificate nor its fingerprint is ever served over plain http, where anyone on the network path could
 * swap both. The owner's own screen (`goodvibes-daemon pair`, `webui https`, the Secure address screen) shows the link
 * to the page on the https address with the certificate's fingerprint in it (`#fp=`, never sent over the network); the
 * page there reads the certificate over that connection, checks it against that fingerprint in the phone's browser, and
 * offers it only when they match; a certificate that does not match is refused with words. The plain page says only
 * where to find that link. Then, on the phone, the certificate's own fingerprint is compared with the one on the owner's screen
 * once more when it is installed.
 */
import { X509Certificate } from 'node:crypto';
/** Which certificate the https listener serves: only GoodVibes' own is installed on a phone from this page. */
export { httpsCertificateSource, type HttpsCertificateSource } from './served-https.js';
/** The check of a certificate you made, for `goodvibes-daemon webui enable --https --certificate own-files`. */
export { readOwnCertificate } from './own-certificate.js';

export const LAN_HTTPS_PAGE_PATH = '/lan-https';
export const LAN_HTTPS_CA_PATH = '/lan-https/goodvibes-ca.crt';

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** The page's words, also what `goodvibes-daemon webui https` prints for each phone. */
export const LAN_HTTPS_INSTALL_WORDS = {
  what: 'Installing this certificate lets this phone open GoodVibes over https on your network, which the microphone, push notifications and installing the app need. It was made on one of your computers and can only vouch for names and private network addresses on your own network (that computer\'s, and those of the machines in its group): it cannot be used to pose as any website on the internet. Install it only on your own devices.',
  iphone: [
    'Open this page in Safari and tap Download the certificate; allow the download.',
    'Open Settings, General, VPN & Device Management, tap the GoodVibes profile and tap Install.',
    'Open Settings, General, About, Certificate Trust Settings and switch on full trust for the GoodVibes certificate.',
    'To remove it later: Settings, General, VPN & Device Management, the GoodVibes profile, Remove Profile.',
  ],
  android: [
    'Tap Download the certificate.',
    'Open Settings, Security (or Security & privacy), More security settings, Encryption & credentials, Install a certificate, CA certificate, and choose the downloaded goodvibes-ca.crt.',
    'To remove it later: the same Encryption & credentials screen, Trusted credentials, User, the GoodVibes certificate, Remove.',
  ],
} as const;

/** The SHA-256 fingerprint of the authority's certificate, to compare with what the phone shows. */
export function lanAuthorityFingerprint(certPem: string): string {
  return new X509Certificate(certPem).fingerprint256;
}

/**
 * The link the owner's own screen shows a phone: the page on the https address, with the certificate's fingerprint in
 * its fragment (`#fp=`: the browser never sends it), which the page checks the certificate against before offering it.
 */
export function lanHttpsInstallLink(httpsAddress: string, fingerprint: string): string {
  return `${httpsAddress.replace(/\/+$/, '')}${LAN_HTTPS_PAGE_PATH}#fp=${encodeURIComponent(fingerprint)}`;
}

/** What the plain page says, and what the certificate's address answers over plain http: where the real link is. */
export const LAN_HTTPS_PLAIN_WORDS = 'This page gives no certificate over plain http, where anyone on the network path could swap it. '
  + 'On the computer running GoodVibes, open the link it shows for phones (goodvibes-daemon pair, goodvibes-daemon webui https, '
  + 'or System, Secure address in the web UI there): it opens this page on the https address with the certificate\'s fingerprint, '
  + 'and this phone checks the certificate against it before offering it.';

const html = (body: string): string => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Trust GoodVibes on this phone</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:2rem auto;padding:0 1rem}code{word-break:break-all}a{font-weight:600}.refused{color:#a40000;font-weight:600}</style></head>
<body><h1>Trust GoodVibes on this phone</h1>${body}</body></html>`;

/**
 * In the phone's browser, on the https page: the certificate read over this connection, its SHA-256 compared with the
 * fingerprint from the owner's screen (`#fp=`); offered only when they match. Written inline, as a page with no other
 * request than the certificate itself.
 */
const CHECK_SCRIPT = `(async () => {
  const say = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
  const pin = decodeURIComponent((location.hash.match(/(?:^#|&)fp=([^&]+)/) || [])[1] || '').toUpperCase().replace(/[^0-9A-F]/g, '');
  if (!pin) { say('check', 'No fingerprint came with this link, so the certificate is not offered. Open the link the computer running GoodVibes shows for phones.'); return; }
  try {
    const der = await (await fetch(${JSON.stringify(LAN_HTTPS_CA_PATH)}, { cache: 'no-store' })).arrayBuffer();
    const hex = [...new Uint8Array(await crypto.subtle.digest('SHA-256', der))].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    if (hex !== pin) { document.getElementById('check').className = 'refused'; say('check', 'This certificate does not match the fingerprint your GoodVibes screen showed, so it is not offered: do not install a certificate from this network. Something between this phone and your computer gave another one.'); return; }
    const link = document.getElementById('download');
    link.href = URL.createObjectURL(new Blob([der], { type: 'application/x-x509-ca-cert' }));
    link.hidden = false;
    say('check', 'The certificate matches the fingerprint your GoodVibes screen showed.');
  } catch (error) { say('check', 'The certificate could not be read and checked, so it is not offered: ' + error); }
})();`;

/**
 * The page or the certificate for a request to their paths; null for any other request. `certificate` reads the
 * authority's public certificate (null when none was made yet); `httpsAddress` is where the phone opens GoodVibes once
 * it trusts it. Over plain http neither the certificate nor its fingerprint is given (see the file's comment).
 */
export async function lanHttpsPageResponse(req: Request, certificate: () => Promise<string | null>, httpsAddress: () => string | undefined): Promise<Response | null> {
  if (req.method !== 'GET' && req.method !== 'HEAD') return null;
  const url = new URL(req.url);
  const path = url.pathname;
  if (path !== LAN_HTTPS_PAGE_PATH && path !== LAN_HTTPS_CA_PATH) return null;
  const overTls = url.protocol === 'https:';
  const pem = await certificate();
  const address = httpsAddress();
  if (path === LAN_HTTPS_CA_PATH) {
    if (!overTls) return new Response(LAN_HTTPS_PLAIN_WORDS, { status: 403, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } });
    if (!pem) return new Response('No GoodVibes certificate has been made: https on your network is off.', { status: 404, headers: { 'content-type': 'text/plain; charset=utf-8' } });
    const der = Buffer.from(pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''), 'base64');
    return new Response(der, { headers: { 'content-type': 'application/x-x509-ca-cert', 'content-disposition': 'attachment; filename="goodvibes-ca.crt"', 'cache-control': 'no-store' } });
  }
  const steps = (items: readonly string[]): string => `<ol>${items.map((item) => `<li>${escape(item)}</li>`).join('')}</ol>`;
  const body = !pem
    // Served with a certificate phones already trust (Let's Encrypt, or one you made): there is nothing to install.
    ? address
      ? `<p>There is nothing to install from here: the https address uses a certificate from Let's Encrypt or one its owner made, not GoodVibes' own. Open <a href="${escape(address)}">${escape(address)}</a>.</p>`
      : '<p>https on your network is off, so there is no certificate to install. On the computer running GoodVibes: <code>goodvibes-daemon webui enable --lan --https</code></p>'
    : !overTls
      ? `<p>${escape(LAN_HTTPS_INSTALL_WORDS.what)}</p><p>${escape(LAN_HTTPS_PLAIN_WORDS)}</p>`
      : `<p>${escape(LAN_HTTPS_INSTALL_WORDS.what)}</p>
<p id="check">Checking the certificate against the fingerprint your GoodVibes screen showed...</p>
<p><a id="download" hidden download="goodvibes-ca.crt">Download the certificate</a></p>
<p>When your phone shows the certificate's SHA-256 fingerprint, it must be the one on your GoodVibes screen.</p>
<h2>iPhone and iPad</h2>${steps(LAN_HTTPS_INSTALL_WORDS.iphone)}
<h2>Android</h2>${steps(LAN_HTTPS_INSTALL_WORDS.android)}
${address ? `<p>Then open <a href="${escape(address)}">${escape(address)}</a>.</p>` : ''}
<script>${CHECK_SCRIPT}</script>`;
  return new Response(req.method === 'HEAD' ? null : html(body), { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
