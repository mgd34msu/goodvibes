// ============================================================================
// EVENTS PRELOAD API
// ============================================================================
//
// IPC event listeners and remove listeners
// ============================================================================

import { ipcRenderer } from 'electron';

export const eventsApi = {
  // ============================================================================
  // TERMINAL EVENTS
  // ============================================================================
  onTerminalData: (callback: (data: { id: number; data: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: number; data: string }) => callback(data);
    ipcRenderer.on('terminal-data', handler);
    return () => { ipcRenderer.removeListener('terminal-data', handler); };
  },
  onTerminalExit: (callback: (data: { id: number; exitCode: number }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: number; exitCode: number }) => callback(data);
    ipcRenderer.on('terminal-exit', handler);
    return () => { ipcRenderer.removeListener('terminal-exit', handler); };
  },

  // ============================================================================
  // SESSION EVENTS
  // ============================================================================
  onScanStatus: (callback: (data: { status: string; message?: string; progress?: { current: number; total: number } }) => void): (() => void) => {
    const handler = (_: unknown, data: { status: string; message?: string; progress?: { current: number; total: number } }) => callback(data);
    ipcRenderer.on('scan-status', handler);
    return () => { ipcRenderer.removeListener('scan-status', handler); };
  },
  onSessionDetected: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown) => callback(data);
    ipcRenderer.on('session-detected', handler);
    return () => { ipcRenderer.removeListener('session-detected', handler); };
  },
  onSubagentSessionUpdate: (callback: (data: unknown) => void): (() => void) => {
    const handler = (_: unknown, data: unknown) => callback(data);
    ipcRenderer.on('subagent-session-update', handler);
    return () => { ipcRenderer.removeListener('subagent-session-update', handler); };
  },
  onNewSession: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('new-session', handler);
    return () => { ipcRenderer.removeListener('new-session', handler); };
  },

  // ============================================================================
  // UI EVENTS
  // ============================================================================
  onCloseTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('close-tab', handler);
    return () => { ipcRenderer.removeListener('close-tab', handler); };
  },
  onNextTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('next-tab', handler);
    return () => { ipcRenderer.removeListener('next-tab', handler); };
  },
  onPrevTab: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('prev-tab', handler);
    return () => { ipcRenderer.removeListener('prev-tab', handler); };
  },
  onSwitchView: (callback: (view: string) => void): (() => void) => {
    const handler = (_: unknown, view: string) => callback(view);
    ipcRenderer.on('switch-view', handler);
    return () => { ipcRenderer.removeListener('switch-view', handler); };
  },
  onOpenSettings: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('open-settings', handler);
    return () => { ipcRenderer.removeListener('open-settings', handler); };
  },
  onShowAbout: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on('show-about', handler);
    return () => { ipcRenderer.removeListener('show-about', handler); };
  },

  // ============================================================================
  // AGENT EVENTS
  // ============================================================================
  onAgentUpdate: (callback: (data: { id: string; status: string; name: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: string; status: string; name: string }) => callback(data);
    ipcRenderer.on('agent-update', handler);
    return () => { ipcRenderer.removeListener('agent-update', handler); };
  },
  onAgentDetected: (callback: (data: { id: string; name: string; description?: string; terminalId: number }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: string; name: string; description?: string; terminalId: number }) => callback(data);
    ipcRenderer.on('agent:detected', handler);
    return () => { ipcRenderer.removeListener('agent:detected', handler); };
  },

  // ============================================================================
  // HOOK EVENTS
  // ============================================================================
  onHookExecuted: (callback: (data: { hookId: string; eventType: string; success: boolean; result?: unknown }) => void): (() => void) => {
    const handler = (_: unknown, data: { hookId: string; eventType: string; success: boolean; result?: unknown }) => callback(data);
    ipcRenderer.on('hook-executed', handler);
    return () => { ipcRenderer.removeListener('hook-executed', handler); };
  },
  onHookEvent: (callback: (data: { id: number; eventType: string; sessionId?: string; toolName?: string; blocked: boolean; timestamp: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: number; eventType: string; sessionId?: string; toolName?: string; blocked: boolean; timestamp: string }) => callback(data);
    ipcRenderer.on('hook:event', handler);
    return () => { ipcRenderer.removeListener('hook:event', handler); };
  },
  onHookNotification: (callback: (data: { type?: string; message?: string; sessionId?: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { type?: string; message?: string; sessionId?: string }) => callback(data);
    ipcRenderer.on('hook:notification', handler);
    return () => { ipcRenderer.removeListener('hook:notification', handler); };
  },
  onApprovalRequired: (callback: (data: { id: number; sessionId: string; requestType: string; requestDetails: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: number; sessionId: string; requestType: string; requestDetails: string }) => callback(data);
    ipcRenderer.on('hook:approval-required', handler);
    return () => { ipcRenderer.removeListener('hook:approval-required', handler); };
  },

  // ============================================================================
  // SERVICE EVENTS
  // ============================================================================
  onMCPServerStatus: (callback: (data: { id: string; status: string; error?: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { id: string; status: string; error?: string }) => callback(data);
    ipcRenderer.on('mcp-server-status', handler);
    return () => { ipcRenderer.removeListener('mcp-server-status', handler); };
  },
  onFileChange: (callback: (data: { type: string; path: string; watchId: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { type: string; path: string; watchId: string }) => callback(data);
    ipcRenderer.on('file-change', handler);
    return () => { ipcRenderer.removeListener('file-change', handler); };
  },
  onStreamEvent: (callback: (data: { type: string; sessionId: string; data?: unknown }) => void): (() => void) => {
    const handler = (_: unknown, data: { type: string; sessionId: string; data?: unknown }) => callback(data);
    ipcRenderer.on('stream-event', handler);
    return () => { ipcRenderer.removeListener('stream-event', handler); };
  },
  onHeadlessTaskUpdate: (callback: (data: { taskId: string; status: string; progress?: number; result?: unknown }) => void): (() => void) => {
    const handler = (_: unknown, data: { taskId: string; status: string; progress?: number; result?: unknown }) => callback(data);
    ipcRenderer.on('headless-task-update', handler);
    return () => { ipcRenderer.removeListener('headless-task-update', handler); };
  },

  // ============================================================================
  // TEST EVENTS
  // ============================================================================
  onTestResult: (callback: (data: {
    id: string;
    sessionId: string | null;
    projectPath: string | null;
    command: string;
    timestamp: string;
    status: 'passed' | 'failed' | 'error' | 'unknown';
    totalTests: number;
    passedTests: number;
    failedTests: number;
    skippedTests: number;
    framework: string;
  }) => void): (() => void) => {
    const handler = (_: unknown, data: {
      id: string;
      sessionId: string | null;
      projectPath: string | null;
      command: string;
      timestamp: string;
      status: 'passed' | 'failed' | 'error' | 'unknown';
      totalTests: number;
      passedTests: number;
      failedTests: number;
      skippedTests: number;
      framework: string;
    }) => callback(data);
    ipcRenderer.on('test-monitor:result', handler);
    return () => { ipcRenderer.removeListener('test-monitor:result', handler); };
  },

  // ============================================================================
  // PROJECT EVENTS
  // ============================================================================
  onProjectEvent: (callback: (data: { event: string; projectId: number; data: unknown }) => void): (() => void) => {
    const handler = (_: unknown, data: { event: string; projectId: number; data: unknown }) => callback(data);
    ipcRenderer.on('project:event', handler);
    return () => { ipcRenderer.removeListener('project:event', handler); };
  },
  onProjectSwitched: (callback: (data: { projectId: number; projectPath: string }) => void): (() => void) => {
    const handler = (_: unknown, data: { projectId: number; projectPath: string }) => callback(data);
    ipcRenderer.on('project:switched', handler);
    return () => { ipcRenderer.removeListener('project:switched', handler); };
  },

  // ============================================================================
  // RECOMMENDATION EVENTS
  // ============================================================================
  onRecommendationsNew: (callback: (data: {
    sessionId: string | null;
    recommendations: Array<{
      id: number;
      type: 'agent' | 'skill';
      itemId: number;
      slug: string;
      name: string;
      description: string | null;
      confidenceScore: number;
      source: 'prompt' | 'project' | 'context' | 'historical';
      matchedKeywords: string[];
      reasoning: string;
    }>;
  }) => void): (() => void) => {
    const handler = (_: unknown, data: {
      sessionId: string | null;
      recommendations: Array<{
        id: number;
        type: 'agent' | 'skill';
        itemId: number;
        slug: string;
        name: string;
        description: string | null;
        confidenceScore: number;
        source: 'prompt' | 'project' | 'context' | 'historical';
        matchedKeywords: string[];
        reasoning: string;
      }>;
    }) => callback(data);
    ipcRenderer.on('recommendations:new', handler);
    return () => { ipcRenderer.removeListener('recommendations:new', handler); };
  },

  // ============================================================================
  // UTILITIES
  // ============================================================================
  removeAllListeners: (channel: string) =>
    ipcRenderer.removeAllListeners(channel),
};
