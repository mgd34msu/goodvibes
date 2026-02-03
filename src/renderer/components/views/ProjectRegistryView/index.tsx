// ============================================================================
// PROJECT REGISTRY VIEW - Multi-project management and orchestration
// ============================================================================

import { useState, useCallback } from 'react';
import { createLogger } from '../../../../shared/logger.js';
import { useTerminalStore } from '../../../stores/terminalStore';
import { useAppStore } from '../../../stores/appStore';

const logger = createLogger('ProjectRegistryView');
import { clsx } from 'clsx';
import { useConfirm } from '../../overlays/ConfirmModal';
import { useProjectRegistry, useProjectFilters } from './hooks';
import { ProjectCard } from './ProjectCard';
import { ProjectFilters } from './ProjectFilters';
import { ProjectSettingsDialog } from './ProjectSettingsDialog';
import { CreateTemplateDialog } from './CreateTemplateDialog';
import { TemplateList } from './TemplateList';
import { PreviousSessionsModal } from './PreviousSessionsModal';
import type { RegisteredProject, ProjectSettings } from './types';

type TabType = 'projects' | 'templates';

export default function ProjectRegistryView() {
  const createTerminal = useTerminalStore((state) => state.createTerminal);
  const setCurrentView = useAppStore((state) => state.setCurrentView);
  const [activeTab, setActiveTab] = useState<TabType>('projects');
  const [selectedProject, setSelectedProject] = useState<RegisteredProject | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [showTemplateDialog, setShowTemplateDialog] = useState(false);
  const [showPreviousSessions, setShowPreviousSessions] = useState(false);
  const [previousSessionsProject, setPreviousSessionsProject] = useState<RegisteredProject | null>(null);

  const {
    projects,
    templates,
    projectAnalytics,
    isLoading,
    registerProject,
    removeProject,
    saveSettings,
    createTemplate,
    applyTemplate,
    deleteTemplate,
  } = useProjectRegistry();

  const { searchQuery, setSearchQuery, filteredProjects } = useProjectFilters(projects);

  const { confirm: confirmRemoveProject, ConfirmDialog: RemoveProjectDialog } = useConfirm({
    title: 'Remove Project',
    message: 'Are you sure you want to remove this project from the registry?',
    confirmText: 'Remove',
    cancelText: 'Cancel',
    variant: 'danger',
  });

  const { confirm: confirmDeleteTemplate, ConfirmDialog: DeleteTemplateDialog } = useConfirm({
    title: 'Delete Template',
    message: 'Are you sure you want to delete this template?',
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger',
  });

  const handleRemoveProject = useCallback(async (projectId: number) => {
    const confirmed = await confirmRemoveProject();
    if (confirmed) {
      await removeProject(projectId);
      if (selectedProject?.id === projectId) {
        setSelectedProject(null);
      }
    }
  }, [confirmRemoveProject, removeProject, selectedProject?.id]);

  const handleSaveSettings = async (projectId: number, settings: ProjectSettings) => {
    await saveSettings(projectId, settings);
    setShowSettings(false);
  };

  const handleCreateTemplate = async (name: string, description: string) => {
    if (selectedProject) {
      await createTemplate(selectedProject.id, name, description);
      setShowTemplateDialog(false);
    }
  };

  const handleDeleteTemplate = useCallback(async (templateId: number) => {
    const confirmed = await confirmDeleteTemplate();
    if (confirmed) {
      await deleteTemplate(templateId);
    }
  }, [confirmDeleteTemplate, deleteTemplate]);

  const handleNewSession = useCallback(async (project: RegisteredProject) => {
    // Start a new Claude session in the project's directory
    try {
      const result = await createTerminal(project.path, project.name);
      if (result.error) {
        logger.error('Failed to start Claude session', result.error);
      } else {
        setCurrentView('terminal');
      }
    } catch (err: unknown) {
      logger.error('Failed to start Claude session', err);
    }
  }, [createTerminal, setCurrentView]);

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
    <>
    <RemoveProjectDialog />
    <DeleteTemplateDialog />
    <div className="h-full overflow-auto">
      <div className="max-w-7xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <h1 className="text-xl font-semibold text-surface-100">Project Registry</h1>
          <button
            onClick={registerProject}
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
            <ProjectFilters
              searchQuery={searchQuery}
              onSearchChange={setSearchQuery}
            />

            {/* Project List */}
            {filteredProjects.length === 0 ? (
              <div className="card p-12 text-center">
                <div className="text-4xl mb-4">[ ]</div>
                <div className="text-surface-400 mb-2">No projects registered</div>
                <p className="text-sm text-surface-500 mb-4">
                  Register your projects to enable multi-project orchestration.
                </p>
                <button onClick={registerProject} className="btn btn-primary">
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
                    onNewSession={() => handleNewSession(project)}
                    onOpenPreviousSession={() => {
                      setPreviousSessionsProject(project);
                      setShowPreviousSessions(true);
                    }}
                    onRemove={() => handleRemoveProject(project.id)}
                    onOpenSettings={() => {
                      setSelectedProject(project);
                      setShowSettings(true);
                    }}
                    onApplyTemplate={templateId => applyTemplate(project.id, templateId)}
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
            <TemplateList
              templates={templates}
              onDeleteTemplate={handleDeleteTemplate}
              formatDate={formatDate}
            />
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

        {/* Previous Sessions Modal */}
        {showPreviousSessions && previousSessionsProject && (
          <PreviousSessionsModal
            project={previousSessionsProject}
            onClose={() => {
              setShowPreviousSessions(false);
              setPreviousSessionsProject(null);
            }}
            formatCurrency={formatCurrency}
          />
        )}
      </div>
    </div>
    </>
  );
}

// Re-export types for convenience
export type { RegisteredProject, ProjectSettings, ProjectTemplate, ProjectAnalytics } from './types';
