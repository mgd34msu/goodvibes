import {
  buildMcpWorkspaceFormFields,
  type McpWorkspaceFormField as PlatformMcpWorkspaceFormField,
} from '@goodvibes-jev/engine/terminal-shell/mcp-workspace-model';
import {
  McpWorkspaceState,
  type McpWorkspaceMode as PlatformMcpWorkspaceMode,
} from '@goodvibes-jev/engine/terminal-shell/mcp-workspace-state';
export { handleMcpWorkspaceToken } from '@goodvibes-jev/engine/terminal-shell/mcp-workspace-input';
import {
  MCP_WORKSPACE_MODAL_NAME,
  formToServerConfig,
  serverConfigToForm,
  type McpWorkspaceServerRow,
  type McpWorkspaceRow,
  type McpWorkspaceFormBase,
} from '@goodvibes-jev/engine/terminal-shell/mcp-workspace-model';
export {
  MCP_WORKSPACE_MODAL_NAME,
  type McpWorkspaceServerRow,
  type McpWorkspaceRow,
  type McpWorkspaceActionRow,
} from '@goodvibes-jev/engine/terminal-shell/mcp-workspace-model';
export type McpWorkspaceForm = McpWorkspaceFormBase;

import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import type { CommandContext } from './command-registry.ts';
import { requireMcpApi, requireShellPaths } from './commands/runtime-services.ts';

export type McpWorkspaceMode = PlatformMcpWorkspaceMode;

export type McpWorkspaceFormField = PlatformMcpWorkspaceFormField;

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
        remove: (name, scope) => 'Remove ' + scope + ' server "' + name + '"? Press y to confirm or n/Esc to cancel.',
      },
      paths: requireShellPaths,
      createForm: serverConfigToForm,
      showToolStatusOnOpen: true,
      requestRender: (context) => context.renderRequest(),
    });
  }
  protected publishStatus(text: string, tone: 'info' | 'warning' | 'error' = 'info'): void {
    this.setStatus(text, tone);
  }

  private feedback: { readonly text: string; readonly tone: 'info' | 'warning' | 'error' } = {
    text: 'Ready. Add, edit, remove, reload, and inspect MCP servers without restarting the TUI.',
    tone: 'info',
  };

  /**
   * The browser's always-live search row. Narrows the server and action rows;
   * selectedIndex indexes the narrowed list (visibleRows).
   */

  get status(): string {
    return this.feedback.text;
  }
  get statusTone(): 'info' | 'warning' | 'error' {
    return this.feedback.tone;
  }

  private setStatus(text: string, tone: 'info' | 'warning' | 'error' = 'info'): void {
    this.feedback = { text, tone };
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
      {
        type: 'action',
        id: 'config',
        label: 'Config locations',
        detail: 'Show platform-scanned config files and writable project/global paths.',
      },
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
      const api = requireMcpApi(this.context);
      const roots = requireShellPaths(this.context);
      const result = await api.reload(roots);
      this.refreshSnapshot();
      const connected = this.snapshot.servers.filter((server) => server.connected).length;
      this.setStatus(
        `Reloaded MCP runtime: ${connected}/${this.snapshot.servers.length} server(s) connected. Result: +${result.added} ~${result.changed} -${result.removed}, unchanged ${result.unchanged}.`,
        connected < this.snapshot.servers.length ? 'warning' : 'info',
      );
      void this.refreshTools();
    } catch (error) {
      this.lastError = summarizeError(error);
      this.setStatus(`Reload failed: ${this.lastError}`, 'error');
    } finally {
      this.context?.renderRequest();
    }
  }

  async saveForm(): Promise<void> {
    if (!this.context) return;
    try {
      const server = formToServerConfig(this.form);
      this.setStatus(`Saving ${server.name} to ${this.form.scope} MCP config and reloading runtime...`);
      this.mode = 'browse';
      this.editingServerName = null;
      const api = requireMcpApi(this.context);
      const result = await api.upsertServerConfig(requireShellPaths(this.context), this.form.scope, server);
      this.refreshSnapshot();
      this.setStatus(
        `Saved ${server.name} to ${result.path}. Reload result: +${result.reload.added} ~${result.reload.changed} -${result.reload.removed}, unchanged ${result.reload.unchanged}.`,
      );
      void this.refreshTools();
    } catch (error) {
      this.lastError = summarizeError(error);
      this.setStatus(`Save failed: ${this.lastError}`, 'error');
      this.context.renderRequest();
    }
  }

  async confirmDelete(): Promise<void> {
    if (!this.context || !this.editingServerName) return;
    const name = this.editingServerName;
    try {
      const server = this.snapshot.effectiveConfig.servers.find((entry) => entry.server.name === name);
      const scope = server?.source.scope === 'global' ? 'global' : 'project';
      const api = requireMcpApi(this.context);
      const result = await api.removeServerConfig(requireShellPaths(this.context), scope, name);
      this.mode = 'browse';
      this.editingServerName = null;
      this.refreshSnapshot();
      this.setStatus(
        result.removed
          ? `Removed ${scope} server "${name}" from ${result.path}. Reload result: +${result.reload.added} ~${result.reload.changed} -${result.reload.removed}.`
          : `No ${scope} MCP server named "${name}" exists in ${result.path}.`,
        result.removed ? 'info' : 'warning',
      );
      void this.refreshTools();
    } catch (error) {
      this.lastError = summarizeError(error);
      this.setStatus(`Remove failed: ${this.lastError}`, 'error');
      this.context.renderRequest();
    }
  }
}
