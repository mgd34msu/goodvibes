/** A path under the home directory written as `~/...` for display; any other path unchanged. */
export function homeRelativePath(path: string, home: string | null | undefined): string {
  const root = home?.replace(/[\\/]+$/, '');
  if (!root || !path) return path;
  if (path === root) return '~';
  return path.startsWith(`${root}/`) || path.startsWith(`${root}\\`) ? `~${path.slice(root.length)}` : path;
}
