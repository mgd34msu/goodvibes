// ============================================================================
// MAIN CONTENT LAYOUT
// ============================================================================

import { Suspense, lazy } from 'react';
import { useAppStore } from '../../stores/appStore';
import { LoadingSpinner } from '../common/LoadingSpinner';
import { ErrorBoundary } from '../common/ErrorBoundary';
import type { ViewName } from '../../../shared/constants';

// Lazy load views for code splitting
const TerminalView = lazy(() => import('../views/TerminalView'));
const SessionsView = lazy(() => import('../views/SessionsView'));
const AnalyticsView = lazy(() => import('../views/AnalyticsView'));
const NotesView = lazy(() => import('../views/NotesView'));
const KnowledgeView = lazy(() => import('../views/KnowledgeView'));
const SettingsView = lazy(() => import('../views/SettingsView'));
const HooksView = lazy(() => import('../views/HooksView'));
const MCPView = lazy(() => import('../views/MCPView'));
const AgentsView = lazy(() => import('../views/AgentsView'));
const MemoryView = lazy(() => import('../views/MemoryView'));
const SkillsView = lazy(() => import('../views/SkillsView'));
const MonitorView = lazy(() => import('../views/MonitorView'));
// Phase 9-12 views
const ProjectRegistryView = lazy(() => import('../views/ProjectRegistryView'));

const VIEW_COMPONENTS: Record<ViewName, React.LazyExoticComponent<() => React.JSX.Element>> = {
  terminal: TerminalView,
  sessions: SessionsView,
  analytics: AnalyticsView,
  notes: NotesView,
  knowledge: KnowledgeView,
  settings: SettingsView,
  hooks: HooksView,
  mcp: MCPView,
  agents: AgentsView,
  memory: MemoryView,
  skills: SkillsView,
  monitor: MonitorView,
  // Phase 9-12 views
  projects: ProjectRegistryView,
};

export function MainContent() {
  const currentView = useAppStore((s) => s.currentView);
  const ViewComponent = VIEW_COMPONENTS[currentView];

  return (
    <div className="flex-1 overflow-hidden h-full">
      <ErrorBoundary
        resetKeys={[currentView]}
        onError={(error, errorInfo) => {
          console.error(`Error in ${currentView} view:`, error, errorInfo);
        }}
      >
        <Suspense fallback={<ViewLoader />}>
          <ViewComponent />
        </Suspense>
      </ErrorBoundary>
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
