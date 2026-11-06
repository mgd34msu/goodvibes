import type { McpWorkspaceFormField } from './mcp-workspace-model.js';
export type { McpWorkspaceFormField } from './mcp-workspace-model.js';
/** Common MCP workspace state and inspection; each product retains its write authority. */
import type { McpApi, McpServerConfig, RegisteredTool } from '@goodvibes-jev/engine/sdk/platform/mcp';
import type { ShellPathService } from '@goodvibes-jev/engine/sdk/platform/runtime/shell';
import { summarizeError } from '@goodvibes-jev/engine/sdk/platform/utils';
import {
  MCP_ROLES,
  MCP_FORM_TRUST_MODES,
  nextEnumValue,
  mergeServers,
  type McpWorkspaceRow,
  type McpWorkspaceServerRow,
  type McpWorkspaceSnapshot,
  type McpWorkspaceFormBase,
} from './mcp-workspace-model.js';
export type McpWorkspaceMode<Extra extends string = never> = 'browse' | 'form' | 'delete-confirm' | Extra;

export interface McpWorkspaceStatePorts<Context, Form extends McpWorkspaceFormBase> {
  readonly api: (context: Context) => Pick<McpApi, 'getEffectiveConfig' | 'listServerSecurity' | 'listAllTools'>;
  readonly paths: (context: Context) => ShellPathService;
  readonly createForm: (server?: McpServerConfig | undefined) => Form;
  readonly showToolStatusOnOpen: boolean;
  readonly formStatus: {
    readonly add: string;
    readonly edit: (name: string, scope: 'project' | 'global', hasLaunch: boolean) => string;
    readonly remove: (name: string, scope: 'project' | 'global') => string;
  };
  readonly requestRender: (context: Context) => void;
}
function isTextField(field: string): field is 'name' | 'command' | 'args' | 'env' | 'allowedPaths' | 'allowedHosts' {
  return (
    field === 'name' || field === 'command' || field === 'args' || field === 'env' || field === 'allowedPaths' || field === 'allowedHosts'
  );
}
export abstract class McpWorkspaceState<Context, Form extends McpWorkspaceFormBase, ExtraMode extends string = never> {
  public active = false;
  public mode: McpWorkspaceMode<ExtraMode> = 'browse';
  public selectedIndex = 0;
  public formIndex = 0;
  public form: Form;
  public editingServerName: string | null = null;
  public tools: readonly RegisteredTool[] = [];
  public loadingTools = false;
  public lastError: string | null = null;
  public query = '';
  protected context: Context | null = null;
  protected snapshot: McpWorkspaceSnapshot = {
    projectPath: '',
    globalPath: '',
    effectiveConfig: { servers: [], locations: [] },
    servers: [],
  };
  constructor(private readonly ports: McpWorkspaceStatePorts<Context, Form>) {
    this.form = ports.createForm();
  }
  abstract get rows(): readonly McpWorkspaceRow[];
  abstract get formFields(): readonly McpWorkspaceFormField<'confirm'>[];
  protected abstract publishStatus(text: string, tone?: ('info' | 'warning' | 'error') | undefined): void;
  abstract reloadRuntime(): Promise<void>;
  openAddForm(): void {
    this.mode = 'form';
    this.formIndex = 0;
    this.editingServerName = null;
    this.form = this.ports.createForm();
    this.publishStatus(this.ports.formStatus.add);
  }
  openEditForm(serverName: string): void {
    const entry = this.snapshot.effectiveConfig.servers.find((item) => item.server.name === serverName);
    this.mode = 'form';
    this.formIndex = 0;
    this.editingServerName = serverName;
    const scope = entry?.source.scope === 'global' ? 'global' : 'project';
    this.form = { ...this.ports.createForm(entry?.server), scope };
    this.publishStatus(this.ports.formStatus.edit(serverName, scope, entry !== undefined), entry ? 'info' : 'warning');
  }
  requestDelete(serverName: string): void {
    this.mode = 'delete-confirm';
    this.editingServerName = serverName;
    const entry = this.snapshot.effectiveConfig.servers.find((item) => item.server.name === serverName);
    const scope = entry?.source.scope === 'global' ? 'global' : 'project';
    this.publishStatus(this.ports.formStatus.remove(serverName, scope));
  }
  open(context: Context): void {
    this.context = context;
    this.active = true;
    this.mode = 'browse';
    this.selectedIndex = 0;
    this.formIndex = 0;
    this.lastError = null;
    this.query = '';
    this.refreshSnapshot();
    void this.refreshTools(this.ports.showToolStatusOnOpen);
  }
  close(): void {
    this.active = false;
    this.mode = 'browse';
  }
  requestReload(): void | Promise<void> {
    return this.reloadRuntime();
  }
  get projectPath(): string {
    return this.snapshot.projectPath;
  }
  get servers(): readonly McpWorkspaceServerRow[] {
    return this.snapshot.servers;
  }
  get visibleRows(): readonly McpWorkspaceRow[] {
    const q = this.query.trim().toLowerCase();
    if (!q) return this.rows;
    return this.rows.filter((row) =>
      row.type === 'server'
        ? [row.server.name, row.server.role, row.server.source].some((v) => v.toLowerCase().includes(q))
        : row.label.toLowerCase().includes(q),
    );
  }
  setQuery(query: string): void {
    this.query = query;
    this.selectedIndex = 0;
  }
  get selectedRow(): McpWorkspaceRow | null {
    return this.visibleRows[this.selectedIndex] ?? null;
  }
  get selectedServer(): McpWorkspaceServerRow | null {
    const row = this.selectedRow;
    return row?.type === 'server' ? row.server : null;
  }
  refreshSnapshot(): void {
    if (!this.context) return;
    const roots = this.ports.paths(this.context);
    const api = this.ports.api(this.context);
    const effectiveConfig = api.getEffectiveConfig(roots);
    const runtimeServers = api.listServerSecurity();
    const projectPath =
      effectiveConfig.locations.find((location) => location.scope === 'project' && location.writable)?.path ??
      `${roots.workingDirectory}/.goodvibes/mcp.json`;
    const globalPath =
      effectiveConfig.locations.find((location) => location.scope === 'global' && location.writable)?.path ??
      `${roots.homeDirectory}/.config/mcp/mcp.json`;
    this.snapshot = {
      projectPath,
      globalPath,
      effectiveConfig,
      servers: mergeServers(effectiveConfig, runtimeServers),
    };
    this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.visibleRows.length - 1));
  }
  moveSelection(delta: number): void {
    const total = this.mode === 'form' ? this.formFields.length : this.visibleRows.length;
    if (total <= 0) return;
    if (this.mode === 'form') {
      this.formIndex = Math.max(0, Math.min(total - 1, this.formIndex + delta));
      return;
    }
    this.selectedIndex = Math.max(0, Math.min(total - 1, this.selectedIndex + delta));
  }
  adjustFormEnum(direction: 1 | -1): void {
    const field = this.formFields[this.formIndex];
    if (!field) return;
    if (field.id === 'role') {
      this.form.role = nextEnumValue(MCP_ROLES, this.form.role, direction);
    } else if (field.id === 'scope') {
      this.form.scope = nextEnumValue(['project', 'global'] as const, this.form.scope, direction);
    } else if (field.id === 'trustMode') {
      this.form.trustMode = nextEnumValue(MCP_FORM_TRUST_MODES, this.form.trustMode, direction);
    }
  }
  appendFormText(text: string): void {
    const field = this.formFields[this.formIndex];
    if (!field) return;
    if (field.id === 'confirm') {
      if ('confirm' in this.form && typeof this.form.confirm === 'string') this.form.confirm += text;
    } else if (isTextField(field.id)) this.form[field.id] += text;
  }
  backspaceFormText(): void {
    const field = this.formFields[this.formIndex];
    if (!field) return;
    if (field.id === 'confirm') {
      if ('confirm' in this.form && typeof this.form.confirm === 'string') this.form.confirm = this.form.confirm.slice(0, -1);
    } else if (isTextField(field.id)) this.form[field.id] = this.form[field.id].slice(0, -1);
  }
  reopen(): void {
    this.active = true;
  }
  async refreshTools(updateStatus = true): Promise<void> {
    if (!this.context) return;
    this.loadingTools = true;
    this.lastError = null;
    try {
      const api = this.ports.api(this.context);
      this.tools = await api.listAllTools();
      if (updateStatus) this.publishStatus(`Tool list refreshed: ${this.tools.length} tool(s) available.`);
    } catch (error) {
      this.lastError = summarizeError(error);
      this.publishStatus(`Tool refresh failed: ${this.lastError}`, 'error');
    } finally {
      this.loadingTools = false;
      this.context && this.ports.requestRender(this.context);
    }
  }
  abstract saveForm(): Promise<void>;
  abstract confirmDelete(): Promise<void>;
  cancelForm(): void {
    this.mode = 'browse';
    this.editingServerName = null;
    this.publishStatus('Returned to MCP server browser.');
  }
  async activateSelected(): Promise<void> {
    if (this.mode === 'form') {
      const field = this.formFields[this.formIndex];
      if (field?.id === 'save') await this.saveForm();
      else if (field?.id === 'cancel') this.cancelForm();
      return;
    }
    if (this.mode === 'delete-confirm') {
      await this.confirmDelete();
      return;
    }
    if (this.mode === 'reload-confirm') {
      this.mode = 'browse';
      await this.reloadRuntime();
      return;
    }
    const row = this.selectedRow;
    if (!row) return;
    if (row.type === 'server') {
      this.openEditForm(row.server.name);
      return;
    }
    if (row.id === 'add') this.openAddForm();
    else if (row.id === 'reload') await this.requestReload();
    else if (row.id === 'refresh-tools') await this.refreshTools();
    else if (row.id === 'config') {
      this.publishStatus(
        [
          `Project config: ${this.snapshot.projectPath}`,
          `Global config: ${this.snapshot.globalPath}`,
          `Scanned: ${this.snapshot.effectiveConfig.locations.map((location) => `${location.kind}:${location.writable ? 'writable' : 'read-only'}`).join(', ')}`,
        ].join(' '),
      );
    }
  }
}
