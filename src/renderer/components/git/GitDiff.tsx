// ============================================================================
// GIT DIFF COMPONENT - Diff viewing modal
// ============================================================================

import { clsx } from 'clsx';

interface GitDiffProps {
  isOpen: boolean;
  diffFile: string | null;
  diffContent: string | null;
  diffIsStaged: boolean;
  diffCommit: string | null;
  isLoadingDiff: boolean;
  onClose: () => void;
}

export function GitDiff({
  isOpen,
  diffFile,
  diffContent,
  diffIsStaged,
  diffCommit,
  isLoadingDiff,
  onClose,
}: GitDiffProps) {
  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-4xl max-h-[85vh] bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
          <div className="flex items-center gap-3">
            <svg className="w-5 h-5 text-primary-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
            </svg>
            <span className="font-medium text-surface-100">Diff: {diffFile}</span>
            {diffIsStaged && (
              <span className="px-2 py-0.5 text-xs bg-success-500/20 text-success-400 rounded">Staged</span>
            )}
            {diffCommit && (
              <span className="px-2 py-0.5 text-xs bg-primary-500/20 text-primary-400 rounded font-mono">
                {diffCommit.substring(0, 7)}
              </span>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-surface-800 text-surface-400 hover:text-surface-200 transition-colors"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Modal Content */}
        <div className="flex-1 overflow-auto bg-surface-950">
          {isLoadingDiff ? (
            <div className="flex items-center justify-center py-12">
              <div className="animate-spin w-6 h-6 border-2 border-surface-600 border-t-primary-500 rounded-full" />
            </div>
          ) : diffContent ? (
            <DiffContent content={diffContent} />
          ) : (
            <div className="text-center py-8 text-surface-500">
              No differences to display
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// DIFF CONTENT RENDERER
// ============================================================================

interface DiffContentProps {
  content: string;
}

function DiffContent({ content }: DiffContentProps) {
  return (
    <pre className="p-4 text-xs font-mono overflow-x-auto">
      {content.split('\n').map((line, idx) => {
        let lineClass = 'text-surface-400';
        let bgClass = '';

        if (line.startsWith('+') && !line.startsWith('+++')) {
          lineClass = 'text-success-400';
          bgClass = 'bg-success-500/10';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          lineClass = 'text-error-400';
          bgClass = 'bg-error-500/10';
        } else if (line.startsWith('@@')) {
          lineClass = 'text-info-400';
          bgClass = 'bg-info-500/10';
        } else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) {
          lineClass = 'text-surface-500';
        }

        return (
          <div key={idx} className={clsx('px-2 -mx-2', bgClass, lineClass)}>
            {line || ' '}
          </div>
        );
      })}
    </pre>
  );
}
