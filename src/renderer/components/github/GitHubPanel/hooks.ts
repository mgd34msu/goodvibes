// ============================================================================
// GITHUB PANEL - CUSTOM HOOKS
// ============================================================================

import { useState, useEffect, useCallback, useRef } from 'react';
import type { GitHubUser, GitHubRemoteInfo, GitHubCheckRun, GitHubCombinedStatus, GitHubRepository, GitHubOrganization } from '../../../../shared/types/github';
import { createLogger } from '../../../../shared/logger';

const logger = createLogger('GitHubPanel');

export interface UseGitHubAuthReturn {
  isAuthenticated: boolean;
  user: GitHubUser | null;
  isLoading: boolean;
  setIsLoading: (loading: boolean) => void;
  loadAuthState: () => Promise<boolean>;
  handleAuthChange: (authenticated: boolean, authUser: GitHubUser | null) => void;
}

export function useGitHubAuth(_cwd: string): UseGitHubAuthReturn {
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [user, setUser] = useState<GitHubUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const loadAuthState = useCallback(async () => {
    try {
      const state = await window.goodvibes.githubGetAuthState();
      setIsAuthenticated(state.isAuthenticated);
      setUser(state.user);
      return state.isAuthenticated;
    } catch (err) {
      logger.error('Failed to load GitHub auth state:', err);
      return false;
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAuthState();
  }, [loadAuthState]);

  const handleAuthChange = useCallback((authenticated: boolean, authUser: GitHubUser | null) => {
    setIsAuthenticated(authenticated);
    setUser(authUser);
  }, []);

  return {
    isAuthenticated,
    user,
    isLoading,
    setIsLoading,
    loadAuthState,
    handleAuthChange,
  };
}

export interface UseRepoInfoReturn {
  repoInfo: GitHubRemoteInfo | null;
  error: string | null;
  setError: (error: string | null) => void;
  loadRepoInfo: () => Promise<void>;
  setRepoInfo: (info: GitHubRemoteInfo | null) => void;
}

export function useRepoInfo(cwd: string, isAuthenticated: boolean): UseRepoInfoReturn {
  const [repoInfo, setRepoInfo] = useState<GitHubRemoteInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const loadRepoInfo = useCallback(async () => {
    if (!cwd) return;

    setError(null);

    try {
      const remotesResult = await window.goodvibes.gitRemotes(cwd);
      if (!remotesResult.success || !remotesResult.remotes || remotesResult.remotes.length === 0) {
        setRepoInfo(null);
        return;
      }

      const remote = remotesResult.remotes.find((r: { name: string }) => r.name === 'origin') || remotesResult.remotes[0];
      const parseResult = await window.goodvibes.githubParseRemote(remote.fetchUrl);

      if (parseResult && parseResult.isGitHub) {
        setRepoInfo({
          ...parseResult,
          remoteName: remote.name,
          remoteUrl: remote.fetchUrl,
        });
      } else {
        setRepoInfo(null);
      }
    } catch (err) {
      logger.error('Failed to load repo info:', err);
      setRepoInfo(null);
    }
  }, [cwd]);

  useEffect(() => {
    if (isAuthenticated && cwd) {
      loadRepoInfo();
    }
  }, [cwd, isAuthenticated, loadRepoInfo]);

  return {
    repoInfo,
    error,
    setError,
    loadRepoInfo,
    setRepoInfo,
  };
}

export interface UseCIStatusReturn {
  ciStatus: {
    checks: GitHubCheckRun[];
    combined: GitHubCombinedStatus | null;
  };
  ciLoading: boolean;
  loadCIStatus: () => Promise<void>;
}

export function useCIStatus(repoInfo: GitHubRemoteInfo | null, currentBranch?: string): UseCIStatusReturn {
  const [ciStatus, setCIStatus] = useState<{
    checks: GitHubCheckRun[];
    combined: GitHubCombinedStatus | null;
  }>({ checks: [], combined: null });
  const [ciLoading, setCILoading] = useState(false);

  const loadCIStatus = useCallback(async () => {
    // Don't make API calls if branch is missing or invalid
    if (!repoInfo || !currentBranch || currentBranch === 'unknown') return;

    setCILoading(true);

    try {
      const [checksResult, statusResult] = await Promise.all([
        window.goodvibes.githubGetChecks(repoInfo.owner, repoInfo.repo, currentBranch),
        window.goodvibes.githubGetCommitStatus(repoInfo.owner, repoInfo.repo, currentBranch),
      ]);

      setCIStatus({
        checks: checksResult.success ? checksResult.data || [] : [],
        combined: statusResult.success ? statusResult.data || null : null,
      });
    } catch (err) {
      logger.error('Failed to load CI status:', err);
    } finally {
      setCILoading(false);
    }
  }, [repoInfo, currentBranch]);

  useEffect(() => {
    if (repoInfo && currentBranch && currentBranch !== 'unknown') {
      loadCIStatus();
    }
  }, [repoInfo, currentBranch, loadCIStatus]);

  return {
    ciStatus,
    ciLoading,
    loadCIStatus,
  };
}

export function useRepoSelector(cwd: string, loadRepoInfo: () => Promise<void>) {
  const [showRepoDropdown, setShowRepoDropdown] = useState(false);
  const [repos, setRepos] = useState<GitHubRepository[]>([]);
  const [orgs, setOrgs] = useState<GitHubOrganization[]>([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [selectedOrg, setSelectedOrg] = useState<string | null>(null);
  const [addingRemote, setAddingRemote] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dropdownRef = useRef<HTMLDivElement>(null);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowRepoDropdown(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const loadUserRepos = async () => {
    if (reposLoading) return;

    setReposLoading(true);
    try {
      const [reposResult, orgsResult] = await Promise.all([
        window.goodvibes.githubListRepos({ sort: 'pushed', per_page: 100 }),
        window.goodvibes.githubListOrgs(),
      ]);

      if (reposResult.success && reposResult.data) {
        setRepos(reposResult.data);
      }
      if (orgsResult.success && orgsResult.data) {
        setOrgs(orgsResult.data);
      }
    } catch (err) {
      logger.error('Failed to load repos:', err);
    } finally {
      setReposLoading(false);
    }
  };

  const loadOrgRepos = async (org: string) => {
    setReposLoading(true);
    setSelectedOrg(org);
    try {
      const result = await window.goodvibes.githubListOrgRepos(org, { sort: 'pushed', per_page: 100 });
      if (result.success && result.data) {
        setRepos(result.data);
      }
    } catch (err) {
      logger.error('Failed to load org repos:', err);
    } finally {
      setReposLoading(false);
    }
  };

  const handleSelectRepo = async (repo: GitHubRepository) => {
    setAddingRemote(true);
    setError(null);

    try {
      const remotesResult = await window.goodvibes.gitRemotes(cwd);
      const originExists = remotesResult.success &&
        remotesResult.remotes?.some((r: { name: string }) => r.name === 'origin');

      if (originExists) {
        await loadRepoInfo();
        setShowRepoDropdown(false);
        return;
      }

      const result = await window.goodvibes.gitRemoteAdd(cwd, 'origin', repo.clone_url);

      if (result.success) {
        await loadRepoInfo();
        setShowRepoDropdown(false);
      } else {
        if (result.error?.includes('already exists')) {
          await loadRepoInfo();
          setShowRepoDropdown(false);
        } else {
          setError(result.error || 'Failed to add remote');
        }
      }
    } catch (err) {
      logger.error('Failed to add remote:', err);
      setError('Failed to add remote');
    } finally {
      setAddingRemote(false);
    }
  };

  const handleOpenRepoDropdown = () => {
    setShowRepoDropdown(true);
    setSelectedOrg(null);
    loadUserRepos();
  };

  return {
    showRepoDropdown,
    setShowRepoDropdown,
    repos,
    orgs,
    reposLoading,
    selectedOrg,
    setSelectedOrg,
    addingRemote,
    error,
    setError,
    dropdownRef,
    loadUserRepos,
    loadOrgRepos,
    handleSelectRepo,
    handleOpenRepoDropdown,
  };
}
