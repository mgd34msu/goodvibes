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
  serverConfigToForm as makeForm,
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
export interface McpWorkspaceForm extends McpWorkspaceFormBase {
  confirm: string;
}
import { prepareSystemMessagePresentation } from '@goodvibes-jev/engine/sdk/platform/runtime';

import type { McpServerConfig } from '@goodvibes-jev/engine/sdk/platform/mcp';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import type { CommandContext } from './command-registry.ts';
import { requireMcpApi, requireShellPaths } from './commands/runtime-services.ts';

export type McpWorkspaceMode = PlatformMcpWorkspaceMode<'reload-confirm'>;

export type McpWorkspaceFormField = PlatformMcpWorkspaceFormField<'confirm'>;

function isAffirmative(value: string): boolean {
  return /^(y|yes|true)$/i.test(value.trim());
}

function serverConfigToForm(server?: McpServerConfig): McpWorkspaceForm {
  return { ...makeForm(server), confirm: '' };
}

// The workspace form edits stdio (command-launched) servers only, so the
// converted config always carries a command; streamable-HTTP (url) servers
// from the SDK's widened McpServerConfig appear in the list but are managed
// through the /mcp command line.

export class McpWorkspace extends McpWorkspaceState<CommandContext, McpWorkspaceForm, 'reload-confirm'> {
  constructor() {
    super({
      api: requireMcpApi,
      paths: requireShellPaths,
      createForm: serverConfigToForm,
      showToolStatusOnOpen: false,
      requestRender: (context) => context.renderRequest(),
    });
  }
  protected publishStatus(text: string): void {
    this.status = text;
  }

  private statusReading: AbortController | undefined;
  private statusValue = 'Ready. Inspect MCP servers and tools. Config writes/reloads require explicit workspace confirmation.';
  public get status(): string {
    return this.statusValue;
  }
  public set status(value: string) {
    this.statusValue = value;
    this.statusReading?.abort();
    const controller = new AbortController();
    this.statusReading = controller;
    void prepareSystemMessagePresentation(value, controller.signal)
      .then(() => {
        if (!controller.signal.aborted && this.statusValue === value) this.context?.renderRequest();
      })
      .catch(() => {});
  }

  /**
   * The browser's always-live search row. Narrows the server and action rows;
   * selectedIndex indexes the narrowed list (visibleRows).
   */

  close(): void {
    this.statusReading?.abort();
    super.close();
  }

  get rows(): readonly McpWorkspaceRow[] {
    return [
      ...this.snapshot.servers.map((server): McpWorkspaceRow => ({ type: 'server', server })),
      {
        type: 'action',
        id: 'add',
        label: 'Add or update server',
        detail: `Open a confirmed Agent workspace form to save an MCP server in ${this.form.scope} scope.`,
      },
      {
        type: 'action',
        id: 'reload',
        label: 'Reload runtime',
        detail: 'Confirm an MCP runtime reload from this workspace after external config edits.',
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
        id: 'confirm',
        label: 'Confirm',
        value: this.form.confirm,
        help: 'Type yes to save this MCP server through the TUI command dispatcher.',
        editable: true,
      },
      {
        id: 'save',
        label: 'Save server',
        value: '',
        help: 'Dispatch the confirmed MCP server add/update through the workspace.',
        editable: false,
      },
      { id: 'cancel', label: 'Cancel', value: '', help: 'Return to the MCP server browser without changing config.', editable: false },
    ];
  }

  requestReload(): void {
    this.lastError = null;
    this.mode = 'reload-confirm';
    this.status = 'Confirm MCP runtime reload. Press Enter or y to reload; Esc or n cancels.';
    this.context?.renderRequest();
  }

  async reloadRuntime(): Promise<void> {
    await this.dispatchMcpCommand(['reload', '--yes'], 'MCP runtime reload');
  }

