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
/** A bare domain name (`evil.example`, `api.example.com.`), its last label letters only, two or more. */
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,63})\.?$/i;
/**
 * File extensions that are not top-level domains, so a value such as
 * `report.pdf` or `package.json` is a file name, not a destination. An
 * extension that is also a domain (`.sh`, `.py`, `.md`, `.rs`, `.zip`, `.app`)
 * is deliberately absent: such a value is checked as a host.
 */
const FILE_EXTENSIONS = new Set(['json', 'jsonl', 'txt', 'pdf', 'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'yaml', 'yml',
  'toml', 'csv', 'tsv', 'html', 'htm', 'css', 'scss', 'less', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'xml', 'log',
  'lock', 'ini', 'cfg', 'conf', 'env', 'sql', 'db', 'sqlite', 'wasm', 'gz', 'tgz', 'tar', 'bz2', 'xz', 'exe', 'dll',
  'bak', 'tmp', 'cpp', 'hpp', 'java', 'kt', 'swift', 'go', 'rb', 'php', 'lua', 'vue', 'svelte', 'mdx', 'docx', 'xlsx',
  'pptx', 'doc', 'xls', 'ppt', 'mp3', 'mp4', 'wav', 'ogg', 'webm', 'pem', 'crt', 'cer', 'diff', 'patch']);
/** A bare domain name that is not a file name by its extension. */
const isDomainValue = (value: string): boolean => {
  const match = DOMAIN.exec(value);
  return match !== null && !FILE_EXTENSIONS.has(match[1]!.toLowerCase());
};
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

type JsonSchemaNode = Readonly<Record<string, unknown>>;
const schemaNode = (value: unknown): JsonSchemaNode | undefined =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as JsonSchemaNode : undefined;
/** The schema of one property of an object schema, if the schema names it. */
const propertySchema = (schema: JsonSchemaNode | undefined, name: string): JsonSchemaNode | undefined =>
  schemaNode(schemaNode(schema?.['properties'])?.[name]);
/** A JSON-schema `format` that names a filesystem location or a URI. */
const URI_FORMATS = new Set(['uri', 'uri-reference', 'iri', 'iri-reference']);
const schemaFormat = (schema: JsonSchemaNode | undefined): string =>
  typeof schema?.['format'] === 'string' ? (schema['format'] as string).toLowerCase() : '';
const isPathFormat = (format: string): boolean => /(?:^|-)(?:path|file|dir|directory|folder)(?:$|-)/.test(format);

/**
 * One token that names a location: absolute (`/x`, `\\x`, `//server/x`,
 * `C:\x`), under the home directory (`~`), relative by its first segment (`.`,
 * `..`, `./x`, `../x`), or holding a separator between names (`secrets/key.pem`).
 * Separators alone (`//`, `/*`) are not a path.
 */
function isPathToken(token: string): boolean {
  if (token === '~' || token.startsWith('~/') || token.startsWith('~\\')) return true;
  if (token === '/' || token === '\\' || /^[\\/]{1,2}[\w.~$@+-]/.test(token) || /^[a-z]:[\\/]/i.test(token)) return true;
  if (token === '.' || token === '..' || /^\.\.?[\\/]/.test(token)) return true;
  return /[\w.~$@+-][\\/][\w.~$@+-]/.test(token);
}

/** A token that starts at a root, the home directory or `.`/`..`: a location even with spaces after it. */
const isRootedToken = (token: string): boolean =>
  isPathToken(token) && (/^(?:~|[\\/]|[a-z]:[\\/]|\.\.?(?:[\\/]|$))/i.test(token));

/**
 * A value that names a location whatever argument holds it. With no
 * whitespace: any path token, a relative `dir/file` included. A one-line value
 * with spaces (`/home/me/My Keys/id_rsa`, `~/x y/../z`) is a path when its first
 * token starts at a root, the home directory or `.`/`..`, so prose that holds a
 * slash ("TCP/IP tuning", "either/or") is not one. A multi-line value is text.
 */
function isPathValue(value: string): boolean {
  if (/[\r\n]/.test(value)) return false;
  if (!/\s/.test(value)) return isPathToken(value);
  return isRootedToken(value.split(/\s/, 1)[0]!);
}

/**
 * The values of a call that the server's scopes apply to. A value is a path
 * when the tool's own input schema declares its argument a path or URI
 * (`format: "uri"`, `"path"`, `"file-path"`, ...), when its argument is named
 * like one (`path`, `filename`, `target`, `sourcePath`, ...), or when the value
 * itself names a location (see {@link isPathValue}). Membership is decided on
 * the value: the argument's name only labels it in the refusal. A value is a
 * destination when its argument is named like one, it has a URL scheme, it is
 * an address (an IP, `localhost`, or a host with a port), or it is a bare
 * domain name, unless its argument is a declared path; a dotted file name such
 * as `report.pdf` (an extension that is not a domain) is not a host.
 */
export function readScopedValues(
  args: Record<string, unknown>,
  scopes: { readonly paths: boolean; readonly hosts: boolean },
  inputSchema?: Readonly<Record<string, unknown>> | undefined,
): { readonly paths: readonly ScopedValue[]; readonly hosts: readonly ScopedValue[] } {
  const paths: ScopedValue[] = [];
  const hosts: ScopedValue[] = [];
  if (!scopes.paths && !scopes.hosts) return { paths, hosts };
  const visit = (value: unknown, key: string, schema: JsonSchemaNode | undefined): void => {
    if (Array.isArray(value)) { for (const entry of value) visit(entry, key, schemaNode(schema?.['items'])); return; }
    if (value && typeof value === 'object') {
      for (const [name, entry] of Object.entries(value)) visit(entry, name, propertySchema(schema, name));
      return;
    }
    if (typeof value !== 'string') return;
    const trimmed = value.trim();
    if (!trimmed) return;
    const fileUrl = trimmed.startsWith('file:');
    const url = SCHEME.test(trimmed) && !fileUrl;
    const format = schemaFormat(schema);
    const declaredPath = isPathFormat(format) || (URI_FORMATS.has(format) && !url);
    const pathShaped = fileUrl || (!url && isPathValue(trimmed));
    if (scopes.paths && (((isPathKey(key) || declaredPath) && !url) || pathShaped)) paths.push({ argument: key, value: trimmed });
    if (scopes.hosts && !fileUrl && !pathShaped && !declaredPath
      && (isHostKey(key) || url || ADDRESS.test(trimmed) || (!isPathKey(key) && isDomainValue(trimmed)))) hosts.push({ argument: key, value: trimmed });
  };
  visit(args, '', schemaNode(inputSchema));
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
export function pathOutsideScope(allowedPaths: readonly string[], paths: readonly ScopedValue[], base?: string): (ScopedValue & { readonly resolved?: string }) | undefined {
  if (allowedPaths.length === 0) return undefined;
  const roots = allowedPaths.map((root) => realPathOf(root));
  for (const entry of paths) {
    let target: string;
    try {
      target = realPathOf(asFilesystemPath(entry.value), base);
    } catch {
      return entry;
    }
    if (!roots.some((root) => target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`))) return { ...entry, resolved: target };
  }
  return undefined;
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
