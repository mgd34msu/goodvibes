# Agent Tool Usage Analysis

Generated: 2026-01-14

## GoodVibes MCP Tools Used (290 calls)

| Tool | Calls | Purpose |
|------|-------|---------|
| `detect_stack` | 97 | Tech stack detection |
| `scan_patterns` | 44 | Code pattern scanning |
| `check_types` | 42 | TypeScript type checking |
| `project_issues` | 32 | Project issue detection |
| `find_tests_for_file` | 19 | Test file discovery |
| `find_circular_deps` | 13 | Circular dependency detection |
| `scan_for_secrets` | 11 | Secret scanning |
| `get_diagnostics` | 10 | LSP diagnostics |
| `find_dead_code` | 9 | Dead code detection |
| `analyze_dependencies` | 6 | Dependency analysis |
| `detect_memory_leaks` | 4 | Memory leak detection |
| `find_references` | 3 | Symbol reference lookup |

## GoodVibes Skills Used

| Skill | Calls |
|-------|-------|
| None | 0 |

**Note:** GoodVibes skills weren't invoked - agents used MCP tools directly via `mcp-cli call`.

---

## Agents Spawned (177 total)

| Agent Type | Count |
|------------|-------|
| Explore | 34 |
| Bash | 27 |
| Plan | 23 |
| `goodvibes:brutally-honest-reviewer` | 17 |
| `goodvibes:backend-engineer` | 17 |
| `goodvibes:code-architect` | 16 |
| `goodvibes:frontend-architect` | 15 |
| `goodvibes:test-engineer` | 11 |
| typescript | 5 |
| frontend-ui | 4 |
| `goodvibes:fullstack-integrator` | 3 |
| backend-data | 3 |
| `goodvibes:workflow-planner` | 1 |
| `goodvibes:devops-deployer` | 1 |

---

## Bash Commands Analysis (Non-MCP)

### Full Command Breakdown with Replacement Potential

| Category | Command Pattern | Count | | Replacement | Agent |
|----------|-----------------|-------|---|-------------|-------|
| **Test Execution** | | | | | |
| | `npx vitest run ...` | 26 | 🟡 | `run_smoke_test` - partial coverage | `test-engineer` |
| | `npx vitest run ...` | 3 | 🟡 | `run_smoke_test` - partial coverage | `backend-engineer` |
| | `npm test -- --run ...` | 8 | 🟡 | `run_smoke_test` - basic support | `backend-engineer` |
| | `npm test -- --run ...` | 6 | 🟡 | `run_smoke_test` - basic support | `code-architect` |
| | `npm test -- --run ...` | 5 | 🟡 | `run_smoke_test` - basic support | `test-engineer` |
| | `npm test -- --run ...` | 3 | 🟡 | `run_smoke_test` - basic support | `frontend-architect` |
| | `npm run test:coverage` | 5 | 🟢 | `get_test_coverage` - dedicated tool | `test-engineer` |
| | `npm run test:coverage` | 5 | 🟢 | `get_test_coverage` - dedicated tool | `backend-engineer` |
| **TypeScript Checks** | | | | | |
| | `npx tsc --noEmit ...` | 13 | 🟢 | `check_types` - exact replacement | `code-architect` |
| | `npx tsc --noEmit ...` | 8 | 🟢 | `check_types` - exact replacement | `test-engineer` |
| | `npx tsc --noEmit ...` | 7 | 🟢 | `check_types` - exact replacement | `backend-engineer` |
| | `npx tsc --noEmit ...` | 4 | 🟢 | `check_types` - exact replacement | `frontend-architect` |
| | `npm run typecheck ...` | 5 | 🟢 | `check_types` - exact replacement | `code-architect` |
| **File Discovery** | | | | | |
| | `find src -name "*.ts"` | 8 | 🟢 | `workspace_symbols` - structured | `brutally-honest-reviewer` |
| | `find src -name "*.test.ts"` | 6 | 🟢 | `find_tests_for_file` - dedicated | `brutally-honest-reviewer` |
| | `find src -name ...` | 6 | 🟢 | `workspace_symbols` | `brutally-honest-reviewer` |
| | `find -type d \| wc -l` | 3 | 🔴 | No equivalent - basic stat | `brutally-honest-reviewer` |
| **Package Management** | | | | | |
| | `npm install ...` | 2 | 🔴 | No equivalent - needs npm | `devops-deployer` |
| | `npm install ...` | 2 | 🔴 | No equivalent - needs npm | `backend-engineer` |
| | `rm -rf node_modules && npm install` | 2 | 🔴 | No equivalent - destructive | `backend-engineer` |
| | `npm audit ...` | 2 | 🟢 | `analyze_dependencies` - vuln scan | `brutally-honest-reviewer` |
| | `npm outdated ...` | 2 | 🟢 | `check_versions` - version check | `brutally-honest-reviewer` |
| **Linting** | | | | | |
| | `npx eslint src/...` | 4 | 🟢 | `get_diagnostics` - LSP linting | `backend-engineer` |
| | `npm run lint ...` | 6 | 🟢 | `project_issues` - aggregated | `brutally-honest-reviewer` |
| **File Operations** | | | | | |
| | `mkdir -p src/...` | 4 | 🔴 | No equivalent - fs mutation | `code-architect` |
| | `rm src/...` | 1 | 🔴 | No equivalent - fs deletion | `code-architect` |
| | `wc -l src/...` | 5 | 🔴 | No equivalent - line count | `code-architect` |
| | `git grep -l "..."` | 1 | 🟡 | `find_references` - symbol only | `code-architect` |
| **Electron Testing** | | | | | |
| | `npx electron -e "..."` | 6 | 🔴 | No equivalent - runtime test | `backend-engineer` |
| | `npx @electron-forge ...` | 2 | 🔴 | No equivalent - electron build | `backend-engineer` |
| **Inspection** | | | | | |
| | `cat package.json` | 1 | 🟢 | `read_config` - config reader | `brutally-honest-reviewer` |
| | `cat tsconfig.json` | 1 | 🟢 | `read_config` - config reader | `brutally-honest-reviewer` |
| | `ls -la src/...` | 2 | 🟡 | `get_document_symbols` - partial | `brutally-honest-reviewer` |

