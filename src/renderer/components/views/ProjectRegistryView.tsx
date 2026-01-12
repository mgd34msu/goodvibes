// ============================================================================
// PROJECT REGISTRY VIEW - Multi-project management and orchestration
// ============================================================================

import { useState, useEffect } from 'react';
import { clsx } from 'clsx';

// ============================================================================
// TYPES
// ============================================================================

interface RegisteredProject {
  id: number;
  path: string;
  name: string;
  description: string | null;
  lastOpened: string;
  settings: ProjectSettings;
  createdAt: string;
  updatedAt: string;
}

interface ProjectSettings {
  defaultModel?: string;
  permissionMode?: 'default' | 'strict' | 'permissive';
  budgetLimitUsd?: number;
  autoInjectClaudeMd?: boolean;
  claudeMdTemplate?: string;
  enabledHooks?: string[];
  enabledMCPServers?: string[];
  customEnv?: Record<string, string>;
  tags?: string[];
  priority?: number;
}

interface ProjectTemplate {
  id: number;
  name: string;
  description: string | null;
  settings: ProjectSettings;
  agents: TemplateAgent[];
  createdAt: string;
  updatedAt: string;
}

interface TemplateAgent {
  agentId: number;
  priority: number;
  settings: Record<string, unknown>;
}

interface ProjectAnalytics {
  projectId: number;
  projectPath: string;
  projectName: string;
  totalSessions: number;
  totalTokens: number;
  totalCostUsd: number;
  avgSessionDuration: number;
  avgTokensPerSession: number;
  avgCostPerSession: number;
  successRate: number;
  lastActivity: string | null;
}

type TabType = 'projects' | 'templates';

// ============================================================================
// MAIN COMPONENT
// ============================================================================