  openAddForm(): void {
    this.mode = 'form';
    this.formIndex = 0;
    this.editingServerName = null;
    this.form = serverConfigToForm();
    this.status = 'Draft an MCP server. Type yes on the Confirm field, then press Enter on Save server.';
  }

  openEditForm(serverName: string): void {
    const entry = this.snapshot.effectiveConfig.servers.find((configEntry) => configEntry.server.name === serverName);
    this.mode = 'form';
    this.formIndex = 0;
    this.editingServerName = serverName;
    this.form = { ...serverConfigToForm(entry?.server), scope: entry?.source.scope === 'global' ? 'global' : 'project' };
    this.status = entry
      ? `Editing ${serverName}. Type yes on the Confirm field, then press Enter on Save server to update it.`
      : `Viewing ${serverName}. Runtime status exists, but no launch config was found.`;
  }

  requestDelete(serverName: string): void {
    this.mode = 'delete-confirm';
    this.editingServerName = serverName;
    const entry = this.snapshot.effectiveConfig.servers.find((configEntry) => configEntry.server.name === serverName);
    const scope = entry?.source.scope === 'global' ? 'global' : 'project';
    this.status = `Confirm removal of ${serverName} from ${scope} MCP config. Press Enter or y to remove; Esc or n cancels.`;
  }

  async saveForm(): Promise<void> {
    if (!this.context) return;
    try {
      if (!isAffirmative(this.form.confirm)) {
        this.status = 'MCP server add/update not confirmed. Type yes on the Confirm field, then press Enter on Save server.';
        this.context.renderRequest();
        return;
      }
      const server = formToServerConfig(this.form);
      const args = ['add', server.name, server.command, ...(server.args ?? []), '--scope', this.form.scope];
      if (server.role) args.push('--role', server.role);
      if (server.trustMode) args.push('--trust', server.trustMode);
      for (const [key, value] of Object.entries(server.env ?? {})) args.push('--env', `${key}=${value}`);
      for (const path of server.allowedPaths ?? []) args.push('--path', path);
      for (const host of server.allowedHosts ?? []) args.push('--host', host);
      args.push('--yes');
      this.mode = 'browse';
      this.editingServerName = null;
      await this.dispatchMcpCommand(args, `MCP server ${server.name} add/update`);
    } catch (error) {
      this.lastError = summarizeError(error);
      this.status = `MCP server save failed before dispatch: ${this.lastError}`;
      this.context.renderRequest();
    }
  }

  async confirmDelete(): Promise<void> {
    if (!this.context || !this.editingServerName) return;
    const name = this.editingServerName;
    const server = this.snapshot.effectiveConfig.servers.find((entry) => entry.server.name === name);
    const scope = server?.source.scope === 'global' ? 'global' : 'project';
    this.mode = 'browse';
    this.editingServerName = null;
    await this.dispatchMcpCommand(['remove', name, '--scope', scope, '--yes'], `MCP server ${name} removal`);
  }

  private async dispatchMcpCommand(args: readonly string[], summary: string): Promise<void> {
    const context = this.context;
    if (!context?.executeCommand) {
      this.status = `${summary} blocked: command dispatch is unavailable in this workspace.`;
      this.lastError = 'Command dispatch is unavailable.';
      context?.renderRequest();
      return;
    }
    this.status = `${summary} dispatched from MCP workspace.`;
    this.lastError = null;
    context.renderRequest();
    try {
      const handled = await context.executeCommand('mcp', [...args]);
      if (!handled) {
        this.status = `${summary} failed: the command router did not handle /mcp.`;
        this.lastError = 'Command router did not handle /mcp.';
        context.renderRequest();
        return;
      }
      this.refreshSnapshot();
      this.status = `${summary} completed through MCP workspace.`;
    } catch (error) {
      this.lastError = summarizeError(error);
      this.status = `${summary} failed: ${this.lastError}`;
    } finally {
      context.renderRequest();
    }
  }
}
