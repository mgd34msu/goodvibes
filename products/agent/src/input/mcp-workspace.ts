import {
  buildMcpWorkspaceFormFields,
  type McpWorkspaceFormField as PlatformMcpWorkspaceFormField,
} from '@goodvibes/engine/terminal-shell/mcp-workspace-model';
import {
  McpWorkspaceState,
  type McpWorkspaceMode as PlatformMcpWorkspaceMode,
} from '@goodvibes/engine/terminal-shell/mcp-workspace-state';
export { handleMcpWorkspaceToken } from '@goodvibes/engine/terminal-shell/mcp-workspace-input';
import {
  MCP_WORKSPACE_MODAL_NAME,
  formToServerConfig,
  serverConfigToForm,
  type McpWorkspaceServerRow,
  type McpWorkspaceRow,
  type McpWorkspaceFormBase,
} from '@goodvibes/engine/terminal-shell/mcp-workspace-model';
export {
  MCP_WORKSPACE_MODAL_NAME,
  type McpWorkspaceServerRow,
  type McpWorkspaceRow,
  type McpWorkspaceActionRow,
} from '@goodvibes/engine/terminal-shell/mcp-workspace-model';
export type McpWorkspaceForm = McpWorkspaceFormBase;

import { summarizeError } from '@goodvibes/engine/platform/platform/utils';
import type { CommandContext } from './command-registry.ts';
import { requireMcpApi, requireReadModels, requireShellPaths } from './commands/runtime-services.ts';

export type McpWorkspaceMode = PlatformMcpWorkspaceMode;

export type McpWorkspaceFormField = PlatformMcpWorkspaceFormField;

// The workspace form edits stdio (command-launched) servers only, so the
// converted config always carries a command; streamable-HTTP (url) servers
// from the platform's widened McpServerConfig appear in the list but are managed
// through the /mcp command line. Save is the ask and a reload runs at once, as
// in the terminal app: a reload is reversible and asks nothing of the owner.

export class McpWorkspace extends McpWorkspaceState<CommandContext, McpWorkspaceForm> {
  constructor() {
    super({
      api: requireMcpApi,
      formStatus: {
        add: 'Add an MCP server. Choose project or global scope, then save and reload.',
        edit: (name, scope, hasLaunch) =>
          hasLaunch
            ? 'Editing ' + name + '. Saving writes a ' + scope + ' config entry and reloads the live runtime.'
            : 'Editing ' + name + '. Runtime status exists, but no launch config was found; enter command details before saving.',
        remove: (name, scope) =>
          'Confirm removal of ' + name + ' from ' + scope + ' MCP config. Press Enter or y to remove; Esc or n cancels.',
      },
      paths: requireShellPaths,
      createForm: serverConfigToForm,
      showToolStatusOnOpen: false,
      requestRender: (context) => context.renderRequest(),
      connections: (context) => {
        const mcp = requireReadModels(context).mcp;
        return { connected: () => mcp.getSnapshot().connectedServerNames, subscribe: (listener) => mcp.subscribe(listener) };
      },
    });
  }
  protected publishStatus(text: string): void {
    this.status = text;
  }

  private statusValue = 'Ready. Add, edit, remove, reload, and inspect MCP servers without restarting the Agent.';
  private statusToneValue: 'info' | 'warning' | 'error' = 'info';
  public get status(): string {
    return this.statusValue;
  }
  /** A status line set this way is information; a warning or failure is set with `setStatus`. */
  public set status(value: string) {
    this.setStatus(value);
  }
  /** The level the line's writer gave it; the renderer colours by it and reads nothing. */
  public get statusTone(): 'info' | 'warning' | 'error' {
    return this.statusToneValue;
  }
  private setStatus(text: string, tone: 'info' | 'warning' | 'error' = 'info'): void {
    this.statusValue = text;
    this.statusToneValue = tone;
  }

  /**
   * The browser's always-live search row. Narrows the server and action rows;
   * selectedIndex indexes the narrowed list (visibleRows).
   */

  close(): void {
    super.close();
  }

