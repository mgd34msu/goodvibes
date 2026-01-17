# GoodVibes

GoodVibes is an Electron-based desktop application that provides an enhanced interface for Claude CLI with session management, analytics, Git integration, and a rich plugin ecosystem.

## Features

- **Terminal Management**: Multiple Claude CLI terminal sessions with tabs
- **Session Analytics**: Track usage statistics, token consumption, and session history
- **Git Integration**: Built-in Git panel with staging, commits, branches, and GitHub PR/Issue management
- **Hooks System**: Customize Claude behavior with PreToolUse, PostToolUse, and Stop hooks
- **MCP Servers**: Model Context Protocol server management for extending Claude capabilities
- **Skills Library**: Reusable prompt templates and workflows
- **Agent Templates**: Pre-configured agent personalities for different tasks
- **Project Registry**: Multi-project management with per-project settings
- **Memory Management**: Edit CLAUDE.md files for persistent context injection

## GoodVibes Plugin

For the best experience, we recommend using GoodVibes alongside the **GoodVibes Plugin** for Claude Code. The plugin provides:

- **Specialized Agents**: Pre-configured agents for frontend, backend, testing, DevOps, and more
- **Skills Library**: Reusable slash commands for common workflows (security audits, code reviews, etc.)
- **MCP Tools**: Extended tooling via Model Context Protocol for code intelligence, validation, and automation
- **Output Styles**: Different interaction modes including autonomous "JustVibes" mode

**Get the plugin:** [github.com/mgd34msu/goodvibes-plugin](https://github.com/mgd34msu/goodvibes-plugin)

## Prerequisites

- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **npm**: v9.0.0 or higher
- **Claude CLI**: Anthropic's Claude CLI must be installed and configured
- **Git**: Required for version control features
- **Windows/macOS/Linux**: Cross-platform support

## Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/mgd34msu/goodvibes.sh.git
   cd goodvibes.sh
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Start development server**
   ```bash
   npm run dev
   ```

4. **Build for production**
   ```bash
   npm run build
   ```

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start development server with hot reload |
| `npm run build` | Build for production |
| `npm run start` | Preview production build |
| `npm run test` | Run unit tests with Vitest |
| `npm run test:ui` | Run tests with Vitest UI |
| `npm run test:coverage` | Run tests with coverage report |
| `npm run test:e2e` | Run E2E tests with Playwright |
| `npm run lint` | Lint TypeScript/React code |
| `npm run lint:fix` | Auto-fix lint issues |
| `npm run typecheck` | Run TypeScript type checking |
| `npm run package` | Build and package for current platform |
| `npm run package:win` | Package for Windows |
| `npm run package:mac` | Package for macOS |
| `npm run package:linux` | Package for Linux |

## Architecture Overview

GoodVibes follows a standard Electron architecture with separate main and renderer processes:

```
goodvibes/
├── src/
│   ├── main/                    # Main process (Node.js)
│   │   ├── index.ts             # Application entry point
│   │   ├── window.ts            # Window management
│   │   ├── preload.ts           # IPC bridge (contextBridge)
│   │   ├── database/            # SQLite database layer
│   │   │   ├── index.ts         # Core operations
│   │   │   ├── migrations.ts    # Schema migrations
│   │   │   └── ...              # Feature-specific modules
│   │   └── services/            # Business logic
│   │       ├── terminalManager.ts   # PTY management
│   │       ├── sessionManager.ts    # Session scanning
│   │       ├── git.ts               # Git operations
│   │       ├── github.ts            # GitHub OAuth/API
│   │       ├── logger.ts            # Structured logging
│   │       └── ...
│   │
│   ├── renderer/                # Renderer process (React)
│   │   ├── main.tsx             # React entry point
│   │   ├── App.tsx              # Root component
│   │   ├── components/          # React components
│   │   │   ├── views/           # Main view components
│   │   │   ├── overlays/        # Modals, command palette
│   │   │   ├── common/          # Shared UI components
│   │   │   └── github/          # GitHub integration UI
│   │   ├── stores/              # Zustand state stores
│   │   └── hooks/               # Custom React hooks
│   │
│   └── shared/                  # Shared between processes
│       ├── types/               # TypeScript definitions
│       ├── constants.ts         # Shared constants
│       ├── logger.ts            # Shared logger utility
│       └── utils.ts             # Utility functions
│
├── docs/                        # Documentation
├── test/                        # Test files
└── build/                       # Build resources
```

### Key Technologies

- **Electron**: Desktop application framework
- **React 19**: UI framework
- **TypeScript**: Type-safe JavaScript
- **Vite**: Build tool and dev server
- **Zustand**: State management
- **TanStack Query**: Server state management
- **better-sqlite3**: SQLite database
- **node-pty**: Terminal emulation
- **xterm.js**: Terminal UI
- **Tailwind CSS**: Styling

### IPC Communication

Communication between main and renderer processes uses Electron's contextBridge:

```typescript
// Main process exposes APIs via preload script
window.goodvibes.startClaude(options)
window.goodvibes.getSessions()
window.goodvibes.gitStatus(cwd)
// ... etc
```

### Database

SQLite database with WAL mode for concurrent access. Tables include:
- `sessions` - Session metadata
- `messages` - Session messages
- `settings` - User preferences
- `hooks` - Hook configurations
- `mcp_servers` - MCP server configs
- `agents` - Agent templates
- `skills` - Skill definitions
- `projects` - Project registry

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Make your changes following the existing code style
4. Run tests: `npm run test`
5. Run linter: `npm run lint:fix`
6. Run type checking: `npm run typecheck`
7. Commit your changes with a descriptive message
8. Push to your fork and create a Pull Request

### Code Style

- Follow TypeScript strict mode
- Use ESLint and Prettier configurations
- Write meaningful commit messages
- Add tests for new features
- Update documentation as needed

### Testing

- Unit tests: `src/**/*.test.ts` files using Vitest
- E2E tests: `test/e2e/` using Playwright
- Run all tests before submitting PRs

## License

MIT License - see LICENSE file for details.

## Acknowledgments

- Built for use with [Claude CLI](https://docs.anthropic.com/claude/docs/claude-cli) by Anthropic
- Terminal rendering powered by [xterm.js](https://xtermjs.org/)
- Icons from [Lucide](https://lucide.dev/)
