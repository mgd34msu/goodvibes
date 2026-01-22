// ============================================================================
// MCP SERVER CARD - Premium Glass Morphism Design
// ============================================================================

import React from 'react';
import {
  Play,
  Square,
  RefreshCw,
  Trash2,
  Edit2,
  CheckCircle,
  XCircle,
  AlertCircle,
  Server,
} from 'lucide-react';

// ============================================================================
// TYPES
// ============================================================================

export interface MCPServer {
  id: number;
  name: string;
  description: string | null;
  transport: 'stdio' | 'http';
  command: string | null;
  url: string | null;
  args: string[];
  env: Record<string, string>;
  scope: 'user' | 'project';
  projectPath: string | null;
  enabled: boolean;
  status: 'connected' | 'disconnected' | 'error' | 'unknown';
  lastConnected: string | null;
  errorMessage: string | null;
  toolCount: number;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// CONSTANTS
// ============================================================================

interface StatusConfig {
  iconClass: string;
  statusClass: string;
  icon: React.ReactNode;
}

const STATUS_CONFIG: Record<string, StatusConfig> = {
  connected: {
    iconClass: 'card-icon-success',
    statusClass: 'card-status-connected',
    icon: <CheckCircle className="w-5 h-5" />,
  },
  disconnected: {
    iconClass: '',
    statusClass: 'card-status-disconnected',
    icon: <Server className="w-5 h-5" />,
  },
  error: {
    iconClass: 'card-icon-error',
    statusClass: 'card-status-error',
    icon: <XCircle className="w-5 h-5" />,
  },
  unknown: {
    iconClass: 'card-icon-warning',
    statusClass: 'card-status-warning',
    icon: <AlertCircle className="w-5 h-5" />,
  },
};

// ============================================================================
// SERVER CARD COMPONENT
// ============================================================================

interface ServerCardProps {
  server: MCPServer;
  timezone?: string;
  onStart: (id: number) => void;
  onStop: (id: number) => void;
  onRestart: (id: number) => void;
  onEdit: (server: MCPServer) => void;
  onDelete: (id: number) => void;
}

const DEFAULT_STATUS: StatusConfig = {
  iconClass: 'card-icon-warning',
  statusClass: 'card-status-warning',
  icon: <AlertCircle className="w-5 h-5" />,
};

export function MCPServerCard({ server, timezone = 'UTC', onStart, onStop, onRestart, onEdit, onDelete }: ServerCardProps): React.JSX.Element {
  const statusConfig: StatusConfig = STATUS_CONFIG[server.status] ?? DEFAULT_STATUS;

  return (
    <div className={`card-hover group ${!server.enabled ? 'card-disabled' : ''}`}>
      {/* Main Content */}
      <div className="flex items-start justify-between gap-4">
        {/* Left Section: Status + Icon + Info */}
        <div className="flex items-start gap-3 flex-1 min-w-0">
          {/* Status Indicator */}
          <div className={`card-status ${statusConfig.statusClass} mt-2`} />

          {/* Icon */}
          <div className={`card-icon ${statusConfig.iconClass}`}>
            {statusConfig.icon}
          </div>

          {/* Info */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h3 className="card-title-gradient text-base">{server.name}</h3>
              <span className="card-badge">
                {server.transport.toUpperCase()}
              </span>
              <span className="card-badge">
                {server.scope}
              </span>
            </div>
            {server.description && (
              <p className="card-description line-clamp-2">{server.description}</p>
            )}
            <div className="card-meta mt-3">
              <span className="card-meta-item">
                Tools: {server.toolCount}
              </span>
              {server.lastConnected && (
                <span className="card-meta-item">
                  Last connected: {new Date(server.lastConnected).toLocaleString(undefined, { timeZone: timezone })}
                </span>
              )}
            </div>
            {server.errorMessage && (
              <p className="text-xs text-error-400 mt-2 flex items-center gap-1">
                <XCircle className="w-3 h-3" />
                {server.errorMessage}
              </p>
            )}
          </div>
        </div>

        {/* Right Section: Actions */}
        <div className="card-actions">
          {server.status === 'connected' ? (
            <button
              onClick={() => onStop(server.id)}
              className="card-action-btn card-action-btn-danger"
              title="Stop"
            >
              <Square className="w-4 h-4" />
            </button>
          ) : (
            <button
              onClick={() => onStart(server.id)}
              className="card-action-btn card-action-btn-success"
              title="Start"
            >
              <Play className="w-4 h-4" />
            </button>
          )}
          <button
            onClick={() => onRestart(server.id)}
            className="card-action-btn card-action-btn-primary"
            title="Restart"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={() => onEdit(server)}
            className="card-action-btn card-action-btn-primary"
            title="Edit"
          >
            <Edit2 className="w-4 h-4" />
          </button>
          <button
            onClick={() => onDelete(server.id)}
            className="card-action-btn card-action-btn-danger"
            title="Delete"
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
}

export default MCPServerCard;