  get rows(): readonly McpWorkspaceRow[] {
    return [
      ...this.snapshot.servers.map((server): McpWorkspaceRow => ({ type: 'server', server })),
      {
        type: 'action',
        id: 'add',
        label: 'Add server',
        detail: `Write a server through the platform config manager. Default scope: ${this.form.scope}.`,
      },
      {
        type: 'action',
        id: 'reload',
        label: 'Reload runtime',
        detail: 'Reconnect all MCP servers from global, Claude, and project config files.',
      },
      {
        type: 'action',
        id: 'refresh-tools',
        label: 'Refresh tools',
        detail: 'Fetch the currently available MCP tool list from connected servers.',
      },
      { type: 'action', id: 'config', label: 'Config locations', detail: 'Show detected config files and writable project/global paths.' },
    ];
  }

  /** The rows the search row lets through (servers by name, role or source; actions by label). */

  /** Replace the browser query; the selection moves to the first match. */

  get formFields(): readonly McpWorkspaceFormField[] {
    return [
      ...buildMcpWorkspaceFormFields(this.form),
      {
        id: 'save',
        label: 'Save and reload',
        value: '',
        help: 'Write the selected scope config and reconnect the live MCP runtime.',
        editable: false,
      },
      { id: 'cancel', label: 'Cancel', value: '', help: 'Return to the MCP server browser without changing config.', editable: false },
    ];
  }

  async reloadRuntime(): Promise<void> {
    if (!this.context) return;
    this.lastError = null;
    try {
      const result = await requireMcpApi(this.context).reload(requireShellPaths(this.context));
      this.refreshSnapshot();
      const connected = this.snapshot.servers.filter((server) => server.connected).length;
      this.setStatus(
        `Reloaded MCP runtime: ${connected}/${this.snapshot.servers.length} server(s) connected. Result: +${result.added} ~${result.changed} -${result.removed}, unchanged ${result.unchanged}.`,
        connected < this.snapshot.servers.length ? 'warning' : 'info',
      );
      void this.refreshTools(false);
    } catch (error) {
      this.lastError = summarizeError(error);
      this.setStatus(`MCP runtime reload failed: ${this.lastError}`, 'error');
    } finally {
      this.context?.renderRequest();
    }
  }

  async saveForm(): Promise<void> {
    if (!this.context) return;
    this.lastError = null;
    try {
      const server = formToServerConfig(this.form);
      this.setStatus(`Saving ${server.name} to ${this.form.scope} MCP config and reloading runtime...`);
      // The config writer's own result decides: it throws when the save did not
      // happen, and the form stays open with what was typed so it can be corrected.
      // The owner's own form: the server is the owner's request, not something the folder brought.
      const result = await requireMcpApi(this.context).upsertServerConfig(requireShellPaths(this.context), this.form.scope, server, { byOwner: true });
      this.mode = 'browse';
      this.editingServerName = null;
      this.refreshSnapshot();
      this.setStatus(
        `Saved MCP server ${server.name} to ${result.path}. Reload result: +${result.reload.added} ~${result.reload.changed} -${result.reload.removed}, unchanged ${result.reload.unchanged}.`,
      );
      void this.refreshTools(false);
    } catch (error) {
      this.lastError = summarizeError(error);
      this.setStatus(`MCP server save failed: ${this.lastError}`, 'error');
    } finally {
      this.context?.renderRequest();
    }
  }

  async confirmDelete(): Promise<void> {
    if (!this.context || !this.editingServerName) return;
    const name = this.editingServerName;
    const server = this.snapshot.effectiveConfig.servers.find((entry) => entry.server.name === name);
    const scope = server?.source.scope === 'global' ? 'global' : 'project';
    // Leave the confirmation before awaiting, so a repeated y or Enter cannot start a second removal.
    this.mode = 'browse';
    this.editingServerName = null;
    this.lastError = null;
    try {
      const result = await requireMcpApi(this.context).removeServerConfig(requireShellPaths(this.context), scope, name);
      this.refreshSnapshot();
      if (result.removed) {
        this.setStatus(`Removed MCP server ${name} from ${scope} config ${result.path}. Reload result: +${result.reload.added} ~${result.reload.changed} -${result.reload.removed}.`);
      } else {
        this.lastError = `No ${scope} MCP server named ${name} exists in ${result.path}.`;
        this.setStatus(`${this.lastError} If it still appears, it comes from another config scope or an external MCP config.`, 'warning');
      }
      void this.refreshTools(false);
    } catch (error) {
      this.lastError = summarizeError(error);
      this.setStatus(`MCP server ${name} removal failed: ${this.lastError}`, 'error');
    } finally {
      this.context?.renderRequest();
    }
  }
}
