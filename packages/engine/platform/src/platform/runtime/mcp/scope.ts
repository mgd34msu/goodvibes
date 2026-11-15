/** Apply configured MCP scopes to the path and address arguments of a call, in code. */
import { realpathSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

/**
 * The path as the file system will resolve it: `..` and `.` segments removed
 * and symlinks followed for the part of the path that exists, so a request
 * for `/allowed/../elsewhere` or a link out of an allowed directory is judged
 * by where it lands, not by how it is spelled. A relative path is resolved
 * against `base`, the directory the server works in.
 */
function realPathOf(path: string, base?: string): string {
  const absolute = base === undefined ? resolve(path) : resolve(base, path);
  let existing = absolute;
  const rest: string[] = [];
  for (;;) {
    try {
      return join(realpathSync.native(existing), ...rest);
    } catch {
      const parent = dirname(existing);
      if (parent === existing) return absolute;
      rest.unshift(basename(existing));
      existing = parent;
    }
  }
}

/** An IPv4 address, `localhost` or a bracketed IPv6 address, or any dotted host with a port. */
const ADDRESS = /^(?:(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:.]+\])(?::\d{1,5})?|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z][a-z0-9-]*:\d{1,5})$/i;
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/** Keys whose value is a filesystem location, whatever it looks like (a bare name included). */
const PATH_KEYS = new Set(['path', 'paths', 'file', 'files', 'filename', 'filenames', 'dir', 'dirs', 'directory', 'directories',
  'folder', 'folders', 'cwd', 'root', 'src', 'source', 'dest', 'dst', 'destination', 'target', 'from']);
/** Keys whose value is a network destination. */
const HOST_KEYS = new Set(['host', 'hosts', 'hostname', 'hostnames', 'url', 'urls', 'uri', 'uris', 'endpoint', 'endpoints', 'href', 'domain', 'domains']);

const normalizedKey = (key: string): string => key.toLowerCase().replace(/[-_\s]/g, '');
const isPathKey = (key: string): boolean => {
  const name = normalizedKey(key);
  return PATH_KEYS.has(name) || /(?:path|paths|file|files|dir|directory|directories|folder)$/.test(name);
};
const isHostKey = (key: string): boolean => {
  const name = normalizedKey(key);
  return HOST_KEYS.has(name) || /(?:url|urls|uri|host|hostname)$/.test(name);
};

/** One argument value the scope applies to, with the argument it came from. */
export interface ScopedValue { readonly argument: string; readonly value: string }

/**
 * The values of a call that the server's scopes apply to. A value is a path
 * when its argument is named like one (`path`, `filename`, `target`,
 * `sourcePath`, ...) or when the whole value is shaped like a path: no
 * whitespace and a separator, a home prefix, `.`/`..` or a `file:` URL. Prose
 * that happens to hold a slash ("TCP/IP tuning") is not a path. A value is a
 * destination when its argument is named like one, it has a URL scheme, or
 * it is an address (an IP, `localhost`, or a host with a port); a dotted file
 * name such as `report.pdf` is not a host.
 */
export function readScopedValues(
  args: Record<string, unknown>,
  scopes: { readonly paths: boolean; readonly hosts: boolean },
): { readonly paths: readonly ScopedValue[]; readonly hosts: readonly ScopedValue[] } {
  const paths: ScopedValue[] = [];
  const hosts: ScopedValue[] = [];
  if (!scopes.paths && !scopes.hosts) return { paths, hosts };
  const visit = (value: unknown, key: string): void => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry, key); return; }
    if (value && typeof value === 'object') { for (const [name, entry] of Object.entries(value)) visit(entry, name); return; }
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const fileUrl = trimmed.startsWith('file:');
    const url = SCHEME.test(trimmed) && !fileUrl;
    const pathKey = isPathKey(key);
    const pathShaped = fileUrl || (!/\s/.test(trimmed) && !url
      && (trimmed.startsWith('~') || trimmed.includes('/') || trimmed.includes('\\') || trimmed === '.' || trimmed === '..'));
    if (scopes.paths && ((pathKey && !url) || pathShaped)) paths.push({ argument: key, value: trimmed });
    if (scopes.hosts && !fileUrl && !pathShaped && (isHostKey(key) || url || ADDRESS.test(trimmed))) hosts.push({ argument: key, value: trimmed });
  };
  visit(args, '');
  return { paths, hosts };
}

/** A path value as a filesystem path: a `file:` URL is converted by the URL grammar. */
const asFilesystemPath = (value: string): string => {
  if (value.startsWith('file:')) return fileURLToPath(value);
  if (value === '~' || value.startsWith('~/')) return join(homedir(), value.slice(1));
  return value;
};

/**
 * The first path the call touches that lies outside every one of the owner's
 * allowed directories, or undefined when all are inside. Containment is a
 * path-component comparison of real paths, so `/allowed-2` is not inside
 * `/allowed`; a relative path is resolved against `base`.
 */
export function pathOutsideScope(allowedPaths: readonly string[], paths: readonly ScopedValue[], base?: string): ScopedValue | undefined {
  if (allowedPaths.length === 0) return undefined;
  const roots = allowedPaths.map((root) => realPathOf(root));
  return paths.find(({ value }) => {
    let target: string;
    try {
      target = realPathOf(asFilesystemPath(value), base);
    } catch {
      return true;
    }
    return !roots.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`));
  });
}

/**
 * The host a destination value names, by the URL grammar: a value with a
 * scheme is parsed as a URL; a bare `host`, `host:port` or IP is parsed as the
 * authority of one. Undefined when the value is not a parseable authority.
 */
function hostOf(value: string): string | undefined {
  try {
    return (value.includes('://') ? new URL(value) : new URL(`http://${value}`)).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** The first destination the call reaches that is not one of the owner's allowed hosts or their subdomains. */
export function hostOutsideScope(allowedHosts: readonly string[], hosts: readonly ScopedValue[]): ScopedValue | undefined {
  if (allowedHosts.length === 0) return undefined;
  return hosts.find(({ value }) => {
    const host = hostOf(value);
    return host === undefined || !allowedHosts.some((entry) => {
      // An allowed host is compared as a host: `Example.com`, `https://example.com`
      // and `example.com:8443` all name `example.com`.
      const allowed = hostOf(entry.trim());
      return allowed !== undefined && (host === allowed || host.endsWith(`.${allowed}`));
    });
  });
}
