// ============================================================================
// AGENTS VIEW - Agent Template Library Management
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import {
  Users,
  Plus,
  Search,
  Edit2,
  Trash2,
  Copy,
  Check,
  Play,
  Save,
  ChevronDown,
  ChevronRight,
  Settings,
  Zap,
  Code,
  FileText,
  Bug,
  GitBranch,
  TestTube,
  Shield,
} from 'lucide-react';
import ProjectSelector from '../shared/ProjectSelector';

// ============================================================================
// TYPES
// ============================================================================

interface AgentTemplate {
  id: string;
  name: string;
  description: string | null;
  cwd: string | null;
  initialPrompt: string | null;
  claudeMdContent: string | null;
  flags: string[];
  model: string | null;
  permissionMode: 'default' | 'plan' | 'bypassPermissions' | null;
  allowedTools: string[] | null;
  deniedTools: string[] | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// BUILT-IN AGENT TEMPLATES
// ============================================================================

const BUILT_IN_AGENTS: Omit<AgentTemplate, 'id' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'code-reviewer',
    description: 'Reviews code for bugs, security issues, and best practices',
    cwd: null,
    initialPrompt: `You are a code reviewer. Your task is to:

1. **Analyze Code Quality**
   - Check for bugs and edge cases
   - Identify potential security vulnerabilities
   - Look for performance issues
   - Ensure proper error handling

2. **Review Best Practices**
   - Verify code follows project patterns
   - Check naming conventions
   - Ensure proper typing
   - Look for code duplication

3. **Provide Feedback**
   - Give specific, actionable suggestions
   - Explain the "why" behind each recommendation
   - Prioritize issues by severity`,
    claudeMdContent: null,
    flags: [],
    model: null,
    permissionMode: 'default',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    deniedTools: null,
  },
  {
    name: 'test-writer',
    description: 'Creates comprehensive tests for existing code',
    cwd: null,
    initialPrompt: `You are a test writer. Your task is to write comprehensive tests:

1. **Analyze the Code**
   - Understand the function/component behavior
   - Identify all code paths
   - Note edge cases and error conditions

2. **Write Tests**
   - Unit tests for individual functions
   - Integration tests for modules
   - Edge case coverage
   - Error handling tests

3. **Best Practices**
   - Use descriptive test names
   - Follow AAA pattern (Arrange, Act, Assert)
   - Mock external dependencies appropriately
   - Ensure tests are isolated and repeatable`,
    claudeMdContent: null,
    flags: [],
    model: null,
    permissionMode: 'default',
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    deniedTools: null,
  },
  {
    name: 'debugger',
    description: 'Systematically debugs issues and identifies root causes',
    cwd: null,
    initialPrompt: `You are a debugging specialist. Follow this systematic approach:

1. **Understand the Problem**
   - What is the expected behavior?
   - What is the actual behavior?
   - Can you reproduce it?

2. **Gather Information**
   - Check error messages and stack traces
   - Review recent changes (git diff, git log)
   - Examine logs and state

3. **Isolate the Issue**
   - Binary search through code paths
   - Add strategic logging
   - Test hypotheses one at a time

4. **Fix and Verify**
   - Make minimal changes
   - Verify the fix works
   - Ensure no regressions`,
    claudeMdContent: null,
    flags: [],
    model: null,
    permissionMode: 'default',
    allowedTools: null,
    deniedTools: null,
  },
  {
    name: 'refactorer',
    description: 'Safely refactors code while preserving behavior',
    cwd: null,
    initialPrompt: `You are a refactoring specialist. Follow these safety guidelines:

1. **Ensure Test Coverage**
   - Verify tests exist for code being changed
   - Add tests if coverage is insufficient
   - Run tests frequently

2. **Make Small Changes**
   - One logical change at a time
   - Commit after each successful change
   - Keep the code working at all times

3. **Common Refactorings**
   - Extract function/method
   - Rename for clarity
   - Remove duplication (DRY)
   - Simplify conditionals
   - Improve type safety

4. **Verify**
   - All tests pass
   - No new warnings
   - Behavior unchanged`,
    claudeMdContent: null,
    flags: [],
    model: null,
    permissionMode: 'default',
    allowedTools: ['Read', 'Edit', 'Bash', 'Grep', 'Glob'],
    deniedTools: null,
  },
  {
    name: 'documenter',
    description: 'Creates and improves code documentation',
    cwd: null,
    initialPrompt: `You are a documentation specialist. Your task is to:

1. **Analyze Code**
   - Understand the purpose and behavior
   - Identify public APIs and interfaces
   - Note important implementation details

2. **Write Documentation**
   - Clear function/method descriptions
   - Parameter and return value documentation
   - Usage examples where helpful
   - Important caveats and edge cases

3. **Documentation Types**
   - JSDoc/TSDoc comments
   - README files
   - API documentation
   - Architecture documentation

Keep documentation concise, accurate, and maintainable.`,
    claudeMdContent: null,
    flags: [],
    model: null,
    permissionMode: 'default',
    allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
    deniedTools: null,
  },
  {
    name: 'security-auditor',
    description: 'Audits code for security vulnerabilities',
    cwd: null,
    initialPrompt: `You are a security auditor. Analyze code for:

1. **Injection Vulnerabilities**
   - SQL injection
   - Command injection
   - XSS (Cross-Site Scripting)
   - Template injection

2. **Authentication & Authorization**
   - Proper auth checks
   - Session management
   - Access control issues

3. **Data Security**
   - Sensitive data exposure
   - Insecure data storage
   - Missing encryption

4. **Common Vulnerabilities**
   - OWASP Top 10
   - Insecure dependencies
   - Configuration issues

Report findings with severity levels and remediation steps.`,
    claudeMdContent: null,
    flags: [],
    model: null,
    permissionMode: 'default',
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    deniedTools: null,
  },
];

