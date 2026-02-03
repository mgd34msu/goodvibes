// ============================================================================
// PLUGINS VIEW CONSTANTS
// ============================================================================

import type { Plugin } from './types';

/**
 * Built-in plugins that are available in the marketplace
 * Order: Featured plugins first (GoodVibes), then alphabetically
 */
export const BUILT_IN_PLUGINS: Plugin[] = [
  // ============================================================================
  // FEATURED PLUGINS
  // ============================================================================
  {
    id: 'goodvibes',
    name: 'GoodVibes',
    description: 'Supercharge Claude Code with intelligent context injection, persistent memory, smart error recovery, automated quality gates, and 170+ development skills.',
    category: 'productivity',
    repository: 'https://github.com/mgd34msu/goodvibes-plugin',
    documentation: 'https://goodvibes.sh/',
    featured: true,
    vibes: 'immaculate',
  },
  // ============================================================================
  // ANTHROPIC OFFICIAL PLUGINS (alphabetically sorted)
  // ============================================================================
  {
    id: 'agent-sdk-dev',
    name: 'Agent SDK Dev',
    description: 'Comprehensive toolkit for developing Claude Agent SDK applications with project scaffolding, automated verification, and best practices enforcement.',
    category: 'ai',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/agent-sdk-dev',
    author: 'Anthropic',
  },
  {
    id: 'clangd-lsp',
    name: 'C/C++ Language Server',
    description: 'C/C++ language server (clangd) providing code intelligence, diagnostics, and formatting for C and C++ projects.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/clangd-lsp',
    author: 'Anthropic',
  },
  {
    id: 'code-review',
    name: 'Code Review',
    description: 'Automated pull request review using multiple specialized agents with confidence-based scoring to identify bugs, check guideline compliance, and reduce false positives.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-review',
    author: 'Anthropic',
  },
  {
    id: 'code-simplifier',
    name: 'Code Simplifier',
    description: 'Identifies unnecessary complexity in code and suggests targeted refactoring opportunities to improve maintainability.',
    category: 'productivity',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/code-simplifier',
    author: 'Anthropic',
  },
  {
    id: 'commit-commands',
    name: 'Commit Commands',
    description: 'Streamline git workflows with commands for smart commits, push operations, and automatic pull request creation with contextual descriptions.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/commit-commands',
    author: 'Anthropic',
  },
  {
    id: 'csharp-lsp',
    name: 'C# Language Server',
    description: 'C# language server providing code intelligence, diagnostics, and refactoring for .NET projects.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/csharp-lsp',
    author: 'Anthropic',
  },
  {
    id: 'example-plugin',
    name: 'Example Plugin',
    description: 'Comprehensive example demonstrating Claude Code extension patterns including commands, skills, and MCP server integration.',
    category: 'custom',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/example-plugin',
    author: 'Anthropic',
  },
  {
    id: 'explanatory-output-style',
    name: 'Explanatory Output Style',
    description: 'SessionStart hook that encourages educational insights about implementation choices and codebase patterns alongside code work.',
    category: 'productivity',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/explanatory-output-style',
    author: 'Anthropic',
  },
  {
    id: 'feature-dev',
    name: 'Feature Development',
    description: 'Systematic 7-phase approach to building features with discovery, architecture design, implementation, and quality review using specialized agents.',
    category: 'productivity',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/feature-dev',
    author: 'Anthropic',
  },
  {
    id: 'frontend-design',
    name: 'Frontend Design',
    description: 'Generate distinctive, production-grade frontend interfaces with bold aesthetics, unique typography, and high-impact animations.',
    category: 'productivity',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/frontend-design',
    author: 'Anthropic',
  },
  {
    id: 'get-shit-done',
    name: 'Get Shit Done',
    description: 'A meta-prompting, context engineering and spec-driven development system. Combats context rot with structured phases, atomic commits, and multi-agent orchestration.',
    category: 'productivity',
    repository: 'https://github.com/glittercowboy/get-shit-done',
    featured: true,
    vibes: 'great',
  },
  {
    id: 'gopls-lsp',
    name: 'Go Language Server',
    description: 'Go language server (gopls) providing code intelligence, refactoring, and analysis for Go projects.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/gopls-lsp',
    author: 'Anthropic',
  },
  {
    id: 'hookify',
    name: 'Hookify',
    description: 'Create custom behavioral safeguards through markdown configuration. Detect patterns, block dangerous operations, and enforce practices without code editing.',
    category: 'productivity',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/hookify',
    author: 'Anthropic',
  },
  {
    id: 'jdtls-lsp',
    name: 'Java Language Server',
    description: 'Java language server (Eclipse JDT.LS) providing code intelligence, refactoring, and diagnostics for Java projects.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/jdtls-lsp',
    author: 'Anthropic',
  },
  {
    id: 'kotlin-lsp',
    name: 'Kotlin Language Server',
    description: 'Kotlin language server providing code intelligence, refactoring support, and analysis for Kotlin projects.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/kotlin-lsp',
    author: 'Anthropic',
  },
  {
    id: 'learning-output-style',
    name: 'Learning Output Style',
    description: 'Interactive learning approach that identifies opportunities for hands-on coding while providing educational context and explanations.',
    category: 'productivity',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/learning-output-style',
    author: 'Anthropic',
  },
  {
    id: 'lua-lsp',
    name: 'Lua Language Server',
    description: 'Lua language server (LuaLS) providing code intelligence, diagnostics, and completion for Lua projects.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/lua-lsp',
    author: 'Anthropic',
  },
  {
    id: 'php-lsp',
    name: 'PHP Language Server',
    description: 'PHP language server (Intelephense) providing code intelligence, diagnostics, and completion for PHP projects.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/php-lsp',
    author: 'Anthropic',
  },
  {
    id: 'plugin-dev',
    name: 'Plugin Development',
    description: 'Comprehensive toolkit for developing Claude Code plugins with expert guidance on hooks, MCP integration, plugin structure, and publishing.',
    category: 'ai',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/plugin-dev',
    author: 'Anthropic',
  },
  {
    id: 'pr-review-toolkit',
    name: 'PR Review Toolkit',
    description: 'Collection of six specialized review agents covering comments, test coverage, error handling, type design, code quality, and simplification.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pr-review-toolkit',
    author: 'Anthropic',
  },
  {
    id: 'pyright-lsp',
    name: 'Python Language Server',
    description: 'Python language server (Pyright) providing static type checking and code intelligence for Python projects.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/pyright-lsp',
    author: 'Anthropic',
  },
  {
    id: 'ralph-loop',
    name: 'Ralph Loop',
    description: 'Self-referential AI feedback loop enabling iterative, hands-off task completion through session management and automatic re-prompting.',
    category: 'ai',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/ralph-loop',
    author: 'Anthropic',
    featured: true,
    vibes: 'immaculate',
  },
  {
    id: 'rust-analyzer-lsp',
    name: 'Rust Language Server',
    description: 'Rust language server (rust-analyzer) providing code intelligence, diagnostics, and refactoring for Rust projects.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/rust-analyzer-lsp',
    author: 'Anthropic',
  },
  {
    id: 'security-guidance',
    name: 'Security Guidance',
    description: 'Security-focused analysis and guidance for identifying vulnerabilities and implementing secure coding practices.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/security-guidance',
    author: 'Anthropic',
  },
  {
    id: 'swift-lsp',
    name: 'Swift Language Server',
    description: 'Swift language server (SourceKit-LSP) providing code intelligence, diagnostics, and navigation for Swift projects.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/swift-lsp',
    author: 'Anthropic',
  },
  {
    id: 'typescript-lsp',
    name: 'TypeScript Language Server',
    description: 'TypeScript/JavaScript language server providing code intelligence, go-to-definition, find references, and error checking.',
    category: 'devops',
    repository: 'https://github.com/anthropics/claude-plugins-official/tree/main/plugins/typescript-lsp',
    author: 'Anthropic',
  },
];

/**
 * Category filter options for the marketplace
 */
export const CATEGORY_FILTERS = [
  { value: 'all', label: 'All Categories' },
  { value: 'productivity', label: 'Productivity' },
  { value: 'devops', label: 'DevOps' },
  { value: 'communication', label: 'Communication' },
  { value: 'ai', label: 'AI & ML' },
  { value: 'custom', label: 'Custom' },
] as const;
