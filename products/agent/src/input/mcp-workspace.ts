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

import type { McpServerConfig } from '@goodvibes-jev/engine/platform/platform/mcp';
import { summarizeError } from '@goodvibes-jev/engine/platform/platform/utils';
import { isAffirmative } from './agent-workspace-command-editor-engine.ts';
import { captureCommandPrint, capturedOutputReportsFailure, firstFailureLine } from './workspace-command-output.ts';
import type { CommandContext } from './command-registry.ts';
import { requireMcpApi, requireShellPaths } from './commands/runtime-services.ts';

export type McpWorkspaceMode = PlatformMcpWorkspaceMode<'reload-confirm'>;

export type McpWorkspaceFormField = PlatformMcpWorkspaceFormField<'confirm'>;

function serverConfigToForm(server?: McpServerConfig): McpWorkspaceForm {
  return { ...makeForm(server), confirm: '' };
}

// The workspace form edits stdio (command-launched) servers only, so the
// converted config always carries a command; streamable-HTTP (url) servers
// from the platform's widened McpServerConfig appear in the list but are managed
// through the /mcp command line.

export class McpWorkspace extends McpWorkspaceState<CommandContext, McpWorkspaceForm, 'reload-confirm'> {
  constructor() {
    super({
      api: requireMcpApi,
      formStatus: {
        add: 'Draft an MCP server. Type yes on the Confirm field, then press Enter on Save server.',
        edit: (name, _scope, hasLaunch) =>
          hasLaunch
            ? 'Editing ' + name + '. Type yes on the Confirm field, then press Enter on Save server to update it.'
            : 'Viewing ' + name + '. Runtime status exists, but no launch config was found.',
        remove: (name, scope) =>
          'Confirm removal of ' + name + ' from ' + scope + ' MCP config. Press Enter or y to remove; Esc or n cancels.',
      },
      paths: requireShellPaths,
      createForm: serverConfigToForm,
      showToolStatusOnOpen: false,
      requestRender: (context) => context.renderRequest(),
    });
  }
  protected publishStatus(text: string): void {
    this.status = text;
  }

  private statusValue = 'Ready. Inspect MCP servers and tools. Config writes/reloads require explicit workspace confirmation.';
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

  async saveForm(): Promise<void> {
    if (!this.context) return;
    try {
      if (!isAffirmative(this.form.confirm)) {
        this.setStatus('MCP server add/update not confirmed. Type yes on the Confirm field, then press Enter on Save server.', 'warning');
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
      // The form stays open until the command reports success, so a failed save can be corrected.
      if (await this.dispatchMcpCommand(args, `MCP server ${server.name} add/update`)) {
        this.mode = 'browse';
        this.editingServerName = null;
      }
    } catch (error) {
      this.lastError = summarizeError(error);
      this.setStatus(`MCP server save failed before dispatch: ${this.lastError}`, 'error');
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

  /** Runs `/mcp` and reports what it did. Returns true only when the command ran and did not report a failure. */
  private async dispatchMcpCommand(args: readonly string[], summary: string): Promise<boolean> {
    const context = this.context;
    if (!context?.executeCommand) {
      this.setStatus(`${summary} blocked: command dispatch is unavailable in this workspace.`, 'error');
      this.lastError = 'Command dispatch is unavailable.';
      context?.renderRequest();
      return false;
    }
    this.status = `${summary} dispatched from MCP workspace.`;
    this.lastError = null;
    context.renderRequest();
    const executeCommand = context.executeCommand;
    const outcome = await captureCommandPrint(context, () => executeCommand('mcp', [...args]));
    // What the command printed still belongs in the transcript.
    for (const line of outcome.lines) context.print(line);
    try {
      if (!outcome.ok) {
        this.lastError = summarizeError(outcome.error);
        this.setStatus(`${summary} failed: ${this.lastError}`, 'error');
        return false;
      }
      if (!outcome.value) {
        this.setStatus(`${summary} failed: the command router did not handle /mcp.`, 'error');
        this.lastError = 'Command router did not handle /mcp.';
        return false;
      }
      this.refreshSnapshot();
      // /mcp reports most failures by printing and returning, not by throwing.
      if (capturedOutputReportsFailure(outcome.lines)) {
        const reported = firstFailureLine(outcome.lines);
        this.lastError = reported;
        this.setStatus(`${summary} failed: ${reported}`, 'error');
        return false;
      }
      this.status = `${summary} completed through MCP workspace.`;
      return true;
    } finally {
      context.renderRequest();
    }
  }
}
