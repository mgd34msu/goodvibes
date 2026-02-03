// ============================================================================
// TASKS VIEW COMPONENT
// ============================================================================

import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import type { QuickNote } from '../../../shared/types';
import { formatRelativeTime } from '../../../shared/utils';
import { toast } from '../../stores/toastStore';

export default function TasksView() {
  const [filter, setFilter] = useState<'active' | 'completed'>('active');
  const [newNoteContent, setNewNoteContent] = useState('');
  const queryClient = useQueryClient();

  const { data: notes = [], isLoading } = useQuery<QuickNote[]>({
    queryKey: ['notes', filter],
    queryFn: () => window.goodvibes.getQuickNotes(filter),
  });

  const createMutation = useMutation({
    mutationFn: (content: string) => window.goodvibes.createQuickNote(content),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      setNewNoteContent('');
      toast.success('Task created');
    },
    onError: () => {
      toast.error('Failed to create task');
    },
  });

  const statusMutation = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) =>
      window.goodvibes.setQuickNoteStatus(id, status),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
    },
    onError: () => {
      toast.error('Failed to update task status');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: number) => window.goodvibes.deleteQuickNote(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['notes'] });
      toast.info('Task deleted');
    },
    onError: () => {
      toast.error('Failed to delete task');
    },
  });

  const handleCreateNote = () => {
    if (newNoteContent.trim()) {
      createMutation.mutate(newNoteContent.trim());
    }
  };

  return (
    <div className="h-full overflow-auto">
      <div className="max-w-3xl mx-auto px-6 py-6 space-y-6">
        {/* Header */}
        <div className="page-header">
          <div>
            <h1 className="text-xl font-semibold text-surface-100">Task List</h1>
            <p className="text-sm text-surface-500 mt-1">Track your To-Dos and Tasks</p>
          </div>
        </div>

        {/* New Task Input */}
        <div className="card-elevated rounded-xl overflow-hidden">
          <textarea
            value={newNoteContent}
            onChange={(e) => setNewNoteContent(e.target.value)}
            placeholder="Enter new task ..."
            className="w-full bg-transparent text-surface-100 placeholder:text-surface-500 resize-none outline-none p-4 min-h-[100px] text-sm leading-relaxed"
            rows={3}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && e.ctrlKey) {
                handleCreateNote();
              }
            }}
          />
          <div className="flex items-center justify-between px-4 py-3 bg-surface-800/30 border-t border-surface-700/50">
            <span className="text-xs text-surface-500 flex items-center gap-1.5">
              <kbd className="px-1.5 py-0.5 bg-surface-700 rounded text-surface-400 text-2xs">Ctrl</kbd>
              <span>+</span>
              <kbd className="px-1.5 py-0.5 bg-surface-700 rounded text-surface-400 text-2xs">Enter</kbd>
              <span className="ml-1">to save</span>
            </span>
            <button
              onClick={handleCreateNote}
              disabled={!newNoteContent.trim() || createMutation.isPending}
              className="btn btn-primary btn-sm"
            >
              {createMutation.isPending ? 'Saving...' : 'Add Task'}
            </button>
          </div>
        </div>

        {/* Filter Tabs */}
        <div className="filter-pills">
          {(['active', 'completed'] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={clsx('filter-pill', filter === f && 'active')}
            >
              {f.charAt(0).toUpperCase() + f.slice(1)}
              {f === 'active' && notes.filter(n => n.status === 'active').length > 0 && (
                <span className="ml-1.5 text-xs opacity-70">
                  ({filter === 'active' ? notes.length : notes.filter(n => n.status === 'active').length})
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Tasks List */}
        {isLoading ? (
          <LoadingSkeleton />
        ) : notes.length === 0 ? (
          <EmptyState filter={filter} />
        ) : (
          <div className="space-y-3">
            {notes.map((note) => (
              <TaskCard
                key={note.id}
                task={note}
                onStatusChange={(status) => statusMutation.mutate({ id: note.id, status })}
                onDelete={() => deleteMutation.mutate(note.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// TASK CARD
// ============================================================================

interface TaskCardProps {
  task: QuickNote;
  onStatusChange: (status: string) => void;
  onDelete: () => void;
}

function TaskCard({ task, onStatusChange, onDelete }: TaskCardProps) {
  const isCompleted = task.status === 'completed';

  return (
    <div className={clsx(
      'card-interactive group',
      isCompleted && 'opacity-60'
    )}>
      <div className="flex items-start gap-4">
        <button
          onClick={() => onStatusChange(isCompleted ? 'active' : 'completed')}
          className={clsx(
            'w-5 h-5 rounded-full border-2 flex items-center justify-center mt-0.5 transition-all duration-200 flex-shrink-0',
            isCompleted
              ? 'border-success-500 bg-success-500 scale-100'
              : 'border-surface-500 hover:border-primary-400 hover:scale-110'
          )}
          aria-label={isCompleted ? 'Mark as active' : 'Mark as completed'}
        >
          {isCompleted && (
            <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          )}
        </button>

        <div className="flex-1 min-w-0">
          <p className={clsx(
            'text-sm text-surface-200 leading-relaxed',
            isCompleted && 'line-through text-surface-500'
          )}>
            {task.content}
          </p>
          <div className="flex items-center gap-2 mt-2.5 flex-wrap">
            <span className="text-xs text-surface-500">{formatRelativeTime(task.createdAt)}</span>
            {task.projectName && (
              <>
                <span className="text-surface-600">&#8226;</span>
                <span className="text-xs font-medium text-primary-400">{task.projectName}</span>
              </>
            )}
            {task.priority === 'high' && (
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-2xs font-semibold bg-error-500/15 text-error-400 border border-error-500/20">
                <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                  <path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
                </svg>
                High
              </span>
            )}
          </div>
        </div>

        <button
          onClick={onDelete}
          className="p-1.5 rounded-lg text-surface-500 hover:text-error-400 hover:bg-error-500/10 transition-all duration-150 opacity-0 group-hover:opacity-100"
          aria-label="Delete task"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// EMPTY STATE
// ============================================================================

function EmptyState({ filter }: { filter: string }) {
  const config = {
    active: {
      icon: '📝',
      title: 'No active tasks',
      description: 'Create new tasks to get started'
    },
    completed: {
      icon: '✓',
      title: 'No completed tasks',
      description: 'Completed tasks will appear here'
    }
  }[filter] || { icon: '📝', title: 'No tasks', description: 'Add a task above' };

  return (
    <div className="empty-state-pro">
      <div className="empty-icon-wrap">
        <span className="emoji-icon">{config.icon}</span>
      </div>
      <h3>{config.title}</h3>
      <p>{config.description}</p>
    </div>
  );
}

// ============================================================================
// LOADING SKELETON
// ============================================================================

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="card p-4">
          <div className="flex items-start gap-4">
            <div className="w-5 h-5 rounded-full skeleton flex-shrink-0" />
            <div className="flex-1 space-y-2.5">
              <div className="h-4 w-4/5 skeleton rounded" />
              <div className="h-3 w-32 skeleton rounded" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
