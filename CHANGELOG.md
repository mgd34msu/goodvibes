# Changelog

All notable changes to GoodVibes will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-02-03

### Added

#### File Explorer Enhancements
- **Session viewing in File Explorer** - Right-click any folder to view Claude sessions for that project
- **Sessions panel with table layout** - Redesigned with Date/Time, Messages, Tokens, Cost columns
- **CLI resume button** - "Open with CLI" button to resume any session directly in terminal
- **Session ID display** - 7-character session ID shown in table and preview header
- **Pinned folders persistence** - Pinned folders now persist across app restarts via database storage
- **Markdown preview toggle** - Eye/EyeOff toggle for .md/.mdx files to switch between raw and rendered markdown

#### Analytics Improvements
- **Subagent cost attribution** - Subagent costs now roll up to their parent project instead of appearing separately
- **Project name decoding** - Fixed folders with dots (e.g., `goodvibes.sh`) displaying correctly

### Fixed
- Dropdown menu items no longer appear highlighted on open (`tabIndex={-1}` fix)
- Session cost calculation using correct Anthropic pricing table columns
- Analytics dashboard crash when `agent_tree_nodes` table doesn't exist
- Folders with dots in names now correctly detect sessions
- Sessions panel layout positioning (FileExplorer stays visible)

### Changed
- Sessions panel default split changed to 20% list / 80% preview
- Resizable range constrained to 10-50% (favors preview area)

## [1.0.0] - 2026-01-28

### Added

#### Session Management
- **Live session detection** - Real-time detection of active Claude sessions with visual indicators
- **Session virtualization** - Virtualized lists for smooth scrolling with thousands of sessions
- **Auto-rescan sessions** - Sessions view refreshes every 10 seconds automatically
- **Previous Sessions modal** - Load session preview or resume directly in CLI

#### Plugin & MCP Ecosystem
- **Dedicated Plugins view** - Separate from MCP server management
- **MCP Marketplace** - Curated list of MCP servers organized by category
- **Featured plugins** - Highlighted recommended plugins with special styling
- **GoodVibes Plugin integration** - Documentation and quick-install scripts

#### Terminal Improvements
- **Multi-session support** - Run multiple Claude sessions in parallel tabs
- **Shell customization** - Configure preferred shell in settings
- **Cursor visibility** - Show cursor in plain terminals, hide only for Claude CLI sessions
- **Large paste handling** - Fixed UI freezes when pasting large content

#### Comprehensive Stability Fixes
- 15+ stability and performance fixes from codebase remediation
- Fixed infinite loop in SafeHighlight regex parsing
- Resolved race conditions in various components

## [0.5.0] - 2026-01-20

### Added

#### GitHub Integration
- **GitHub OAuth Device Flow authentication** - Secure, seamless login using GitHub's device authorization flow
- **Custom OAuth App configuration** - Option to use your own GitHub OAuth App for maximum security
- **Authorization Code Flow support** - Alternative OAuth flow when device flow is disabled
- **Full GitHub API integration** - PR management, issue tracking, repository operations

#### Accessibility (WCAG 2.1 AA Compliance)
- **ARIA labels** - Comprehensive screen reader support across all interactive elements
- **Keyboard navigation** - Full keyboard support for terminal, sidebar, and all UI components
- **Focus management** - Proper focus trapping in modals and dialogs
- **Screen reader announcements** - Live regions for dynamic content updates
- **WCAG color contrast** - All themes meet AA contrast requirements (4.5:1 for text, 3:1 for UI)

#### Performance Optimizations
- **Virtualized lists** - Session lists, MCP servers, and file trees now use virtualization
- **Batch database operations** - Reduced database round-trips with batched queries
- **Memo optimization** - React.memo and useMemo for expensive renders
- **Lazy loading** - Components and views load on demand

#### Theme System
- **12 built-in themes** - Including Goodvibes Classic, Nord, Dracula, Solarized, and more
- **Custom theme support** - Create and save your own color themes
- **Real-time preview** - See theme changes instantly before applying
- **Persistent preferences** - Theme selection saved across sessions

#### Hooks System
- **62 built-in hooks** - Pre-configured hooks for all Claude Code event types
- **All event types supported** - PreToolUse, PostToolUse, PreAssistant, PostAssistant, Notification, etc.
- **Hook installation modal** - Easy installation with scope selection (user/project)
- **Project-specific hooks** - Configure hooks per project

#### Skills & Commands
- **Separate Skills and Commands pages** - Agent skills separate from slash commands
- **Install modals** - Easy installation with code preview
- **Best practices** - Built-in skills follow enterprise-grade patterns

#### CLAUDE.md Templates
- **Scope-based organization** - Templates organized by user, project, and local scope
- **Pre-built templates** - Common patterns for testing, security, documentation, etc.

### Fixed
- Race condition in device flow countdown causing false expiration
- Large paste operations in terminal causing UI freezes
- Card hover/active animations reduced by 50% for better performance
- MCP marketplace search/filter layout issues
- Missing icon and label for Commands in navigation
- Node.js process.cwd() incorrectly used in renderer code

### Changed
- Card interactions now use full card click area for expand/collapse
- Theme settings section now collapsible for cleaner UI
- Reduced hover animation intensity across all cards
- Improved test coverage to 4125+ passing tests

## [0.4.0] - 2026-01-15

### Added
- **Git watcher** - Real-time git status updates without manual refresh
- **Click-to-open modal** - Live Monitor items open in modal on click
- **Text Editor option** - Added to startup menu for quick file editing
- **Quick Restart option** - Restart Claude session from startup menu
- **Collapsible theme settings** - Cleaner settings UI

### Fixed
- Card dropdown UX improvements
- Hover animation performance issues

## [0.3.0] - 2026-01-10

### Added
- **Previous Sessions modal** - Load session preview or resume in CLI
- **Terminal shell customization** - Configure preferred shell (bash, zsh, fish, etc.)
- **Rebranded icons** - New icon set matching GoodVibes aesthetic
- **Notes renamed to Tasks** - Better reflects the feature's purpose
- **Analytics improvements** - Enhanced usage tracking and visualization

### Changed
- Repository URL updated to goodvibes.sh
- Cleaned up development scripts and planning files
- Prepared for initial public release

## [0.2.0] - 2026-01-05

### Added
- **Memory management** - Edit CLAUDE.md files for persistent context injection
- **Agent templates** - Pre-configured agent personalities for different tasks
- **Skills library** - Reusable prompt templates and workflows
- **Project registry** - Multi-project management with per-project settings

### Fixed
- Terminal resize handling edge cases
- Session scanning reliability improvements

## [0.1.0] - 2025-12-28

### Added
- **Git integration panel** - Staging, commits, branches, and diff viewing
- **Session history and search** - Find and filter past Claude sessions
- **Multi-tab terminal management** - Multiple Claude sessions in tabs
- **Session analytics** - Track usage statistics and token consumption

## [0.0.1] - 2025-12-20

### Added
- Initial Electron application structure
- Claude CLI terminal integration with xterm.js
- SQLite database for session storage (better-sqlite3)
- Basic settings and preferences
- Core UI with React 19 and Tailwind CSS

---

**Note:** GoodVibes was originally developed under the name "Clausitron" before being renamed and open-sourced. For historical commits, see the [commit history](https://github.com/mgd34msu/goodvibes.sh/commits/main).
