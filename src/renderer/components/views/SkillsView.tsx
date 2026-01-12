// ============================================================================
// SKILLS VIEW - Skills Library Management
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import {
  Sparkles,
  Plus,
  Search,
  Edit2,
  Trash2,
  Copy,
  Check,
  Play,
  Save,
  Star,
  Clock,
  ChevronDown,
  ChevronRight,
  Settings,
} from 'lucide-react';
import ProjectSelector from '../shared/ProjectSelector';

// ============================================================================
// TYPES
// ============================================================================

interface Skill {
  id: number;
  name: string;
  description: string | null;
  content: string;
  allowedTools: string[] | null;
  scope: 'user' | 'project';
  projectPath: string | null;
  useCount: number;
  lastUsed: string | null;
  createdAt: string;
  updatedAt: string;
}

// ============================================================================
// BUILT-IN SKILLS
// ============================================================================

const BUILT_IN_SKILLS: Omit<Skill, 'id' | 'useCount' | 'lastUsed' | 'createdAt' | 'updatedAt'>[] = [
  {
    name: 'commit',
    description: 'Create a git commit with proper message formatting',
    content: `You are creating a git commit. Follow these steps:

1. Review all staged changes using git diff --staged
2. Analyze the nature of changes (bug fix, feature, refactor, etc.)
3. Write a commit message following conventional commits:
   - Use present tense ("Add feature" not "Added feature")
   - First line: type(scope): description (max 72 chars)
   - Body: explain what and why, not how
4. Execute the commit

Types: feat, fix, docs, style, refactor, test, chore`,
    allowedTools: ['Bash', 'Read', 'Edit'],
    scope: 'user',
    projectPath: null,
  },
  {
    name: 'review-pr',
    description: 'Perform a comprehensive PR review',
    content: `You are reviewing a pull request. Your review should cover:

## Code Quality
- Check for bugs, edge cases, error handling
- Verify code follows project patterns
- Look for potential performance issues

## Security
- Check for vulnerabilities (injection, auth bypass, etc.)
- Verify sensitive data handling

## Testing
- Are new features tested?
- Are edge cases covered?

## Documentation
- Are new functions documented?
- Is README updated if needed?

Provide constructive feedback with specific suggestions.`,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
  },
  {
    name: 'debug',
    description: 'Systematic debugging workflow',
    content: `You are debugging an issue. Follow this systematic approach:

1. **Understand the Problem**
   - What is the expected behavior?
   - What is the actual behavior?
   - Can you reproduce it consistently?

2. **Gather Information**
   - Check error messages and stack traces
   - Review recent changes
   - Check logs and monitoring

3. **Form Hypothesis**
   - Based on evidence, what could cause this?
   - List possible causes in order of likelihood

4. **Test & Verify**
   - Add logging if needed
   - Test each hypothesis
   - Verify the fix doesn't break other things

5. **Document**
   - Record the root cause
   - Document the fix
   - Consider if similar bugs could exist elsewhere`,
    allowedTools: null,
    scope: 'user',
    projectPath: null,
  },
  {
    name: 'refactor',
    description: 'Safe code refactoring workflow',
    content: `You are refactoring code. Follow these safety guidelines:

1. **Ensure Test Coverage**
   - Verify tests exist for code being changed
   - Add tests if coverage is insufficient

2. **Make Small Changes**
   - One logical change at a time
   - Commit frequently

3. **Preserve Behavior**
   - Refactoring should not change functionality
   - Run tests after each change

4. **Common Refactorings**
   - Extract function/method
   - Rename for clarity
   - Remove duplication
   - Simplify conditionals
   - Improve type safety

5. **Verify**
   - All tests pass
   - No new warnings
   - Code review ready`,
    allowedTools: ['Read', 'Edit', 'Bash'],
    scope: 'user',
    projectPath: null,
  },
];

// ============================================================================
// SKILL FORM COMPONENT
// ============================================================================

interface SkillFormProps {
  skill?: Skill;
  onSave: (skill: Partial<Skill>, projectPath: string | null) => void;
  onCancel: () => void;
}

