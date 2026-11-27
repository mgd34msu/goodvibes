/** One live trust authority for each physical workspace owned by this daemon. */
import { realpathSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { createShellPathService } from '@goodvibes/engine/platform/platform/runtime/shell';
import { WorkspaceTrustManager } from '@goodvibes/engine/platform/platform/runtime/operations';
import { projectIdentityOf } from '@goodvibes/engine/platform/platform/workspace';
import { GOODVIBES_DAEMON_SURFACE_ROOT } from '../config/surface.js';

/** How many projects' trust managers are kept at once (the daemon's own folder always among them). */
const MAX_KEPT_TRUSTS = 64;
const trustByHost = new WeakMap<WorkspaceTrustManager, Map<string, WorkspaceTrustManager>>();
function workspaceTrustKey(workspaceRoot: string): string {
  let parent = resolve(workspaceRoot);
  const suffix: string[] = [];
  for (;;) {
    try { return resolve(realpathSync(parent), ...suffix); }
    catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
      const next = dirname(parent);
      if (next === parent) throw error;
      suffix.unshift(basename(parent)); parent = next;
    }
  }
}

export function createDaemonWorkspaceTrustResolver(owner: {
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly workspaceTrustManager: WorkspaceTrustManager;
}): (workspaceRoot: string) => WorkspaceTrustManager {
  let cache = trustByHost.get(owner.workspaceTrustManager);
  if (!cache) {
    cache = new Map([[workspaceTrustKey(owner.workingDirectory), owner.workspaceTrustManager]]);
    trustByHost.set(owner.workspaceTrustManager, cache);
  }
  const trustByWorkspace = cache;
  const ownKey = workspaceTrustKey(owner.workingDirectory);
  return (workspaceRoot) => {
    // One trust per project: a folder inside a project is under its project's decision (workspaceTrustOwnerOf).
    const key = workspaceTrustKey(projectIdentityOf(workspaceRoot));
    let trust = trustByWorkspace.get(key);
    if (trust) {
      // Most recently used last: the bound below lets go of the folder used longest ago first.
      trustByWorkspace.delete(key);
      trustByWorkspace.set(key, trust);
      return trust;
    }
    trust = new WorkspaceTrustManager({ shellPaths: createShellPathService({ workingDirectory: key, homeDirectory: owner.homeDirectory }), surfaceRoot: GOODVIBES_DAEMON_SURFACE_ROOT });
    trustByWorkspace.set(key, trust);
    // Bounded: a trust is read again from the register when its folder comes back, so letting one go loses nothing.
    for (const oldest of trustByWorkspace.keys()) {
      if (trustByWorkspace.size <= MAX_KEPT_TRUSTS) break;
      if (oldest !== ownKey) trustByWorkspace.delete(oldest);
    }
    return trust;
  };
}
