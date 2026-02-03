# GoodVibes v1.1.0 Pre-Plan Document
## Session Tagging System - Complete Feature Specification

**Created**: 2026-02-03
**Status**: Pre-Planning
**Scope**: Full implementation (Phase 1, 2, 3 - nothing optional)

---

## Table of Contents

1. [Overview](#overview)
2. [Naming Conventions](#naming-conventions)
3. [Database Schema](#database-schema)
4. [Phase 1: Core Tag System](#phase-1-core-tag-system)
5. [Phase 2: AI Suggestions](#phase-2-ai-suggestions)
6. [Phase 3: Advanced Features](#phase-3-advanced-features)
7. [UI Components](#ui-components)
8. [IPC Handlers](#ipc-handlers)
9. [Settings & Configuration](#settings--configuration)
10. [Keyboard Shortcuts](#keyboard-shortcuts)
11. [Edge Cases & Error Handling](#edge-cases--error-handling)

---

## Overview

A comprehensive tagging system for Claude Code sessions that includes:
- Manual tag management with colors and effects
- Advanced filtering (AND/OR/NOT with grouping)
- Bulk operations
- AI-powered tag suggestions via Haiku
- Tag hierarchy, aliases, templates
- Full analytics dashboard

---

## Naming Conventions

**CRITICAL**: Follow these conventions exactly to maintain codebase consistency.

| Layer | Convention | Examples |
|-------|------------|----------|
| Database columns | snake_case | `tag_name`, `session_id`, `created_at`, `usage_count` |
| TypeScript interfaces/types | camelCase | `tagName`, `sessionId`, `createdAt`, `usageCount` |
| React component props | camelCase | `onTagSelect`, `isSelected`, `tagColor` |
| IPC handler names | kebab-case | `get-all-tags`, `create-tag`, `add-tag-to-session` |
| Function names | camelCase | `getAllTags()`, `createTag()`, `addTagToSession()` |
| Component names | PascalCase | `TagChip`, `TagFilterModal`, `TagsSection` |
| CSS classes | kebab-case | `tag-chip`, `tag-filter-modal` |
| Constants | SCREAMING_SNAKE_CASE | `MAX_TAGS_PER_SESSION`, `DEFAULT_TAG_COLOR` |

**Mapper Pattern**: Database queries return snake_case → mapper functions convert to camelCase for application layer.

---

## Database Schema

### New Tables

```sql
-- Main tags table
CREATE TABLE tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  color TEXT DEFAULT NULL,              -- Hex color code, optional
  effect TEXT DEFAULT NULL,             -- 'shimmer', 'glow', 'pulse', NULL
  parent_id INTEGER DEFAULT NULL,       -- For hierarchy/nesting
  alias_of INTEGER DEFAULT NULL,        -- Points to canonical tag ID
  description TEXT DEFAULT NULL,        -- Optional tag description
  is_pinned INTEGER DEFAULT 0,          -- Pinned/favorite tags
  usage_count INTEGER DEFAULT 0,        -- Denormalized for performance
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (parent_id) REFERENCES tags(id) ON DELETE SET NULL,
  FOREIGN KEY (alias_of) REFERENCES tags(id) ON DELETE CASCADE
);

-- Many-to-many relationship: sessions <-> tags
CREATE TABLE session_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tag_id INTEGER NOT NULL,
  added_at TEXT NOT NULL,
  added_by TEXT DEFAULT 'user',         -- 'user', 'ai', 'bulk', 'template'
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE,
  UNIQUE(session_id, tag_id)
);

-- AI tag suggestions
CREATE TABLE tag_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  tag_name TEXT NOT NULL,               -- Suggested tag name (may not exist yet)
  confidence REAL NOT NULL,             -- 0.0 to 1.0
  category TEXT,                        -- 'task_type', 'technology', 'domain', 'complexity', 'outcome', 'pattern'
  reasoning TEXT,                       -- Why Haiku suggested this
  status TEXT DEFAULT 'pending',        -- 'pending', 'accepted', 'rejected', 'dismissed'
  created_at TEXT NOT NULL,
  reviewed_at TEXT DEFAULT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);

-- Suggestion feedback for learning
CREATE TABLE suggestion_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_name TEXT NOT NULL,
  context_hash TEXT,                    -- Hash of session context for similarity
  accepted_count INTEGER DEFAULT 0,
  rejected_count INTEGER DEFAULT 0,
  last_feedback_at TEXT,
  UNIQUE(tag_name, context_hash)
);

-- Tag templates/presets
CREATE TABLE tag_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  tag_ids TEXT NOT NULL,                -- JSON array of tag IDs
  is_system INTEGER DEFAULT 0,          -- System vs user-created
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Recent tags tracking (for quick access)
CREATE TABLE recent_tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag_id INTEGER NOT NULL,
  used_at TEXT NOT NULL,
  FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
);
```

### Modifications to Existing Tables

```sql
-- Add scan tracking to sessions table
ALTER TABLE sessions ADD COLUMN suggestion_scan_status TEXT DEFAULT 'pending';
-- Values: 'pending', 'queued', 'scanning', 'completed', 'skipped', 'failed'

ALTER TABLE sessions ADD COLUMN suggestion_scanned_at TEXT DEFAULT NULL;

ALTER TABLE sessions ADD COLUMN suggestion_scan_depth TEXT DEFAULT NULL;
-- Values: 'quick', 'full'

-- Remove old comma-separated tags column (migrate data first!)
-- ALTER TABLE sessions DROP COLUMN tags;
```

### Indexes

```sql
CREATE INDEX idx_tags_name ON tags(name);
CREATE INDEX idx_tags_parent ON tags(parent_id);
CREATE INDEX idx_tags_alias ON tags(alias_of);
CREATE INDEX idx_tags_pinned ON tags(is_pinned);

CREATE INDEX idx_session_tags_session ON session_tags(session_id);
CREATE INDEX idx_session_tags_tag ON session_tags(tag_id);

CREATE INDEX idx_suggestions_session ON tag_suggestions(session_id);
CREATE INDEX idx_suggestions_status ON tag_suggestions(status);

CREATE INDEX idx_sessions_scan_status ON sessions(suggestion_scan_status);
```

---

## Phase 1: Core Tag System

### 1.1 Tag CRUD Operations

- **Create tag**: Name, optional color, optional effect, optional parent, optional description
- **Read tags**: Get all, get by ID, get by name, get children, get aliases
- **Update tag**: Rename (globally), change color, change effect, change parent, update description
- **Delete tag**: Remove tag, optionally reassign sessions to another tag
- **Merge tags**: Combine two tags into one, update all session associations

### 1.2 Tag Properties

| Property | Type | Description |
|----------|------|-------------|
| name | string | Tag name (unique, trimmed, lowercase normalized for matching) |
| color | string | null | Hex color code (e.g., `#FF5733`) |
| effect | string | null | Visual effect: `shimmer`, `glow`, `pulse`, or null |
| parentId | number | null | Parent tag ID for hierarchy |
| aliasOf | number | null | Canonical tag ID if this is an alias |
| description | string | null | Optional description |
| isPinned | boolean | Whether tag is pinned to top |
| usageCount | number | Number of sessions using this tag (denormalized) |

### 1.3 Tag Colors

Predefined color palette (user can also use custom hex):

```typescript
const TAG_COLORS = {
  red: '#EF4444',
  orange: '#F97316',
  amber: '#F59E0B',
  yellow: '#EAB308',
  lime: '#84CC16',
  green: '#22C55E',
  emerald: '#10B981',
  teal: '#14B8A6',
  cyan: '#06B6D4',
  sky: '#0EA5E9',
  blue: '#3B82F6',
  indigo: '#6366F1',
  violet: '#8B5CF6',
  purple: '#A855F7',
  fuchsia: '#D946EF',
  pink: '#EC4899',
  rose: '#F43F5E',
  slate: '#64748B',
};
```

### 1.4 Tag Effects

Visual effects matching GoodVibes plugin style:

- **shimmer**: Animated gradient sweep
- **glow**: Soft outer glow with tag color
- **pulse**: Subtle pulsing animation
- **none**: No effect (default)

### 1.5 Tag Hierarchy/Nesting

Tags can have parent-child relationships:

```
#frontend
├── #frontend/react
├── #frontend/vue
└── #frontend/svelte

#backend
├── #backend/api
├── #backend/database
└── #backend/auth
```

- Filtering by parent tag includes all children
- Display as `parent/child` or just `child` based on context
- Max depth: 3 levels

### 1.6 Tag Aliases

Prevent duplicates by aliasing similar tags:

- `#bugfix` → canonical
- `#bug-fix` → alias of `#bugfix`
- `#bug_fix` → alias of `#bugfix`

When user types an alias, auto-resolve to canonical tag.

### 1.7 Session-Tag Operations

- **Add tag to session**: Create association, update usage count
- **Remove tag from session**: Delete association, update usage count
- **Get tags for session**: Return all tags with full metadata
- **Get sessions for tag**: Return all sessions with a specific tag
- **Clear all tags from session**: Remove all associations
- **Replace session tags**: Atomic replace all tags

### 1.8 Bulk Operations

- **Add tag to multiple sessions**: Multi-select in list, apply tag
- **Remove tag from multiple sessions**: Multi-select, remove tag
- **Clear all tags from multiple sessions**: Multi-select, clear all

### 1.9 Tag Filtering (Advanced)

#### Filter Operators

| Operator | Syntax | Description |
|----------|--------|-------------|
| AND | `tag1 AND tag2` | Sessions must have both tags |
| OR | `tag1 OR tag2` | Sessions must have at least one tag |
| NOT | `NOT tag1` | Sessions must NOT have the tag |
| Grouping | `(tag1 OR tag2) AND tag3` | Parentheses for precedence |

#### Filter UI

- Simple mode: Click tags to toggle (OR logic by default)
- Advanced mode: Text input with full syntax support
- Visual query builder: Drag-drop tags with operator selectors

#### Filter Examples

```
#feature                           -- Has feature tag
#feature AND #react                -- Has both
#feature OR #bugfix                -- Has either
NOT #archived-work                 -- Does not have tag
(#frontend OR #backend) AND #urgent -- Complex query
#frontend/*                        -- Any child of frontend
```

### 1.10 Recent Tags

- Track last 10 tags used
- Display as quick-access strip in tag input areas
- Clicking recent tag applies it immediately

### 1.11 Pinned/Favorite Tags

- Users can pin tags to always show at top
- Pinned tags appear before search results
- Toggle via right-click or dedicated button

### 1.12 Tag Search Syntax in Main Search

Extend main search bar to support tag queries:

```
tag:#important              -- Sessions with #important tag
tag:#feature,#react         -- Sessions with either tag
-tag:#wip                   -- Sessions WITHOUT #wip tag
react tag:#frontend         -- Text "react" AND has #frontend tag
```

### 1.13 Tag Autocomplete

- Fuzzy matching as user types
- Show usage count next to suggestions
- Highlight matching characters
- Keyboard navigation (up/down, enter to select)
- Show "Create new tag" option if no exact match

---

## Phase 2: AI Suggestions

### 2.1 Suggestion Engine Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Tag Suggestion Engine                    │
├─────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │  Queue Manager  │  │ Context Gather  │  │   Analyzer  │ │
│  │                 │  │                 │  │   (Haiku)   │ │
│  │ - LIFO priority │  │ - User messages │  │             │ │
│  │ - Rate limiting │  │ - Subagent data │  │ - Batch     │ │
│  │ - Backlog track │  │ - Project meta  │  │ - Structured│ │
│  └────────┬────────┘  └────────┬────────┘  └──────┬──────┘ │
│           │                    │                   │        │
│           v                    v                   v        │
│  ┌─────────────────────────────────────────────────────────┐│
│  │                   Suggestion Store                      ││
│  │  - Save to tag_suggestions table                        ││
│  │  - Track accept/reject feedback                         ││
│  │  - Update suggestion_feedback for learning              ││
│  └─────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────┘
```

### 2.2 LIFO Priority Queue

**Priority Order (highest → lowest)**:

1. **Immediate**: Just-completed sessions (queue on session end)
2. **High**: Recent sessions (< 7 days) without any tags
3. **Medium**: Recent sessions with manual tags but no AI suggestions
4. **Low**: Older untagged sessions (LIFO - newest first)
5. **Background**: Older tagged sessions (for additional suggestions)

**Queue Status Tracking**:

```typescript
type ScanStatus = 'pending' | 'queued' | 'scanning' | 'completed' | 'skipped' | 'failed';

interface ScanQueueItem {
  sessionId: string;
  priority: number;  // 1-5 based on above
  queuedAt: string;
  attempts: number;
}
```

### 2.3 Data Sources for Analysis

**Primary Sources**:
- User messages (intent, requests)
- Session summary (if exists)
- Project name/path (technology hints)
- Session metadata (duration, message count, tokens, cost)
- Session outcome (success/failed/abandoned)

**Secondary Sources (Full Scan)**:
- Assistant responses (work performed)
- Tool usage patterns (file edits, terminal commands)
- Subagent sessions (delegated work)
- Error patterns (debugging sessions)

### 2.4 Suggestion Categories

| Category | Examples | Detection Signal |
|----------|----------|------------------|
| task_type | `#feature`, `#bugfix`, `#refactor`, `#research`, `#debugging` | User intent keywords |
| technology | `#react`, `#typescript`, `#postgres`, `#docker`, `#aws` | Project path, imports, commands |
| domain | `#auth`, `#payments`, `#api`, `#ui`, `#database`, `#testing` | Keywords, file paths |
| complexity | `#quick-fix`, `#deep-dive`, `#multi-session`, `#exploration` | Duration, message count |
| outcome | `#success`, `#partial`, `#blocked`, `#abandoned` | Session outcome field |
| pattern | `#pair-programming`, `#code-review`, `#learning`, `#prototyping` | Interaction patterns |

### 2.5 Haiku Analysis Prompt

```typescript
const SUGGESTION_PROMPT = `
Analyze these Claude Code sessions and suggest relevant tags.

For each session, suggest 2-5 tags with confidence scores.

Categories to consider:
- task_type: What kind of work? (feature, bugfix, refactor, research, debugging, deployment, documentation)
- technology: What technologies? (react, typescript, python, postgres, docker, aws, etc.)
- domain: What domain/area? (auth, payments, api, ui, database, testing, devops)
- complexity: How complex? (quick-fix, standard, deep-dive, multi-session)
- outcome: How did it end? (success, partial, blocked, abandoned)
- pattern: What pattern? (pair-programming, code-review, learning, prototyping)

Output format (JSON):
{
  "sessions": [
    {
      "sessionId": "...",
      "suggestions": [
        {
          "tag": "feature",
          "confidence": 0.92,
          "category": "task_type",
          "reasoning": "User explicitly requested new functionality"
        }
      ]
    }
  ]
}

Sessions to analyze:
`;
```

### 2.6 Background Processing

**Processing Flow**:

1. **Startup**: Check for pending sessions, populate queue
2. **New Session**: On session end, add to immediate queue
3. **Processing Loop**:
   - Check rate limit (configurable sessions/hour)
   - Dequeue highest priority item
   - Gather context
   - Call Haiku API
   - Store suggestions
   - Update session scan status
4. **Error Handling**: Exponential backoff, max 3 retries

**Rate Limiting**:

```typescript
interface RateLimitConfig {
  sessionsPerHour: number;      // Default: 10
  maxConcurrent: number;        // Default: 1
  batchSize: number;            // Default: 5 sessions per API call
  cooldownMs: number;           // Delay between batches
}
```

### 2.7 "Scan All" Feature

**Before Scanning**:
- Show total unscanned sessions
- Estimate API cost (based on Haiku pricing)
- Estimate time to complete
- Warn if very large (> 1000 sessions)

**During Scanning**:
- Progress modal with percentage
- Sessions processed / total
- Estimated time remaining
- Cancel button
- Chunk into batches of 50

**After Scanning**:
- Summary of suggestions generated
- Option to review all new suggestions

### 2.8 Suggestion UI

**In Session Detail Modal**:

```
┌─────────────────────────────────────────────────────────────┐
│ ✨ Suggested Tags                              [Accept All] │
├─────────────────────────────────────────────────────────────┤
│ [+ #typescript 94%] [+ #frontend 87%] [+ #refactor 72%]    │
│                                                             │
│ Tap to accept, or                            [Dismiss All]  │
└─────────────────────────────────────────────────────────────┘
```

- Show confidence as percentage
- Hover to see reasoning
- Click to accept (creates tag if needed, applies to session)
- X to dismiss (marks as rejected)
- "Accept All" applies all suggestions
- "Dismiss All" rejects all suggestions

### 2.9 Feedback Loop

Track user accept/reject to improve suggestions:

```typescript
interface SuggestionFeedback {
  tagName: string;
  contextHash: string;  // Hash of session characteristics
  acceptedCount: number;
  rejectedCount: number;
}
```

Use feedback to:
- Boost confidence for frequently accepted tags in similar contexts
- Lower confidence for frequently rejected tags
- Don't suggest tags rejected > 3 times in similar contexts

### 2.10 Subagent Analysis

When doing full scan:
- Find related subagent sessions (same project, overlapping time)
- Extract subagent prompts (what work was delegated)
- Include in context for richer suggestions

---

## Phase 3: Advanced Features

### 3.1 Tag Templates/Presets

**System Templates** (built-in):

```typescript
const SYSTEM_TEMPLATES = [
  {
    name: 'Development',
    description: 'Common development workflow tags',
    tags: ['feature', 'bugfix', 'refactor', 'research', 'testing', 'documentation'],
  },
  {
    name: 'Frontend',
    description: 'Frontend development tags',
    tags: ['react', 'vue', 'svelte', 'css', 'responsive', 'accessibility'],
  },
  {
    name: 'Backend',
    description: 'Backend development tags',
    tags: ['api', 'database', 'auth', 'caching', 'queue', 'microservice'],
  },
  {
    name: 'DevOps',
    description: 'DevOps and infrastructure tags',
    tags: ['docker', 'kubernetes', 'ci-cd', 'monitoring', 'deployment', 'aws'],
  },
];
```

**User Templates**:
- Create custom templates
- Apply template to create multiple tags at once
- Share templates (export/import)

### 3.2 Tag Analytics Dashboard

**New View**: Tags Analytics (accessible from sidebar or settings)

**Metrics**:

- Total unique tags
- Total tag applications
- Tags created this week/month
- Most used tags (top 10)
- Least used tags (cleanup candidates)
- Orphaned tags (0 usage)
- Tag growth over time (chart)
- Tags by category breakdown (pie chart)
- Tag co-occurrence matrix (which tags appear together)

**Actions**:

- Bulk delete orphaned tags
- Merge similar tags
- Export tag statistics

### 3.3 Tag Activity Feed

In Monitor Panel, show tag activity:

```
📊 AI suggested 3 tags for "Auth refactor session"
🏷️ User added #urgent to 5 sessions
📊 Backlog scan: 15% complete (342/2,505)
🏷️ New tag created: #v2-migration
```

### 3.4 Export/Import Tags

**Export**:
- Export all tags with colors, effects, hierarchy
- Export tag templates
- Format: JSON

**Import**:
- Import tags (merge or replace)
- Conflict resolution UI
- Preview changes before applying

### 3.5 Tag Grouping View

Alternative session list view:
- Group sessions by tag
- Collapsible tag groups
- Sessions can appear in multiple groups
- "Untagged" group at bottom

---

## UI Components

### New Components

```
src/renderer/components/
├── common/
│   ├── TagChip.tsx                  # Reusable tag display
│   ├── TagInput.tsx                 # Tag autocomplete input
│   ├── TagColorPicker.tsx           # Color selection
│   ├── TagEffectPicker.tsx          # Effect selection
│   └── TagFilterBuilder.tsx         # Visual filter builder
├── views/SessionsView/
│   ├── TagFilterButton.tsx          # Button to open filter modal
│   └── TagFilterModal.tsx           # Full filter modal
├── overlays/SessionDetailModal/
│   └── TagsSection.tsx              # Tags management section
├── overlays/
│   ├── TagManagerModal.tsx          # Full tag management
│   ├── TagAnalyticsModal.tsx        # Analytics dashboard
│   └── ScanProgressModal.tsx        # "Scan All" progress
└── settings/
    └── TagSuggestionsSettings.tsx   # AI settings panel
```

### TagChip Component

```typescript
interface TagChipProps {
  tag: Tag;
  size?: 'sm' | 'md' | 'lg';
  showCount?: boolean;           // Show usage count
  showConfidence?: boolean;      // Show AI confidence %
  removable?: boolean;           // Show X button
  selectable?: boolean;          // Toggle selection on click
  selected?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  onRemove?: () => void;
}
```

**Visual States**:
- Default: Rounded pill with tag name
- With color: Background tinted with tag color
- With effect: Shimmer/glow/pulse animation
- Selected: Stronger border/background
- Suggested: Dashed border, + icon

### TagInput Component

```typescript
interface TagInputProps {
  value: string;
  onChange: (value: string) => void;
  onTagSelect: (tag: Tag) => void;
  onTagCreate: (name: string) => void;
  existingTags: Tag[];
  sessionTags?: Tag[];           // Tags already on session (to exclude)
  placeholder?: string;
  autoFocus?: boolean;
}
```

**Features**:
- Fuzzy autocomplete
- Keyboard navigation
- "Create new tag" option
- Recent tags strip below input

### TagFilterModal

```typescript
interface TagFilterModalProps {
  isOpen: boolean;
  onClose: () => void;
  selectedTags: Tag[];
  filterExpression: string;      // Advanced filter string
  onFilterChange: (tags: Tag[], expression: string) => void;
}
```

**Layout**:
```
┌─────────────────────────────────────────────────────────────┐
│ 🏷️ Filter by Tags                                    [X]   │
├─────────────────────────────────────────────────────────────┤
│ Search: [_________________________]                         │
│                                                             │
│ ┌─ Active Filters ────────────────────────────────────────┐ │
│ │ [#feature ×] [#react ×] [AND ▼]              [Clear All]│ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─ Pinned Tags ───────────────────────────────────────────┐ │
│ │ [#urgent] [#important] [#wip]                           │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─ All Tags ──────────────────────────────────────────────┐ │
│ │ [#feature (47)] [#bugfix (32)] [#react (28)]            │ │
│ │ [#typescript (25)] [#api (21)] [#auth (18)]             │ │
│ │ [#testing (15)] [#refactor (12)] [#docker (8)]          │ │
│ │ [#documentation (5)] [#deployment (3)]                  │ │
│ └─────────────────────────────────────────────────────────┘ │
│                                                             │
│ ┌─ Advanced ──────────────────────────────────────────────┐ │
│ │ [(#feature OR #bugfix) AND #react]                      │ │
│ │ [Validate] [Apply]                                      │ │
│ └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### TagsSection (in SessionDetailModal)

```
┌─────────────────────────────────────────────────────────────┐
│ 🏷️ Tags                                                     │
├─────────────────────────────────────────────────────────────┤
│ Applied Tags:                                               │
│ [#feature ×] [#react ×] [#auth ×]              [Clear All]  │
│                                                             │
│ Add Tag: [_______________] [Create]                         │
│ Recent: [#bugfix] [#api] [#testing]                         │
├─────────────────────────────────────────────────────────────┤
│ ✨ Suggested Tags (3)                          [Accept All] │
│ [+ #typescript 94%] [+ #frontend 87%] [+ #refactor 72%]    │
│                                               [Dismiss All] │
└─────────────────────────────────────────────────────────────┘
```

---

## IPC Handlers

### Tag CRUD

```typescript
// handlers/tags.ts

// Tag management
'get-all-tags'                    // () => Tag[]
'get-tag'                         // (id: number) => Tag | null
'get-tag-by-name'                 // (name: string) => Tag | null
'create-tag'                      // (data: CreateTagInput) => Tag
'update-tag'                      // (id: number, data: UpdateTagInput) => Tag
'delete-tag'                      // (id: number, reassignTo?: number) => void
'merge-tags'                      // (sourceId: number, targetId: number) => Tag
'get-tag-children'                // (parentId: number) => Tag[]
'get-tag-aliases'                 // (tagId: number) => Tag[]

// Tag properties
'toggle-tag-pinned'               // (id: number) => Tag
'set-tag-color'                   // (id: number, color: string | null) => Tag
'set-tag-effect'                  // (id: number, effect: string | null) => Tag
'set-tag-parent'                  // (id: number, parentId: number | null) => Tag
'create-tag-alias'                // (aliasName: string, canonicalId: number) => Tag

// Session-tag associations
'add-tag-to-session'              // (sessionId: string, tagId: number) => void
'remove-tag-from-session'         // (sessionId: string, tagId: number) => void
'get-session-tags'                // (sessionId: string) => Tag[]
'get-sessions-by-tag'             // (tagId: number) => Session[]
'clear-session-tags'              // (sessionId: string) => void
'set-session-tags'                // (sessionId: string, tagIds: number[]) => void

// Bulk operations
'add-tag-to-sessions'             // (sessionIds: string[], tagId: number) => void
'remove-tag-from-sessions'        // (sessionIds: string[], tagId: number) => void
'clear-tags-from-sessions'        // (sessionIds: string[]) => void

// Filtering
'get-sessions-by-filter'          // (filter: TagFilterExpression) => Session[]
'validate-filter-expression'      // (expression: string) => ValidationResult

// Recent & pinned
'get-recent-tags'                 // (limit?: number) => Tag[]
'get-pinned-tags'                 // () => Tag[]
'record-tag-usage'                // (tagId: number) => void
```

### AI Suggestions

```typescript
// handlers/tag-suggestions.ts

// Suggestion management
'get-session-suggestions'         // (sessionId: string) => TagSuggestion[]
'accept-suggestion'               // (suggestionId: number) => void
'reject-suggestion'               // (suggestionId: number) => void
'dismiss-all-suggestions'         // (sessionId: string) => void
'accept-all-suggestions'          // (sessionId: string) => void

// Scanning
'get-scan-status'                 // () => ScanStatus
'get-scan-queue'                  // () => QueueItem[]
'start-background-scan'           // () => void
'stop-background-scan'            // () => void
'scan-session'                    // (sessionId: string) => TagSuggestion[]
'scan-all-sessions'               // () => void (triggers full scan)
'get-scan-progress'               // () => ScanProgress
'cancel-scan'                     // () => void

// Settings
'get-suggestion-settings'         // () => SuggestionSettings
'update-suggestion-settings'      // (settings: Partial<SuggestionSettings>) => void
```

### Templates

```typescript
// handlers/tag-templates.ts

'get-all-templates'               // () => TagTemplate[]
'get-template'                    // (id: number) => TagTemplate
'create-template'                 // (data: CreateTemplateInput) => TagTemplate
'update-template'                 // (id: number, data: UpdateTemplateInput) => TagTemplate
'delete-template'                 // (id: number) => void
'apply-template'                  // (templateId: number) => Tag[] (creates tags)
'get-system-templates'            // () => TagTemplate[]
```

### Analytics

```typescript
// handlers/tag-analytics.ts

'get-tag-statistics'              // () => TagStatistics
'get-tag-usage-over-time'         // (days: number) => TimeSeriesData
'get-tag-co-occurrence'           // () => CoOccurrenceMatrix
'get-orphaned-tags'               // () => Tag[]
'delete-orphaned-tags'            // () => number (count deleted)
```

### Export/Import

```typescript
// handlers/tag-export.ts

'export-tags'                     // () => ExportData
'import-tags'                     // (data: ExportData, mode: 'merge' | 'replace') => ImportResult
'preview-import'                  // (data: ExportData) => ImportPreview
```

---

## Settings & Configuration

### New Settings Section: Tags

```typescript
interface TagSettings {
  // Display
  showTagsInSessionList: boolean;     // Show tag chips on session cards
  maxVisibleTagsInList: number;       // How many to show before "+N more"
  
  // AI Suggestions
  enableAiSuggestions: boolean;
  sessionsPerHour: number;            // Rate limit: 1-60
  minimumSessionLength: number;       // Min messages to scan: 1-50
  scanDepth: 'quick' | 'full';        // Quick = user msgs, Full = includes subagents
  autoAcceptHighConfidence: boolean;  // Auto-accept suggestions > 95%
  autoAcceptThreshold: number;        // Threshold for auto-accept: 0.9-1.0
  
  // Filter behavior
  defaultFilterLogic: 'and' | 'or';   // Default when selecting multiple tags
  rememberFilterState: boolean;       // Persist filter across sessions
}
```

### Settings UI

```
┌─────────────────────────────────────────────────────────────┐
│ 🏷️ Tags                                                     │
├─────────────────────────────────────────────────────────────┤
│ Display                                                     │
│ ├─ Show tags in session list                      [ON]     │
│ └─ Max visible tags: [3 ▼]                                 │
│                                                             │
│ Filtering                                                   │
│ ├─ Default filter logic: [OR ▼]                            │
│ └─ Remember filter state                          [ON]     │
├─────────────────────────────────────────────────────────────┤
│ 🤖 AI Tag Suggestions                                       │
├─────────────────────────────────────────────────────────────┤
│ ○ Enable AI tag suggestions                       [ON]     │
│                                                             │
│ Scan Rate                                                   │
│ ├─ Sessions per hour: [10 ▼]                               │
│ ├─ Minimum session length: [5 messages ▼]                  │
│ └─ Scan depth: [● Quick ○ Full]                            │
│                                                             │
│ Auto-Accept                                                 │
│ ├─ Auto-accept high confidence suggestions        [OFF]    │
│ └─ Confidence threshold: [95% ▼]                           │
│                                                             │
│ ─────────────────────────────────────────────────────────── │
│ 📊 Backlog Status                                           │
│                                                             │
│ Total sessions: 2,847                                       │
│ ├─ Scanned: 342 (12%)     ████░░░░░░░░░░░░░░░░             │
│ ├─ Pending: 2,505                                          │
│ └─ Estimated completion: ~10 days at current rate          │
│                                                             │
│ [Scan All Unscanned Sessions]                               │
│ ⚠️ Estimated cost: ~$0.47 | Time: ~25 minutes               │
│                                                             │
│ [Pause Background Scanning]  [Reset All Suggestions]        │
└─────────────────────────────────────────────────────────────┘
```

---

## Keyboard Shortcuts

### Global (SessionsView)

| Shortcut | Action |
|----------|--------|
| `T` | Open tag filter modal |
| `Shift+T` | Focus tag search in filter modal |
| `Escape` | Close modal / clear filter |

### In Session Detail Modal

| Shortcut | Action |
|----------|--------|
| `Cmd/Ctrl+T` | Focus tag input |
| `Cmd/Ctrl+Shift+T` | Accept all suggestions |
| `Tab` (in tag input) | Accept first autocomplete suggestion |
| `Enter` (in tag input) | Create/apply tag |
| `Backspace` (empty input) | Remove last applied tag |

### In Tag Filter Modal

| Shortcut | Action |
|----------|--------|
| `Enter` | Apply filter |
| `Cmd/Ctrl+A` | Select all visible tags |
| `Cmd/Ctrl+Shift+A` | Clear all selected tags |
| `Up/Down` | Navigate tag list |
| `Space` | Toggle selected tag |

---

## Edge Cases & Error Handling

### Tag Operations

| Scenario | Handling |
|----------|----------|
| Create tag with existing name | Return existing tag (case-insensitive match) |
| Create tag matching an alias | Apply canonical tag instead |
| Delete tag with sessions | Remove associations first, update counts |
| Merge tag into itself | No-op, return tag |
| Circular parent reference | Reject, return error |
| Tag name with special chars | Sanitize: lowercase, alphanumeric + hyphens only |
| Very long tag name | Truncate to 50 characters |
| Empty tag name | Reject, return error |

### AI Suggestions

| Scenario | Handling |
|----------|----------|
| API rate limit | Exponential backoff, max 3 retries |
| API error | Log error, mark session as 'failed', retry later |
| Session deleted during scan | Skip, no error |
| Invalid JSON response | Log, mark 'failed', retry |
| Confidence below threshold | Still store, but don't auto-accept |
| Suggested tag doesn't exist | Create tag when accepted |
| App closed during scan | Resume from queue on restart |

### Filtering

| Scenario | Handling |
|----------|----------|
| Invalid filter expression | Show validation error, don't apply |
| Filter returns no results | Show "No sessions match" state |
| Tag deleted while in filter | Remove from filter, reapply |
| Complex expression timeout | Limit query complexity, show warning |

### Migration

| Scenario | Handling |
|----------|----------|
| Existing comma-separated tags | Migrate to new tables on upgrade |
| Duplicate tags after migration | Merge, keep first created |
| Invalid tag data | Skip with warning in logs |

---

## Migration Plan

### From Old Schema

1. **Backup**: Create backup of sessions table
2. **Parse**: Extract comma-separated tags from sessions.tags column
3. **Create**: Insert unique tags into tags table
4. **Associate**: Create session_tags entries
5. **Verify**: Confirm all associations created
6. **Cleanup**: Remove old tags column (optional, can keep for rollback)

```typescript
async function migrateTagsToNewSchema() {
  const sessions = await db.all('SELECT id, tags FROM sessions WHERE tags IS NOT NULL');
  
  for (const session of sessions) {
    const tagNames = session.tags.split(',').map(t => t.trim()).filter(Boolean);
    
    for (const tagName of tagNames) {
      // Get or create tag
      let tag = await getTagByName(tagName);
      if (!tag) {
        tag = await createTag({ name: tagName });
      }
      
      // Create association
      await addTagToSession(session.id, tag.id);
    }
  }
}
```

---

## Performance Considerations

### Database

- Denormalized `usage_count` on tags table for fast sorting
- Indexes on all foreign keys and frequently queried columns
- Batch updates for bulk operations
- Prepared statements for repeated queries

### UI

- Virtualized tag lists for large tag counts
- Debounced search/autocomplete (300ms)
- Lazy load suggestions (only fetch when section visible)
- Cache tag list with React Query (5 minute stale time)

### AI Suggestions

- Batch sessions in groups of 5-10 per API call
- Queue-based processing to prevent blocking
- Background worker thread for scanning
- Chunked "Scan All" to prevent memory issues

---

## Testing Requirements

### Unit Tests

- Tag CRUD operations
- Filter expression parsing
- Tag name sanitization
- Alias resolution
- Parent/child relationships

### Integration Tests

- Session-tag associations
- Bulk operations
- Migration from old schema
- IPC handler responses

### E2E Tests

- Create tag flow
- Apply tag to session
- Filter by tag
- AI suggestion accept/reject
- Keyboard shortcuts

---

## Success Metrics

- Tags created (total, per week)
- Tags applied (manual vs AI-accepted)
- Filter usage (how often, complexity)
- AI suggestion acceptance rate
- Time to tag (manual vs accepting suggestion)
- Sessions with tags (percentage)

---

## Open Questions

1. ~~Tag colors: Optional or required?~~ **Optional with color picker**
2. ~~Tag effects: Optional or required?~~ **Optional with effect picker**
3. ~~Filter logic: AND-only, OR-only, or full boolean?~~ **Full boolean with NOT and grouping**
4. ~~AI suggestions: Phase 2 or include in Phase 1?~~ **All phases together**
5. Tag limits: Max tags per session? **No limit initially, monitor performance**
6. Tag character restrictions: Allow emojis? **Yes, but sanitize for search**

---

## Appendix: Type Definitions

```typescript
// src/shared/types/tag-types.ts

export interface Tag {
  id: number;
  name: string;
  color: string | null;
  effect: TagEffect | null;
  parentId: number | null;
  aliasOf: number | null;
  description: string | null;
  isPinned: boolean;
  usageCount: number;
  createdAt: string;
  updatedAt: string;
}

export type TagEffect = 'shimmer' | 'glow' | 'pulse';

export interface SessionTag {
  id: number;
  sessionId: string;
  tagId: number;
  addedAt: string;
  addedBy: TagSource;
}

export type TagSource = 'user' | 'ai' | 'bulk' | 'template';

export interface TagSuggestion {
  id: number;
  sessionId: string;
  tagName: string;
  confidence: number;
  category: SuggestionCategory;
  reasoning: string | null;
  status: SuggestionStatus;
  createdAt: string;
  reviewedAt: string | null;
}

export type SuggestionCategory = 
  | 'task_type' 
  | 'technology' 
  | 'domain' 
  | 'complexity' 
  | 'outcome' 
  | 'pattern';

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected' | 'dismissed';

export interface TagTemplate {
  id: number;
  name: string;
  description: string | null;
  tagIds: number[];
  isSystem: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TagFilterExpression {
  type: 'tag' | 'and' | 'or' | 'not';
  tagId?: number;
  children?: TagFilterExpression[];
}

export interface ScanStatus {
  isRunning: boolean;
  isPaused: boolean;
  totalSessions: number;
  scannedSessions: number;
  pendingSessions: number;
  currentSessionId: string | null;
  estimatedTimeRemaining: number | null;
  lastError: string | null;
}

export interface ScanProgress {
  current: number;
  total: number;
  percentage: number;
  estimatedTimeMs: number;
  currentSessionId: string;
}

export interface TagStatistics {
  totalTags: number;
  totalApplications: number;
  tagsCreatedThisWeek: number;
  tagsCreatedThisMonth: number;
  mostUsedTags: Array<{ tag: Tag; count: number }>;
  leastUsedTags: Array<{ tag: Tag; count: number }>;
  orphanedTags: Tag[];
  sessionsWithTags: number;
  sessionsWithoutTags: number;
  averageTagsPerSession: number;
}

export interface CreateTagInput {
  name: string;
  color?: string;
  effect?: TagEffect;
  parentId?: number;
  description?: string;
}

export interface UpdateTagInput {
  name?: string;
  color?: string | null;
  effect?: TagEffect | null;
  parentId?: number | null;
  description?: string | null;
}

export interface SuggestionSettings {
  enabled: boolean;
  sessionsPerHour: number;
  minimumSessionLength: number;
  scanDepth: 'quick' | 'full';
  autoAcceptHighConfidence: boolean;
  autoAcceptThreshold: number;
}

export interface TagSettings {
  showTagsInSessionList: boolean;
  maxVisibleTagsInList: number;
  defaultFilterLogic: 'and' | 'or';
  rememberFilterState: boolean;
  suggestions: SuggestionSettings;
}
```

---

**Document Version**: 1.0.0
**Last Updated**: 2026-02-03
**Author**: Claude (Orchestrator) + User Collaboration
