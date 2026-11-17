/**
 * shared-register-path.ts, where the workspace register lives, for every
 * product that touches it.
 *
 * ── Why this file exists ──────────────────────────────────────────────────
 *
 * The register is not one surface's state. Three products read and write the
 * SAME file: the platform's gateway verb group writes it, goodvibes-agent reads and
 * writes it directly, and the daemon reads it again to decide checkpoint
 * eligibility.
 *
 * Surface-scoping it (`.goodvibes/<surface root>/control-plane/`) is what the
 * rest of that directory's stores correctly did, and it is exactly wrong here:
 * it resolves to whichever product is asking, so the agent and the daemon would
 * each get their own register. Workspaces registered from one would vanish from
 * the other, and checkpoint eligibility would refuse workspaces the operator had
 * registered. That split was written once and reverted before it shipped.
 *
 * It belongs in the platform's SHARED tier, `~/.goodvibes/shared/`, which
 * already holds the cross-surface settings tier and the canonical memory store.
 * That tier is home-scoped and takes no surface root, which is the property the
 * register needs: one path, identical from every product.
 */

/** The shared tier's directory name under `~/.goodvibes/`. */
export const SHARED_TIER_DIRECTORY = 'shared';

/** The register's file name in the shared tier. */
export const WORKSPACE_REGISTER_FILE = 'workspace-registrations.json';

/** The slice of ShellPathService these resolvers need. */
export interface WorkspaceRegisterShellPaths {
  resolveUserPath(...segments: string[]): string;
}

function requireResolved(path: string, what: string): string {
  if (!path || !path.trim()) {
    throw new Error(
      `${what}: the resolved path is empty. The workspace register is shared across products; `
      + 'an empty path would silently split it or write it somewhere nothing reads.',
    );
  }
  return path;
}

/**
 * Where the register is read and written:
 * `<home>/.goodvibes/shared/workspace-registrations.json`.
 */
export function sharedWorkspaceRegisterPath(shellPaths: WorkspaceRegisterShellPaths): string {
  return requireResolved(
    shellPaths.resolveUserPath(SHARED_TIER_DIRECTORY, WORKSPACE_REGISTER_FILE),
    'sharedWorkspaceRegisterPath',
  );
}