function SkillForm({ skill, onSave, onCancel }: SkillFormProps) {
  const [name, setName] = useState(skill?.name || '');
  const [description, setDescription] = useState(skill?.description || '');
  const [content, setContent] = useState(skill?.content || '');
  const [allowedToolsString, setAllowedToolsString] = useState(
    skill?.allowedTools?.join(', ') || ''
  );
  const [scope, setScope] = useState<'user' | 'project'>(skill?.scope || 'user');
  const [selectedProjectId, setSelectedProjectId] = useState<number | null>(null);
  const [selectedProjectPath, setSelectedProjectPath] = useState<string | null>(skill?.projectPath || null);

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
      id: skill?.id,
      name,
      description: description || null,
      content,
      allowedTools: allowedTools.length > 0 ? allowedTools : null,
      scope,
      projectPath,
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
            Skill Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="my-skill"
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

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Description
        </label>
        <input
          type="text"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What this skill does..."
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Skill Content (SKILL.md)
        </label>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder="# Skill Instructions&#10;&#10;Provide detailed instructions for this skill..."
          rows={12}
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 font-mono text-sm focus:ring-2 focus:ring-accent-purple focus:border-transparent"
          required
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-surface-300 mb-1">
          Allowed Tools (comma-separated)
        </label>
        <input
          type="text"
          value={allowedToolsString}
          onChange={(e) => setAllowedToolsString(e.target.value)}
          placeholder="Bash, Read, Edit, Grep"
          className="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-md text-surface-100 focus:ring-2 focus:ring-accent-purple focus:border-transparent"
        />
        <p className="text-xs text-surface-500 mt-1">
          Leave empty to allow all tools
        </p>
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
          {skill ? 'Update Skill' : 'Create Skill'}
        </button>
      </div>
    </form>
  );
}

// ============================================================================
// SKILL CARD COMPONENT
// ============================================================================

interface SkillCardProps {
  skill: Skill | (Omit<Skill, 'id' | 'useCount' | 'lastUsed' | 'createdAt' | 'updatedAt'> & { isBuiltIn: true });
  onUse: () => void;
  onEdit?: () => void;
  onDelete?: () => void;
  onCopy: () => void;
}

