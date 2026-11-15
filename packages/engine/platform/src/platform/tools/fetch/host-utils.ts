/**
 * The one host normaliser and host-pattern matcher. The fetch tool's trust
 * tiers and the permission layer's network-scope rules both match through
 * here, so a host is compared in one form everywhere.
 */
import { globBodyToRegexSource } from '../../utils/glob-to-regex.js';

/**
 * The form every host list and rule is compared in: trimmed, lower-case, one
 * trailing dot removed (`a.example.com.` names the same server as
 * `a.example.com`), and a non-ASCII name in the ASCII (punycode) form the URL
 * parser sends. A bracketed IPv6 literal keeps its brackets, as `URL.hostname`
 * returns it.
 */
export function normalizeHost(host: string): string {
  let out = host.trim().toLowerCase();
  if (out.endsWith('.') && !out.endsWith('..')) out = out.slice(0, -1);
  let ascii = true;
  for (let i = 0; i < out.length && ascii; i++) ascii = out.charCodeAt(i) < 0x80;
  if (!ascii) {
    try {
      const encoded = new URL(`http://${out}/`).hostname;
      if (encoded !== '') out = encoded;
    } catch { /* not a valid name: compared as written */ }
  }
  return out;
}

const globRegexCache = new Map<string, RegExp>();

function globRegex(pattern: string): RegExp {
  let re = globRegexCache.get(pattern);
  if (!re) {
    re = new RegExp(`^${globBodyToRegexSource(pattern, '[^.]*', '.*')}$`);
    if (globRegexCache.size > 100) globRegexCache.clear();
    globRegexCache.set(pattern, re);
  }
  return re;
}

/**
 * Whether `host` matches a host pattern. Inside a pattern `*` matches one label
 * (no dot) and `**` matches across dots; a pattern that is only `*` or `**`
 * matches every host. Host and pattern are both normalised first.
 */
export function hostMatchesGlob(host: string, pattern: string): boolean {
  const wanted = normalizeHost(pattern);
  if (wanted === '*' || wanted === '**') return true;
  return globRegex(wanted).test(normalizeHost(host));
}
