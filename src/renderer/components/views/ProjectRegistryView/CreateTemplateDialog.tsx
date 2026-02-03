// ============================================================================
// CREATE TEMPLATE DIALOG
// ============================================================================

import { useState } from 'react';
import type { RegisteredProject } from './types';

interface CreateTemplateDialogProps {
  project: RegisteredProject;
  onCreate: (name: string, description: string) => void;
  onClose: () => void;
}

export function CreateTemplateDialog({
  project,
  onCreate,
  onClose,
}: CreateTemplateDialogProps) {
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
