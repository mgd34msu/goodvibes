// ============================================================================
// INSTALL HOOK MODAL
// Modal for selecting scope and project when installing built-in hooks
// ============================================================================

import { Download, Terminal, Tag } from 'lucide-react';
import { InstallItemModal } from '../../common/InstallItemModal';
import { EVENT_TYPE_ICONS } from './types';
import { CATEGORY_COLORS, CATEGORY_LABELS, type BuiltinHook } from './builtinHooks';

// ============================================================================
// TYPES
// ============================================================================

interface InstallHookModalProps {
  hook: BuiltinHook;
  isOpen: boolean;
  onClose: () => void;
  onInstall: (hook: BuiltinHook, scope: 'user' | 'project', projectPath: string | null) => void;
}

// ============================================================================
// COMPONENT
// ============================================================================

export function InstallHookModal({
  hook,
  isOpen,
  onClose,
  onInstall,
}: InstallHookModalProps) {
  return (
    <InstallItemModal<BuiltinHook>
      item={hook}
      isOpen={isOpen}
      onClose={onClose}
      onInstall={onInstall}
      modalTitle="Install Hook"
      itemDisplayName={hook.name}
      installButtonText="Install Hook"
      headerIcon={<Download className="w-5 h-5 text-accent-purple" />}
      previewTitle="Hook Preview"
      itemKey={hook.id}
      renderPreview={(hook) => (
        <>
          {/* Name and Category */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="flex items-center gap-2">
              {EVENT_TYPE_ICONS[hook.eventType]}
              <span className="font-medium text-surface-200">{hook.name}</span>
            </div>
            <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs border ${CATEGORY_COLORS[hook.category]}`}>
              {CATEGORY_LABELS[hook.category]}
            </span>
          </div>

          {/* Description */}
          <p className="text-sm text-surface-400">{hook.description}</p>

          {/* Details Grid */}
          <div className="grid grid-cols-3 gap-3 pt-2">
            <div className="bg-surface-900/50 rounded p-2">
              <span className="text-xs text-surface-500 block">Event</span>
              <span className="text-sm text-surface-300 font-mono">{hook.eventType}</span>
            </div>
            <div className="bg-surface-900/50 rounded p-2">
              <span className="text-xs text-surface-500 block">Matcher</span>
              <span className="text-sm text-surface-300 font-mono">{hook.matcher || 'None'}</span>
            </div>
            <div className="bg-surface-900/50 rounded p-2">
              <span className="text-xs text-surface-500 block">Timeout</span>
              <span className="text-sm text-surface-300 font-mono">{hook.timeout}ms</span>
            </div>
          </div>

          {/* Type Badge */}
          <div className="flex items-center gap-2 pt-1">
            <Terminal className="w-3.5 h-3.5 text-surface-500" />
            <span className="text-xs text-surface-500">
              {hook.hookType === 'command' ? 'Shell Command' : 'Prompt Hook'}
            </span>
          </div>

          {/* Tags */}
          {hook.tags.length > 0 && (
            <div className="flex items-center gap-2 flex-wrap pt-1">
              {hook.tags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="inline-flex items-center gap-1 px-1.5 py-0.5 bg-surface-900 text-surface-500 rounded text-xs"
                >
                  <Tag className="w-2.5 h-2.5" />
                  {tag}
                </span>
              ))}
              {hook.tags.length > 4 && (
                <span className="text-xs text-surface-600">
                  +{hook.tags.length - 4} more
                </span>
              )}
            </div>
          )}
        </>
      )}
    />
  );
}
