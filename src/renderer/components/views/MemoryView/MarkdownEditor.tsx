// ============================================================================
// MARKDOWN EDITOR COMPONENT
// ============================================================================

import { useState, useRef } from 'react';
import { Edit2, Eye } from 'lucide-react';

interface MarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  readOnly?: boolean;
}

export function MarkdownEditor({
  value,
  onChange,
  placeholder,
  readOnly,
}: MarkdownEditorProps) {
  const [showPreview, setShowPreview] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  return (
    <div className="flex flex-col h-full border border-surface-700 rounded-lg overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-surface-800 border-b border-surface-700">
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowPreview(false)}
            className={`px-2 py-1 text-sm rounded ${
              !showPreview
                ? 'bg-surface-700 text-surface-200'
                : 'text-surface-400 hover:text-surface-200'
            }`}
          >
            <Edit2 className="w-4 h-4 inline mr-1" />
            Edit
          </button>
          <button
            onClick={() => setShowPreview(true)}
            className={`px-2 py-1 text-sm rounded ${
              showPreview
                ? 'bg-surface-700 text-surface-200'
                : 'text-surface-400 hover:text-surface-200'
            }`}
          >
            <Eye className="w-4 h-4 inline mr-1" />
            Preview
          </button>
        </div>

        <div className="text-xs text-surface-500">{value.length} characters</div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        {showPreview ? (
          <div className="p-4 prose prose-invert prose-sm max-w-none">
            <pre className="whitespace-pre-wrap text-surface-200 font-sans">
              {value || 'Nothing to preview'}
            </pre>
          </div>
        ) : (
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder={placeholder}
            readOnly={readOnly}
            className="w-full h-full p-4 bg-transparent text-surface-100 font-mono text-sm resize-none focus:outline-none"
            spellCheck={false}
          />
        )}
      </div>
    </div>
  );
}
