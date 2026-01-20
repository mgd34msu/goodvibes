# Changelog

All notable changes to GoodVibes will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [2.5.0] - 2026-01-20

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

#### Plugins & MCP
- **Dedicated Plugins view** - Separate from MCP server management
- **MCP Marketplace** - Curated list of MCP servers with categories
- **Featured plugins** - Highlighted recommended plugins with special styling
- **Search and filter** - Find plugins and MCP servers quickly

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

## [2.4.0] - 2026-01-15

### Added

- Git watcher for real-time status updates
- Collapsible theme settings section
- Text Editor and Quick Restart options to startup menu
- Comprehensive theme system with 12 themes

### Fixed

- Card dropdown UX improvements
- Hover animation performance

## [2.3.0] - 2026-01-10

### Added

- GoodVibes Plugin integration documentation
- Session analytics and usage tracking
- Project registry for multi-project management

### Changed

- Repository URL updated to goodvibes.sh
- Cleaned up development scripts and planning files
- Prepared for initial public release

## [2.2.0] - 2026-01-05

### Added

- Memory management for CLAUDE.md files
- Agent templates for pre-configured personalities
- Skills library for reusable prompts

### Fixed

- Terminal resize handling
- Session scanning reliability

## [2.1.0] - 2025-12-28

### Added

- Basic Git integration panel
- Session history and search
- Multi-tab terminal management

## [2.0.0] - 2025-12-20

### Added

- Initial Electron application structure
- Claude CLI terminal integration
- SQLite database for session storage
- Basic settings and preferences

---

For older versions, see the [commit history](https://github.com/mgd34msu/goodvibes.sh/commits/main).
