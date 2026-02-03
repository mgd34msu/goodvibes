// ============================================================================
// PROJECT REGISTRY VIEW - CUSTOM HOOKS
// ============================================================================

import { useState, useEffect, useCallback } from 'react';
import { createLogger } from '../../../../shared/logger';
import type {
  RegisteredProject,
  ProjectSettings,
  ProjectTemplate,
  ProjectAnalytics,
} from './types';

const logger = createLogger('ProjectRegistryView');

export interface UseProjectRegistryReturn {
  projects: RegisteredProject[];
  templates: ProjectTemplate[];
  projectAnalytics: Map<number, ProjectAnalytics>;
  isLoading: boolean;
  loadData: () => Promise<void>;
  registerProject: () => Promise<void>;
  removeProject: (projectId: number) => Promise<void>;
  switchProject: (projectId: number) => Promise<void>;
  saveSettings: (projectId: number, settings: ProjectSettings) => Promise<void>;
  createTemplate: (projectId: number, name: string, description: string) => Promise<void>;
  applyTemplate: (projectId: number, templateId: number) => Promise<void>;
  deleteTemplate: (templateId: number) => Promise<void>;
}

export function useProjectRegistry(): UseProjectRegistryReturn {
  const [projects, setProjects] = useState<RegisteredProject[]>([]);
  const [templates, setTemplates] = useState<ProjectTemplate[]>([]);
  const [projectAnalytics, setProjectAnalytics] = useState<Map<number, ProjectAnalytics>>(new Map());
  const [isLoading, setIsLoading] = useState(true);

  const loadData = useCallback(async () => {
    setIsLoading(true);
    try {
      const [projectsResult, templatesResult] = await Promise.all([
        window.goodvibes?.projectGetAll?.(),
        window.goodvibes?.templateGetAll?.(),
      ]);

      setProjects(projectsResult || []);
      setTemplates(templatesResult || []);

      // Load analytics for all projects in parallel (avoiding N+1 pattern)
      if (projectsResult?.length) {
        const analyticsResults = await Promise.all(
          projectsResult.map((project: RegisteredProject) =>
            window.goodvibes?.projectGetAnalytics?.(project.id)
          )
        );
        const analyticsMap = new Map<number, ProjectAnalytics>();
        projectsResult.forEach((project: RegisteredProject, index: number) => {
          const analytics = analyticsResults[index];
          if (analytics) {
            analyticsMap.set(project.id, analytics);
          }
        });
        setProjectAnalytics(analyticsMap);
      }
    } catch (error) {
      logger.error('Failed to load project registry data:', error);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Listen for project events with debouncing
  useEffect(() => {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    const handleProjectEvent = () => {
      // Debounce rapid events
      if (timeoutId) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        loadData();
      }, 300);
    };

    const cleanup = window.goodvibes?.onProjectEvent?.(handleProjectEvent);
    return () => {
      if (timeoutId) clearTimeout(timeoutId);
      cleanup?.();
    };
  }, [loadData]);

  const registerProject = async () => {
    const path = await window.goodvibes?.selectFolder?.();
    if (path) {
      await window.goodvibes?.projectRegister?.({ path });
      loadData();
    }
  };

  const removeProject = async (projectId: number) => {
    await window.goodvibes?.projectRemove?.(projectId);
    // Optimistic removal - update local state immediately
    setProjects((prev) => prev.filter((p) => p.id !== projectId));
    setProjectAnalytics((prev) => {
      const next = new Map(prev);
      next.delete(projectId);
      return next;
    });
  };

  const switchProject = async (projectId: number) => {
    await window.goodvibes?.projectSwitch?.(projectId);
    // No reload needed - switching just changes active project marker
  };

  const saveSettings = async (projectId: number, settings: ProjectSettings) => {
    await window.goodvibes?.projectUpdateSettings?.(projectId, settings as unknown as Record<string, unknown>);
    // Optimistic update - update local state immediately
    setProjects((prev) =>
      prev.map((p) =>
        p.id === projectId ? { ...p, settings: { ...p.settings, ...settings } } : p
      )
    );
  };

  const createTemplate = async (projectId: number, name: string, description: string) => {
    await window.goodvibes?.templateCreateFromProject?.({
      projectId,
      templateName: name,
      description,
    });
    loadData();
  };

  const applyTemplate = async (projectId: number, templateId: number) => {
    await window.goodvibes?.templateApply?.(projectId, templateId);
    loadData();
  };

  const deleteTemplate = async (templateId: number) => {
    await window.goodvibes?.templateDelete?.(templateId);
    // Optimistic removal
    setTemplates((prev) => prev.filter((t) => t.id !== templateId));
  };

  return {
    projects,
    templates,
    projectAnalytics,
    isLoading,
    loadData,
    registerProject,
    removeProject,
    switchProject,
    saveSettings,
    createTemplate,
    applyTemplate,
    deleteTemplate,
  };
}

export interface UseProjectFiltersReturn {
  filteredProjects: RegisteredProject[];
  searchQuery: string;
  setSearchQuery: (query: string) => void;
}

export function useProjectFilters(projects: RegisteredProject[]): UseProjectFiltersReturn {
  const [searchQuery, setSearchQuery] = useState('');

  const filteredProjects = searchQuery
    ? projects.filter(p =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.path.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.description?.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : projects;

  return {
    searchQuery,
    setSearchQuery,
    filteredProjects,
  };
}
