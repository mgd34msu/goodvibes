// ============================================================================
// MCP SERVER FORM - Form for adding/editing MCP servers
// ============================================================================

import React, { useState } from 'react';
import { Save } from 'lucide-react';
import type { MCPServer } from './MCPServerCard';

// ============================================================================
// SERVER FORM COMPONENT
// ============================================================================

interface ServerFormProps {
  server?: MCPServer;
  onSave: (server: Partial<MCPServer>) => void;
  onCancel: () => void;
}

export function MCPServerForm({ server, onSave, onCancel }: ServerFormProps): React.JSX.Element {
  const [name, setName] = useState(server?.name || '');
  const [description, setDescription] = useState(server?.description || '');
  const [transport, setTransport] = useState<'stdio' | 'http'>(server?.transport || 'stdio');
  const [command, setCommand] = useState(server?.command || '');
  const [url, setUrl] = useState(server?.url || '');
  const [args, setArgs] = useState(server?.args.join(' ') || '');
  const [envString, setEnvString] = useState(
    server?.env ? Object.entries(server.env).map(([k, v]) => `${k}=${v}`).join('\n') : ''
  );
  const [scope, setScope] = useState<'user' | 'project'>(server?.scope || 'user');

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    const env: Record<string, string> = {};
    envString.split('\n').forEach((line) => {
      const [key, ...valueParts] = line.split('=');
      if (key && valueParts.length > 0) {
        env[key.trim()] = valueParts.join('=').trim();
      }
    });

    onSave({
      id: server?.id,
      name,
      description: description || null,
      transport,
      command: transport === 'stdio' ? command : null,
      url: transport === 'http' ? url : null,
      args: args.split(' ').filter(Boolean),
      env,
      scope,
      enabled: server?.enabled ?? true,
    });
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-4 bg-surface-900 rounded-lg p-4 border border-surface-700">
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">Name</label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="My MCP Server"
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            required
          />
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">Transport</label>
          <select
            value={transport}
            onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          >
            <option value="stdio">STDIO</option>
            <option value="http">HTTP</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">Description</label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="Optional description"
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      {transport === 'stdio' ? (
        <>
          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Command</label>
            <input
              type="text"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              placeholder="npx @example/mcp-server"
              className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
              required
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-surface-300 mb-1">Arguments (space-separated)</label>
            <input
              type="text"
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              placeholder="--flag value"
              className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            />
          </div>
        </>
      ) : (
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">URL</label>
          <input
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="http://localhost:3000"
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            required
          />
        </div>
      )}

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Environment Variables (one per line, KEY=value)
        </label>
        <textarea
          value={envString}
          onChange={(e) => setEnvString(e.target.value)}
          placeholder="API_KEY=your-key&#10;OTHER_VAR=value"
          rows={3}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">Scope</label>
        <select
          value={scope}
          onChange={(e) => setScope(e.target.value as 'user' | 'project')}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        >
          <option value="user">User (Global)</option>
          <option value="project">Project</option>
        </select>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-surface-300 hover:text-surface-100 hover:bg-surface-700 rounded-md transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          className="px-4 py-2 bg-accent-purple text-white rounded-md hover:bg-accent-purple/80 transition-colors flex items-center gap-2"
        >
          <Save className="w-4 h-4" />
          {server ? 'Update Server' : 'Add Server'}
        </button>
      </div>
    </form>
  );
}

export default MCPServerForm;
