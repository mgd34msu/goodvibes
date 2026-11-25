import type { HookApi } from '@goodvibes/engine/platform/platform/hooks';
import type { HooksReloadServices } from '@goodvibes/engine/platform/platform/capabilities';
import { commandRefusal } from './command-confirmation.js';
import type { CommandActionContext } from './command-actions/types.js';

/**
 * The hooks, as each terminal program holds them. Every act on the hooks file
 * runs in the daemon (capabilities/builtin/hooks.ts), on the project's own
 * hooks file, from the Tools and extensions place (places/tools-place.ts; the
 * lists its forms choose from are in places/tools-lists.ts). Reading the file
 * again into this program's own dispatcher (`hooks.reload`) is this
 * program's, and is all that is left here.
 */

/** What the hooks services read from a product's command context. */
export interface HooksCommandContext extends CommandActionContext {
  /** This program's hook API: its own dispatcher, which `reload` reads the file into. */
  readonly clients?: { readonly hookApi?: HookApi | undefined } | undefined;
}

/** This program's own dispatcher, as `hooks.reload` takes it. */
export function hooksReloadServices(ctx: HooksCommandContext): HooksReloadServices {
  return {
    hookFile: {
      async reload() {
        const api = ctx.clients?.hookApi;
        if (!api) throw commandRefusal('This program runs no hooks, so there is nothing to read again.');
        await api.workbench.reload();
        return api.workbench.getFilePath();
      },
    },
  };
}
