// ============================================================================
// TERMINAL FOOTER - Premium zoom controls and session info
// ============================================================================

import { useMemo } from 'react';
import { clsx } from 'clsx';
import { useTerminalStore } from '../../stores/terminalStore';

// ============================================================================
// COMPONENT
// ============================================================================

export function TerminalFooter() {
  const terminalsMap = useTerminalStore((s) => s.terminals);
  const activeTerminalId = useTerminalStore((s) => s.activeTerminalId);
  const activeTerminal = useMemo(
    () => activeTerminalId ? terminalsMap.get(activeTerminalId) : undefined,
    [terminalsMap, activeTerminalId]
  );
  const zoomLevel = useTerminalStore((s) => s.zoomLevel);
  const setZoomLevel = useTerminalStore((s) => s.setZoomLevel);

  const handleZoomIn = () => setZoomLevel(zoomLevel + 10);
  const handleZoomOut = () => setZoomLevel(zoomLevel - 10);
  const handleZoomReset = () => setZoomLevel(100);

  return (
    <div className="footer-premium flex items-center justify-between px-4 py-2.5">
      {/* Session Path Info */}
      <div className="flex items-center gap-3 min-w-0">
        <div className="flex items-center gap-2 text-surface-500">
          <svg className="w-3.5 h-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
          </svg>
          <span className="text-xs font-medium truncate max-w-[300px] text-surface-400">
            {activeTerminal?.cwd || 'No folder selected'}
          </span>
        </div>
      </div>

      {/* Zoom Controls - Premium Style */}
      <div className="flex items-center gap-1" role="group" aria-label="Zoom controls">
        <button
          onClick={handleZoomOut}
          className="btn-premium-ghost w-7 h-7 flex items-center justify-center text-surface-400 hover:text-surface-200 rounded-md"
          title="Zoom Out (Ctrl+-)"
          aria-label="Zoom out"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M20 12H4" />
          </svg>
        </button>

        <div
          className={clsx(
            'min-w-[52px] px-2 py-1 text-center text-xs font-medium rounded-md transition-colors',
            zoomLevel === 100
              ? 'text-surface-400 bg-transparent'
              : 'text-primary-400 bg-primary-500/10'
          )}
          id="zoom-level"
          aria-live="polite"
        >
          {zoomLevel}%
        </div>

        <button
          onClick={handleZoomIn}
          className="btn-premium-ghost w-7 h-7 flex items-center justify-center text-surface-400 hover:text-surface-200 rounded-md"
          title="Zoom In (Ctrl++)"
          aria-label="Zoom in"
        >
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 4v16m8-8H4" />
          </svg>
        </button>

        <div className="w-px h-4 bg-surface-700/50 mx-1" />

        <button
          onClick={handleZoomReset}
          className={clsx(
            'btn-premium-ghost px-2.5 py-1 text-xs font-medium rounded-md transition-all duration-200',
            zoomLevel === 100
              ? 'text-surface-500 cursor-default'
              : 'text-surface-300 hover:text-white hover:bg-surface-700/50'
          )}
          title="Reset Zoom (Ctrl+0)"
          aria-label="Reset zoom to 100%"
          disabled={zoomLevel === 100}
        >
          Reset
        </button>
      </div>
    </div>
  );
}

export default TerminalFooter;
