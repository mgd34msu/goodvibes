import { basename, isAbsolute, relative } from 'node:path';

/**
 * A path as the model should see it: under the home directory it is shown as
 * `~/...`, anywhere else only its final component is kept. Absolute paths name
 * the account holder and, for credential files, say exactly where to read them.
 */
export function harnessDisplayPath(path: string, homeDirectory: string | undefined): string {
  // `env:NAME` style sources and other non-filesystem names carry no location to hide.
  if (!path || !isAbsolute(path)) return path;
  if (!homeDirectory) return `<path withheld>/${basename(path)}`;
  const rel = relative(homeDirectory, path);
  if (rel === '') return '~';
  if (!rel.startsWith('..') && !isAbsolute(rel)) return `~/${rel.split('\\').join('/')}`;
  return `<outside-home>/${basename(path)}`;
}
