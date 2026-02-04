# GoodVibes

![GoodVibes](assets/goodvibes.png)

GoodVibes is an Electron-based desktop application that provides an enhanced interface for Claude CLI with session management, analytics, Git integration, and a rich plugin ecosystem.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Version](https://img.shields.io/badge/version-1.0.0-blue.svg)](https://github.com/mgd34msu/goodvibes-plugin)
[![Claude Code Platform](https://img.shields.io/badge/Claude%20Code-Platform-purple.svg)](https://claude.com/claude-code)
[![Vibe Development Environment](https://img.shields.io/badge/Vibe%20Development%20Environment-VDE-green.svg)](https://goodvibes.sh)
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

## Installation

Download the latest release for your operating system from the [Releases page](https://github.com/mgd34msu/goodvibes.sh/releases):

| Platform | Download |
|----------|----------|
| Windows | `GoodVibes-Setup-x.x.x.exe` |
| macOS | `GoodVibes-x.x.x.dmg` |
| Linux | `GoodVibes-x.x.x.AppImage` |

See [Linux Setup](#linux-setup) below for additional configuration on Linux systems.

## GoodVibes Plugin - Highly Recommended

For the best experience, we recommend using GoodVibes alongside the **GoodVibes Plugin** for Claude Code. The plugin provides:

- **Directed or Autonomous Modes**: Vibecoding mode gives interactive feedback as you guide the orchestrator, Justvibes mode is full auto
- **Specialized Agents**: Pre-configured agents for frontend, backend, testing, DevOps, and more
- **Skills Library**: Reusable slash commands for common workflows (security audits, code reviews, etc.)
- **MCP Tools**: Extended tooling via Model Context Protocol for code intelligence, validation, and automation

### Quick-install plugin:

Copy/Paste these into your terminal of choice. 

#### Linux / MacOS
```
curl -sL https://goodvibes.sh/install-plugin.sh | bash
```
#### Windows (Powershell)
```
powershell -ExecutionPolicy Bypass -NoProfile -Command "& { $(Invoke-RestMethod -Uri https://goodvibes.sh/install-plugin.ps1) }"
```

#### Download Links
- Linux & MacOS: [https://goodvibes.sh/install-plugin.sh](https://goodvibes.sh/install-plugin.sh)
- MacOS [interactive]: [https://goodvibes.sh/install-plugin.command](https://goodvibes.sh/install-plugin.command)
- Windows [powershell]: [https://goodvibes.sh/install-plugin.ps1](https://goodvibes.sh/install-plugin.ps1)
- Windows [cmd.exe]: [https://goodvibes.sh/install-plugin.bat](https://goodvibes.sh/install-plugin.bat)

**Goodvibes Plugin Repo:** [github.com/mgd34msu/goodvibes-plugin](https://github.com/mgd34msu/goodvibes-plugin)

#### Important Security Notes:

Users are **STRONGLY** encouraged to download and inspect these scripts **AND** the plugin source code prior to running / installing them.
Regardless of what some may claim, as of January 31st 2026, **ALL** CLI plugins and MCP servers have unrestricted access to read, write, and execute code on your computer. 
This is true for OpenAI, Google, and Anthropic CLIs, as well as any third-party CLIs. The problem is inherent in 1) the MCP standard and 2) with plugins being granted the same rights as native tools.

## GitHub Integration

GoodVibes includes GitHub integration for PR management, issue tracking, and repository operations. Authentication uses GitHub's OAuth Device Flow for secure, seamless login.

### Default Configuration

Out of the box, GoodVibes uses a built-in GitHub OAuth App. This works immediately with no setup required—just click "Login with GitHub" in the settings.

### Custom OAuth App (Optional)

For users who want full control over their GitHub integration, you can configure your own GitHub OAuth App:

1. **Create a GitHub OAuth App** at [github.com/settings/developers](https://github.com/settings/developers)
   - See GitHub's guide: [Creating an OAuth App](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/creating-an-oauth-app)
   - Use any **Application name** and **Homepage URL**
   - Set **Authorization callback URL** to: `goodvibes://oauth/callback`

2. **Configure in GoodVibes**
   - Go to **Settings → GitHub → Custom OAuth App → Configure**
   - Enter your **Client ID**
   - Choose **Device Flow** (recommended) or **Authorization Code Flow**
   - If using Authorization Code Flow, also enter your **Client Secret**

### Why Use a Custom OAuth App?

| Built-in App | Custom App |
|--------------|------------|
| Zero configuration | Full control over permissions |
| Works immediately | Your own app in GitHub's authorized list |
| Source code available for review | Maximum security for sensitive repos |
| Shared OAuth App ID | Isolated from other GoodVibes users |

**Note:** The GoodVibes source code is fully available for review, and the built-in OAuth App cannot perform any unauthorized access. However, creating your own OAuth App provides an additional layer of security by giving you complete ownership of the GitHub integration.

## Prerequisites

- **Node.js**: v18.0.0 or higher (v20+ recommended)
- **npm**: v9.0.0 or higher
- **Claude CLI**: Anthropic's Claude CLI must be installed and configured
- **Git**: Required for version control features
- **Windows/macOS/Linux**: Cross-platform support

## Linux Setup

When running GoodVibes from a desktop launcher (not a terminal), your shell's PATH modifications from `.bashrc` or `.zshrc` may not be available. This can prevent GoodVibes from finding the `claude` CLI.

### Fix PATH for Desktop Apps

Add your local bin directory to the systemd user environment:

```bash
mkdir -p ~/.config/environment.d
echo 'PATH="$HOME/.local/bin:$PATH"' > ~/.config/environment.d/path.conf
```

Then **log out and back in** for changes to take effect.

### AppImage Desktop Entry

To create a desktop entry for the AppImage with proper flags:

1. Download the AppImage to a permanent location (e.g., `~/.local/bin/GoodVibes.AppImage`)
2. Make it executable: `chmod +x ~/.local/bin/GoodVibes.AppImage`
3. Create a desktop entry:

```bash
cat > ~/.local/share/applications/goodvibes.desktop << 'EOF'
[Desktop Entry]
Name=GoodVibes
Comment=Enhanced Claude CLI Interface
Exec=$HOME/.local/bin/GoodVibes.AppImage --no-sandbox %U
Icon=goodvibes
Type=Application
Categories=Development;
StartupWMClass=GoodVibes
MimeType=x-scheme-handler/goodvibes;
EOF
```

**Note:** The `--no-sandbox` flag may be required on some Linux distributions when running AppImages. If GoodVibes launches without issues, you can omit this flag.

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

## License

MIT License - see LICENSE file for details.

## Acknowledgments

- Built for use with [Claude CLI](https://docs.anthropic.com/claude/docs/claude-cli) by Anthropic
- Terminal rendering powered by [xterm.js](https://xtermjs.org/)
- Icons from [Lucide](https://lucide.dev/)