// Icon mapping for built-in agents
const AGENT_ICONS: Record<string, React.ReactNode> = {
  'code-reviewer': <Code className="w-4 h-4" />,
  'test-writer': <TestTube className="w-4 h-4" />,
  'debugger': <Bug className="w-4 h-4" />,
  'refactorer': <GitBranch className="w-4 h-4" />,
  'documenter': <FileText className="w-4 h-4" />,
  'security-auditor': <Shield className="w-4 h-4" />,
};

// ============================================================================
// AGENT FORM COMPONENT
// ============================================================================

interface AgentFormProps {
  agent?: AgentTemplate;
  onSave: (agent: Partial<AgentTemplate>, projectPath: string | null) => void;
  onCancel: () => void;
}

function AgentForm({ agent, onSave, onCancel }: AgentFormProps) {
  const [name, setName] = useState(agent?.name || '');
  const [description, setDescription] = useState(agent?.description || '');
  const [scope, setScope] = useState<'user' | 'project'>(agent?.cwd ? 'project' : 'user');
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(agent?.cwd || null);
  const [initialPrompt, setInitialPrompt] = useState(agent?.initialPrompt || '');
  const [claudeMdContent, setClaudeMdContent] = useState(agent?.claudeMdContent || '');
  const [model, setModel] = useState(agent?.model || '');
  const [permissionMode, setPermissionMode] = useState<'default' | 'plan' | 'bypassPermissions'>(
    agent?.permissionMode || 'default'
  );
  const [allowedToolsString, setAllowedToolsString] = useState(
    agent?.allowedTools?.join(', ') || ''
  );
  const [flagsString, setFlagsString] = useState(agent?.flags?.join(', ') || '');

  const handleProjectChange = (projectId: number | null, projectPath: string | null) => {
    setSelectedProjectId(projectId);
    setSelectedProjectPath(projectPath);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const allowedTools = allowedToolsString
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);

    const flags = flagsString
      .split(',')
      .map((f) => f.trim())
      .filter(Boolean);

    let projectPath: string | null = null;

    if (scope === 'project') {
      if (selectedProjectPath) {
        projectPath = selectedProjectPath;
      } else {
        // No project selected, prompt for folder
        const folderPath = await window.goodvibes?.selectFolder?.();
        if (!folderPath) {
          return; // User cancelled
        }
        projectPath = folderPath;
      }
    }

    onSave({
      id: agent?.id,
      name,
      description: description || null,
      initialPrompt: initialPrompt || null,
      claudeMdContent: claudeMdContent || null,
      model: model || null,
      permissionMode,
      allowedTools: allowedTools.length > 0 ? allowedTools : null,
      flags,
      cwd: projectPath,
      deniedTools: null,
    }, projectPath);
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="space-y-4 bg-surface-900 rounded-lg p-4 border border-surface-700"
    >
      <div className="grid grid-cols-3 gap-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Agent Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-agent"
            pattern="[a-z0-9-]+"
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            required
          />
          <p className="text-xs text-surface-500 mt-1">
            Lowercase letters, numbers, and hyphens only
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Scope
          </label>
          <select
            value={scope}
            onChange={(e) => {
              const newScope = e.target.value as 'user' | 'project';
              setScope(newScope);
              if (newScope === 'user') {
                setSelectedProjectId(null);
                setSelectedProjectPath(null);
              }
            }}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          >
            <option value="user">User (Global)</option>
            <option value="project">Project</option>
          </select>
        </div>

        <ProjectSelector
          scope={scope}
          selectedProjectId={selectedProjectId}
          onProjectChange={handleProjectChange}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Model
          </label>
          <select
            value={model}
            onChange={(e) => setModel(e.target.value)}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          >
            <option value="">Default</option>
            <option value="claude-sonnet-4-20250514">Claude Sonnet 4</option>
            <option value="claude-opus-4-5-20251101">Claude Opus 4.5</option>
            <option value="claude-3-5-haiku-20241022">Claude 3.5 Haiku</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Permission Mode
          </label>
          <select
            value={permissionMode}
            onChange={(e) => setPermissionMode(e.target.value as typeof permissionMode)}
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          >
            <option value="default">Default</option>
            <option value="plan">Plan Mode</option>
            <option value="bypassPermissions">Bypass Permissions</option>
          </select>
        </div>
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Description
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this agent does..."
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Initial Prompt (System Instructions)
        </label>
        <textarea
          value={initialPrompt}
          onChange={(e) => setInitialPrompt(e.target.value)}
          placeholder="# Agent Instructions&#10;&#10;You are a specialized agent that..."
          rows={10}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          CLAUDE.md Content (Optional)
        </label>
        <textarea
          value={claudeMdContent}
          onChange={(e) => setClaudeMdContent(e.target.value)}
          placeholder="Additional context to inject into CLAUDE.md..."
          rows={4}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            Allowed Tools (comma-separated)
          </label>
          <input
            type="text"
            value={allowedToolsString}
            onChange={(e) => setAllowedToolsString(e.target.value)}
            placeholder="Bash, Read, Edit, Grep, Glob"
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          />
          <p className="text-xs text-surface-500 mt-1">
            Leave empty to allow all tools
          </p>
        </div>

        <div>
          <label className="block text-sm font-medium text-surface-300 mb-1">
            CLI Flags (comma-separated)
          </label>
          <input
            type="text"
            value={flagsString}
            onChange={(e) => setFlagsString(e.target.value)}
            placeholder="--verbose, --no-cache"
            className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          />
          <p className="text-xs text-surface-500 mt-1">
            Additional CLI arguments
          </p>
        </div>
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
          {agent ? 'Update Agent' : 'Create Agent'}
        </button>
      </div>
    </form>
  );
}