---

## Summary by Agent

| Agent | Total Bash | 🟢 Replaceable | 🟡 Partial | 🔴 Not |
|-------|------------|----------------|------------|--------|
| `brutally-honest-reviewer` | 52 | 28 (54%) | 18 (35%) | 6 (11%) |
| `test-engineer` | 47 | 23 (49%) | 24 (51%) | 0 (0%) |
| `code-architect` | 38 | 18 (47%) | 1 (3%) | 19 (50%) |
| `backend-engineer` | 36 | 11 (31%) | 11 (31%) | 14 (38%) |
| `frontend-architect` | 7 | 7 (100%) | 0 (0%) | 0 (0%) |
| `devops-deployer` | 2 | 0 (0%) | 0 (0%) | 2 (100%) |

---

## Overall Replacement Potential

| Possibility | Count | Percentage |
|-------------|-------|------------|
| 🟢 Replaceable | 44 | 52% |
| 🟡 Partial | 37 | 44% |
| 🔴 Not Replaceable | 12 | 14% |

---

## Key Recommendations

### GoodVibes tools that should be used more:

| Current Bash | Recommended Tool | Calls Saved |
|--------------|------------------|-------------|
| `npx tsc --noEmit` | `check_types` | 32 |
| `find -name "*.test.ts"` | `find_tests_for_file` | 14 |
| `npm run test:coverage` | `get_test_coverage` | 10 |
| `npm audit` | `analyze_dependencies` | 4 |
| `npm run lint` / `npx eslint` | `project_issues` / `get_diagnostics` | 10 |
| `npm outdated` | `check_versions` | 4 |
| `cat *.json` | `read_config` | 2 |

### Commands that cannot be replaced (by design):

- `npm install` - Package installation requires npm
- `rm -rf` / `rm` - Destructive file operations
- `mkdir -p` - Directory creation
- `npx electron` - Electron runtime testing
- `wc -l` - Line counting statistics

---

## Insights

1. **`brutally-honest-reviewer`** and **`test-engineer`** have the highest potential for GoodVibes tool adoption (54% and 49% replaceable respectively).

2. **`code-architect`** performs many filesystem mutations (mkdir, rm, wc) that inherently require bash.

3. **`frontend-architect`** already uses bash minimally and all calls are replaceable.

4. **`devops-deployer`** only uses bash for npm install which cannot be replaced.

5. **Zero skills were invoked** - agents relied entirely on MCP tools via `mcp-cli call`. Consider whether skills could provide higher-level abstractions.

6. **TypeScript checking** (`check_types`) is the single biggest opportunity - 32 bash calls could be replaced.
