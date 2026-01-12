# Clausitron: Claude-First Platform Roadmap

> **The definitive Claude Code companion, powered by 937 specialized components and deep hook integration.**

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Analysis](#current-state-analysis)
3. [The Claude-First Vision](#the-claude-first-vision)
4. [Hook Integration Architecture](#hook-integration-architecture)
5. [Agent System Architecture](#agent-system-architecture)
6. [Skill System Architecture](#skill-system-architecture)
7. [Feature Specifications](#feature-specifications)
8. [Implementation Phases](#implementation-phases)
9. [Differentiators](#differentiators)

---

## Executive Summary

### What We Have

| Asset | Count | Purpose |
|-------|-------|---------|
| **Specialized Agents** | 224 | Domain-specific AI personas with deep expertise |
| **Skills** | 713 | Reusable knowledge patterns and procedures |
| **Hook Events** | 12 | Lifecycle interception points for automation |
| **Existing Views** | 12 | UI infrastructure already built |

### The Opportunity

Clausitron has the potential to become THE definitive Claude Code companion by:
1. Making 937 expert components instantly accessible and manageable
2. Leveraging all 12 Claude hook events for deep integration
3. Providing a mission control interface for AI-driven development
4. Enabling workflows that no other tool can match

### Core Thesis

**Clausitron transforms Claude Code from a powerful CLI into an orchestrated development platform where humans architect intent and AI executes with expertise.**

---

## Current State Analysis

### Existing Clausitron Infrastructure

The codebase already provides solid foundations:

**Services (Main Process):**
- `hooks.ts` - Hook execution, settings sync, built-in hook scripts
- `agentRegistry.ts` - Agent lifecycle tracking (spawning, active, idle, terminated)
- `sessionManager.ts` - Claude session scanning, parsing, live watching
- `terminalManager.ts` - PTY management for Claude instances
- `mcpManager.ts` - MCP server management
- Database with better-sqlite3 for persistence

**Views (Renderer):**
- `TerminalView.tsx` (153KB) - Rich terminal interface
- `SessionsView.tsx` - Session browser
- `AgentsView.tsx` - Agent management UI
- `SkillsView.tsx` - Skill browser
- `HooksView.tsx` - Hook configuration
- `MCPView.tsx` - MCP server management
- `MemoryView.tsx` - CLAUDE.md management
- `KnowledgeView.tsx` - Knowledge base viewer
- `AnalyticsView.tsx` - Usage analytics
- `SettingsView.tsx` - Configuration

### The Agency Knowledge Base

Located at `../agency/.claude/`:

```
agents/ (224 files)
├── webdev/
│   ├── ai-ml/          (6 agents: OpenAI, Anthropic, LangChain, etc.)
│   ├── backend/        (frameworks, auth, validation, runtimes)
│   ├── content-media/  (CMS, file storage, image optimization)
│   ├── databases/      (relational, NoSQL, vector, BaaS, ORMs)
│   ├── developer-tooling/ (git, package managers, linting, monorepo)
│   ├── email/          (Resend, SendGrid, Postmark, AWS SES)
│   ├── frontend/       (UI frameworks, state, styling, meta-frameworks)
│   ├── infrastructure/ (CI/CD, containerization, cloud, IaC)
│   ├── payments/       (Stripe, PayPal, Paddle, LemonSqueezy)
│   ├── realtime-messaging/ (WebSockets, message queues)
│   └── search/         (Elasticsearch, Algolia, Meilisearch)

skills/ (713 files)
├── webdev/
│   ├── frontend/       (component patterns, state management, testing)
│   ├── backend/        (API patterns, auth, validation)
│   ├── databases/      (schema design, query patterns, migrations)
│   ├── infrastructure/ (deployment, containerization, CI/CD)
│   └── ...
```

### What's Missing

1. **Deep Hook Integration** - Hooks exist but aren't fully leveraged
2. **Agency Component Browser** - No UI for the 937 external components
3. **Component Activation System** - No way to inject agents/skills into Claude
4. **Orchestrated Workflows** - No agent coordination beyond basic spawning
5. **Hook-Based Automation** - Hooks aren't driving automated behaviors
6. **Cost/Budget Controls** - No budget enforcement via hooks
7. **Approval Queue** - No batched approval handling

---

## The Claude-First Vision

### Design Principles

1. **Claude is the Engine, Clausitron is Mission Control**
   - Claude Code does the work
   - Clausitron provides visibility, control, and orchestration

2. **Hooks are the Nervous System**
   - Every significant event flows through hooks
   - Clausitron intercepts, analyzes, and can modify behavior

3. **The 937 Components are First-Class Citizens**
   - Not hidden in directories - fully browsable and searchable
   - One-click activation into Claude's context
   - Usage tracking and recommendations

4. **Maximum Autonomy, Strategic Intervention**
   - Set policies, budgets, and constraints upfront
   - Batch and intelligently handle approvals
   - Intervene only when genuinely needed

### User Experience Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                          CLAUSITRON                                  │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐ │
│  │   AGENTS    │  │   SKILLS    │  │   HOOKS     │  │  SESSIONS   │ │
│  │   (224)     │  │   (713)     │  │   (12)      │  │   (live)    │ │
│  │             │  │             │  │             │  │             │ │
│  │ [Browse]    │  │ [Browse]    │  │ [Configure] │  │ [Monitor]   │ │
│  │ [Search]    │  │ [Search]    │  │ [View Logs] │  │ [Resume]    │ │
│  │ [Activate]  │  │ [Queue]     │  │ [Automate]  │  │ [Compare]   │ │
│  └─────────────┘  └─────────────┘  └─────────────┘  └─────────────┘ │
├─────────────────────────────────────────────────────────────────────┤
│  ┌───────────────────────────────────────────────────────────────┐  │
│  │                     ACTIVE SESSION                             │  │
│  │  Agent: @webdev/frontend/react  │  Skill: implementing-zustand│  │
│  │  Budget: $10.00 │ Spent: $2.34 │ Time: 18m │ Tools: 47        │  │
│  │                                                                 │  │
│  │  [LIVE TERMINAL OUTPUT]                                        │  │
│  │  > Editing src/stores/userStore.ts...                         │  │
│  │  > Running tests...                                            │  │
│  │  > 12/12 passing                                               │  │
│  │                                                                 │  │
│  │  [Pause] [Inject Context] [Change Agent] [Approval Queue (3)] │  │
│  └───────────────────────────────────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────┤
│  HOOK ACTIVITY (real-time)                                          │
│  14:32:01 PostToolUse   Edit      src/stores/userStore.ts    ✓     │
│  14:32:03 PreToolUse    Bash      npm test                   ⏳    │
│  14:32:15 PostToolUse   Bash      npm test (passed)          ✓     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Hook Integration Architecture

### Complete Hook Event Catalog

Claude Code provides 12 hook events that Clausitron will fully leverage:

| Hook Event | Trigger | Clausitron Actions |
|------------|---------|-------------------|
| `SessionStart` | Session begins | Load project context, inject agents/skills, set env vars, log to database |
| `SessionEnd` | Session ends | Save state summary, calculate costs, update analytics, trigger notifications |
| `PreToolUse` | Before tool executes | Apply policies, check budgets, log intent, optionally block (exit 2) |
| `PostToolUse` | After tool succeeds | Update state, track file changes, trigger formatters, update UI |
| `PostToolUseFailure` | After tool fails | Log failure, offer intervention, analyze patterns |
| `PermissionRequest` | Permission needed | Route to approval queue, apply auto-policies, batch similar requests |
| `UserPromptSubmit` | User sends prompt | Enrich with context, apply templates, detect agent/skill triggers |
| `Stop` | Claude stops responding | Analyze completion, trigger notifications, save session summary |
| `SubagentStart` | Sub-agent spawns | Register in agent tree, allocate budget slice, track lineage |
| `SubagentStop` | Sub-agent completes | Collect results, update parent context, aggregate costs |
| `PreCompact` | Before compaction | Preserve critical context, archive full history |
| `Notification` | System notification | Route to Clausitron notifications, trigger desktop alerts |

### Hook Implementation Architecture

The architecture uses two distinct communication channels:

1. **HTTP** (localhost:23847): External hook scripts -> Clausitron main process
2. **Electron IPC**: Clausitron main process <-> Clausitron renderer process

```
┌──────────────────────────────────────────────────────────────────────┐
│                        CLAUSITRON MAIN PROCESS                        │
├──────────────────────────────────────────────────────────────────────┤
│                                                                       │
│  ┌──────────────────────────────────────────────────────────────┐    │
│  │                    HOOK ORCHESTRATOR                          │    │
│  │                                                               │    │
│  │  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐           │    │
│  │  │ HTTP Server │──│ Event Router│──│ Handler Chain│          │    │
│  │  │ :23847      │  │             │  │              │          │    │
│  │  │ (receives   │  │             │  │              │          │    │
│  │  │ from hooks) │  │             │  │              │          │    │
│  │  └─────────────┘  └─────────────┘  └─────────────┘           │    │
│  │         │                                  │                  │    │
│  │         │              ┌───────────────────┼────────────────┐│    │
│  │         │              │                   │                ││    │
│  │         ▼              ▼                   ▼                ▼│    │
│  │  ┌───────────┐  ┌───────────┐  ┌───────────┐  ┌───────────┐ │    │
│  │  │  Policy   │  │  Budget   │  │  State    │  │ Approval  │ │    │
│  │  │  Engine   │  │  Tracker  │  │  Manager  │  │  Queue    │ │    │
│  │  └───────────┘  └───────────┘  └───────────┘  └───────────┘ │    │
│  │         │              │              │              │       │    │
│  │         └──────────────┴──────────────┴──────────────┘       │    │
│  │                              │                                │    │
│  │                              ▼                                │    │
│  │                    ┌─────────────────┐                       │    │
│  │                    │ Electron IPC    │                       │    │
│  │                    │ (to Renderer)   │                       │    │
│  │                    └─────────────────┘                       │    │
│  └──────────────────────────────────────────────────────────────┘    │
│                                                                       │
└──────────────────────────────────────────────────────────────────────┘
```

### Hook Scripts Deployment

Clausitron installs hook scripts that communicate back to the main process:

```
~/.clausitron/hooks/
├── pre-tool-use.js      # Policy checks, budget validation
├── post-tool-use.js     # State updates, UI notifications
├── session-start.js     # Context injection, agent/skill activation
├── session-end.js       # Summary generation, analytics
├── subagent-start.js    # Agent tree tracking
├── subagent-stop.js     # Result collection
├── notification.js      # Desktop notification routing
└── permission-request.js # Approval queue routing
```

### Hook Communication Architecture

**Understanding the Challenge:**

Claude hooks are shell commands spawned by Claude Code (not Clausitron). This means:
- Hooks are independent processes with no parent-child relationship to Clausitron
- Standard Electron IPC (main/renderer) is irrelevant here
- We need inter-process communication between unrelated processes

**Why HTTP is the Correct Choice:**

| Method | Cross-Platform | Applicability |
|--------|---------------|---------------|
| **HTTP Server** | Windows/Mac/Linux | Best - simple, reliable, request/response |
| Named Pipes | Different APIs per OS | Complex cross-platform implementation |
| Unix Sockets | Unix only | Not viable for Windows |
| File Watcher | Works everywhere | Unreliable (latency, race conditions) |
| Node IPC | Requires parent-child | Not applicable (Claude spawns hooks) |

HTTP is ideal because:
1. Works identically on all platforms
2. Simple to implement in hook scripts (just `curl` or Node `http`)
3. Supports request/response pattern (hooks can wait for decisions)
4. Claude Code hook timeout (60s default) gives ample time for round-trip

**How Claude Hooks Actually Work:**

```
┌─────────────────────┐     stdin (JSON)     ┌──────────────────┐
│    Claude Code      │ ──────────────────── │   Hook Script    │
│                     │                      │  (spawned child) │
│  spawns hook as     │ ←────────────────── │                  │
│  child process      │     stdout (JSON)    │  reads stdin,    │
└─────────────────────┘     + exit code      │  writes stdout   │
                                             └──────────────────┘
```

Hook scripts receive JSON via **stdin**, not environment variables:

```json
{
  "hook_event_name": "PreToolUse",
  "tool_name": "Bash",
  "tool_input": {
    "command": "npm test",
    "description": "Run tests"
  },
  "session_id": "abc123",
  "working_directory": "/path/to/project"
}
```

**Clausitron Hook Architecture:**

```
┌─────────────────────┐                     ┌──────────────────┐
│    Claude Code      │  spawns             │  Clausitron      │
│                     │ ──────────────────  │  Hook Script     │
│  (running Claude    │                     │                  │
│   CLI session)      │                     │  1. Read stdin   │
└─────────────────────┘                     │  2. POST to HTTP │
                                            │  3. Wait for resp│
         ┌──────────────────────────────────│  4. Write stdout │
         │                                  │  5. Exit w/ code │
         │  HTTP POST                       └──────────────────┘
         │  localhost:23847
         ▼
┌─────────────────────────────────────────────────────────────────┐
│                    CLAUSITRON (Electron App)                     │
│                                                                  │
│  ┌────────────────────────────────────────────────────────────┐ │
│  │                    Main Process                             │ │
│  │                                                             │ │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │ │
│  │  │ HTTP Server  │───▶│ Hook Handler │───▶│   Policy     │  │ │
│  │  │ (port 23847) │    │              │    │   Engine     │  │ │
│  │  └──────────────┘    └──────────────┘    └──────────────┘  │ │
│  │         │                   │                   │          │ │
│  │         ▼                   ▼                   ▼          │ │
│  │  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │ │
│  │  │   Database   │    │ IPC to       │    │   Budget     │  │ │
│  │  │  (SQLite)    │    │ Renderer     │    │   Tracker    │  │ │
│  │  └──────────────┘    └──────────────┘    └──────────────┘  │ │
│  │                             │                              │ │
│  └─────────────────────────────│──────────────────────────────┘ │
│                                │                                 │
│  ┌─────────────────────────────▼──────────────────────────────┐ │
│  │                   Renderer Process                          │ │
│  │                                                             │ │
│  │   [Live Hook Dashboard]  [Approval Queue]  [Cost Tracker]  │ │
│  │                                                             │ │
│  └─────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
```

**Hook Script Implementation (Correct Pattern):**

```javascript
#!/usr/bin/env node
// ~/.clausitron/hooks/pre-tool-use.js
// Reads stdin, forwards to Clausitron, returns response

const http = require('http');

// Read JSON from stdin (how Claude hooks actually work)
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', async () => {
  try {
    const hookData = JSON.parse(input);

    // Forward to Clausitron's HTTP server
    const response = await postToClausitron('/api/hooks/pre-tool-use', hookData);

    // Output response for Claude Code
    if (response.decision === 'block') {
      console.log(JSON.stringify({ decision: 'block', message: response.message }));
      process.exit(2);  // Exit code 2 = block the action
    }

    console.log(JSON.stringify({ decision: 'allow' }));
    process.exit(0);
  } catch (err) {
    // On error, allow the action (fail-open)
    process.exit(0);
  }
});

function postToClausitron(path, data) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: 'localhost',
      port: 23847,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000,
    }, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(JSON.parse(body)));
    });
    req.on('error', reject);
    req.write(JSON.stringify(data));
    req.end();
  });
}
```

**Communication Protocol:**

```typescript
// Hook scripts POST to Clausitron's HTTP server
interface HookPayload {
  hook_event_name: HookEventType;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  tool_response?: { success: boolean; content: string };
  session_id?: string;
  working_directory?: string;
}

interface HookResponse {
  decision: 'allow' | 'deny' | 'block';
  message?: string;
  inject_context?: string;  // For SessionStart: content to add
}
```

**Key Implementation Notes:**

1. **HTTP Server in Main Process**: Clausitron's Electron main process runs an HTTP server on a fixed port (23847)

2. **Hook Scripts Read stdin**: Unlike the current implementation that uses env vars, scripts must read stdin as that's how Claude actually passes data

3. **Fail-Open Design**: If Clausitron isn't running or times out, hooks should allow actions (exit 0) to avoid breaking Claude

4. **IPC for UI Updates**: Main process uses Electron IPC to push updates to renderer (this IS the right use of IPC - between main/renderer)

5. **Blocking Decisions**: For PreToolUse, hooks can wait for user approval via HTTP long-poll or WebSocket upgrade

### Automated Hook Behaviors

| Event | Automated Action |
|-------|------------------|
| `SessionStart` | Inject active agent's prompt, load queued skills, set environment |
| `PreToolUse(Edit\|Write)` | Check file against protected patterns, verify budget remaining |
| `PostToolUse(Edit\|Write)` | Run prettier/eslint if configured, update file change log |
| `PreToolUse(Bash)` | Check command against allow/deny lists, log for audit |
| `PostToolUse(Bash(npm test))` | Parse results, update test status badge |
| `PermissionRequest` | Batch with similar requests, auto-approve if policy matches |
| `Stop` | Generate session summary, trigger desktop notification |
| `SubagentStart` | Register in agent hierarchy, allocate budget portion |

---

## Agent System Architecture

### Agent Registry Enhancement

The existing `agentRegistry.ts` tracks Claude-spawned agents. We extend this to:

1. **Index the 224 Agency Agents** - Parse and catalog all external agent files
2. **Enable Agent Activation** - Inject agent prompts into Claude sessions
3. **Track Agent Usage** - Record which agents are used, success rates, costs
4. **Recommend Agents** - Suggest relevant agents based on task context

### Agent Data Model

```typescript
interface AgencyAgent {
  // Identity
  id: string;                    // e.g., "webdev/frontend/react"
  name: string;                  // From frontmatter
  description: string;           // From frontmatter
  category: string[];            // ["webdev", "frontend", "ui-frameworks"]

  // Configuration
  tools?: string[];              // Allowed tools
  model?: 'sonnet' | 'opus' | 'haiku' | 'inherit';
  skills?: string[];             // Skills to load with this agent

  // Content
  systemPrompt: string;          // Full markdown content
  filePath: string;              // Absolute path to .md file

  // Metadata
  lastModified: Date;
  fileSize: number;

  // Usage Statistics
  usageCount: number;
  avgSessionDuration: number;
  avgCost: number;
  successRate: number;
  lastUsed: Date | null;

  // Relationships
  relatedAgents: string[];       // Other agents often used together
  requiredSkills: string[];      // Skills this agent needs
}
```

### Agent Browser UI

```
┌─────────────────────────────────────────────────────────────────────┐
│  AGENTS                                    [Search...] [+ Custom]   │
├─────────────────────────────────────────────────────────────────────┤
│  CATEGORIES                    │ AGENT DETAIL                       │
│  ────────────────              │ ──────────────                     │
│  ▼ webdev (224)                │ react                              │
│    ▼ frontend (89)             │ ────────────────────────────       │
│      ▶ ui-frameworks (7)       │ Expert React developer for         │
│        [●] react          ←──  │ modern React 19 patterns, hooks,   │
│        [ ] vue                 │ Server Components, and performance │
│        [ ] angular             │ optimization.                      │
│        [ ] svelte              │                                    │
│        [ ] solidjs             │ Model: sonnet                      │
│        [ ] qwik                │ Tools: All                         │
│        [ ] htmx                │ Skills: implementing-react-patterns│
│      ▶ state-management (8)    │                                    │
│      ▶ styling (8)             │ USAGE STATS                        │
│      ▶ meta-frameworks (6)     │ ──────────                        │
│      ▶ component-libs (6)      │ Sessions: 47                       │
│      ▶ testing (5)             │ Avg Duration: 23m                  │
│    ▶ backend (67)              │ Avg Cost: $2.34                    │
│    ▶ databases (42)            │ Success Rate: 94%                  │
│    ▶ infrastructure (26)       │                                    │
│  ▶ ai-ml (6)                   │ [Activate] [Preview] [Edit]        │
│  ▶ devops (12)                 │                                    │
└─────────────────────────────────────────────────────────────────────┘
```

### Agent Activation Flow

When a user activates an agent:

1. **Parse Agent File** - Read frontmatter and content
2. **Check Dependencies** - Verify required skills exist
3. **Prepare Context** - Build the injection payload
4. **Queue for Injection** - Store until next SessionStart hook
5. **Inject via Hook** - On SessionStart, write agent prompt to `$CLAUDE_ENV_FILE`

```typescript
// SessionStart hook injection
async function injectAgentContext(activeAgent: AgencyAgent): Promise<void> {
  const claudeEnvFile = process.env.CLAUDE_ENV_FILE;
  if (!claudeEnvFile) return;

  // Create custom system prompt addition
  const injection = `
# Active Agent: ${activeAgent.name}

${activeAgent.systemPrompt}

---
`;

  // Append to Claude's environment file for context injection
  await fs.appendFile(claudeEnvFile, `export CLAUSITRON_AGENT="${activeAgent.id}"\n`);

  // Also inject via CLAUDE.md modification if needed
  await injectIntoCLAUDEMD(activeAgent);
}
```

### Agent Recommendations

The system learns from usage patterns:

```typescript
interface AgentRecommendation {
  agent: AgencyAgent;
  reason: string;
  confidence: number;
  triggers: string[];  // What in the prompt triggered this
}

function recommendAgents(userPrompt: string, projectContext: ProjectContext): AgentRecommendation[] {
  const recommendations: AgentRecommendation[] = [];

  // Pattern matching based on keywords
  if (userPrompt.match(/react|component|hook|state/i)) {
    recommendations.push({
      agent: getAgent('webdev/frontend/react'),
      reason: 'React-related keywords detected',
      confidence: 0.85,
      triggers: ['react', 'component']
    });
  }

  // Based on file context
  if (projectContext.hasPackage('next')) {
    recommendations.push({
      agent: getAgent('webdev/frontend/meta-frameworks/nextjs'),
      reason: 'Project uses Next.js',
      confidence: 0.95,
      triggers: ['package.json: next']
    });
  }

  return recommendations.sort((a, b) => b.confidence - a.confidence);
}
```

---

## Skill System Architecture

### Skill Registry

Similar to agents, but for the 713 skills:

```typescript
interface AgencySkill {
  // Identity
  id: string;                    // e.g., "webdev/frontend/state/implementing-zustand"
  name: string;                  // From frontmatter
  description: string;           // From frontmatter
  category: string[];            // ["webdev", "frontend", "state"]

  // Configuration
  allowedTools?: string[];       // Tool restrictions

  // Content
  content: string;               // Full SKILL.md content
  filePath: string;              // Absolute path

  // Metadata
  lastModified: Date;
  fileSize: number;

  // Usage Statistics
  usageCount: number;
  avgSessionDuration: number;
  lastUsed: Date | null;

  // Relationships
  compatibleAgents: string[];    // Agents that use this skill
  relatedSkills: string[];       // Often used together
}
```

### Skill Queue System

Skills can be queued for injection:

```typescript
interface SkillQueue {
  pending: AgencySkill[];        // Skills waiting to be injected
  active: AgencySkill[];         // Currently active in session
  history: SkillUsageRecord[];   // Past skill usages
}

// On SessionStart, inject queued skills
async function injectQueuedSkills(queue: SkillQueue): Promise<void> {
  for (const skill of queue.pending) {
    await injectSkillContext(skill);
    queue.active.push(skill);
  }
  queue.pending = [];
}
```

### Skill Browser UI

```
┌─────────────────────────────────────────────────────────────────────┐
│  SKILLS                                   [Search...] [+ Custom]    │
├─────────────────────────────────────────────────────────────────────┤
│  QUICK ACCESS                  │ SKILL DETAIL                       │
│  ────────────                  │ ──────────────                     │
│  Recently Used:                │ implementing-zustand-stores        │
│  • implementing-react-patterns │ ────────────────────────────       │
│  • configuring-typescript      │ Build reactive stores with Zustand │
│  • implementing-zod-schemas    │ for React applications. Covers     │
│                                │ slices, middleware, devtools,      │
│  CATEGORIES (713)              │ and TypeScript patterns.           │
│  ─────────────                 │                                    │
│  ▼ webdev                      │ ALLOWED TOOLS                      │
│    ▼ frontend                  │ ──────────────                    │
│      ▼ state-management        │ • Read                             │
│        [✓] implementing-zustand│ • Edit                             │
│        [ ] implementing-redux  │ • Write                            │
│        [ ] implementing-jotai  │ • Glob                             │
│        [ ] configuring-tanstack│                                    │
│      ▶ ui-frameworks (12)      │ COMPATIBLE AGENTS                  │
│      ▶ styling (9)             │ ──────────────────                │
│    ▶ backend (87)              │ • react                            │
│    ▶ databases (124)           │ • nextjs                           │
│                                │                                    │
│  SKILL QUEUE                   │ [Add to Queue] [Preview] [Edit]    │
│  ───────────                   │                                    │
│  1. implementing-zustand  [×]  │                                    │
│  2. configuring-typescript [×] │                                    │
│                                │                                    │
│  [Clear Queue] [Inject Now]    │                                    │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Feature Specifications

### Feature 1: Hook Dashboard

**Purpose**: Real-time visibility into all hook activity with filtering and analysis.

**UI Components**:
- Live hook event stream with timestamp, type, tool, result
- Filtering by event type, tool, time range
- Hook execution statistics (count, avg duration, success rate)
- Hook configuration manager (enable/disable, edit commands)

**Data Model**:
```typescript
interface HookEvent {
  id: string;
  timestamp: Date;
  eventType: HookEventType;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  toolResult?: { success: boolean; content: string };
  sessionId: string;
  hookExecutions: HookExecutionResult[];
  duration: number;
  blocked: boolean;
}
```

### Feature 2: Budget & Cost Center

**Purpose**: Budget setting, enforcement via hooks, and cost analytics.

**UI Components**:
- Budget setting per project/session/agent
- Real-time cost tracking with progress bar
- Cost projections based on current rate
- Usage breakdown by agent, skill, tool
- Alert configuration (warning at X%, hard stop at Y%)

**Hook Integration**:
- `PreToolUse`: Check remaining budget, block if exceeded
- `PostToolUse`: Update spent amount based on tool type
- `SessionEnd`: Calculate final cost, update analytics

**Data Model**:
```typescript
interface Budget {
  projectId: string;
  limitUSD: number;
  spentUSD: number;
  warningThresholdPercent: number;
  hardStopEnabled: boolean;
  resetPeriod: 'session' | 'daily' | 'weekly' | 'monthly';
}
```

### Feature 3: Approval Queue

**Purpose**: Intelligent batching and policy-based handling of permissions.

**UI Components**:
- Pending approvals list with risk assessment
- Batch approval for similar requests
- Policy configuration (auto-approve, auto-deny, require review)
- Approval history with search

**Hook Integration**:
- `PermissionRequest`: Route to queue instead of blocking terminal
- Apply policies: auto-approve based on rules
- Batch similar requests (e.g., multiple Edit operations)

**Policies**:
```typescript
interface ApprovalPolicy {
  id: string;
  name: string;
  matcher: string;           // Tool pattern (e.g., "Edit(src/test/*)")
  action: 'auto-approve' | 'auto-deny' | 'queue';
  priority: number;
  conditions?: {
    maxFileSize?: number;
    allowedPaths?: string[];
    blockedPaths?: string[];
  };
}
```

### Feature 4: Agent Orchestrator

**Purpose**: Visual management of agent hierarchy and coordination.

**UI Components**:
- Agent tree visualization (parent/child relationships)
- Active agent status with live activity
- Agent spawning controls
- Budget allocation per agent branch
- Performance metrics per agent

**Hook Integration**:
- `SubagentStart`: Register in tree, allocate budget
- `SubagentStop`: Collect results, update parent context

### Feature 5: Session Intelligence

**Purpose**: Cross-session continuity and context preservation.

**UI Components**:
- Session timeline with key events
- Session comparison (diff view)
- Resumption with context injection
- Session search (find when X was changed)
- Session templates

**Hook Integration**:
- `SessionEnd`: Generate summary, preserve context
- `SessionStart`: Inject previous session context

### Feature 6: Live File Monitor

**Purpose**: Real-time visualization of file changes.

**UI Components**:
- File change stream with syntax-highlighted diffs
- File tree with change indicators
- Change filtering by path, type, time
- Rollback capability (git integration)

**Hook Integration**:
- `PostToolUse(Edit|Write)`: Capture change, compute diff
- `PostToolUse(Bash(git))`: Track git operations

### Feature 7: Test Watcher

**Purpose**: Automated test monitoring and status display.

**UI Components**:
- Test suite status badge (passing/failing)
- Test output viewer with filtering
- Failed test drill-down
- Coverage metrics (if available)

**Hook Integration**:
- `PostToolUse(Bash(npm test|jest|vitest))`: Parse results
- Update status badge in real-time

### Feature 8: Context Injector

**Purpose**: Dynamic injection of context into Claude sessions.

**UI Components**:
- Active context display
- Context queue management
- CLAUDE.md editor with live preview
- Import from agents/skills

**Hook Integration**:
- `SessionStart`: Inject queued context
- `UserPromptSubmit`: Optionally enrich prompts

---

## Implementation Phases

### Phase 1: Hook Infrastructure Deep Dive

**Goal**: Complete hook integration infrastructure.

**Deliverables**:
1. HTTP server for hook communication (port 23847)
2. All 12 hook scripts installed to `~/.clausitron/hooks/`
3. Hook event stream to renderer via IPC
4. Hook event persistence to database
5. Real-time Hook Dashboard view
6. Hook configuration UI (enable/disable, edit)

**Dependencies**: None

**Success Criteria**:
- All 12 hook events captured and displayed in real-time
- Hook events persisted and queryable
- Hooks configurable via UI and synced to Claude settings.json

---

### Phase 2: Agency Component Indexer

**Goal**: Index and make searchable all 937 agency components.

**Deliverables**:
1. Agent indexer service (parse 224 agent .md files)
2. Skill indexer service (parse 713 SKILL.md files)
3. Database schema for agents and skills
4. Full-text search across agents and skills
5. Category tree navigation
6. Relationship mapping (agent-skill, agent-agent, skill-skill)

**Dependencies**: Phase 1 (for database foundation)

**Success Criteria**:
- All 937 components indexed in database
- Sub-100ms search across all components
- Category tree fully navigable
- Relationships correctly mapped

---

### Phase 3: Enhanced Agent & Skill Browsers

**Goal**: Rich UI for browsing and managing components.

**Deliverables**:
1. Redesigned AgentsView with category tree, search, detail panel
2. Redesigned SkillsView with category tree, search, queue
3. Agent detail view with stats, relationships, preview
4. Skill detail view with stats, compatible agents, preview
5. Usage statistics tracking and display
6. Agent/Skill comparison view

**Dependencies**: Phase 2

**Success Criteria**:
- All 937 components browsable with <200ms navigation
- Search returns relevant results
- Usage statistics accurately tracked

---

### Phase 4: Context Injection System

**Goal**: Inject agents and skills into Claude sessions.

**Deliverables**:
1. Agent activation system via SessionStart hook
2. Skill queue and injection system
3. Context Injector view
4. CLAUDE.md manipulation utilities
5. Environment variable injection
6. Verification that injection succeeded

**Dependencies**: Phase 1, Phase 2

**Success Criteria**:
- Activated agent's prompt appears in Claude's context
- Queued skills are injected on session start
- Context modifications verified via terminal output

---

### Phase 5: Budget & Cost Controls

**Goal**: Full budget management with enforcement.

**Deliverables**:
1. Budget data model and database schema
2. Cost tracking in PostToolUse hook
3. Budget enforcement in PreToolUse hook
4. Cost Center view (dashboard, breakdown, projections)
5. Budget alerts and notifications
6. Per-project, per-session, per-agent budgets

**Dependencies**: Phase 1

**Success Criteria**:
- Accurate cost tracking within 5% of actual
- Budget enforcement blocks operations when exceeded
- Alerts trigger at configured thresholds

---

### Phase 6: Approval Queue

**Goal**: Intelligent approval handling.

**Deliverables**:
1. Approval queue data model
2. PermissionRequest hook handler
3. Policy engine (auto-approve, auto-deny rules)
4. Approval Queue view with batch operations
5. Approval history and analytics
6. Policy configuration UI

**Dependencies**: Phase 1

**Success Criteria**:
- Permissions route to queue instead of blocking terminal
- Policies correctly auto-handle matching requests
- Batch approval works for similar requests

---

### Phase 7: Agent Orchestration

**Goal**: Visual agent hierarchy management.

**Deliverables**:
1. Enhanced agent tree data model
2. SubagentStart/SubagentStop hook handlers
3. Agent tree visualization component
4. Agent spawning from UI
5. Budget allocation across agent tree
6. Agent performance metrics

**Dependencies**: Phase 1, Phase 5

**Success Criteria**:
- Agent hierarchy accurately visualized
- Sub-agent spawn/complete captured via hooks
- Budget correctly allocated and tracked

---

### Phase 8: Session Intelligence

**Goal**: Cross-session continuity.

**Deliverables**:
1. Session summary generation (via Stop hook)
2. Session comparison (diff view)
3. Session resumption with context injection
4. Cross-session search
5. Session templates
6. Session export/import

**Dependencies**: Phase 1, Phase 4

**Success Criteria**:
- Sessions resumable with full context
- Search finds changes across sessions
- Templates speed up common workflows

---

### Phase 9: Live Monitoring

**Goal**: Real-time file and test monitoring.

**Deliverables**:
1. Live file change stream
2. File diff visualization
3. Git integration for rollback
4. Test output parser
5. Test status badge component
6. Coverage display (if available)

**Dependencies**: Phase 1

**Success Criteria**:
- File changes appear in real-time with diffs
- Test results parsed and displayed accurately
- Status badge reflects current state

---

### Phase 10: Agent Recommendations

**Goal**: Intelligent agent/skill suggestions.

**Deliverables**:
1. Recommendation engine
2. Prompt analysis for keyword extraction
3. Project context analysis (package.json, file patterns)
4. Recommendation UI (inline suggestions)
5. Recommendation feedback loop (accept/reject tracking)
6. ML-ready data export for future improvements

**Dependencies**: Phase 2, Phase 3

**Success Criteria**:
- Relevant agents suggested based on prompt
- Project context influences recommendations
- Feedback improves recommendation quality

---

### Phase 11: Multi-Project Orchestration

**Goal**: Coordinate across multiple projects.

**Deliverables**:
1. Project registry with context preservation
2. Cross-project agent coordination
3. Shared skill configurations
4. Project templates
5. Project comparison and insights
6. Global analytics across projects

**Dependencies**: Phase 2, Phase 5

**Success Criteria**:
- Seamless project switching
- Context preserved per project
- Insights span all projects

---

### Phase 12: Polish & Performance

**Goal**: Production-ready experience.

**Deliverables**:
1. Performance optimization (virtualization, lazy loading)
2. Error handling and recovery
3. Onboarding flow for new users
4. Documentation and help system
5. Keyboard shortcuts for power users
6. Accessibility improvements (ARIA, screen reader support)

**Dependencies**: All previous phases

**Success Criteria**:
- Responsive UI under load (1000+ sessions, 937 components)
- New users productive in <10 minutes
- WCAG 2.1 AA compliance

---

## Differentiators

### Why Clausitron Wins

| Aspect | Current Tools | Clausitron |
|--------|---------------|------------|
| **Component Library** | 0-10 built-in agents | 937 specialized components |
| **Hook Integration** | Basic or none | All 12 hooks, deep automation |
| **Budget Control** | None | Real-time tracking, enforcement |
| **Approval Handling** | Block terminal | Queue, batch, policies |
| **Session Continuity** | None | Full context preservation |
| **Agent Orchestration** | Manual | Visual tree, tracking |
| **Recommendations** | None | Context-aware suggestions |

### The Moat

1. **The 937 Components** - Years of domain knowledge, immediately accessible
2. **Hook Depth** - No other tool leverages all 12 hooks
3. **Mission Control** - Not just a terminal wrapper, but a command center
4. **Learning System** - Usage patterns improve recommendations

### Target Users

| Persona | Value Proposition |
|---------|-------------------|
| **Solo Developer** | 10x productivity through agent expertise |
| **Team Lead** | Standardized agents/skills, cost visibility |
| **Enterprise** | Budget governance, audit trail, compliance |

---

## Conclusion

Clausitron has the foundation to become THE Claude Code companion. By fully leveraging:

- **224 Specialized Agents** for domain expertise
- **713 Skills** for procedural knowledge
- **12 Claude Hooks** for deep integration
- **Existing UI Infrastructure** for rapid iteration

The platform can deliver unprecedented visibility, control, and productivity for AI-driven development.

The roadmap prioritizes:
1. Deep hook integration (foundation for everything)
2. Component accessibility (making 937 components useful)
3. Control mechanisms (budget, approvals)
4. Intelligence (recommendations, continuity)

Each phase builds on the previous, with clear deliverables and success criteria.

**The future of software development is AI-driven. Clausitron makes it manageable.**

---

*This roadmap is a living document. Update as implementation reveals new insights.*
