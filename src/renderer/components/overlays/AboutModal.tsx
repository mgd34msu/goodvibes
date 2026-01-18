// ============================================================================
// ABOUT MODAL COMPONENT
// Premium cinematic modal with glass morphism
// ============================================================================

import { X, Zap } from 'lucide-react';
import { useAppStore } from '../../stores/appStore';

export function AboutModal(): React.JSX.Element | null {
  const activeModal = useAppStore((s) => s.activeModal);
  const closeModal = useAppStore((s) => s.closeModal);

  if (activeModal !== 'about') return null;

  return (
    <div className="modal-backdrop-premium" onClick={closeModal}>
      <div
        className="modal-panel-premium modal-sm"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="modal-header-premium">
          <h2>About GoodVibes</h2>
          <button onClick={closeModal} className="modal-close-premium">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Content */}
        <div className="modal-body-premium text-center">
          {/* Logo */}
          <div className="modal-icon-container icon-info mx-auto mb-4">
            <Zap className="w-7 h-7 text-violet-400" strokeWidth={1.5} />
          </div>

          <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-100 to-violet-300 bg-clip-text text-transparent mb-1">
            GoodVibes
          </h1>
          <p className="text-sm text-slate-400 mb-6">
            A powerful desktop companion for Claude CLI
          </p>

          {/* Version Info */}
          <div className="space-y-2 text-sm">
            <div className="flex items-center justify-between px-4 py-2.5 bg-white/[0.03] rounded-xl border border-white/[0.06]">
              <span className="text-slate-400">Version</span>
              <span className="font-mono text-slate-200 bg-violet-500/10 px-2 py-0.5 rounded-md">1.0.0</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 bg-white/[0.03] rounded-xl border border-white/[0.06]">
              <span className="text-slate-400">Electron</span>
              <span className="font-mono text-slate-300">{process.versions.electron || 'N/A'}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 bg-white/[0.03] rounded-xl border border-white/[0.06]">
              <span className="text-slate-400">Node.js</span>
              <span className="font-mono text-slate-300">{process.versions.node || 'N/A'}</span>
            </div>
            <div className="flex items-center justify-between px-4 py-2.5 bg-white/[0.03] rounded-xl border border-white/[0.06]">
              <span className="text-slate-400">Chrome</span>
              <span className="font-mono text-slate-300">{process.versions.chrome || 'N/A'}</span>
            </div>
          </div>

          {/* Footer text */}
          <div className="mt-6 pt-4 border-t border-white/[0.06]">
            <p className="text-xs text-slate-500">
              Built with Electron, React, and Tailwind CSS
            </p>
            <p className="text-xs text-slate-600 mt-1">
              Manage Claude CLI sessions with style
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="modal-footer-premium justify-center">
          <button onClick={closeModal} className="btn btn-primary min-w-[100px]">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