// ============================================================================
// AGENT CARD COMPONENT
// ============================================================================

interface AgentCardProps {
  agent: AgentTemplate | (Omit<AgentTemplate, 'id' | 'createdAt' | 'updatedAt'> & { isBuiltIn: true });
  onUse: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onCopy: () => void;
}

function AgentCard({ agent, onUse, onEdit, onDelete, onCopy }: AgentCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const isBuiltIn = 'isBuiltIn' in agent;

  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const icon = AGENT_ICONS[agent.name] || <Zap className="w-4 h-4" />;

  return (
    <div className="bg-surface-900 rounded-lg border border-surface-700">
      <div className="p-4">
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3">
            <button
              onClick={() => setExpanded(!expanded)}
              className="mt-1 text-surface-400 hover:text-surface-200 transition-colors"
            >
              {expanded ? (
                <ChevronDown className="w-4 h-4" />
              ) : (
                <ChevronRight className="w-4 h-4" />
              )}
            </button>

            <div>
              <div className="flex items-center gap-2">
                <span className="text-accent-purple">{icon}</span>
                <h3 className="font-medium text-surface-100">{agent.name}</h3>
                {isBuiltIn && (
                  <span className="text-xs px-2 py-0.5 bg-blue-400/20 text-blue-400 rounded">
                    Built-in
                  </span>
                )}
                <span className="text-xs px-2 py-0.5 bg-surface-700 rounded text-surface-400">
                  {agent.cwd ? 'project' : 'user'}
                </span>
                {agent.model && (
                  <span className="text-xs px-2 py-0.5 bg-surface-700 rounded text-surface-400">
                    {agent.model.replace('claude-', '').replace(/-\d+$/, '')}
                  </span>
                )}
              </div>
              {agent.description && (
                <p className="text-sm text-surface-400 mt-1">{agent.description}</p>
              )}
              {!isBuiltIn && 'createdAt' in agent && (
                <div className="flex items-center gap-4 mt-2 text-xs text-surface-500">
                  <span>Created: {new Date(agent.createdAt).toLocaleDateString()}</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-1">
            <button
              onClick={onUse}
              className="px-3 py-1.5 text-sm bg-accent-purple text-white rounded hover:bg-accent-purple/80 transition-colors flex items-center gap-1"
            >
              <Play className="w-3 h-3" />
              Use
            </button>
            <button
              onClick={handleCopy}
              className="p-1.5 text-surface-400 hover:text-surface-200 hover:bg-surface-700 rounded transition-colors"
              title="Copy prompt"
            >
              {copied ? (
                <Check className="w-4 h-4 text-green-400" />
              ) : (
                <Copy className="w-4 h-4" />
              )}
            </button>
            {!isBuiltIn && onEdit && (
              <button
                onClick={onEdit}
                className="p-1.5 text-surface-400 hover:text-surface-200 hover:bg-surface-700 rounded transition-colors"
                title="Edit"
              >
                <Edit2 className="w-4 h-4" />
              </button>
            )}
            {!isBuiltIn && onDelete && (
              <button
                onClick={onDelete}
                className="p-1.5 text-surface-400 hover:text-red-400 hover:bg-red-400/10 rounded transition-colors"
                title="Delete"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {expanded && (
          <div className="mt-4 pt-4 border-t border-surface-700 space-y-4">
            {agent.initialPrompt && (
              <div>
                <span className="text-xs text-surface-500 uppercase tracking-wider">Initial Prompt</span>
                <div className="bg-surface-800 rounded-lg p-3 mt-1">
                  <pre className="text-sm text-surface-300 whitespace-pre-wrap font-mono">
                    {agent.initialPrompt}
                  </pre>
                </div>
              </div>
            )}

            {agent.claudeMdContent && (
              <div>
                <span className="text-xs text-surface-500 uppercase tracking-wider">CLAUDE.md Content</span>
                <div className="bg-surface-800 rounded-lg p-3 mt-1">
                  <pre className="text-sm text-surface-300 whitespace-pre-wrap font-mono">
                    {agent.claudeMdContent}
                  </pre>
                </div>
              </div>
            )}

            <div className="flex flex-wrap gap-4">
              {agent.permissionMode && agent.permissionMode !== 'default' && (
                <div>
                  <span className="text-xs text-surface-500">Permission Mode:</span>
                  <span className="ml-2 text-xs px-2 py-0.5 bg-yellow-400/20 text-yellow-400 rounded">
                    {agent.permissionMode}
                  </span>
                </div>
              )}

              {agent.allowedTools && agent.allowedTools.length > 0 && (
                <div>
                  <span className="text-xs text-surface-500">Allowed Tools:</span>
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {agent.allowedTools.map((tool) => (
                      <span
                        key={tool}
                        className="text-xs px-2 py-0.5 bg-surface-700 rounded text-surface-300"
                      >
                        {tool}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {agent.flags && agent.flags.length > 0 && (
                <div>
                  <span className="text-xs text-surface-500">CLI Flags:</span>
                  <div className="flex gap-1 mt-1 flex-wrap">
                    {agent.flags.map((flag) => (
                      <span
                        key={flag}
                        className="text-xs px-2 py-0.5 bg-surface-700 rounded text-surface-300 font-mono"
                      >
                        {flag}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// MAIN AGENTS VIEW
// ============================================================================

export default function AgentsView() {
  const [agents, setAgents] = useState<AgentTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingAgent, setEditingAgent] = useState<AgentTemplate | undefined>();
  const [searchQuery, setSearchQuery] = useState('');
  const [showBuiltIn, setShowBuiltIn] = useState(true);

  const loadAgents = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.goodvibes.getAgentTemplates();
      setAgents(result || []);
    } catch (error) {
      console.error('Failed to load agent templates:', error);
      setAgents([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAgents();
  }, [loadAgents]);

  const handleSave = async (agentData: Partial<AgentTemplate>, projectPath: string | null) => {
    try {
      if (agentData.id) {
        await window.goodvibes.updateAgentTemplate(agentData.id, {
          ...agentData,
          cwd: projectPath || undefined,
        });
      } else {
        await window.goodvibes.createAgentTemplate({
          name: agentData.name || '',
          description: agentData.description || undefined,
          initialPrompt: agentData.initialPrompt || undefined,
          claudeMdContent: agentData.claudeMdContent || undefined,
          model: agentData.model || undefined,
          permissionMode: agentData.permissionMode || undefined,
          flags: agentData.flags || undefined,
          cwd: projectPath || undefined,
        });
      }
      setShowForm(false);
      setEditingAgent(undefined);
      loadAgents();
    } catch (error) {
      console.error('Failed to save agent template:', error);
    }
  };

  const handleUse = async (agentName: string) => {
    try {
      // Copy agent name to clipboard for easy use
      await navigator.clipboard.writeText(agentName);
    } catch (error) {
      console.error('Failed to copy agent name:', error);
    }
  };

  const handleCopy = async (content: string) => {
    await navigator.clipboard.writeText(content);
  };

  const handleDelete = async (id: string) => {
    if (confirm('Are you sure you want to delete this agent template?')) {
      try {
        await window.goodvibes.deleteAgentTemplate(id);
        loadAgents();
      } catch (error) {
        console.error('Failed to delete agent template:', error);
      }
    }
  };

  const filteredAgents = agents.filter(
    (a) =>
      !searchQuery ||
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredBuiltIn = BUILT_IN_AGENTS.filter(
    (a) =>
      !searchQuery ||
      a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      a.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-surface-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Users className="w-6 h-6 text-accent-purple" />
            <div>
              <h1 className="text-xl font-semibold text-surface-100">Agents</h1>
              <p className="text-sm text-surface-400">
                Agent template library for Claude Code
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              setEditingAgent(undefined);
              setShowForm(true);
            }}
            className="px-4 py-2 bg-accent-purple text-white rounded-lg hover:bg-accent-purple/80 transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Agent
          </button>
        </div>

        {/* Search and filters */}
        <div className="flex gap-4 mt-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-surface-500" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search agents..."
              className="w-full pl-10 pr-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
            />
          </div>
          <button
            onClick={() => setShowBuiltIn(!showBuiltIn)}
            className={`px-3 py-2 text-sm rounded-lg transition-colors ${
              showBuiltIn
                ? 'bg-surface-700 text-surface-200'
                : 'text-surface-400 hover:text-surface-200 hover:bg-surface-800'
            }`}
          >
            {showBuiltIn ? 'Hide Built-in' : 'Show Built-in'}
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {showForm && (
          <div className="mb-6">
            <AgentForm
              agent={editingAgent}
              onSave={handleSave}
              onCancel={() => {
                setShowForm(false);
                setEditingAgent(undefined);
              }}
            />
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center h-64">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-accent-purple" />
          </div>
        ) : (
          <div className="space-y-6">
            {/* Custom Agents */}
            {filteredAgents.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-surface-400 mb-3">
                  Custom Agents ({filteredAgents.length})
                </h2>
                <div className="space-y-3">
                  {filteredAgents.map((agent) => (
                    <AgentCard
                      key={agent.id}
                      agent={agent}
                      onUse={() => handleUse(agent.name)}
                      onEdit={() => {
                        setEditingAgent(agent);
                        setShowForm(true);
                      }}
                      onDelete={() => handleDelete(agent.id)}
                      onCopy={() => handleCopy(agent.initialPrompt || '')}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Built-in Agents */}
            {showBuiltIn && filteredBuiltIn.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-surface-400 mb-3">
                  Built-in Agents ({filteredBuiltIn.length})
                </h2>
                <div className="space-y-3">
                  {filteredBuiltIn.map((agent) => (
                    <AgentCard
                      key={agent.name}
                      agent={{ ...agent, isBuiltIn: true as const }}
                      onUse={() => handleUse(agent.name)}
                      onCopy={() => handleCopy(agent.initialPrompt || '')}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Empty state */}
            {filteredAgents.length === 0 && (!showBuiltIn || filteredBuiltIn.length === 0) && (
              <div className="text-center py-12">
                <Users className="w-12 h-12 text-surface-600 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-surface-300">
                  {searchQuery ? 'No agents match your search' : 'No custom agents yet'}
                </h3>
                <p className="text-surface-500 mt-2">
                  {searchQuery
                    ? 'Try a different search term'
                    : 'Create agent templates for specialized tasks'}
                </p>
                {!searchQuery && (
                  <button
                    onClick={() => setShowForm(true)}
                    className="mt-4 px-4 py-2 bg-surface-700 text-surface-200 rounded-lg hover:bg-surface-600 transition-colors"
                  >
                    Create your first agent
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Info section */}
        <div className="mt-8 p-4 bg-surface-900 rounded-lg border border-surface-700">
          <div className="flex items-start gap-3">
            <Settings className="w-5 h-5 text-surface-400 mt-0.5" />
            <div className="text-sm text-surface-400">
              <p className="font-medium text-surface-300 mb-1">About Agents</p>
              <p>
                Agent templates define specialized configurations for Claude Code sessions.
                Each template includes an initial prompt, model selection, permission settings,
                and tool restrictions to create focused, task-specific agents.
              </p>
              <p className="mt-2">
                Use the "Use" button to copy the agent name, or expand an agent to view
                and copy its full configuration.
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
