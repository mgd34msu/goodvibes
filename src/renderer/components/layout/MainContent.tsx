// ============================================================================
// MAIN CONTENT LAYOUT
// ============================================================================

import { Suspense, lazy, type ComponentType } from 'react';
import { useAppStore } from '../../stores/appStore';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { ErrorBoundary, type FallbackRenderProps } from '../common/ErrorBoundary';
import type { ViewName } from '../../../shared/constants';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('MainContent');

// Lazy load views for code splitting
const TerminalView = lazy(() => import('../views/TerminalView'));
const SessionsView = lazy(() => import('../views/SessionsView/index'));
const AnalyticsView = lazy(() => import('../views/AnalyticsView'));
const TasksView = lazy(() => import('../views/TasksView'));
const NotebookView = lazy(() => import('../views/NotebookView'));
const FilesView = lazy(() => import('../views/FilesView/index'));
const SettingsView = lazy(() => import('../views/SettingsView'));
const HooksView = lazy(() => import('../views/HooksView'));
const MCPView = lazy(() => import('../views/MCPView'));
const AgentsView = lazy(() => import('../views/AgentsView'));
const MemoryView = lazy(() => import('../views/MemoryView'));
const SkillsView = lazy(() => import('../views/SkillsView/index'));
const CommandsView = lazy(() => import('../views/CommandsView/index'));
const PluginsView = lazy(() => import('../views/PluginsView/index'));
// Project views
const ProjectRegistryView = lazy(() => import('../views/ProjectRegistryView/index'));

// ============================================================================
// VIEW CONFIGURATION
// Maps view names to their components and display names for error boundaries
// ============================================================================

interface ViewConfig {
  component: React.LazyExoticComponent<ComponentType>;
  displayName: string;
}

const VIEW_CONFIG: Record<ViewName, ViewConfig> = {
  terminal: { component: TerminalView, displayName: 'Terminal' },
  sessions: { component: SessionsView, displayName: 'Sessions' },
  analytics: { component: AnalyticsView, displayName: 'Analytics' },
  tasks: { component: TasksView, displayName: 'Tasks' },
  notebook: { component: NotebookView, displayName: 'Notebook' },
  files: { component: FilesView, displayName: 'Files' },
  settings: { component: SettingsView, displayName: 'Settings' },
  hooks: { component: HooksView, displayName: 'Hooks' },
  mcp: { component: MCPView, displayName: 'MCP Servers' },
  plugins: { component: PluginsView, displayName: 'Plugins' },
  agents: { component: AgentsView, displayName: 'Agents' },
  memory: { component: MemoryView, displayName: 'Memory' },
  skills: { component: SkillsView, displayName: 'Skills' },
  commands: { component: CommandsView, displayName: 'Commands' },
  projects: { component: ProjectRegistryView, displayName: 'Projects' },
};

// ============================================================================
// VIEW ERROR FALLBACK
// Provides view-specific error UI with the view name displayed
// ============================================================================

interface ViewErrorFallbackProps extends FallbackRenderProps {
  viewName: string;
}

function ViewErrorFallback({
  error,
  errorInfo,
  resetErrorBoundary,
  isDevelopment,
  viewName,
}: ViewErrorFallbackProps): React.JSX.Element {
  return (
    <div
      role="alert"
      aria-live="assertive"
      className="flex flex-col items-center justify-center h-full p-8 text-center"
    >
      {/* Error Icon */}
      <div className="w-16 h-16 mx-auto mb-6 rounded-full bg-error-500/20 flex items-center justify-center">
        <svg
          className="w-8 h-8 text-error-500"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"
          />
        </svg>
      </div>

      {/* Error Title with View Name */}
      <h2 className="text-xl font-semibold text-surface-100 mb-2">
        {viewName} View Error
      </h2>

      {/* User-friendly message */}
      <p className="text-surface-400 mb-6 max-w-md">
        {isDevelopment
          ? `An error occurred in the ${viewName} view. Check the details below for debugging information.`
          : `The ${viewName} view encountered an error. Please try again or switch to a different view.`}
      </p>

      {/* Development mode: Show error details */}
      {isDevelopment && (
        <div className="mb-6 text-left max-w-2xl w-full">
          <div className="mb-4 p-4 bg-error-500/10 border border-error-500/30 rounded-lg">
            <h3 className="text-sm font-medium text-error-400 mb-2">Error Message</h3>
            <code className="text-sm text-error-300 font-mono break-all">
              {error.message}
            </code>
          </div>

          {error.stack && (
            <details className="mb-4">
              <summary className="cursor-pointer text-sm text-surface-400 hover:text-surface-200 font-medium">
                Stack Trace
              </summary>
              <pre className="mt-2 p-4 bg-surface-900 rounded-lg text-xs text-surface-300 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
                {error.stack}
              </pre>
            </details>
          )}

          {errorInfo?.componentStack && (
            <details>
              <summary className="cursor-pointer text-sm text-surface-400 hover:text-surface-200 font-medium">
                Component Stack
              </summary>
              <pre className="mt-2 p-4 bg-surface-900 rounded-lg text-xs text-surface-300 overflow-auto max-h-48 font-mono whitespace-pre-wrap">
                {errorInfo.componentStack}
              </pre>
            </details>
          )}
        </div>
      )}

      {/* Action Button */}
      <button
        onClick={resetErrorBoundary}
        className="btn btn-primary flex items-center gap-2"
        type="button"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          aria-hidden="true"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
          />
        </svg>
        Retry {viewName}
      </button>
    </div>
  );
}

// ============================================================================
// VIEW WRAPPER
// Wraps individual views with their own ErrorBoundary for isolated error handling
// ============================================================================

interface ViewWrapperProps {
  viewName: ViewName;
}

function ViewWrapper({ viewName }: ViewWrapperProps): React.JSX.Element {
  const config = VIEW_CONFIG[viewName];
  const ViewComponent = config.component;

  return (
    <ErrorBoundary
      resetKeys={[viewName]}
      onError={(error, errorInfo) => {
        logger.error(`Error in ${config.displayName} view:`, error.message);
        logger.debug('Error details:', { error, errorInfo });
      }}
      fallbackRender={(props) => (
        <ViewErrorFallback {...props} viewName={config.displayName} />
      )}
    >
      <Suspense fallback={<ViewLoader />}>
        <ViewComponent />
      </Suspense>
    </ErrorBoundary>
  );
}

// ============================================================================
// MAIN CONTENT
// ============================================================================

export function MainContent(): React.JSX.Element {
  const currentView = useAppStore((s) => s.currentView);

  return (
    <div className="flex-1 overflow-hidden h-full">
      <ViewWrapper viewName={currentView} />
    </div>
  );
}

function ViewLoader() {
  return (
    <div className="flex items-center justify-center h-full">
      <LoadingSpinner size="lg" />
    </div>
  );
}
