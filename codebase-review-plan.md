# GoodVibes Comprehensive Codebase Review Plan

**Version**: 1.0  
**Date**: 2026-02-03  
**Prepared by**: Architecture Agent  
**Goal**: Complete codebase review to prepare for release - fix ALL issues regardless of severity

---

## Executive Summary

This document outlines a comprehensive review plan for the GoodVibes Electron application. The codebase consists of approximately **300+ TypeScript/TSX files** organized into:

- **Main Process** (Electron backend): `/src/main/` - Database, IPC handlers, services, lifecycle
- **Renderer Process** (React frontend): `/src/renderer/` - Components, stores, hooks, views
- **Shared Code**: `/src/shared/` - Types, utilities, constants
- **Preload Scripts**: `/src/preload/` - IPC bridge APIs

The review is organized into **6 parallel workstreams**, each assignable to a separate agent.

---

## Codebase Statistics

| Category | Count | Location |
|----------|-------|----------|
| Total Source Files | 300+ | `src/**/*.ts`, `src/**/*.tsx` |
| Test Files | 51 | `**/*.test.ts`, `**/*.spec.ts` |
| Database Modules | 25+ | `src/main/database/` |
| Service Modules | 100+ | `src/main/services/` |
| IPC Handlers | 30+ | `src/main/ipc/handlers/` |
| React Components | 100+ | `src/renderer/components/` |
| Zustand Stores | 4 | `src/renderer/stores/` |
| Custom Hooks | 7+ | `src/renderer/hooks/` |

---

## Review Priorities

### Priority 1: Security (CRITICAL)

Security issues must be addressed before any release.

### Priority 2: Performance & Memory

Memory leaks and performance issues directly impact user experience.

### Priority 3: Error Handling & Resilience

Proper error handling prevents crashes and improves reliability.

### Priority 4: Code Quality & Maintainability

Clean code ensures long-term maintainability.

### Priority 5: Code Reuse & DRY

Reduce duplication to minimize bugs and maintenance burden.

### Priority 6: Testing Coverage

Ensure adequate test coverage for critical paths.

---

## Workstream 1: Security Review (Agent 1)

**Focus**: Command injection, SQL injection, XSS, auth, secrets, path traversal

### 1.1 Command Execution Security

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/safeExec.ts` (476 lines)
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/inputSanitizer.ts` (417 lines)
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/headlessRunner.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/terminalManager.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/hooks/hook-execution.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/lifecycle/agentBridge.ts`

**What to Look For**:
- Uses of `child_process.exec()`, `execSync()`, `spawn()`, `spawnSync()`
- Commands constructed from user input
- Missing validation before command execution
- Shell metacharacter escaping
- Ensure all execution uses `safeExec.ts` utilities

**Known Good Patterns**:
- `safeExecSync()`, `safeExecAsync()`, `safeSpawn()` from safeExec.ts
- Input validation via `inputSanitizer.ts`

### 1.2 SQL Injection Prevention

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/main/database/index.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/database/migrations.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/database/agentTree.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/database/sessions.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/database/search.ts`
- All files in `/home/buzzkill/Projects/goodvibes.sh/src/main/database/*/`

**What to Look For**:
- String concatenation in SQL queries
- Missing parameterized queries with `?` placeholders
- Dynamic table/column names from user input
- `db.exec()` with unsanitized input

**Pattern to Enforce**:
```typescript
// GOOD: Parameterized query
db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId)

// BAD: String concatenation
db.exec(`SELECT * FROM sessions WHERE id = '${sessionId}'`)
```

### 1.3 XSS Prevention (Renderer)

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/preview/contentPrettify/SafeHighlight.tsx`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/preview/contentPrettify/CodeBlock.tsx`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/views/HooksView/OutputDecisionHelp.tsx`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/utils/sanitize.ts`
- Any component using `dangerouslySetInnerHTML`

**What to Look For**:
- Uses of `dangerouslySetInnerHTML` without DOMPurify sanitization
- Direct HTML string rendering
- Markdown rendering without proper sanitization

### 1.4 Authentication & Token Security

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/github/token-manager.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/github/credentials.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/github/device-flow.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/github/oauth-flow.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/preload/api/github.ts`

**What to Look For**:
- Tokens stored in plaintext
- Tokens exposed to renderer process unnecessarily
- Missing token validation/expiration checks
- Insecure token transmission

### 1.5 Path Traversal Prevention

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/main/ipc/validation.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/contextInjection.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/fileWatcher.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/config.ts`

**What to Look For**:
- User-provided paths without validation
- Missing `..` traversal checks
- Symlink following without restriction
- File operations outside expected directories

---

## Workstream 2: Memory & Performance (Agent 2)

**Focus**: Memory leaks, event listener cleanup, interval clearing, async race conditions