function SkillCard({ skill, onUse, onEdit, onDelete, onCopy }: SkillCardProps) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const isBuiltIn = 'isBuiltIn' in skill;

  const handleCopy = () => {
    onCopy();
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

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
                <Sparkles className="w-4 h-4 text-accent-purple" />
                <h3 className="font-medium text-surface-100">/{skill.name}</h3>
                {isBuiltIn && (
                  <span className="text-xs px-2 py-0.5 bg-blue-400/20 text-blue-400 rounded">
                    Built-in
                  </span>
                )}
                <span className="text-xs px-2 py-0.5 bg-surface-700 rounded text-surface-400">
                  {skill.scope}
                </span>
              </div>
              {skill.description && (
                <p className="text-sm text-surface-400 mt-1">{skill.description}</p>
              )}
              {!isBuiltIn && 'useCount' in skill && skill.useCount > 0 && (
                <div className="flex items-center gap-4 mt-2 text-xs text-surface-500">
                  <span className="flex items-center gap-1">
                    <Star className="w-3 h-3" />
                    Used {skill.useCount} times
                  </span>
                  {skill.lastUsed && (
                    <span className="flex items-center gap-1">
                      <Clock className="w-3 h-3" />
                      Last: {new Date(skill.lastUsed).toLocaleDateString()}
                    </span>
                  )}
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
              title="Copy"
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
          <div className="mt-4 pt-4 border-t border-surface-700">
            <div className="bg-surface-800 rounded-lg p-3">
              <pre className="text-sm text-surface-300 whitespace-pre-wrap font-mono">
                {skill.content}
              </pre>
            </div>
            {skill.allowedTools && skill.allowedTools.length > 0 && (
              <div className="mt-3">
                <span className="text-xs text-surface-500">Allowed Tools:</span>
                <div className="flex gap-2 mt-1 flex-wrap">
                  {skill.allowedTools.map((tool) => (
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
          </div>
        )}
      </div>
    </div>
  );
}

// ============================================================================
// MAIN SKILLS VIEW
// ============================================================================

export default function SkillsView() {
  const [skills, setSkills] = useState<Skill[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [editingSkill, setEditingSkill] = useState<Skill | undefined>();
  const [searchQuery, setSearchQuery] = useState('');
  const [showBuiltIn, setShowBuiltIn] = useState(true);

  const loadSkills = useCallback(async () => {
    setLoading(true);
    try {
      const result = await window.goodvibes.getSkills();
      // Map API response to Skill interface
      const mappedSkills: Skill[] = (result || []).map((s: Record<string, unknown>) => ({
        id: s.id as number,
        name: s.name as string,
        description: s.description as string | null,
        content: s.content as string || s.promptTemplate as string || '',
        allowedTools: s.allowedTools as string[] | null,
        scope: (s.scope as 'user' | 'project') || 'user',
        projectPath: s.projectPath as string | null,
        useCount: (s.useCount as number) || 0,
        lastUsed: s.lastUsed as string | null,
        createdAt: s.createdAt as string || new Date().toISOString(),
        updatedAt: s.updatedAt as string || new Date().toISOString(),
      }));
      setSkills(mappedSkills);
    } catch (error) {
      console.error('Failed to load skills:', error);
      setSkills([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const handleSave = async (skillData: Partial<Skill>, projectPath: string | null) => {
    try {
      if (skillData.id) {
        await window.goodvibes.updateSkill(skillData.id, {
          name: skillData.name,
          description: skillData.description,
          promptTemplate: skillData.content,
          allowedTools: skillData.allowedTools,
          scope: skillData.scope,
          projectPath: projectPath || undefined,
        });
      } else {
        await window.goodvibes.createSkill({
          name: skillData.name || '',
          description: skillData.description || undefined,
          promptTemplate: skillData.content || '',
          isBuiltIn: false,
          scope: skillData.scope,
          projectPath: projectPath || undefined,
        });
      }
      setShowForm(false);
      setEditingSkill(undefined);
      loadSkills();
    } catch (error) {
      console.error('Failed to save skill:', error);
    }
  };

  const handleUse = async (skillName: string) => {
    try {
      // Copy slash command to clipboard
      await navigator.clipboard.writeText(`/${skillName}`);
    } catch (error) {
      console.error('Failed to copy skill command:', error);
    }
  };

  const handleCopy = async (content: string) => {
    await navigator.clipboard.writeText(content);
  };

  const handleDelete = async (id: number) => {
    if (confirm('Are you sure you want to delete this skill?')) {
      try {
        await window.goodvibes.deleteSkill(id);
        loadSkills();
      } catch (error) {
        console.error('Failed to delete skill:', error);
      }
    }
  };

  const filteredSkills = skills.filter(
    (s) =>
      !searchQuery ||
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const filteredBuiltIn = BUILT_IN_SKILLS.filter(
    (s) =>
      !searchQuery ||
      s.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.description?.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="h-full flex flex-col">
      {/* Header */}
      <div className="flex-shrink-0 px-6 py-4 border-b border-surface-800">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Sparkles className="w-6 h-6 text-accent-purple" />
            <div>
              <h1 className="text-xl font-semibold text-surface-100">Skills</h1>
              <p className="text-sm text-surface-400">
                Custom skill library for Claude Code
              </p>
            </div>
          </div>

          <button
            onClick={() => {
              setEditingSkill(undefined);
              setShowForm(true);
            }}
            className="px-4 py-2 bg-accent-purple text-white rounded-lg hover:bg-accent-purple/80 transition-colors flex items-center gap-2"
          >
            <Plus className="w-4 h-4" />
            New Skill
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
              placeholder="Search skills..."
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
            <SkillForm
              skill={editingSkill}
              onSave={handleSave}
              onCancel={() => {
                setShowForm(false);
                setEditingSkill(undefined);
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
            {/* Custom Skills */}
            {filteredSkills.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-surface-400 mb-3">
                  Custom Skills ({filteredSkills.length})
                </h2>
                <div className="space-y-3">
                  {filteredSkills.map((skill) => (
                    <SkillCard
                      key={skill.id}
                      skill={skill}
                      onUse={() => handleUse(skill.name)}
                      onEdit={() => {
                        setEditingSkill(skill);
                        setShowForm(true);
                      }}
                      onDelete={() => handleDelete(skill.id)}
                      onCopy={() => handleCopy(skill.content)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Built-in Skills */}
            {showBuiltIn && filteredBuiltIn.length > 0 && (
              <div>
                <h2 className="text-sm font-medium text-surface-400 mb-3">
                  Built-in Skills ({filteredBuiltIn.length})
                </h2>
                <div className="space-y-3">
                  {filteredBuiltIn.map((skill) => (
                    <SkillCard
                      key={skill.name}
                      skill={{ ...skill, isBuiltIn: true as const }}
                      onUse={() => handleUse(skill.name)}
                      onCopy={() => handleCopy(skill.content)}
                    />
                  ))}
                </div>
              </div>
            )}

            {/* Empty state */}
            {filteredSkills.length === 0 && (!showBuiltIn || filteredBuiltIn.length === 0) && (
              <div className="text-center py-12">
                <Sparkles className="w-12 h-12 text-surface-600 mx-auto mb-4" />
                <h3 className="text-lg font-medium text-surface-300">
                  {searchQuery ? 'No skills match your search' : 'No custom skills yet'}
                </h3>
                <p className="text-surface-500 mt-2">
                  {searchQuery
                    ? 'Try a different search term'
                    : 'Create skills to automate common workflows'}
                </p>
                {!searchQuery && (
                  <button
                    onClick={() => setShowForm(true)}
                    className="mt-4 px-4 py-2 bg-surface-700 text-surface-200 rounded-lg hover:bg-surface-600 transition-colors"
                  >
                    Create your first skill
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
              <p className="font-medium text-surface-300 mb-1">About Skills</p>
              <p>
                Skills are reusable instruction sets that can be invoked with slash commands
                (e.g., /commit, /review-pr). They help maintain consistency across sessions
                and automate common workflows.
              </p>
              <p className="mt-2">
                Use the Skill tool in Claude Code: <code className="bg-surface-800 px-1 rounded">Skill skill: "my-skill"</code>
              </p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
