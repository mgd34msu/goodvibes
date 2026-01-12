// ============================================================================
// ABOUT MODAL COMPONENT
// ============================================================================

import { useAppStore } from '../../stores/appStore';

export function AboutModal() {
  const activeModal = useAppStore((s) => s.activeModal);
  const closeModal = useAppStore((s) => s.closeModal);

  if (activeModal !== 'about') return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={closeModal}
    >
      <div
        className="w-full max-w-md bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-700">
          <h2 className="text-lg font-semibold text-surface-100">About GoodVibes</h2>
          <button
            onClick={closeModal}
            className="p-1 rounded-lg hover:bg-surface-800 text-surface-400"
          >
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6 text-center">
          <div className="text-5xl mb-4">⚡</div>
          <h1 className="text-2xl font-bold text-surface-100 mb-1">GoodVibes</h1>
          <p className="text-sm text-surface-400 mb-4">A powerful desktop companion for Claude CLI</p>

          <div className="space-y-3 text-sm">
            <div className="flex items-center justify-between px-4 py-2 bg-surface-800 rounded-lg">
              <span className="text-surface-400">Version</span>
              <span className="text-surface-100 font-mono">1.0.0</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2 bg-surface-800 rounded-lg">
              <span className="text-surface-400">Electron</span>
              <span className="text-surface-100 font-mono">{process.versions.electron || 'N/A'}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2 bg-surface-800 rounded-lg">
              <span className="text-surface-400">Node.js</span>
              <span className="text-surface-100 font-mono">{process.versions.node || 'N/A'}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2 bg-surface-800 rounded-lg">
              <span className="text-surface-400">Chrome</span>
              <span className="text-surface-100 font-mono">{process.versions.chrome || 'N/A'}</span>
            </div>
          </div>

          <div className="mt-6 pt-4 border-t border-surface-700">
            <p className="text-xs text-surface-500">
              Built with Electron, React, and Tailwind CSS
            </p>
            <p className="text-xs text-surface-600 mt-1">
              Manage Claude CLI sessions with style
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-center px-6 py-4 border-t border-surface-700">
          <button onClick={closeModal} className="btn btn-primary">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