### 2.1 Event Listener Leaks

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/main/lifecycle/listenerRegistry.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/preload/api/events.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/hooks/useIpcListeners.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/agentRegistry/events.ts`

**What to Look For**:
- `addEventListener` without corresponding `removeEventListener` in cleanup
- `ipcRenderer.on()` without `removeListener` in useEffect cleanup
- `EventEmitter.on()` without `.off()` or `.removeListener()`
- Missing cleanup functions in useEffect hooks

**Pattern to Enforce**:
```typescript
useEffect(() => {
  const handler = () => { /* ... */ };
  window.addEventListener('event', handler);
  return () => window.removeEventListener('event', handler);
}, []);
```

### 2.2 Timer/Interval Leaks

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/fileWatcher.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/gitWatcher.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/mcpManager/serverLifecycle.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/stores/toastStore.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/hooks/useMcpServers.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/github/device-flow.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/ptyStreamAnalyzer/service.ts`

**What to Look For**:
- `setInterval` without stored reference and `clearInterval`
- `setTimeout` without cleanup on component unmount
- Polling loops that don't stop on cleanup

### 2.3 Async Race Conditions

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/sessionManager/service.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/mcpManager/service.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/projectCoordinator/`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/agentRegistry/lifecycle.ts`

**What to Look For**:
- State updates after component unmount
- Concurrent async operations modifying shared state
- Missing abort controllers for cancellable operations
- Stale closure problems in async callbacks

### 2.4 Large Object Retention

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/stores/terminalStore.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/sessionManager/`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/database/mappers.ts`

**What to Look For**:
- Growing Maps/Sets without cleanup
- Cached data without TTL or size limits
- Session data retained after session ends

---

## Workstream 3: Error Handling & Resilience (Agent 3)

**Focus**: try/catch coverage, error boundaries, graceful degradation

### 3.1 Main Process Error Handling

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/main/index.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/lifecycle/initialization.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/lifecycle/shutdown.ts`
- All files in `/home/buzzkill/Projects/goodvibes.sh/src/main/ipc/handlers/`

**What to Look For**:
- IPC handlers without try/catch
- Unhandled promise rejections
- Database operations without error handling
- Missing error logging

### 3.2 Renderer Error Boundaries

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/common/ErrorBoundary.tsx`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/common/ErrorFallback.tsx`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/common/ErrorRecovery.tsx`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/App.tsx`

**What to Look For**:
- Components that should have error boundaries but don't
- Missing recovery mechanisms
- Error messages not user-friendly

### 3.3 API Error Handling

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/preload/api/*.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/hooks/*.ts`

**What to Look For**:
- Missing error states in hooks
- API calls without error handling
- Silent failures

