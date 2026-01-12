// ============================================================================
// GIT PANEL COMPONENT - Main orchestrator for Git integration
// Refactored from 2,842 lines to <200 lines
// ============================================================================

import { useCallback } from 'react';
import { clsx } from 'clsx';
import { useSettingsStore } from '../../stores/settingsStore';
import { GitHubPanel } from '../github';
import { createLogger } from '../../../shared/logger';

import { useGitState, formatRelativeTime } from './hooks/useGitState';
import { GitStatus } from './GitStatus';
import { GitBranches, DeleteBranchModal, CheckoutConfirmModal } from './GitBranches';
import { GitCommits } from './GitCommits';
import { GitRemote } from './GitRemote';
import { GitMerge } from './GitMerge';
import { GitStash } from './GitStash';
import { GitTags } from './GitTags';
import { GitDiff } from './GitDiff';
import { GitConflicts } from './GitConflicts';
import { GitRebase } from './GitRebase';
import { GitFileHistory, GitBlame } from './GitFileHistory';
import { GitCommitDetailModal } from './GitCommitDetail';
import type { GitPanelProps } from './types';

const logger = createLogger('GitPanel');

export function GitPanel({ cwd, position }: GitPanelProps) {
  const githubEnabled = useSettingsStore((s) => s.settings.githubEnabled);
  const githubShowInGitPanel = useSettingsStore((s) => s.settings.githubShowInGitPanel);

  const {
    state,
    setState,
    branchDropdownRef,
    localBranches,
    totalChanges,
    fetchGitInfo,
    toggleSection,
    handleStage,
    handleUnstage,
    handleStageAll,
    handleUnstageAll,
    handleDiscard,
    handleCommitWithAmend,
    handlePush,
    handlePull,
    handleFetch,
    handleCheckout,
    handleDiscardAndCheckout,
    handleCancelCheckout,
    handleCreateBranch,
    handleCancelNewBranch,
    handleDeleteBranch,
    handleViewCommit,
    handleCloseCommitDetail,
    handleViewDiff,
    handleCloseDiffModal,
    handleViewFileHistory,
    handleViewBlame,
    handleViewReflog,
    handleConventionalPrefix,
  } = useGitState(cwd);

  // Cherry-pick handler
  const handleCherryPick = useCallback(async (commit: string) => {
    setState(prev => ({ ...prev, operationInProgress: 'cherry-picking' }));
    try {
      const result = await window.goodvibes.gitCherryPick(cwd, commit);
      if (!result.success) {
        if (result.error?.includes('conflict') || result.stderr?.includes('CONFLICT')) {
          setState(prev => ({ ...prev, error: 'Cherry-pick has conflicts - resolve them and continue' }));
        } else {
          setState(prev => ({ ...prev, error: `Cherry-pick failed: ${result.error}` }));
        }
      }
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to cherry-pick:', err);
    }
    setState(prev => ({ ...prev, operationInProgress: null }));
  }, [cwd, fetchGitInfo, setState]);

  // Merge handlers
  const handleMerge = useCallback(async () => {
    if (!state.mergeBranch) return;
    setState(prev => ({ ...prev, isMerging: true, showMergeModal: false }));
    try {
      const result = await window.goodvibes.gitMerge(cwd, state.mergeBranch, state.mergeOptions);
      if (!result.success) {
        if (result.error?.includes('conflict') || result.stderr?.includes('CONFLICT')) {
          setState(prev => ({ ...prev, isMerging: false, mergeInProgress: true, error: 'Merge has conflicts - resolve them and commit' }));
        } else {
          setState(prev => ({ ...prev, isMerging: false, error: `Merge failed: ${result.error}` }));
        }
      }
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to merge:', err);
    }
    setState(prev => ({ ...prev, isMerging: false, mergeBranch: null, mergeOptions: { noFf: false, squash: false } }));
  }, [cwd, state.mergeBranch, state.mergeOptions, fetchGitInfo, setState]);

  const handleMergeAbort = useCallback(async () => {
    try {
      await window.goodvibes.gitMergeAbort(cwd);
      await fetchGitInfo();
    } catch (err) {
      logger.error('Failed to abort merge:', err);
    }
  }, [cwd, fetchGitInfo]);

  // Cherry-pick continue/abort
  const handleCherryPickContinue = useCallback(async () => {
    setState(prev => ({ ...prev, operationInProgress: 'cherry-pick-continue' }));
    try {
      const result = await window.goodvibes.gitCherryPickContinue(cwd);
      if (!result.success) setState(prev => ({ ...prev, error: `Continue failed: ${result.error}` }));
      await fetchGitInfo();
    } catch (err) { logger.error('Failed to continue cherry-pick:', err); }
    setState(prev => ({ ...prev, operationInProgress: null }));
  }, [cwd, fetchGitInfo, setState]);

  const handleCherryPickAbort = useCallback(async () => {
    try { await window.goodvibes.gitCherryPickAbort(cwd); await fetchGitInfo(); } catch (err) { logger.error('Failed to abort cherry-pick:', err); }
  }, [cwd, fetchGitInfo]);

  // Rebase handlers
  const handleRebase = useCallback(async () => {
    if (!state.rebaseBranch) return;
    setState(prev => ({ ...prev, operationInProgress: 'rebasing', showRebaseModal: false }));
    try {
      const result = await window.goodvibes.gitRebase(cwd, state.rebaseBranch);
      if (!result.success) {
        if (result.error?.includes('conflict') || result.stderr?.includes('CONFLICT')) {
          setState(prev => ({ ...prev, error: 'Rebase has conflicts - resolve them and continue' }));
        } else {
          setState(prev => ({ ...prev, error: `Rebase failed: ${result.error}` }));
        }
      }
      await fetchGitInfo();
    } catch (err) { logger.error('Failed to rebase:', err); }
    setState(prev => ({ ...prev, operationInProgress: null, rebaseBranch: null }));
  }, [cwd, state.rebaseBranch, fetchGitInfo, setState]);

  const handleRebaseAbort = useCallback(async () => { try { await window.goodvibes.gitRebaseAbort(cwd); await fetchGitInfo(); } catch (err) { logger.error('Failed to abort rebase:', err); } }, [cwd, fetchGitInfo]);
  const handleRebaseContinue = useCallback(async () => { setState(prev => ({ ...prev, operationInProgress: 'rebase-continue' })); try { const result = await window.goodvibes.gitRebaseContinue(cwd); if (!result.success) setState(prev => ({ ...prev, error: `Continue failed: ${result.error}` })); await fetchGitInfo(); } catch (err) { logger.error('Failed to continue rebase:', err); } setState(prev => ({ ...prev, operationInProgress: null })); }, [cwd, fetchGitInfo, setState]);
  const handleRebaseSkip = useCallback(async () => { try { await window.goodvibes.gitRebaseSkip(cwd); await fetchGitInfo(); } catch (err) { logger.error('Failed to skip rebase step:', err); } }, [cwd, fetchGitInfo]);

  // Stash handlers
  const handleStashPush = useCallback(async () => { setState(prev => ({ ...prev, operationInProgress: 'stashing', showStashModal: false })); try { const result = await window.goodvibes.gitStashPush(cwd, state.stashMessage || undefined); if (!result.success) setState(prev => ({ ...prev, error: `Stash failed: ${result.error}` })); await fetchGitInfo(); } catch (err) { logger.error('Failed to stash:', err); } setState(prev => ({ ...prev, operationInProgress: null, stashMessage: '' })); }, [cwd, state.stashMessage, fetchGitInfo, setState]);
  const handleStashPop = useCallback(async (index?: number) => { setState(prev => ({ ...prev, operationInProgress: 'popping-stash' })); try { const result = await window.goodvibes.gitStashPop(cwd, index); if (!result.success) setState(prev => ({ ...prev, error: `Stash pop failed: ${result.error}` })); await fetchGitInfo(); } catch (err) { logger.error('Failed to pop stash:', err); } setState(prev => ({ ...prev, operationInProgress: null })); }, [cwd, fetchGitInfo, setState]);
  const handleStashApply = useCallback(async (index?: number) => { setState(prev => ({ ...prev, operationInProgress: 'applying-stash' })); try { const result = await window.goodvibes.gitStashApply(cwd, index); if (!result.success) setState(prev => ({ ...prev, error: `Stash apply failed: ${result.error}` })); await fetchGitInfo(); } catch (err) { logger.error('Failed to apply stash:', err); } setState(prev => ({ ...prev, operationInProgress: null })); }, [cwd, fetchGitInfo, setState]);
  const handleStashDrop = useCallback(async (index: number) => { if (!confirm(`Drop stash@{${index}}? This cannot be undone.`)) return; setState(prev => ({ ...prev, operationInProgress: 'dropping-stash' })); try { const result = await window.goodvibes.gitStashDrop(cwd, index); if (!result.success) setState(prev => ({ ...prev, error: `Stash drop failed: ${result.error}` })); await fetchGitInfo(); } catch (err) { logger.error('Failed to drop stash:', err); } setState(prev => ({ ...prev, operationInProgress: null })); }, [cwd, fetchGitInfo, setState]);

  // Tag handlers
  const handleCreateTag = useCallback(async () => { if (!state.newTagName.trim()) return; setState(prev => ({ ...prev, operationInProgress: 'creating-tag' })); try { const result = await window.goodvibes.gitCreateTag(cwd, state.newTagName.trim(), { message: state.newTagMessage.trim() || undefined, commit: state.newTagCommit.trim() || undefined }); if (!result.success) setState(prev => ({ ...prev, error: `Failed to create tag: ${result.error}` })); await fetchGitInfo(); } catch (err) { logger.error('Failed to create tag:', err); } setState(prev => ({ ...prev, operationInProgress: null, showTagModal: false, newTagName: '', newTagMessage: '', newTagCommit: '' })); }, [cwd, state.newTagName, state.newTagMessage, state.newTagCommit, fetchGitInfo, setState]);
  const handleDeleteTag = useCallback(async (name: string) => { if (!confirm(`Delete tag "${name}"?`)) return; setState(prev => ({ ...prev, operationInProgress: 'deleting-tag' })); try { const result = await window.goodvibes.gitDeleteTag(cwd, name); if (!result.success) setState(prev => ({ ...prev, error: `Failed to delete tag: ${result.error}` })); await fetchGitInfo(); } catch (err) { logger.error('Failed to delete tag:', err); } setState(prev => ({ ...prev, operationInProgress: null })); }, [cwd, fetchGitInfo, setState]);

  // Conflict resolution
  const handleResolveOurs = useCallback(async (file: string) => { setState(prev => ({ ...prev, operationInProgress: 'resolving' })); try { const result = await window.goodvibes.gitResolveOurs(cwd, file); if (!result.success) setState(prev => ({ ...prev, error: `Failed to resolve: ${result.error}` })); await fetchGitInfo(); } catch (err) { logger.error('Failed to resolve conflict:', err); } setState(prev => ({ ...prev, operationInProgress: null })); }, [cwd, fetchGitInfo, setState]);
  const handleResolveTheirs = useCallback(async (file: string) => { setState(prev => ({ ...prev, operationInProgress: 'resolving' })); try { const result = await window.goodvibes.gitResolveTheirs(cwd, file); if (!result.success) setState(prev => ({ ...prev, error: `Failed to resolve: ${result.error}` })); await fetchGitInfo(); } catch (err) { logger.error('Failed to resolve conflict:', err); } setState(prev => ({ ...prev, operationInProgress: null })); }, [cwd, fetchGitInfo, setState]);

  // Reflog reset
  const handleResetToReflog = useCallback(async (index: number, hard: boolean = false) => { const confirmMsg = hard ? `Hard reset to HEAD@{${index}}? This will discard all uncommitted changes!` : `Reset to HEAD@{${index}}?`; if (!confirm(confirmMsg)) return; setState(prev => ({ ...prev, operationInProgress: 'resetting' })); try { const result = await window.goodvibes.gitResetToReflog(cwd, index, { hard }); if (!result.success) setState(prev => ({ ...prev, error: `Failed to reset: ${result.error}` })); await fetchGitInfo(); } catch (err) { logger.error('Failed to reset:', err); } setState(prev => ({ ...prev, operationInProgress: null, showReflogModal: false })); }, [cwd, fetchGitInfo, setState]);

  // Initialize repo
  const handleInitRepo = useCallback(async () => { await window.goodvibes.gitInit(cwd); fetchGitInfo(); }, [cwd, fetchGitInfo]);

  return (
    <div className={clsx('w-72 flex-shrink-0 bg-surface-900 overflow-hidden flex flex-col', position === 'left' ? 'border-r border-surface-800' : 'border-l border-surface-800')}>
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-surface-800">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-surface-400" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18V6M6 6a3 3 0 100-6 3 3 0 000 6zm12 12a3 3 0 100-6 3 3 0 000 6zm0 0V9a3 3 0 00-3-3H9" /></svg>
          <span className="text-sm font-medium text-surface-200">Source Control</span>
          {totalChanges > 0 && <span className="px-1.5 py-0.5 text-xs bg-primary-500/20 text-primary-400 rounded-full">{totalChanges}</span>}
        </div>
        <button onClick={fetchGitInfo} className="p-1 rounded hover:bg-surface-800 text-surface-400 hover:text-surface-200 transition-colors" title="Refresh" disabled={state.isLoading}>
          <svg className={clsx('w-3.5 h-3.5', state.isLoading && 'animate-spin')} fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {state.isLoading ? (
          <div className="flex items-center justify-center py-8"><div className="animate-spin w-5 h-5 border-2 border-surface-600 border-t-primary-500 rounded-full" /></div>
        ) : state.error ? (
          <div className="text-xs text-error-400 p-3 m-2 bg-error-500/10 rounded">{state.error}</div>
        ) : !state.isRepo ? (
          <div className="text-center py-8 px-4">
            <div className="text-4xl mb-3">{'</>'}</div>
            <div className="text-surface-400 text-sm mb-3">Not a git repository</div>
            <button onClick={handleInitRepo} className="px-3 py-1.5 text-xs bg-primary-500 hover:bg-primary-600 text-white rounded transition-colors">Initialize Repository</button>
          </div>
        ) : (
          <div className="p-2 space-y-2">
            <GitBranches branch={state.branch} ahead={state.ahead} behind={state.behind} branches={localBranches} showBranchDropdown={state.showBranchDropdown} showNewBranchInput={state.showNewBranchInput} newBranchName={state.newBranchName} newBranchError={state.newBranchError} operationInProgress={state.operationInProgress} branchDropdownRef={branchDropdownRef} onToggleDropdown={() => setState(prev => ({ ...prev, showBranchDropdown: !prev.showBranchDropdown }))} onCheckout={handleCheckout} onCreateBranch={handleCreateBranch} onCancelNewBranch={handleCancelNewBranch} onShowNewBranchInput={() => setState(prev => ({ ...prev, showNewBranchInput: true, newBranchError: null }))} onNewBranchNameChange={(name) => setState(prev => ({ ...prev, newBranchName: name, newBranchError: null }))} onShowDeleteBranchModal={(branch) => setState(prev => ({ ...prev, showDeleteBranchModal: true, branchToDelete: branch }))} />
            <GitRemote hasRemote={state.hasRemote} ahead={state.ahead} behind={state.behind} isPushing={state.isPushing} isPulling={state.isPulling} isFetching={state.isFetching} isMerging={state.isMerging} mergeInProgress={state.mergeInProgress} onPush={handlePush} onPull={handlePull} onFetch={handleFetch} onShowMergeModal={() => setState(prev => ({ ...prev, showMergeModal: true }))} />
            <GitMerge cwd={cwd} branch={state.branch} mergeInProgress={state.mergeInProgress} cherryPickInProgress={state.cherryPickInProgress} localBranches={localBranches} showMergeModal={state.showMergeModal} mergeBranch={state.mergeBranch} mergeOptions={state.mergeOptions} onMergeBranchChange={(branch) => setState(prev => ({ ...prev, mergeBranch: branch }))} onMergeOptionsChange={(options) => setState(prev => ({ ...prev, mergeOptions: options }))} onMerge={handleMerge} onMergeAbort={handleMergeAbort} onCloseMergeModal={() => setState(prev => ({ ...prev, showMergeModal: false, mergeBranch: null }))} onCherryPickContinue={handleCherryPickContinue} onCherryPickAbort={handleCherryPickAbort} />
            <GitConflicts conflictFiles={state.conflictFiles} expandedSections={state.expandedSections} toggleSection={toggleSection} onResolveOurs={handleResolveOurs} onResolveTheirs={handleResolveTheirs} />
            <GitCommits commits={state.commits} commitMessage={state.commitMessage} amendMode={state.amendMode} isCommitting={state.isCommitting} stagedCount={state.staged.length} expandedSections={state.expandedSections} conventionalPrefixes={state.conventionalPrefixes} showConventionalDropdown={state.showConventionalDropdown} toggleSection={toggleSection} onCommitMessageChange={(msg) => setState(prev => ({ ...prev, commitMessage: msg }))} onAmendModeChange={(amend) => setState(prev => ({ ...prev, amendMode: amend }))} onCommit={handleCommitWithAmend} onViewCommit={handleViewCommit} onCherryPick={handleCherryPick} onConventionalPrefix={handleConventionalPrefix} onToggleConventionalDropdown={() => setState(prev => ({ ...prev, showConventionalDropdown: !prev.showConventionalDropdown }))} formatRelativeTime={formatRelativeTime} />
            <GitStatus staged={state.staged} unstaged={state.unstaged} untracked={state.untracked} expandedSections={state.expandedSections} toggleSection={toggleSection} onStage={handleStage} onUnstage={handleUnstage} onStageAll={handleStageAll} onUnstageAll={handleUnstageAll} onDiscard={handleDiscard} onViewDiff={(file, staged) => handleViewDiff(file, staged)} onViewBlame={handleViewBlame} onViewFileHistory={handleViewFileHistory} />
            <GitStash stashes={state.stashes} expandedSections={state.expandedSections} showStashModal={state.showStashModal} stashMessage={state.stashMessage} hasChangesToStash={state.staged.length > 0 || state.unstaged.length > 0} stagedCount={state.staged.length} unstagedCount={state.unstaged.length} toggleSection={toggleSection} onStashMessageChange={(msg) => setState(prev => ({ ...prev, stashMessage: msg }))} onShowStashModal={() => setState(prev => ({ ...prev, showStashModal: true }))} onCloseStashModal={() => setState(prev => ({ ...prev, showStashModal: false, stashMessage: '' }))} onStashPush={handleStashPush} onStashPop={handleStashPop} onStashApply={handleStashApply} onStashDrop={handleStashDrop} />
            <GitTags tags={state.tags} expandedSections={state.expandedSections} showTagModal={state.showTagModal} newTagName={state.newTagName} newTagMessage={state.newTagMessage} newTagCommit={state.newTagCommit} toggleSection={toggleSection} onTagNameChange={(name) => setState(prev => ({ ...prev, newTagName: name }))} onTagMessageChange={(msg) => setState(prev => ({ ...prev, newTagMessage: msg }))} onTagCommitChange={(commit) => setState(prev => ({ ...prev, newTagCommit: commit }))} onShowTagModal={() => setState(prev => ({ ...prev, showTagModal: true }))} onCloseTagModal={() => setState(prev => ({ ...prev, showTagModal: false, newTagName: '', newTagMessage: '', newTagCommit: '' }))} onCreateTag={handleCreateTag} onDeleteTag={handleDeleteTag} />
            <GitRebase branch={state.branch} rebaseInProgress={state.rebaseInProgress} localBranches={localBranches} showRebaseModal={state.showRebaseModal} rebaseBranch={state.rebaseBranch} showReflogModal={state.showReflogModal} reflogEntries={state.reflogEntries} isLoadingReflog={state.isLoadingReflog} formatRelativeTime={formatRelativeTime} onRebaseBranchChange={(branch) => setState(prev => ({ ...prev, rebaseBranch: branch }))} onShowRebaseModal={() => setState(prev => ({ ...prev, showRebaseModal: true }))} onCloseRebaseModal={() => setState(prev => ({ ...prev, showRebaseModal: false, rebaseBranch: null }))} onRebase={handleRebase} onRebaseAbort={handleRebaseAbort} onRebaseContinue={handleRebaseContinue} onRebaseSkip={handleRebaseSkip} onViewReflog={handleViewReflog} onCloseReflogModal={() => setState(prev => ({ ...prev, showReflogModal: false }))} onResetToReflog={handleResetToReflog} />
            {githubEnabled && githubShowInGitPanel && <div className="border-t border-surface-700 pt-3 mt-3"><GitHubPanel cwd={cwd} currentBranch={state.branch} className="h-auto max-h-96" /></div>}
          </div>
        )}
      </div>

      {/* Modals */}
      <GitCommitDetailModal isOpen={state.showCommitDetail} selectedCommit={state.selectedCommit} isLoadingCommit={state.isLoadingCommit} onClose={handleCloseCommitDetail} onViewDiff={(file, staged, commit) => handleViewDiff(file, staged, commit)} />
      <GitDiff isOpen={state.showDiffModal} diffFile={state.diffFile} diffContent={state.diffContent} diffIsStaged={state.diffIsStaged} diffCommit={state.diffCommit} isLoadingDiff={state.isLoadingDiff} onClose={handleCloseDiffModal} />
      <GitFileHistory isOpen={state.showFileHistoryModal} fileHistoryFile={state.fileHistoryFile} fileHistoryCommits={state.fileHistoryCommits} isLoadingFileHistory={state.isLoadingFileHistory} formatRelativeTime={formatRelativeTime} onViewDiff={(file, staged, commit) => handleViewDiff(file, staged, commit)} onClose={() => setState(prev => ({ ...prev, showFileHistoryModal: false, fileHistoryFile: null, fileHistoryCommits: [] }))} />
      <GitBlame isOpen={state.showBlameModal} blameFile={state.blameFile} blameLines={state.blameLines} isLoadingBlame={state.isLoadingBlame} onClose={() => setState(prev => ({ ...prev, showBlameModal: false, blameFile: null, blameLines: [] }))} />
      <CheckoutConfirmModal isOpen={state.showCheckoutConfirmModal} pendingCheckoutBranch={state.pendingCheckoutBranch} stagedCount={state.staged.length} unstagedCount={state.unstaged.length} onCancel={handleCancelCheckout} onDiscardAndCheckout={handleDiscardAndCheckout} />
      <DeleteBranchModal isOpen={state.showDeleteBranchModal} branchToDelete={state.branchToDelete} deleteBranchForce={state.deleteBranchForce} onClose={() => setState(prev => ({ ...prev, showDeleteBranchModal: false, branchToDelete: null, deleteBranchForce: false }))} onDelete={handleDeleteBranch} onForceChange={(force) => setState(prev => ({ ...prev, deleteBranchForce: force }))} />
    </div>
  );
}