export default function ProjectRegistryView() {
  const [activeTab, setActiveTab] = useState<TabType>('projects');
  const [projects, setProjects] = useState<RegisteredProject[]>([]);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedProject, setSelectedProject] = useState<RegisteredProject | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [projectAnalytics, setProjectAnalytics] = useState<Map<number, ProjectAnalytics>>(new Map());

  // Load data
  useEffect(() => {
    loadData();
  }, []);

  // Listen for project events
  useEffect(() => {
    const handleProjectEvent = () => {
      loadData();
    };

    const cleanup = window.goodvibes?.onProjectEvent?.(handleProjectEvent);
    return () => cleanup?.();
  }, []);

  async function loadData() {
    setIsLoading(true);
    try {
      const [projectsResult, templatesResult] = await Promise.all([
        window.goodvibes?.projectGetAll?.(),
        window.goodvibes?.templateGetAll?.(),
      ]);

      setProjects(projectsResult || []);
      setTemplates(templatesResult || []);

      // Load analytics for each project
      if (projectsResult?.length) {
        const analyticsMap = new Map<number, ProjectAnalytics>();
        for (const project of projectsResult) {
          const analytics = await window.goodvibes?.projectGetAnalytics?.(project.id);
          if (analytics) {
            analyticsMap.set(project.id, analytics);
          }
        }
        setProjectAnalytics(analyticsMap);
      }
    } catch (error) {
      console.error('Failed to load project registry data:', error);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleRegisterProject() {
    const path = await window.goodvibes?.selectFolder?.();
    if (path) {
      await window.goodvibes?.projectRegister?.({ path });
      loadData();
    }
  }

  async function handleRemoveProject(projectId: number) {
    if (confirm('Are you sure you want to remove this project from the registry?')) {
      await window.goodvibes?.projectRemove?.(projectId);
      if (selectedProject?.id === projectId) {
        setSelectedProject(null);
      }
      loadData();
    }
  }

  async function handleSwitchProject(projectId: number) {
    await window.goodvibes?.projectSwitch?.(projectId);
    loadData();
  }

  async function handleSaveSettings(projectId: number, settings: ProjectSettings) {
    await window.goodvibes?.projectUpdateSettings?.(projectId, settings as unknown as Record<string, unknown>);
    setShowSettings(false);
    loadData();
  }

  async function handleCreateTemplate(name: string, description: string) {
    if (selectedProject) {
      await window.goodvibes?.templateCreateFromProject?.({
        projectId: selectedProject.id,
        templateName: name,
        description,
      });
      setShowTemplateDialog(false);
      loadData();
    }
  }

  async function handleApplyTemplate(projectId: number, templateId: number) {
    await window.goodvibes?.templateApply?.(projectId, templateId);
    loadData();
  }

  async function handleDeleteTemplate(templateId: number) {
    if (confirm('Are you sure you want to delete this template?')) {
      await window.goodvibes?.templateDelete?.(templateId);
      loadData();
    }
  }

  // Filter projects by search query
  const filteredProjects = searchQuery
    ? projects.filter(p =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.path.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.description?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : projects;

  function formatDate(dateString: string): string {
    return new Date(dateString).toLocaleDateString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  }

  function formatCurrency(value: number): string {
    return `$${value.toFixed(2)}`;
  }

  if (isLoading && projects.length === 0) {
    return (
      <div className="h-full flex items-center justify-center">
        <div className="text-surface-400">Loading project registry...</div>
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-surface-100">Project Registry</h1>
          <button
            onClick={handleRegisterProject}
            className="btn btn-primary"
          >
            + Register Project
          </button>
        </div>

        {/* Tabs */}
        <div className="flex gap-2 border-b border-surface-700">
          {(['projects', 'templates'] as TabType[]).map(tab => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={clsx(
                'px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px',
                activeTab === tab
                  ? 'text-primary-400 border-primary-400'
                  : 'text-surface-400 border-transparent hover:text-surface-200'
              )}
            >
              {tab === 'projects' && `Projects (${projects.length})`}
              {tab === 'templates' && `Templates (${templates.length})`}
            </button>
          ))}
        </div>

        {/* Projects Tab */}
        {activeTab === 'projects' && (
          <div className="space-y-4">
            {/* Search */}
            <div className="relative">
              <input
                type="text"
                placeholder="Search projects..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="input w-full pl-10"
              />
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 w-5 h-5 text-surface-500"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z"
                />
              </svg>
            </div>

            {/* Project List */}
            {filteredProjects.length === 0 ? (
              <div className="card p-12 text-center">
                <div className="text-4xl mb-4">[ ]</div>
                <div className="text-surface-400 mb-2">No projects registered</div>
                <p className="text-sm text-surface-500 mb-4">
                  Register your projects to enable multi-project orchestration.
                </p>
                <button onClick={handleRegisterProject} className="btn btn-primary">
                  Register Your First Project
                </button>
              </div>
            ) : (
              <div className="grid gap-4">
                {filteredProjects.map(project => (
                  <ProjectCard
                    key={project.id}
                    project={project}
                    analytics={projectAnalytics.get(project.id)}
                    templates={templates}
                    isSelected={selectedProject?.id === project.id}
                    onSelect={() => setSelectedProject(project)}
                    onSwitch={() => handleSwitchProject(project.id)}
                    onRemove={() => handleRemoveProject(project.id)}
                    onOpenSettings={() => {
                      setSelectedProject(project);
                      setShowSettings(true);
                    }}
                    onApplyTemplate={templateId => handleApplyTemplate(project.id, templateId)}
                    onCreateTemplate={() => {
                      setSelectedProject(project);
                      setShowTemplateDialog(true);
                    }}
                    formatDate={formatDate}
                    formatCurrency={formatCurrency}
                  />
                ))}
              </div>
            )}
          </div>
        )}

        {/* Templates Tab */}
        {activeTab === 'templates' && (
          <div className="space-y-4">
            {templates.length === 0 ? (
              <div className="card p-12 text-center">
                <div className="text-4xl mb-4">&lt; /&gt;</div>
                <div className="text-surface-400 mb-2">No templates created</div>
                <p className="text-sm text-surface-500">
                  Create templates from existing projects to quickly configure new ones.
                </p>
              </div>
            ) : (
              <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
                {templates.map(template => (
                  <div key={template.id} className="card p-4 space-y-3">
                    <div className="flex items-start justify-between">
                      <div>
                        <h3 className="font-medium text-surface-100">{template.name}</h3>
                        {template.description && (
                          <p className="text-sm text-surface-400 mt-1">{template.description}</p>
                        )}
                      </div>
                      <button
                        onClick={() => handleDeleteTemplate(template.id)}
                        className="text-surface-500 hover:text-red-400 transition-colors"
                        title="Delete template"
                      >
                        x
                      </button>
                    </div>

                    <div className="text-xs text-surface-500 space-y-1">
                      <div>Agents: {template.agents.length}</div>
                      <div>Created: {formatDate(template.createdAt)}</div>
                    </div>

                    {template.settings.tags && template.settings.tags.length > 0 && (
                      <div className="flex flex-wrap gap-1">
                        {template.settings.tags.map((tag, i) => (
                          <span
                            key={i}
                            className="px-2 py-0.5 bg-surface-700 rounded text-xs text-surface-300"
                          >
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Settings Dialog */}
        {showSettings && selectedProject && (
          <ProjectSettingsDialog
            project={selectedProject}
            onSave={settings => handleSaveSettings(selectedProject.id, settings)}
            onClose={() => setShowSettings(false)}
          />
        )}

        {/* Create Template Dialog */}
        {showTemplateDialog && selectedProject && (
          <CreateTemplateDialog
            project={selectedProject}
            onCreate={handleCreateTemplate}
            onClose={() => setShowTemplateDialog(false)}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================================
// PROJECT CARD COMPONENT
// ============================================================================

function ProjectCard({
  project,
  analytics,
  templates,
  isSelected,
  onSelect,
  onSwitch,
  onRemove,
  onOpenSettings,
  onApplyTemplate,
  onCreateTemplate,
  formatDate,
  formatCurrency,
}: {
  project: RegisteredProject;
  analytics?: ProjectAnalytics;
  templates: ProjectTemplate[];
  isSelected: boolean;
  onSelect: () => void;
  onSwitch: () => void;
  onRemove: () => void;
  onOpenSettings: () => void;
  onApplyTemplate: (templateId: number) => void;
  onCreateTemplate: () => void;
  formatDate: (date: string) => string;
  formatCurrency: (value: number) => string;
}) {
  const [showMenu, setShowMenu] = useState(false);
  const [showTemplateMenu, setShowTemplateMenu] = useState(false);

  return (
    <div
      className={clsx(
        'card p-4 transition-all cursor-pointer',
        isSelected && 'ring-2 ring-primary-500'
      )}
      onClick={onSelect}
    >
      <div className="flex items-start gap-4">
        {/* Project Info */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-surface-100">{project.name}</h3>
            {project.settings.tags?.map((tag, i) => (
              <span
                key={i}
                className="px-2 py-0.5 bg-surface-700 rounded text-xs text-surface-400"
              >
                {tag}
              </span>
            ))}
          </div>
          <div className="text-sm text-surface-500 truncate mt-1">{project.path}</div>
          {project.description && (
            <p className="text-sm text-surface-400 mt-2">{project.description}</p>
          )}

          {/* Quick Stats */}
          <div className="flex items-center gap-4 mt-3 text-xs text-surface-500">
            <div>Last opened: {formatDate(project.lastOpened)}</div>
            {analytics && (
              <>
                <div>{analytics.totalSessions} sessions</div>
                <div>{formatCurrency(analytics.totalCostUsd)} spent</div>
                {analytics.successRate > 0 && (
                  <div className={clsx(
                    'px-2 py-0.5 rounded',
                    analytics.successRate >= 0.8 ? 'bg-green-500/20 text-green-400' :
                    analytics.successRate >= 0.5 ? 'bg-yellow-500/20 text-yellow-400' :
                    'bg-red-500/20 text-red-400'
                  )}>
                    {(analytics.successRate * 100).toFixed(0)}% success
                  </div>
                )}
              </>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2">
          <button
            onClick={e => { e.stopPropagation(); onSwitch(); }}
            className="btn btn-sm btn-secondary"
          >
            Switch
          </button>
          <div className="relative">
            <button
              onClick={e => { e.stopPropagation(); setShowMenu(!showMenu); }}
              className="btn btn-sm btn-ghost"
            >
              ...
            </button>
            {showMenu && (
              <div
                className="absolute right-0 top-full mt-1 w-48 bg-surface-800 border border-surface-700 rounded-lg shadow-lg z-[9959]"
                onClick={e => e.stopPropagation()}
              >
                <button
                  onClick={() => { onOpenSettings(); setShowMenu(false); }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-surface-700 text-surface-300"
                >
                  Settings
                </button>
                <button
                  onClick={() => { onCreateTemplate(); setShowMenu(false); }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-surface-700 text-surface-300"
                >
                  Create Template
                </button>
                {templates.length > 0 && (
                  <div className="relative">
                    <button
                      onClick={() => setShowTemplateMenu(!showTemplateMenu)}
                      className="w-full px-4 py-2 text-left text-sm hover:bg-surface-700 text-surface-300 flex items-center justify-between"
                    >
                      Apply Template
                      <span>&gt;</span>
                    </button>
                    {showTemplateMenu && (
                      <div className="absolute left-full top-0 w-48 bg-surface-800 border border-surface-700 rounded-lg shadow-lg">
                        {templates.map(template => (
                          <button
                            key={template.id}
                            onClick={() => {
                              onApplyTemplate(template.id);
                              setShowTemplateMenu(false);
                              setShowMenu(false);
                            }}
                            className="w-full px-4 py-2 text-left text-sm hover:bg-surface-700 text-surface-300"
                          >
                            {template.name}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div className="border-t border-surface-700 my-1" />
                <button
                  onClick={() => { onRemove(); setShowMenu(false); }}
                  className="w-full px-4 py-2 text-left text-sm hover:bg-surface-700 text-red-400"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// PROJECT SETTINGS DIALOG
// ============================================================================

function ProjectSettingsDialog({
  project,
  onSave,
  onClose,
}: {
  project: RegisteredProject;
  onSave: (settings: ProjectSettings) => void;
  onClose: () => void;
}) {
  const [settings, setSettings] = useState<ProjectSettings>(project.settings);
  const [newTag, setNewTag] = useState('');

  function handleAddTag() {
    if (newTag.trim()) {
      setSettings(prev => ({
        ...prev,
        tags: [...(prev.tags || []), newTag.trim()],
      }));
      setNewTag('');
    }
  }

  function handleRemoveTag(index: number) {
    setSettings(prev => ({
      ...prev,
      tags: prev.tags?.filter((_, i) => i !== index),
    }));
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div
        className="bg-surface-900 border border-surface-700 rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-auto"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-surface-700">
          <h2 className="text-lg font-medium text-surface-100">Project Settings</h2>
          <button onClick={onClose} className="text-surface-500 hover:text-surface-300">x</button>
        </div>

        <div className="p-4 space-y-4">
          {/* Model */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Default Model</label>
            <select
              value={settings.defaultModel || ''}
              onChange={e => setSettings(prev => ({ ...prev, defaultModel: e.target.value || undefined }))}
              className="input w-full"
            >
              <option value="">Default</option>
              <option value="claude-sonnet-4">Claude Sonnet 4</option>
              <option value="claude-opus-4-5">Claude Opus 4.5</option>
            </select>
          </div>

          {/* Permission Mode */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Permission Mode</label>
            <select
              value={settings.permissionMode || 'default'}
              onChange={e => setSettings(prev => ({ ...prev, permissionMode: e.target.value as ProjectSettings['permissionMode'] }))}
              className="input w-full"
            >
              <option value="default">Default</option>
              <option value="strict">Strict</option>
              <option value="permissive">Permissive</option>
            </select>
          </div>

          {/* Budget */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Budget Limit (USD)</label>
            <input
              type="number"
              step="0.01"
              min="0"
              value={settings.budgetLimitUsd || ''}
              onChange={e => setSettings(prev => ({ ...prev, budgetLimitUsd: parseFloat(e.target.value) || undefined }))}
              className="input w-full"
              placeholder="No limit"
            />
          </div>

          {/* Priority */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Priority</label>
            <input
              type="number"
              min="0"
              max="100"
              value={settings.priority || 0}
              onChange={e => setSettings(prev => ({ ...prev, priority: parseInt(e.target.value) || 0 }))}
              className="input w-full"
            />
            <p className="text-xs text-surface-500 mt-1">Higher priority projects get precedence in multi-project orchestration</p>
          </div>

          {/* Auto-inject CLAUDE.md */}
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="autoInjectClaudeMd"
              checked={settings.autoInjectClaudeMd ?? false}
              onChange={e => setSettings(prev => ({ ...prev, autoInjectClaudeMd: e.target.checked }))}
              className="w-4 h-4 rounded border-surface-600"
            />
            <label htmlFor="autoInjectClaudeMd" className="text-sm text-surface-300">
              Auto-inject CLAUDE.md on session start
            </label>
          </div>

          {/* Tags */}
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Tags</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {settings.tags?.map((tag, i) => (
                <span
                  key={i}
                  className="px-2 py-1 bg-surface-700 rounded text-sm text-surface-300 flex items-center gap-1"
                >
                  {tag}
                  <button
                    onClick={() => handleRemoveTag(i)}
                    className="text-surface-500 hover:text-surface-300"
                  >
                    x
                  </button>
                </span>
              ))}
            </div>
            <div className="flex gap-2">
              <input
                type="text"
                value={newTag}
                onChange={e => setNewTag(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddTag()}
                className="input flex-1"
                placeholder="Add tag..."
              />
              <button onClick={handleAddTag} className="btn btn-secondary">Add</button>
            </div>
          </div>
        </div>

        <div className="flex justify-end gap-3 p-4 border-t border-surface-700">
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button onClick={() => onSave(settings)} className="btn btn-primary">Save</button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// CREATE TEMPLATE DIALOG
// ============================================================================

function CreateTemplateDialog({
  project,
  onCreate,
  onClose,
}: {
  project: RegisteredProject;
  onCreate: (name: string, description: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(`${project.name} Template`);
  const [description, setDescription] = useState('');

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[9999]" onClick={onClose}>
      <div
        className="bg-surface-900 border border-surface-700 rounded-lg shadow-xl w-full max-w-md"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between p-4 border-b border-surface-700">
          <h2 className="text-lg font-medium text-surface-100">Create Template</h2>
          <button onClick={onClose} className="text-surface-500 hover:text-surface-300">x</button>
        </div>

        <div className="p-4 space-y-4">
          <p className="text-sm text-surface-400">
            Create a template from "{project.name}" settings and agent configuration.
          </p>

          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Template Name</label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              className="input w-full"
              placeholder="Enter template name..."
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Description</label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              className="input w-full h-24 resize-none"
              placeholder="Optional description..."
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 p-4 border-t border-surface-700">
          <button onClick={onClose} className="btn btn-ghost">Cancel</button>
          <button
            onClick={() => onCreate(name, description)}
            disabled={!name.trim()}
            className="btn btn-primary"
          >
            Create Template
          </button>
        </div>
      </div>
    </div>
  );
}
