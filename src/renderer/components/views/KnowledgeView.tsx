// ============================================================================
// KNOWLEDGE VIEW COMPONENT
// ============================================================================

import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import type { KnowledgeEntry } from '../../../shared/types';
import { formatRelativeTime } from '../../../shared/utils';
import { toast } from '../../stores/toastStore';

export default function KnowledgeView() {
  const [search, setSearch] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [selectedEntry, setSelectedEntry] = useState<KnowledgeEntry | null>(null);
  const [isNewEntryModalOpen, setIsNewEntryModalOpen] = useState(false);
  const [editingEntry, setEditingEntry] = useState<KnowledgeEntry | null>(null);
  const queryClient = useQueryClient();

  const { data: entries = [], isLoading } = useQuery<KnowledgeEntry[]>({
    queryKey: ['knowledge', search],
    queryFn: () =>
      search
        ? window.goodvibes.searchKnowledge(search)
        : window.goodvibes.getAllKnowledgeEntries(),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => window.goodvibes.deleteKnowledgeEntry(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge'] });
      setSelectedEntry(null);
      toast.info('Entry deleted');
    },
  });

  const createMutation = useMutation({
    mutationFn: (data: { title: string; content: string; category?: string }) =>
      window.goodvibes.createKnowledgeEntry(data.title, data.content, data.category),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge'] });
      setIsNewEntryModalOpen(false);
      toast.success('Entry created');
    },
    onError: () => {
      toast.error('Failed to create entry');
    },
  });

  const updateMutation = useMutation({
    mutationFn: (data: { id: number; title: string; content: string; category?: string }) =>
      window.goodvibes.updateKnowledgeEntry(data.id, data.title, data.content, data.category),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['knowledge'] });
      setEditingEntry(null);
      setSelectedEntry(null);
      toast.success('Entry updated');
    },
    onError: () => {
      toast.error('Failed to update entry');
    },
  });

  const handleEditEntry = (entry: KnowledgeEntry) => {
    setEditingEntry(entry);
    setSelectedEntry(null);
  };

  // Get unique categories
  const categories = [...new Set(entries.map((e) => e.category).filter(Boolean))];

  // Filter by category
  const filteredEntries = selectedCategory
    ? entries.filter((e) => e.category === selectedCategory)
    : entries;

  return (
    <div className="h-full flex">
      {/* Sidebar */}
      <div className="w-64 border-r border-surface-800/80 bg-surface-900/50 flex flex-col">
        <div className="p-4 border-b border-surface-800/50">
          <div className="relative">
            <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-surface-500" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder="Search knowledge..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="input w-full pl-10"
            />
          </div>
        </div>

        <div className="flex-1 overflow-auto p-3">
          <div className="section-header-pro mb-3">
            <h2>Categories</h2>
          </div>
          <div className="space-y-1">
            <button
              onClick={() => setSelectedCategory(null)}
              className={clsx(
                'w-full px-3 py-2 text-sm text-left rounded-lg transition-all duration-150 flex items-center justify-between',
                selectedCategory === null
                  ? 'bg-primary-500 text-white shadow-sm'
                  : 'text-surface-400 hover:bg-surface-800/70 hover:text-surface-200'
              )}
            >
              <span>All Categories</span>
              <span className={clsx(
                'text-xs px-2 py-0.5 rounded-full',
                selectedCategory === null ? 'bg-white/20' : 'bg-surface-700'
              )}>{entries.length}</span>
            </button>
            {categories.map((category) => {
              const count = entries.filter(e => e.category === category).length;
              return (
                <button
                  key={category}
                  onClick={() => setSelectedCategory(category!)}
                  className={clsx(
                    'w-full px-3 py-2 text-sm text-left rounded-lg transition-all duration-150 flex items-center justify-between',
                    selectedCategory === category
                      ? 'bg-primary-500 text-white shadow-sm'
                      : 'text-surface-400 hover:bg-surface-800/70 hover:text-surface-200'
                  )}
                >
                  <span>{category}</span>
                  <span className={clsx(
                    'text-xs px-2 py-0.5 rounded-full',
                    selectedCategory === category ? 'bg-white/20' : 'bg-surface-700'
                  )}>{count}</span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-800/80 bg-surface-900/30">
          <div>
            <h1 className="text-xl font-semibold text-surface-100">Knowledge Base</h1>
            <p className="text-sm text-surface-500 mt-0.5">
              {filteredEntries.length} {filteredEntries.length === 1 ? 'entry' : 'entries'}
              {selectedCategory && ` in ${selectedCategory}`}
            </p>
          </div>
          <button
            onClick={() => setIsNewEntryModalOpen(true)}
            className="btn btn-primary"
          >
            <svg className="w-4 h-4 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
            New Entry
          </button>
        </div>

        {/* Entries List */}
        <div className="flex-1 overflow-auto p-6">
          {isLoading ? (
            <LoadingSkeleton />
          ) : filteredEntries.length === 0 ? (
            <EmptyState />
          ) : (
            <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
              {filteredEntries.map((entry) => (
                <EntryCard
                  key={entry.id}
                  entry={entry}
                  onClick={() => setSelectedEntry(entry)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Detail Panel */}
      {selectedEntry && (
        <EntryDetailPanel
          entry={selectedEntry}
          onClose={() => setSelectedEntry(null)}
          onEdit={() => handleEditEntry(selectedEntry)}
          onDelete={() => deleteMutation.mutate(selectedEntry.id)}
        />
      )}

      {/* New Entry Modal */}
      {isNewEntryModalOpen && (
        <EntryFormModal
          title="New Entry"
          onClose={() => setIsNewEntryModalOpen(false)}
          onSave={(data) => createMutation.mutate(data)}
          isLoading={createMutation.isPending}
          categories={categories as string[]}
        />
      )}

      {/* Edit Entry Modal */}
      {editingEntry && (
        <EntryFormModal
          title="Edit Entry"
          initialData={editingEntry}
          onClose={() => setEditingEntry(null)}
          onSave={(data) => updateMutation.mutate({ id: editingEntry.id, ...data })}
          isLoading={updateMutation.isPending}
          categories={categories as string[]}
        />
      )}
    </div>
  );
}

// ============================================================================
// ENTRY CARD
// ============================================================================

function EntryCard({ entry, onClick }: { entry: KnowledgeEntry; onClick: () => void }) {
  return (
    <div
      onClick={onClick}
      className="card-interactive group"
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <h3 className="text-sm font-semibold text-surface-100 truncate group-hover:text-primary-400 transition-colors">
          {entry.title}
        </h3>
        <svg className="w-4 h-4 text-surface-600 group-hover:text-primary-400 transition-colors flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </div>
      <p className="text-xs text-surface-400 line-clamp-2 mb-3 leading-relaxed">
        {entry.content.substring(0, 120)}...
      </p>
      <div className="flex items-center justify-between text-xs">
        {entry.category ? (
          <span className="inline-flex items-center px-2 py-0.5 rounded-full text-2xs font-medium bg-primary-500/15 text-primary-400 border border-primary-500/20">
            {entry.category}
          </span>
        ) : (
          <span className="text-surface-600">Uncategorized</span>
        )}
        <span className="text-surface-500 flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
          </svg>
          {entry.viewCount}
        </span>
      </div>
    </div>
  );
}

// ============================================================================
// ENTRY DETAIL PANEL
// ============================================================================

interface EntryDetailPanelProps {
  entry: KnowledgeEntry;
  onClose: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

function EntryDetailPanel({ entry, onClose, onEdit, onDelete }: EntryDetailPanelProps) {
  return (
    <div className="w-96 border-l border-surface-800 flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-surface-700">
        <h3 className="text-sm font-medium text-surface-100">Entry Details</h3>
        <button onClick={onClose} className="p-1 rounded hover:bg-surface-800 text-surface-400">
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-surface-100">{entry.title}</h2>
          {entry.category && (
            <span className="badge badge-primary mt-1">{entry.category}</span>
          )}
        </div>

        <div className="text-sm text-surface-300 whitespace-pre-wrap">
          {entry.content}
        </div>

        <div className="text-xs text-surface-500 space-y-1">
          <div>Created: {formatRelativeTime(entry.createdAt)}</div>
          <div>Updated: {formatRelativeTime(entry.updatedAt)}</div>
          <div>Views: {entry.viewCount}</div>
        </div>
      </div>

      <div className="flex items-center gap-2 px-4 py-3 border-t border-surface-700">
        <button
          onClick={onEdit}
          className="btn btn-secondary btn-sm flex-1"
        >
          Edit
        </button>
        <button
          onClick={onDelete}
          className="btn btn-danger btn-sm flex-1"
        >
          Delete
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// ENTRY FORM MODAL
// ============================================================================

interface EntryFormModalProps {
  title: string;
  initialData?: KnowledgeEntry;
  onClose: () => void;
  onSave: (data: { title: string; content: string; category?: string }) => void;
  isLoading: boolean;
  categories: string[];
}

function EntryFormModal({ title, initialData, onClose, onSave, isLoading, categories }: EntryFormModalProps) {
  const [formTitle, setFormTitle] = React.useState(initialData?.title ?? '');
  const [formContent, setFormContent] = React.useState(initialData?.content ?? '');
  const [formCategory, setFormCategory] = React.useState(initialData?.category ?? '');
  const [newCategory, setNewCategory] = React.useState('');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!formTitle.trim() || !formContent.trim()) return;

    const category = newCategory.trim() || formCategory || undefined;
    onSave({ title: formTitle.trim(), content: formContent.trim(), category });
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-surface-950/80 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg bg-surface-900 border border-surface-700 rounded-xl shadow-elevation-5 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-6 py-4 border-b border-surface-700">
          <h2 className="text-lg font-semibold text-surface-100">{title}</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-surface-800 text-surface-400">
            <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <form onSubmit={handleSubmit} className="p-6 space-y-4">
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1.5">Title</label>
            <input
              type="text"
              value={formTitle}
              onChange={(e) => setFormTitle(e.target.value)}
              placeholder="Entry title..."
              className="input"
              autoFocus
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1.5">Content</label>
            <textarea
              value={formContent}
              onChange={(e) => setFormContent(e.target.value)}
              placeholder="Enter your knowledge..."
              className="input resize-none"
              rows={6}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1.5">Category</label>
            <div className="flex gap-2">
              <select
                value={formCategory}
                onChange={(e) => {
                  setFormCategory(e.target.value);
                  setNewCategory('');
                }}
                className="select flex-1"
              >
                <option value="">Select category...</option>
                {categories.map((cat) => (
                  <option key={cat} value={cat}>{cat}</option>
                ))}
              </select>
              <span className="text-surface-500 self-center">or</span>
              <input
                type="text"
                value={newCategory}
                onChange={(e) => {
                  setNewCategory(e.target.value);
                  setFormCategory('');
                }}
                placeholder="New category..."
                className="input flex-1"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-4 border-t border-surface-700">
            <button type="button" onClick={onClose} className="btn btn-secondary">
              Cancel
            </button>
            <button
              type="submit"
              disabled={!formTitle.trim() || !formContent.trim() || isLoading}
              className="btn btn-primary"
            >
              {isLoading ? 'Saving...' : 'Save Entry'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ============================================================================
// EMPTY STATE
// ============================================================================

function EmptyState() {
  return (
    <div className="empty-state-pro">
      <div className="empty-icon-wrap">
        <span className="emoji-icon">📚</span>
      </div>
      <h3>No knowledge entries</h3>
      <p>Build your personal knowledge base by adding entries. Store code snippets, documentation, or any useful information.</p>
    </div>
  );
}

// ============================================================================
// LOADING SKELETON
// ============================================================================

function LoadingSkeleton() {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="card p-4">
          <div className="flex items-start justify-between mb-2">
            <div className="h-4 w-3/4 skeleton rounded" />
            <div className="w-4 h-4 skeleton rounded flex-shrink-0" />
          </div>
          <div className="space-y-1.5 mb-3">
            <div className="h-3 w-full skeleton rounded" />
            <div className="h-3 w-4/5 skeleton rounded" />
          </div>
          <div className="flex items-center justify-between">
            <div className="h-5 w-20 skeleton rounded-full" />
            <div className="h-4 w-12 skeleton rounded" />
          </div>
        </div>
      ))}
    </div>
  );
}
