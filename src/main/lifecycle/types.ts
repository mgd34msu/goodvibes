// ============================================================================
// LIFECYCLE MODULE - Type Definitions
// ============================================================================

/**
 * Listener reference tracking for proper cleanup during shutdown.
 * Prevents memory leaks from accumulated listeners on hot reload.
 */
export interface MainProcessListeners {
  streamAnalyzer: {
    agentSpawn: ((data: AgentSpawnData) => void) | null;
    agentComplete: ((data: AgentCompleteData) => void) | null;
    agentActivity: ((data: AgentActivityData) => void) | null;
  };
  hookServer: {
    sessionStart: ((data: SessionStartData) => void) | null;
    agentStart: ((data: AgentHookData) => void) | null;
    agentStop: ((data: AgentHookData) => void) | null;
    sessionEnd: ((data: SessionEndData) => void) | null;
  };
  ipcMain: {
    terminalExited: ((event: Electron.IpcMainEvent, data: TerminalExitedData) => void) | null;
  };
}

export interface AgentSpawnData {
  terminalId: number;
  agentName: string;
  description?: string;
  timestamp: number;
  isRealAgent?: boolean;
}

export interface AgentCompleteData {
  terminalId: number;
  agentId: string;
  agentName?: string;
  reason?: string;
  timestamp: number;
}

export interface AgentActivityData {
  terminalId: number;
  agentName: string;
  activity: string;
  timestamp: number;
}

export interface SessionStartData {
  sessionId?: string;
  projectPath?: string;
}

export interface AgentHookData {
  agentName?: string;
  sessionId?: string;
}

export interface SessionEndData {
  sessionId?: string;
}

export interface TerminalExitedData {
  terminalId: number;
}