### 3.4 Database Error Handling

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/main/database/connection.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/database/migrations.ts`
- All query files in `/home/buzzkill/Projects/goodvibes.sh/src/main/database/*/`

**What to Look For**:
- Missing transaction rollbacks
- Uncaught SQL errors
- Connection error handling

---

## Workstream 4: Code Quality & TypeScript (Agent 4)

**Focus**: Type safety, any types, code smells, dead code

### 4.1 TypeScript Strictness

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/shared/utils.ts` (contains `any` types)
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/sessionManager/pricing-fetcher.ts` (contains `any` types)
- Any file with `// @ts-ignore` or `// eslint-disable`

**What to Look For**:
- Uses of `any` type (found 4 instances)
- `// @ts-ignore` comments
- Missing return types on functions
- Implicit `any` in function parameters

### 4.2 TODO/FIXME/HACK Comments

**Files with Known TODOs**:
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/hooks/useMcpServers.test.ts` (3 TODOs)
- `/home/buzzkill/Projects/goodvibes.sh/src/main/database/primitives/agents.ts` (3 TODOs)
- `/home/buzzkill/Projects/goodvibes.sh/src/main/ipc/handlers/primitives.test.ts` (2 TODOs)
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/hookServer/handlers.ts` (3 TODOs)
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/views/AgentsView/constants.ts` (1 TODO)
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/views/CommandsView/constants.ts` (8 TODOs)
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/views/HooksView/builtinHooks.ts` (10 TODOs)

**Action**: Address or document each TODO before release.

### 4.3 Console Logging Cleanup

**Files with console.log**:
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/hookScripts/script-generator.ts` (6 instances)
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/sessionManager/pricing-fetcher.ts` (5 instances)
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/views/AgentsView/constants.ts` (1 instance)
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/views/CommandsView/constants.ts` (3 instances)

**Action**: Replace with proper Logger or remove debug logs.

### 4.4 Deprecated Code

**Files with @deprecated**:
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/github/oauth-config.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/views/CommandsView/constants.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/views/SkillsView/constants.ts`

**Action**: Remove or update deprecated code.

---

## Workstream 5: Code Reuse & Architecture (Agent 5)

**Focus**: DRY violations, module boundaries, shared utilities

### 5.1 Duplicated Logic

**Areas to Check**:
- Session cost calculation (found in multiple locations per memory)
- Date formatting utilities
- Token formatting utilities
- API error handling patterns
- IPC handler patterns

**Files to Compare**:
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/views/FilesView/SessionsPanel.tsx` (has local formatters)
- `/home/buzzkill/Projects/goodvibes.sh/src/shared/utils.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/shared/dateUtils.ts`

### 5.2 Module Boundary Issues

**What to Look For**:
- Renderer importing from main (not allowed in Electron)
- Circular dependencies
- Services directly accessing other services' internals

### 5.3 Shared Utilities

**Files to Review**:
- `/home/buzzkill/Projects/goodvibes.sh/src/shared/constants.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/shared/utils.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/shared/dateUtils.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/shared/types/`

**What to Look For**:
- Duplicated constants
- Similar utility functions that could be consolidated
- Missing shared types

### 5.4 Component Reuse

**Areas to Check**:
- Similar modal patterns across views
- Form patterns
- List/card patterns
- Loading states

---

## Workstream 6: Testing & Validation (Agent 6)

**Focus**: Test coverage gaps, schema validation, integration testing

### 6.1 Test Coverage Analysis

**Current Test Files (51 total)**:
- Database tests: 5 files
- IPC handler tests: 7 files
- IPC schema tests: 11 files
- Service tests: 13 files
- Component tests: 10 files
- Store tests: 3 files
- Utility tests: 2 files

**Critical Paths Needing Tests**:
- Session lifecycle (creation, updates, cleanup)
- Terminal management
- Agent spawning and communication
- Database migrations
- Error recovery paths

### 6.2 Schema Validation

**Files to Review**:
- All files in `/home/buzzkill/Projects/goodvibes.sh/src/main/ipc/schemas/`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/ipc/validation.ts`

**What to Look For**:
- IPC handlers without Zod schema validation
- Missing input validation
- Inconsistent validation patterns

### 6.3 Integration Testing

**Areas Needing Integration Tests**:
- IPC communication (main <-> renderer)
- Database operations
- GitHub OAuth flow
- MCP server lifecycle

---

## Known Issues from Memory

From `.goodvibes/memory/preferences.json`:

| Issue | Status | Files |
|-------|--------|-------|
| FilesView session start bug | Fixed | `src/renderer/components/views/FilesView/index.tsx` |
| Session naming on Linux | Fixed | `src/shared/utils.ts` |
| Pricing fetcher column order | Fixed | `src/main/services/sessionManager/pricing-fetcher.ts` |
| Subagent cost attribution | Fixed | `src/main/database/index.ts` |
| SessionsPanel stale closures | Fixed | `src/renderer/components/views/FilesView/SessionsPanel.tsx` |

---

## Parallel Execution Plan

### Agent Assignment Matrix

| Agent | Workstream | Focus | Estimated Files |
|-------|------------|-------|----------------|
| Agent 1 | Security | Command injection, SQL, XSS, auth | ~50 files |
| Agent 2 | Performance | Memory leaks, timers, race conditions | ~40 files |
| Agent 3 | Error Handling | try/catch, boundaries, resilience | ~60 files |
| Agent 4 | Code Quality | Types, TODOs, dead code | ~30 files |
| Agent 5 | Architecture | DRY, modules, reuse | ~40 files |
| Agent 6 | Testing | Coverage, schemas, integration | ~50 files |

### Dependencies Between Workstreams

```
Security (Agent 1) -----> Error Handling (Agent 3)
                    \----> Testing (Agent 6)

Performance (Agent 2) --> Code Quality (Agent 4)

Architecture (Agent 5) --> All (provides refactoring targets)
```

### Execution Order

1. **Phase 1** (Parallel): All 6 agents start simultaneously
2. **Phase 2**: Security findings inform Error Handling and Testing
3. **Phase 3**: Architecture findings inform all refactoring
4. **Phase 4**: Final integration and validation

---

## Output Requirements

Each agent should produce:

1. **Issue Report**: List of all issues found with:
   - File path
   - Line number(s)
   - Issue type
   - Severity (critical/high/medium/low)
   - Suggested fix

2. **Fix PRs**: Actual code changes for each issue

3. **Test Additions**: New tests for any gaps discovered

4. **Documentation**: Updates to code comments or docs if needed

---

## Success Criteria

- [ ] Zero critical security issues
- [ ] Zero high-severity memory leaks
- [ ] All IPC handlers have try/catch and schema validation
- [ ] All `any` types eliminated or justified
- [ ] All TODOs addressed or documented for future
- [ ] No console.log in production code
- [ ] Test coverage > 70% for critical paths
- [ ] No circular dependencies
- [ ] No deprecated code without migration path

---

## Appendix: File Paths for Quick Reference

### Main Process Entry Points
- `/home/buzzkill/Projects/goodvibes.sh/src/main/index.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/window.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/main/lifecycle/`

### Renderer Entry Points
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/App.tsx`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/main.tsx`

### Preload Entry Points
- `/home/buzzkill/Projects/goodvibes.sh/src/preload/index.ts`
- `/home/buzzkill/Projects/goodvibes.sh/src/preload/api/`

### Database Layer
- `/home/buzzkill/Projects/goodvibes.sh/src/main/database/`

### Services Layer
- `/home/buzzkill/Projects/goodvibes.sh/src/main/services/`

### IPC Layer
- `/home/buzzkill/Projects/goodvibes.sh/src/main/ipc/`

### Shared Layer
- `/home/buzzkill/Projects/goodvibes.sh/src/shared/`

### Renderer Components
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/components/`

### Renderer State
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/stores/`
- `/home/buzzkill/Projects/goodvibes.sh/src/renderer/hooks/`
