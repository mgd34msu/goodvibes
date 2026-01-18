// ============================================================================
// COMMANDS VIEW - CONSTANTS AND BUILT-IN COMMANDS
// ============================================================================

import type { BuiltInCommand } from './types';

export const BUILT_IN_COMMANDS: BuiltInCommand[] = [
  // -------------------------------------------------------------------------
  // /commit - Git commit with conventional commit format
  // -------------------------------------------------------------------------
  {
    name: 'commit',
    description: 'Create a git commit with conventional commit message format',
    content: `---
name: commit
description: Create a git commit with conventional commit message format
allowed-tools: Bash, Read, Grep, Glob
---

You are creating a git commit. Follow this workflow:

## 1. Explore Changes
- Run \`git status\` to see all modified, added, and deleted files
- Run \`git diff --staged\` to review staged changes in detail
- If nothing is staged, run \`git diff\` to see unstaged changes
- Read modified files to understand the full context of changes

## 2. Analyze and Categorize
Determine the type of change:
- **feat**: New feature or capability
- **fix**: Bug fix
- **docs**: Documentation only
- **style**: Formatting, whitespace (no code change)
- **refactor**: Code restructuring (no behavior change)
- **perf**: Performance improvement
- **test**: Adding or updating tests
- **chore**: Build process, dependencies, tooling

Identify the scope (component, module, or area affected).

## 3. Write Commit Message
Follow conventional commits format:

\`\`\`
type(scope): concise description in imperative mood

[optional body]
- Explain WHAT changed and WHY (not how)
- Wrap at 72 characters
- Use bullet points for multiple changes

[optional footer]
BREAKING CHANGE: description (if applicable)
Fixes #issue-number (if applicable)
\`\`\`

## 4. Execute
- Stage files if needed: \`git add <files>\` or \`git add -p\` for partial staging
- Commit: \`git commit -m "message"\`
- Verify with \`git log -1\` to confirm

## Rules
- First line max 72 characters
- Use present tense imperative ("Add" not "Added" or "Adds")
- No period at end of subject line
- Separate subject from body with blank line`,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
  },

  // -------------------------------------------------------------------------
  // /pr - Create a pull request with proper description
  // -------------------------------------------------------------------------
  {
    name: 'pr',
    description: 'Create a pull request with comprehensive description',
    content: `---
name: pr
description: Create a pull request with comprehensive description
allowed-tools: Bash, Read, Grep, Glob
---

You are creating a pull request. Follow this workflow:

## 1. Explore Current State
- Run \`git status\` to check working tree state
- Run \`git log main..HEAD --oneline\` to see commits to be included
- Run \`git diff main...HEAD\` to see all changes vs main branch
- Identify the base branch (usually main or develop)

## 2. Analyze Changes
Review all commits and changes to understand:
- What feature/fix is being delivered
- What files are affected
- What tests were added or modified
- Any breaking changes or migration needs
- Dependencies added or updated

## 3. Create PR Description
Structure your PR with these sections:

\`\`\`markdown
## Summary
Brief description of what this PR does and why.

## Changes
- Bullet point list of specific changes
- Group by feature area if many changes

## Testing
- How was this tested?
- Steps to verify the changes work
- Any edge cases considered

## Screenshots (if UI changes)
Before/after if applicable.

## Checklist
- [ ] Tests pass locally
- [ ] Code follows project style
- [ ] Documentation updated (if needed)
- [ ] No console.log or debug code left
\`\`\`

## 4. Execute
- Push branch if not already pushed: \`git push -u origin <branch>\`
- Create PR: \`gh pr create --title "type: description" --body "..."\`
- Or open in browser: \`gh pr create --web\`

## Rules
- PR title follows conventional commit format
- Link related issues with "Fixes #123" or "Relates to #123"
- Request appropriate reviewers
- Add relevant labels`,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
  },

  // -------------------------------------------------------------------------
  // /review - Code review workflow
  // -------------------------------------------------------------------------
  {
    name: 'review',
    description: 'Perform a thorough code review with actionable feedback',
    content: `---
name: review
description: Perform a thorough code review with actionable feedback
allowed-tools: Bash, Read, Grep, Glob
---

You are performing a code review. Follow this systematic workflow:

## 1. Explore the Changes
- Identify what is being reviewed (PR, branch, specific files)
- Run \`git diff\` or \`gh pr diff\` to see all changes
- Read the PR description or commit messages for context
- Understand the purpose and scope of changes

## 2. Review Checklist

### Correctness
- Does the code do what it claims to do?
- Are edge cases handled?
- Are there off-by-one errors, null checks, bounds checks?
- Is error handling complete and appropriate?

### Security
- Input validation present?
- SQL injection, XSS, CSRF risks?
- Secrets or credentials exposed?
- Auth/authz properly implemented?

### Performance
- N+1 queries or unnecessary loops?
- Large data structures handled efficiently?
- Caching opportunities missed?
- Memory leaks possible?

### Maintainability
- Code is readable and self-documenting?
- Follows project patterns and conventions?
- DRY - no unnecessary duplication?
- Appropriate abstractions?

### Testing
- New code has tests?
- Tests cover happy path AND edge cases?
- Tests are meaningful (not just coverage)?
- Integration points tested?

## 3. Provide Feedback
Structure feedback clearly:

**Critical (must fix):**
- Security issues
- Bugs that will cause failures
- Data loss risks

**Suggested (should fix):**
- Performance improvements
- Better patterns available
- Missing edge case handling

**Nit (optional):**
- Style preferences
- Minor refactoring ideas

## 4. Summarize
- Overall assessment: Approve, Request Changes, or Comment
- Highlight what was done well
- Prioritize feedback items`,
    allowedTools: ['Bash', 'Read', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
  },

  // -------------------------------------------------------------------------
  // /debug - Systematic debugging workflow
  // -------------------------------------------------------------------------
  {
    name: 'debug',
    description: 'Systematic debugging workflow to find and fix issues',
    content: `---
name: debug
description: Systematic debugging workflow to find and fix issues
---

You are debugging an issue. Follow this systematic workflow:

## 1. Understand the Problem
Before touching any code:
- What is the EXPECTED behavior?
- What is the ACTUAL behavior?
- What are the exact steps to reproduce?
- When did it start happening? What changed?
- Does it happen consistently or intermittently?

## 2. Gather Evidence
Collect all available information:
- Read error messages and stack traces CAREFULLY
- Check application logs for context
- Review recent git commits: \`git log --oneline -20\`
- Check environment differences (dev vs prod)
- Look for related issues or past fixes

## 3. Isolate the Problem
Narrow down the cause:
- Identify the specific file(s) and function(s) involved
- Find the exact line where behavior diverges from expected
- Create minimal reproduction case if possible
- Use binary search on commits if needed: \`git bisect\`

## 4. Form Hypotheses
Based on evidence, list possible causes:
1. Most likely: [specific hypothesis based on error]
2. Possible: [alternative explanation]
3. Less likely: [edge case]

## 5. Test Each Hypothesis
For each hypothesis:
- Add targeted logging or debugging
- Make ONE change at a time
- Verify the change fixes the issue
- Check for regressions

## 6. Implement Fix
- Fix the root cause, not just symptoms
- Add test to prevent regression
- Document the fix in commit message
- Consider if similar bugs exist elsewhere

## 7. Verify
- Reproduction steps no longer show bug
- All existing tests pass
- No new warnings or errors
- Fix works in all relevant environments

## Anti-Patterns to Avoid
- Random changes hoping something works
- Fixing symptoms without understanding cause
- Removing error handling to hide errors
- Adding sleep/delays as "fixes"`,
    allowedTools: null,
    scope: 'user',
    projectPath: null,
  },

  // -------------------------------------------------------------------------
  // /test - Test writing workflow
  // -------------------------------------------------------------------------
  {
    name: 'test',
    description: 'Write comprehensive tests for code',
    content: `---
name: test
description: Write comprehensive tests for code
allowed-tools: Read, Edit, Bash, Grep, Glob
---

You are writing tests. Follow this workflow:

## 1. Explore the Code Under Test
- Read the function/component/module to be tested
- Understand its purpose, inputs, outputs, and side effects
- Identify dependencies that may need mocking
- Find existing tests for patterns: \`find . -name "*.test.*"\`

## 2. Identify Test Cases

### Happy Path
- Normal expected usage
- Valid inputs produce correct outputs
- Success scenarios

### Edge Cases
- Empty inputs (null, undefined, [], "")
- Boundary values (0, -1, MAX_INT)
- Single item vs multiple items
- First and last items

### Error Cases
- Invalid inputs
- Missing required data
- Network/service failures
- Timeout scenarios
- Permission denied

### Integration Points
- API calls behave correctly
- Database operations work
- Event handlers fire properly

## 3. Write Tests
Follow this structure:

\`\`\`typescript
describe('ComponentOrFunction', () => {
  // Setup shared between tests
  beforeEach(() => {
    // Reset state, create mocks
  });

  describe('methodName', () => {
    it('should [expected behavior] when [condition]', () => {
      // Arrange - set up test data
      // Act - call the function
      // Assert - verify the result
    });
  });
});
\`\`\`

## 4. Test Quality Checklist
- [ ] Tests are independent (can run in any order)
- [ ] Tests are deterministic (same result every time)
- [ ] Tests are fast (mock external dependencies)
- [ ] Test names describe the scenario clearly
- [ ] Assertions are specific and meaningful
- [ ] No logic in tests (no if/else/loops)
- [ ] Tests fail for the right reason

## 5. Run and Verify
- Run tests: \`npm test\` or project equivalent
- Check coverage: \`npm test -- --coverage\`
- Ensure new tests actually fail when code is broken

## Anti-Patterns to Avoid
- Testing implementation details instead of behavior
- \`expect(true).toBe(true)\` or meaningless assertions
- Massive test files with no organization
- Flaky tests that sometimes pass
- Tests that depend on other tests`,
    allowedTools: ['Read', 'Edit', 'Bash', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
  },

  // -------------------------------------------------------------------------
  // /refactor - Safe refactoring workflow
  // -------------------------------------------------------------------------
  {
    name: 'refactor',
    description: 'Safely refactor code while preserving behavior',
    content: `---
name: refactor
description: Safely refactor code while preserving behavior
allowed-tools: Read, Edit, Bash, Grep, Glob
---

You are refactoring code. Follow this safety-first workflow:

## 1. Explore and Understand
- Read the code to be refactored thoroughly
- Understand its current behavior and purpose
- Find all usages: \`grep -r "functionName" src/\`
- Check existing test coverage
- Identify what "working correctly" means

## 2. Ensure Safety Net
Before changing anything:
- Run existing tests: \`npm test\`
- If coverage is insufficient, ADD TESTS FIRST
- Document current behavior if unclear
- Create a checkpoint: \`git commit -m "checkpoint before refactor"\`

## 3. Plan the Refactoring
Common refactoring patterns:
- **Extract Function**: Move code block to named function
- **Inline Function**: Replace function call with body
- **Rename**: Improve clarity of names
- **Extract Variable**: Name complex expressions
- **Remove Duplication**: DRY principle
- **Simplify Conditionals**: Reduce nesting, use early returns
- **Replace Magic Numbers**: Use named constants

## 4. Execute Incrementally
- Make ONE small change at a time
- Run tests after EACH change
- Commit working states frequently
- If tests fail, revert and try smaller steps

## 5. Refactoring Sequence
1. Rename for clarity (safe, no behavior change)
2. Extract/inline to improve structure
3. Simplify logic
4. Remove duplication
5. Improve types/interfaces

## 6. Verify
- [ ] ALL tests pass
- [ ] No new warnings or errors
- [ ] Behavior is identical to before
- [ ] Code is measurably better (more readable, less complex)
- [ ] Performance is not degraded

## Anti-Patterns to Avoid
- Changing behavior during refactoring
- Large changes without intermediate commits
- Refactoring without tests
- Over-engineering simple code
- Premature abstraction

## Remember
**Refactoring = changing structure WITHOUT changing behavior**
If you want to change behavior, that's a different task.`,
    allowedTools: ['Read', 'Edit', 'Bash', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
  },

  // -------------------------------------------------------------------------
  // /doc - Documentation generation
  // -------------------------------------------------------------------------
  {
    name: 'doc',
    description: 'Generate or improve documentation for code',
    content: `---
name: doc
description: Generate or improve documentation for code
allowed-tools: Read, Edit, Grep, Glob
---

You are generating documentation. Follow this workflow:

## 1. Explore What Needs Documentation
- Identify the target: function, module, API, or project
- Read the code thoroughly to understand it
- Check existing documentation for patterns
- Identify the audience (developers, users, API consumers)

## 2. Documentation Types

### Code Comments (JSDoc/TSDoc)
\`\`\`typescript
/**
 * Brief description of what it does.
 *
 * Longer description if needed, explaining behavior,
 * important details, or context.
 *
 * @param paramName - Description of parameter
 * @returns Description of return value
 * @throws {ErrorType} When this condition occurs
 * @example
 * const result = myFunction('input');
 * // result: 'expected output'
 */
\`\`\`

### README Structure
\`\`\`markdown
# Project Name

Brief description of what this project does.

## Installation
Step-by-step setup instructions.

## Usage
Basic usage examples with code.

## API Reference
Document public functions/methods.

## Configuration
Environment variables, options, settings.

## Contributing
How to contribute to the project.
\`\`\`

### API Documentation
- Endpoint URL and method
- Request parameters and body
- Response format and codes
- Authentication requirements
- Example requests and responses

## 3. Writing Guidelines
- Start with WHY, then WHAT, then HOW
- Use concrete examples
- Keep it concise but complete
- Use consistent formatting
- Include code examples that actually work
- Document edge cases and limitations

## 4. Generate Documentation
- Add JSDoc comments to public functions
- Update README if project-level changes
- Create or update API docs for endpoints
- Add inline comments for complex logic only

## 5. Verify
- Code examples actually work
- Links are not broken
- Formatting renders correctly
- Documentation matches current code behavior

## Anti-Patterns to Avoid
- Documenting obvious things: \`// increment i\`
- Outdated documentation (worse than none)
- Generated docs with no human review
- Documentation that repeats the code`,
    allowedTools: ['Read', 'Edit', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
  },

  // -------------------------------------------------------------------------
  // /security - Security audit
  // -------------------------------------------------------------------------
  {
    name: 'security',
    description: 'Perform a security audit of the codebase',
    content: `---
name: security
description: Perform a security audit of the codebase
allowed-tools: Read, Grep, Glob, Bash
---

You are performing a security audit. Follow this systematic workflow:

## 1. Explore the Attack Surface
- Identify all entry points: APIs, forms, file uploads, webhooks
- Find authentication and authorization code
- Locate data handling: databases, file system, external APIs
- Check dependency list for known vulnerabilities

## 2. OWASP Top 10 Checklist

### A01: Broken Access Control
- [ ] Authorization checked on every request?
- [ ] IDOR vulnerabilities? (accessing other users' data)
- [ ] Missing function-level access control?
- [ ] CORS properly configured?

### A02: Cryptographic Failures
- [ ] Sensitive data encrypted at rest?
- [ ] TLS for data in transit?
- [ ] Strong password hashing (bcrypt, argon2)?
- [ ] No hardcoded secrets?

### A03: Injection
- [ ] SQL injection: parameterized queries used?
- [ ] Command injection: input sanitized?
- [ ] XSS: output encoded?
- [ ] Template injection: user input not in templates?

### A04: Insecure Design
- [ ] Rate limiting on sensitive endpoints?
- [ ] Account lockout after failed attempts?
- [ ] Proper session management?

### A05: Security Misconfiguration
- [ ] Debug mode disabled in production?
- [ ] Default credentials changed?
- [ ] Security headers present (CSP, HSTS, etc.)?
- [ ] Error messages don't leak info?

### A06: Vulnerable Components
- [ ] Run \`npm audit\` or equivalent
- [ ] Dependencies up to date?
- [ ] No known CVEs in dependencies?

### A07: Auth Failures
- [ ] Strong password requirements?
- [ ] MFA available?
- [ ] Secure session handling?
- [ ] Proper logout functionality?

### A08: Data Integrity Failures
- [ ] Updates verified (signatures)?
- [ ] CI/CD pipeline secure?
- [ ] Deserialization safe?

### A09: Logging Failures
- [ ] Security events logged?
- [ ] Logs don't contain sensitive data?
- [ ] Tamper-evident logging?

### A10: SSRF
- [ ] URL validation for external requests?
- [ ] Allowlist for external services?

## 3. Check for Secrets
- Search for hardcoded credentials
- Check .env files not committed
- Verify .gitignore covers secrets
- Look for API keys in code

## 4. Report Findings
For each issue:
- Severity: Critical / High / Medium / Low
- Location: File and line number
- Description: What the vulnerability is
- Impact: What an attacker could do
- Remediation: How to fix it

## 5. Prioritize Remediation
1. Critical: Fix immediately
2. High: Fix this sprint
3. Medium: Plan for fixing
4. Low: Backlog`,
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    scope: 'user',
    projectPath: null,
  },

  // -------------------------------------------------------------------------
  // /perf - Performance analysis
  // -------------------------------------------------------------------------
  {
    name: 'perf',
    description: 'Analyze and improve application performance',
    content: `---
name: perf
description: Analyze and improve application performance
allowed-tools: Read, Grep, Glob, Bash
---

You are analyzing performance. Follow this systematic workflow:

## 1. Identify Performance Goals
Before optimizing, define:
- What metric matters? (load time, response time, throughput)
- What is the current value?
- What is the target value?
- Where are users experiencing slowness?

## 2. Measure Current Performance
- Profile before optimizing (never guess)
- Use appropriate tools:
  - Browser DevTools for frontend
  - \`console.time()\` for quick measurements
  - Profilers for CPU/memory analysis
  - APM tools for production metrics

## 3. Identify Bottlenecks

### Frontend Performance
- [ ] Bundle size: \`npm run build\` and check output
- [ ] Unused code: Can we tree-shake more?
- [ ] Images: Optimized and lazy-loaded?
- [ ] Fonts: Subset and preloaded?
- [ ] JavaScript: Blocking render?
- [ ] CSS: Critical CSS inlined?
- [ ] Caching: Static assets cached?

### Backend Performance
- [ ] N+1 queries: Use eager loading
- [ ] Missing indexes: Check query plans
- [ ] Slow queries: Optimize or cache
- [ ] Connection pooling: Configured?
- [ ] Memory leaks: Monitor over time
- [ ] CPU-bound work: Can it be async?

### API Performance
- [ ] Response payload size
- [ ] Unnecessary data fetched
- [ ] Pagination implemented
- [ ] Compression enabled (gzip/brotli)
- [ ] Caching headers set

## 4. Optimize Strategically
Priority order:
1. Remove unnecessary work entirely
2. Cache repeated expensive operations
3. Parallelize independent operations
4. Optimize algorithms (O(n) vs O(n^2))
5. Micro-optimizations (last resort)

## 5. Common Fixes

### Database
\`\`\`sql
-- Add index for slow queries
CREATE INDEX idx_users_email ON users(email);

-- Use EXPLAIN to understand query
EXPLAIN ANALYZE SELECT * FROM users WHERE email = '...';
\`\`\`

### Frontend
\`\`\`typescript
// Lazy load heavy components
const HeavyComponent = lazy(() => import('./HeavyComponent'));

// Memoize expensive computations
const result = useMemo(() => expensiveCalc(data), [data]);

// Debounce rapid events
const debouncedSearch = useDebouncedCallback(search, 300);
\`\`\`

## 6. Verify Improvements
- Measure again with same methodology
- Compare against baseline
- Ensure no regression in functionality
- Monitor in production

## Anti-Patterns to Avoid
- Premature optimization
- Optimizing without measuring
- Micro-optimizations that hurt readability
- Caching without invalidation strategy`,
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    scope: 'user',
    projectPath: null,
  },

  // -------------------------------------------------------------------------
  // /migrate - Database migration assistance
  // -------------------------------------------------------------------------
  {
    name: 'migrate',
    description: 'Create and manage database migrations safely',
    content: `---
name: migrate
description: Create and manage database migrations safely
allowed-tools: Read, Edit, Bash, Grep, Glob
---

You are managing database migrations. Follow this workflow:

## 1. Understand the Change
- What schema change is needed?
- Why is this change necessary?
- What data currently exists?
- What is the rollback plan?

## 2. Analyze Impact
Before writing migration:
- How much data will be affected?
- Will this lock tables? For how long?
- Are there dependent applications?
- Can this be done with zero downtime?

## 3. Migration Safety Checklist

### Schema Changes
- [ ] Adding column: Use default value or nullable
- [ ] Removing column: Ensure no code references it
- [ ] Renaming column: Deploy code change first (dual-write)
- [ ] Changing type: Data loss possible?
- [ ] Adding NOT NULL: Existing nulls handled?
- [ ] Adding index: Will lock table? Consider CONCURRENTLY

### Data Changes
- [ ] Backfill needed for new columns?
- [ ] Large table? Batch the updates
- [ ] Preserving audit trail?

## 4. Write Migration

### Migration File Structure
\`\`\`typescript
// migrations/YYYYMMDD_HHMMSS_description.ts
export async function up(db) {
  // Forward migration
  await db.schema.alterTable('users', (table) => {
    table.string('phone').nullable();
  });
}

export async function down(db) {
  // Rollback migration (REQUIRED)
  await db.schema.alterTable('users', (table) => {
    table.dropColumn('phone');
  });
}
\`\`\`

### Best Practices
- Make migrations idempotent when possible
- Always include down migration
- Use transactions for atomic changes
- Separate schema and data migrations
- Name files descriptively

## 5. Test Migration
- Run on local database first
- Run on staging with production-like data
- Time the migration on large datasets
- Test the rollback

## 6. Execute Migration

### Development
\`\`\`bash
npm run migrate:up    # Run pending migrations
npm run migrate:down  # Rollback last migration
npm run migrate:status # Check migration status
\`\`\`

### Production Deployment
1. Take database backup
2. Notify stakeholders of maintenance window
3. Run migration
4. Verify application works
5. Monitor for issues
6. Keep rollback ready

## 7. Zero-Downtime Patterns

### Adding Column
1. Add nullable column (migration)
2. Deploy code that writes to both columns
3. Backfill data (migration)
4. Deploy code that reads from new column
5. Remove old column (future migration)

### Renaming Column
1. Add new column (migration)
2. Deploy dual-write code
3. Backfill new column
4. Deploy read from new column
5. Drop old column (future migration)`,
    allowedTools: ['Read', 'Edit', 'Bash', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
  },

  // -------------------------------------------------------------------------
  // /deploy - Deployment checklist
  // -------------------------------------------------------------------------
  {
    name: 'deploy',
    description: 'Pre-deployment checklist and verification',
    content: `---
name: deploy
description: Pre-deployment checklist and verification
allowed-tools: Read, Bash, Grep, Glob
---

You are preparing for deployment. Follow this systematic checklist:

## 1. Pre-Deployment Verification

### Code Quality
- [ ] All tests pass: \`npm test\`
- [ ] No linting errors: \`npm run lint\`
- [ ] Type checking passes: \`npm run typecheck\`
- [ ] Build succeeds: \`npm run build\`
- [ ] No console.log or debug code

### Version Control
- [ ] All changes committed
- [ ] Branch is up to date with main
- [ ] PR approved and merged (if applicable)
- [ ] Version bumped appropriately (semver)
- [ ] CHANGELOG updated

### Configuration
- [ ] Environment variables documented
- [ ] Production config reviewed
- [ ] Secrets rotated if needed
- [ ] Feature flags set correctly

### Database
- [ ] Migrations tested
- [ ] Migration can be rolled back
- [ ] Backup scheduled/completed
- [ ] No breaking schema changes (or coordinated)

### Dependencies
- [ ] \`npm audit\` shows no critical issues
- [ ] Lock file committed
- [ ] No unexpected dependency changes

## 2. Deployment Plan

### Document the deployment:
\`\`\`markdown
## Deployment: [Feature/Fix Name]
Date: [YYYY-MM-DD]
Deployer: [Name]

### Changes
- [List of changes being deployed]

### Risk Assessment
- Risk Level: Low/Medium/High
- Affected Systems: [List]
- Rollback Time: [Estimate]

### Pre-deploy Steps
1. [ ] Notify team in #deployments
2. [ ] Check monitoring dashboards
3. [ ] Verify staging deployment

### Deploy Steps
1. [ ] Run deployment command
2. [ ] Monitor logs during deploy
3. [ ] Verify health checks pass

### Post-deploy Steps
1. [ ] Smoke test critical paths
2. [ ] Check error rates
3. [ ] Monitor for 15 minutes
4. [ ] Notify team of completion
\`\`\`

## 3. Deployment Commands
\`\`\`bash
# Common deployment patterns
git tag -a v1.2.3 -m "Release v1.2.3"
git push origin v1.2.3

# Or direct deployment
npm run deploy:production

# Verify deployment
curl https://api.example.com/health
\`\`\`

## 4. Post-Deployment Monitoring
- Watch error tracking (Sentry, etc.)
- Monitor response times
- Check resource usage (CPU, memory)
- Verify logs show expected behavior
- Test critical user flows

## 5. Rollback Plan
If issues detected:
1. Don't panic
2. Assess severity (can users still use the app?)
3. Decide: hotfix forward or rollback
4. Execute rollback: \`npm run deploy:rollback\` or revert commit
5. Communicate to stakeholders
6. Post-mortem after stabilization

## 6. Communication
- Notify before deployment
- Update status page if user-facing issues
- Notify after successful deployment
- Document any issues encountered`,
    allowedTools: ['Read', 'Bash', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
  },

  // -------------------------------------------------------------------------
  // /cleanup - Code cleanup and dead code removal
  // -------------------------------------------------------------------------
  {
    name: 'cleanup',
    description: 'Find and remove dead code, unused dependencies, and cruft',
    content: `---
name: cleanup
description: Find and remove dead code, unused dependencies, and cruft
allowed-tools: Read, Edit, Bash, Grep, Glob
---

You are cleaning up the codebase. Follow this systematic workflow:

## 1. Identify Cleanup Targets

### Dead Code
- Unused functions and methods
- Unreachable code paths
- Commented-out code blocks
- Unused variables and imports
- Deprecated code marked for removal

### Unused Dependencies
- Packages in package.json not imported anywhere
- Dev dependencies used in production (or vice versa)
- Duplicate packages with different versions

### Cruft
- TODO comments older than 6 months
- Console.log statements
- Debug code left in
- Temporary files
- Empty files or near-empty modules

## 2. Detection Commands

### Find Unused Exports
\`\`\`bash
# Use TypeScript compiler
npx ts-prune

# Or search for potentially unused exports
grep -r "export " src/ | grep -v ".test." | grep -v ".spec."
\`\`\`

### Find Unused Dependencies
\`\`\`bash
npx depcheck
\`\`\`

### Find TODO/FIXME Comments
\`\`\`bash
grep -rn "TODO\\|FIXME\\|HACK\\|XXX" src/
\`\`\`

### Find Console Statements
\`\`\`bash
grep -rn "console\\.log\\|console\\.debug" src/
\`\`\`

### Find Commented Code
Look for blocks of commented code (not documentation comments).

## 3. Safe Removal Process

### Before Removing Anything
1. Verify it's actually unused (search entire codebase)
2. Check for dynamic usage (string-based imports, reflection)
3. Check if it's part of public API
4. Run tests to confirm nothing breaks

### Removal Order (safest first)
1. Console.log and debug statements
2. Commented-out code
3. Unused imports (auto-fix with ESLint)
4. Unused local variables
5. Unused private functions
6. Unused exported functions (verify no external usage)
7. Unused dependencies

## 4. Cleanup Checklist

### Per-file cleanup
- [ ] Remove unused imports
- [ ] Remove unused variables
- [ ] Remove console statements
- [ ] Remove commented-out code
- [ ] Fix or remove stale TODOs

### Project-wide cleanup
- [ ] Remove unused dependencies: \`npm uninstall <pkg>\`
- [ ] Remove unused files (check git history first)
- [ ] Clean up package.json scripts
- [ ] Remove unused configuration files
- [ ] Update .gitignore for new patterns

## 5. Automated Fixes
\`\`\`bash
# Fix unused imports automatically
npx eslint --fix "src/**/*.{ts,tsx}"

# Remove unused dependencies
npx depcheck
npm uninstall <unused-package>

# Sort imports
npx prettier --write "src/**/*.{ts,tsx}"
\`\`\`

## 6. Verify
- [ ] All tests pass
- [ ] Application builds successfully
- [ ] No new TypeScript errors
- [ ] Application runs correctly
- [ ] Bundle size reduced (measure before/after)

## 7. Commit Strategy
- Separate commits for different types of cleanup
- Descriptive commit messages
- Keep refactoring separate from bug fixes

Example commits:
- \`chore: remove unused dependencies\`
- \`chore: remove console.log statements\`
- \`chore: remove dead code in utils module\`

## Anti-Patterns to Avoid
- Removing code that's actually used dynamically
- Cleaning up and adding features in same PR
- Not verifying removal with tests
- Removing public API without deprecation period`,
    allowedTools: ['Read', 'Edit', 'Bash', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
  },
];
