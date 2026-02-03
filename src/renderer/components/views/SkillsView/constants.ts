// ============================================================================
// AGENT SKILLS VIEW - CONSTANTS AND BUILT-IN SKILLS
// ============================================================================
//
// These are agent-callable skills designed for programmatic invocation
// via the Skill tool. Each skill has proper SKILL.md frontmatter format.
// ============================================================================

import type { BuiltInAgentSkill } from './types';

export const BUILT_IN_AGENT_SKILLS: BuiltInAgentSkill[] = [
  // -------------------------------------------------------------------------
  // code-review - Thorough code review with security, performance, best practices
  // -------------------------------------------------------------------------
  {
    name: 'code-review',
    description:
      'Performs thorough code review with security, performance, and best practices analysis',
    content: `---
name: code-review
description: Performs thorough code review with security, performance, and best practices analysis
allowed-tools: Read, Grep, Glob, Bash
---

# Code Review Skill

You are performing a comprehensive code review. This skill is invoked programmatically by agents to analyze code quality.

## Review Dimensions

### 1. Correctness
- Verify logic matches intent
- Check edge cases and boundary conditions
- Validate error handling completeness
- Confirm null/undefined safety

### 2. Security Analysis
- Input validation and sanitization
- Authentication and authorization checks
- Injection vulnerabilities (SQL, XSS, command)
- Secrets and credential exposure
- CORS and CSP configuration

### 3. Performance Assessment
- Algorithm complexity (Big O)
- Database query efficiency (N+1, missing indexes)
- Memory management and leaks
- Unnecessary re-renders (React)
- Bundle size impact

### 4. Best Practices
- SOLID principles adherence
- DRY - no unnecessary duplication
- Appropriate abstraction levels
- Clear naming conventions
- Consistent code style

### 5. Maintainability
- Code readability
- Documentation quality
- Test coverage adequacy
- Modular architecture

## Output Format

Provide findings in structured format:

**Critical Issues** (must fix):
- [Issue with file:line and remediation]

**Recommendations** (should fix):
- [Improvement with rationale]

**Notes** (optional improvements):
- [Minor suggestions]

**Summary**:
- Overall quality assessment
- Key strengths identified
- Priority action items`,
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },

  // -------------------------------------------------------------------------
  // test-generation - Generate comprehensive test suites
  // -------------------------------------------------------------------------
  {
    name: 'test-generation',
    description: 'Generates comprehensive test suites for code with edge cases and mocks',
    content: `---
name: test-generation
description: Generates comprehensive test suites for code with edge cases and mocks
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Test Generation Skill

You are generating comprehensive tests for code. This skill creates test suites following project conventions.

## Test Generation Process

### 1. Analyze Target Code
- Read the function/component/module thoroughly
- Identify inputs, outputs, and side effects
- Map all code paths and branches
- Note dependencies requiring mocks

### 2. Discover Testing Patterns
- Find existing tests: \`**/*.test.{ts,tsx,js,jsx}\` or \`**/*.spec.*\`
- Match project test framework (Jest, Vitest, Mocha, etc.)
- Follow established assertion patterns
- Use project's mocking conventions

### 3. Test Case Categories

**Happy Path Tests**:
- Normal expected usage
- Valid inputs produce correct outputs
- Success scenarios with typical data

**Edge Case Tests**:
- Empty inputs (null, undefined, [], "")
- Boundary values (0, -1, MAX_VALUE)
- Single item vs multiple items
- First and last element handling

**Error Case Tests**:
- Invalid input types
- Missing required parameters
- Network/API failures
- Timeout scenarios
- Permission denied cases

**Integration Tests**:
- Component interactions
- API call verification
- State management flows
- Event handler chains

### 4. Test Structure

\`\`\`typescript
describe('ModuleName', () => {
  beforeEach(() => {
    // Setup: reset state, create mocks
  });

  afterEach(() => {
    // Cleanup: restore mocks, clear timers
  });

  describe('functionName', () => {
    it('should [expected behavior] when [condition]', () => {
      // Arrange
      const input = createTestInput();

      // Act
      const result = functionName(input);

      // Assert
      expect(result).toMatchExpected();
    });
  });
});
\`\`\`

### 5. Quality Requirements
- Tests are independent (run in any order)
- Tests are deterministic (same result every time)
- Tests are fast (mock external dependencies)
- Test names describe scenarios clearly
- Assertions are specific and meaningful
- No logic in tests (no if/else/loops)`,
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },

  // -------------------------------------------------------------------------
  // documentation - Generate or improve code documentation
  // -------------------------------------------------------------------------
  {
    name: 'documentation',
    description: 'Generates or improves code documentation including JSDoc, README, and API docs',
    content: `---
name: documentation
description: Generates or improves code documentation including JSDoc, README, and API docs
allowed-tools: Read, Edit, Write, Grep, Glob
---

# Documentation Generation Skill

You are generating or improving documentation. This skill creates clear, comprehensive documentation.

## Documentation Types

### 1. Code Comments (JSDoc/TSDoc)

\`\`\`typescript
/**
 * Brief description of what the function does.
 *
 * Detailed explanation of behavior, important edge cases,
 * and any non-obvious implementation details.
 *
 * @param paramName - Description of the parameter
 * @param options - Configuration options
 * @param options.timeout - Request timeout in milliseconds
 * @returns Description of return value
 * @throws {ValidationError} When input fails validation
 * @example
 * const result = await processData({ id: 123 });
 * // Returns: { status: 'success', data: {...} }
 */
\`\`\`

### 2. Module Documentation

\`\`\`typescript
/**
 * @module ModuleName
 * @description
 * High-level description of module purpose and responsibilities.
 *
 * ## Usage
 * Import and use the module:
 * \`\`\`ts
 * import { feature } from './module';
 * feature.doSomething();
 * \`\`\`
 *
 * ## Architecture
 * Explain how this module fits into the larger system.
 */
\`\`\`

### 3. README Structure

\`\`\`markdown
# Project Name

Brief description of what this project does.

## Installation
Step-by-step setup instructions.

## Quick Start
Minimal example to get running.

## API Reference
Document public functions and methods.

## Configuration
Environment variables and options.

## Examples
Real-world usage examples.

## Contributing
How to contribute to the project.

## License
License information.
\`\`\`

### 4. API Documentation
- Endpoint URL and HTTP method
- Request parameters (path, query, body)
- Request/response schemas
- Authentication requirements
- Example requests with curl
- Response codes and meanings

## Documentation Guidelines

1. **Start with WHY** - Explain purpose before details
2. **Use examples** - Concrete examples beat abstract descriptions
3. **Keep it current** - Documentation must match code
4. **Be concise** - No unnecessary verbosity
5. **Document edge cases** - Note limitations and gotchas`,
    allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },

  // -------------------------------------------------------------------------
  // refactoring - Safely refactor code while preserving behavior
  // -------------------------------------------------------------------------
  {
    name: 'refactoring',
    description: 'Safely refactors code while preserving behavior using incremental changes',
    content: `---
name: refactoring
description: Safely refactors code while preserving behavior using incremental changes
allowed-tools: Read, Edit, Bash, Grep, Glob
---

# Refactoring Skill

You are refactoring code safely. This skill changes code structure WITHOUT changing behavior.

## Refactoring Principles

**Golden Rule**: Refactoring = changing structure WITHOUT changing behavior.
If you want to change behavior, that's a different task.

## Refactoring Process

### 1. Establish Safety Net
Before any changes:
- Run existing tests: \`npm test\`
- If coverage insufficient, ADD TESTS FIRST
- Create checkpoint: \`git stash\` or commit
- Document current behavior

### 2. Identify Refactoring Target
Common refactoring patterns:
- **Extract Function**: Move code block to named function
- **Inline Function**: Replace function call with its body
- **Rename**: Improve clarity of names
- **Extract Variable**: Name complex expressions
- **Remove Duplication**: Apply DRY principle
- **Simplify Conditionals**: Reduce nesting, use early returns
- **Replace Magic Numbers**: Use named constants
- **Extract Class/Module**: Split large files
- **Compose Method**: Break long functions into steps

### 3. Execute Incrementally
1. Make ONE small change at a time
2. Run tests after EACH change
3. Commit working states frequently
4. If tests fail, revert and try smaller steps

### 4. Refactoring Sequence (safest order)
1. Rename for clarity (no behavior change)
2. Extract/inline for structure
3. Simplify logic patterns
4. Remove duplication
5. Improve types/interfaces

## Verification Checklist

- [ ] ALL tests pass
- [ ] No new warnings or errors
- [ ] Behavior is IDENTICAL to before
- [ ] Code is measurably better (more readable, less complex)
- [ ] Performance is not degraded
- [ ] No functionality removed accidentally

## Anti-Patterns to Avoid

- Changing behavior during refactoring
- Large changes without intermediate commits
- Refactoring without test coverage
- Over-engineering simple code
- Premature abstraction`,
    allowedTools: ['Read', 'Edit', 'Bash', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },

  // -------------------------------------------------------------------------
  // bug-diagnosis - Systematic bug diagnosis and fix proposals
  // -------------------------------------------------------------------------
  {
    name: 'bug-diagnosis',
    description: 'Systematically diagnoses bugs and proposes targeted fixes',
    content: `---
name: bug-diagnosis
description: Systematically diagnoses bugs and proposes targeted fixes
allowed-tools: Read, Grep, Glob, Bash
---

# Bug Diagnosis Skill

You are diagnosing a bug systematically. This skill follows scientific debugging methodology.

## Diagnostic Process

### 1. Understand the Problem
Before touching code:
- What is the EXPECTED behavior?
- What is the ACTUAL behavior?
- What are exact steps to reproduce?
- When did it start? What changed?
- Consistent or intermittent?

### 2. Gather Evidence
Collect all available information:
- Read error messages and stack traces CAREFULLY
- Check application logs for context
- Review recent changes: \`git log --oneline -20\`
- Compare environments (dev vs prod)
- Search for related issues or past fixes

### 3. Isolate the Problem
Narrow down systematically:
- Identify specific file(s) and function(s)
- Find exact line where behavior diverges
- Create minimal reproduction if possible
- Use git bisect for regression: \`git bisect start\`

### 4. Form Hypotheses
Based on evidence, rank possible causes:
1. **Most Likely**: [specific hypothesis from error]
2. **Possible**: [alternative explanation]
3. **Less Likely**: [edge case scenario]

### 5. Test Hypotheses
For each hypothesis:
- Add targeted logging or assertions
- Make ONE change at a time
- Verify the change addresses root cause
- Check for regressions

### 6. Propose Fix
- Address ROOT CAUSE, not symptoms
- Include test to prevent regression
- Document the fix rationale
- Check if similar bugs exist elsewhere

## Diagnosis Output Format

\`\`\`markdown
## Bug Analysis

**Symptom**: [What user observes]

**Root Cause**: [Actual underlying issue]

**Evidence**: [How we determined the cause]

**Proposed Fix**: [Specific code changes]

**Regression Test**: [Test to add]

**Related Areas**: [Other code that might have same issue]
\`\`\`

## Anti-Patterns to Avoid

- Random changes hoping something works
- Fixing symptoms without understanding cause
- Removing error handling to hide errors
- Adding sleep/delays as "fixes"
- Ignoring the actual error message`,
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },

  // -------------------------------------------------------------------------
  // performance-analysis - Analyze code for performance issues
  // -------------------------------------------------------------------------
  {
    name: 'performance-analysis',
    description: 'Analyzes code for performance bottlenecks and optimization opportunities',
    content: `---
name: performance-analysis
description: Analyzes code for performance bottlenecks and optimization opportunities
allowed-tools: Read, Grep, Glob, Bash
---

# Performance Analysis Skill

You are analyzing code for performance issues. This skill identifies bottlenecks and optimization opportunities.

## Analysis Dimensions

### 1. Algorithm Complexity
- Identify Big O complexity of key operations
- Flag O(n^2) or worse in hot paths
- Check for unnecessary iterations
- Verify efficient data structure usage

### 2. Database Performance
- N+1 query detection
- Missing index opportunities
- Over-fetching data
- Unoptimized JOIN operations
- Connection pool configuration

### 3. Frontend Performance
- Bundle size analysis
- Unnecessary re-renders
- Missing memoization
- Image optimization
- Code splitting opportunities
- Critical CSS inlining

### 4. Memory Management
- Memory leak patterns
- Large object retention
- Closure scope issues
- Cache without bounds
- Event listener cleanup

### 5. Network Efficiency
- Payload size optimization
- Caching strategy
- Request batching opportunities
- Compression (gzip/brotli)
- HTTP/2 utilization

## Analysis Commands

\`\`\`bash
# Bundle analysis
npm run build && npm run analyze

# Database query analysis
EXPLAIN ANALYZE SELECT ...

# Memory profiling
node --inspect app.js

# Lighthouse audit
npx lighthouse <url>
\`\`\`

## Optimization Priority

1. **Remove unnecessary work entirely**
2. **Cache repeated expensive operations**
3. **Parallelize independent operations**
4. **Optimize algorithm complexity**
5. **Micro-optimizations (last resort)**

## Output Format

\`\`\`markdown
## Performance Analysis Report

### Critical Issues
- [Issue with measured impact]

### Optimization Opportunities
- [Opportunity with expected improvement]

### Measurements
- Current: [baseline metrics]
- Target: [goal metrics]
- Method: [how to measure]

### Recommended Actions
1. [Prioritized action items]
\`\`\``,
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },

  // -------------------------------------------------------------------------
  // security-audit - Audit code for security vulnerabilities
  // -------------------------------------------------------------------------
  {
    name: 'security-audit',
    description: 'Audits code for security vulnerabilities following OWASP guidelines',
    content: `---
name: security-audit
description: Audits code for security vulnerabilities following OWASP guidelines
allowed-tools: Read, Grep, Glob, Bash
---

# Security Audit Skill

You are performing a security audit. This skill checks code against OWASP Top 10 and security best practices.

## OWASP Top 10 Checklist

### A01: Broken Access Control
- [ ] Authorization checked on every request
- [ ] No IDOR vulnerabilities (accessing others' data)
- [ ] Function-level access control present
- [ ] CORS properly configured

### A02: Cryptographic Failures
- [ ] Sensitive data encrypted at rest
- [ ] TLS for data in transit
- [ ] Strong password hashing (bcrypt, argon2)
- [ ] No hardcoded secrets

### A03: Injection
- [ ] SQL: Parameterized queries only
- [ ] Command: Shell input sanitized
- [ ] XSS: Output properly encoded
- [ ] Template: No user input in templates

### A04: Insecure Design
- [ ] Rate limiting on sensitive endpoints
- [ ] Account lockout after failures
- [ ] Proper session management
- [ ] Threat modeling completed

### A05: Security Misconfiguration
- [ ] Debug disabled in production
- [ ] Default credentials changed
- [ ] Security headers present (CSP, HSTS)
- [ ] Error messages don't leak info

### A06: Vulnerable Components
- [ ] \`npm audit\` clean
- [ ] Dependencies up to date
- [ ] No known CVEs

### A07: Auth Failures
- [ ] Strong password requirements
- [ ] MFA available
- [ ] Secure session handling
- [ ] Proper logout

### A08: Data Integrity Failures
- [ ] Update signatures verified
- [ ] CI/CD pipeline secure
- [ ] Safe deserialization

### A09: Logging Failures
- [ ] Security events logged
- [ ] Logs sanitized (no secrets)
- [ ] Tamper-evident logging

### A10: SSRF
- [ ] URL validation for external requests
- [ ] Allowlist for external services

## Secret Detection

Search for:
- Hardcoded API keys
- Passwords in code
- Private keys
- Connection strings
- JWT secrets

## Output Format

\`\`\`markdown
## Security Audit Report

### Critical Vulnerabilities
- [Severity: Critical] [Location] [Description] [Remediation]

### High Risk Issues
- [Severity: High] [Details]

### Medium Risk Issues
- [Severity: Medium] [Details]

### Recommendations
- [Prioritized security improvements]
\`\`\``,
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },

  // -------------------------------------------------------------------------
  // api-design - Design REST/GraphQL APIs following best practices
  // -------------------------------------------------------------------------
  {
    name: 'api-design',
    description: 'Designs REST and GraphQL APIs following industry best practices',
    content: `---
name: api-design
description: Designs REST and GraphQL APIs following industry best practices
allowed-tools: Read, Edit, Write, Grep, Glob
---

# API Design Skill

You are designing APIs. This skill creates well-structured, consistent, and developer-friendly APIs.

## REST API Design Principles

### 1. Resource Naming
- Use nouns, not verbs: \`/users\` not \`/getUsers\`
- Plural for collections: \`/users\`, \`/orders\`
- Hierarchical: \`/users/{id}/orders\`
- Lowercase with hyphens: \`/user-profiles\`

### 2. HTTP Methods
- GET: Retrieve (idempotent)
- POST: Create
- PUT: Full update (idempotent)
- PATCH: Partial update
- DELETE: Remove (idempotent)

### 3. Response Structure

\`\`\`json
{
  "data": { ... },
  "meta": {
    "page": 1,
    "total": 100,
    "limit": 20
  },
  "links": {
    "self": "/users?page=1",
    "next": "/users?page=2"
  }
}
\`\`\`

### 4. Error Response

\`\`\`json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input",
    "details": [
      {
        "field": "email",
        "message": "Invalid email format"
      }
    ]
  }
}
\`\`\`

### 5. Status Codes
- 200: Success
- 201: Created
- 204: No Content (DELETE)
- 400: Bad Request
- 401: Unauthorized
- 403: Forbidden
- 404: Not Found
- 409: Conflict
- 422: Unprocessable Entity
- 500: Internal Server Error

## GraphQL Design Principles

### 1. Schema Design
- Clear type definitions
- Meaningful field names
- Proper nullability
- Input types for mutations

### 2. Query Structure
\`\`\`graphql
type Query {
  user(id: ID!): User
  users(filter: UserFilter, pagination: Pagination): UserConnection!
}

type Mutation {
  createUser(input: CreateUserInput!): CreateUserPayload!
}
\`\`\`

### 3. Pagination
- Use Relay-style connections
- Include pageInfo with hasNextPage

## API Documentation

Include for each endpoint:
- URL and method
- Authentication required
- Request parameters
- Request/response examples
- Error scenarios`,
    allowedTools: ['Read', 'Edit', 'Write', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },

  // -------------------------------------------------------------------------
  // database-optimization - Optimize database queries and schemas
  // -------------------------------------------------------------------------
  {
    name: 'database-optimization',
    description: 'Optimizes database queries, indexes, and schema design',
    content: `---
name: database-optimization
description: Optimizes database queries, indexes, and schema design
allowed-tools: Read, Edit, Bash, Grep, Glob
---

# Database Optimization Skill

You are optimizing database performance. This skill analyzes and improves queries, indexes, and schema.

## Query Optimization

### 1. Analyze Query Plans
\`\`\`sql
-- PostgreSQL
EXPLAIN ANALYZE SELECT ...;

-- MySQL
EXPLAIN SELECT ...;
\`\`\`

Look for:
- Seq Scan on large tables (needs index)
- High cost estimates
- Nested loops on large datasets
- Sort operations (consider ORDER BY index)

### 2. Common Issues

**N+1 Queries**:
\`\`\`typescript
// BAD: N+1 queries
const users = await User.findAll();
for (const user of users) {
  user.orders = await Order.findByUserId(user.id); // N queries
}

// GOOD: Single query with JOIN or include
const users = await User.findAll({
  include: [{ model: Order }]
});
\`\`\`

**Over-fetching**:
\`\`\`sql
-- BAD: Select everything
SELECT * FROM users;

-- GOOD: Select only needed columns
SELECT id, name, email FROM users;
\`\`\`

### 3. Index Strategies

\`\`\`sql
-- Single column index
CREATE INDEX idx_users_email ON users(email);

-- Composite index (order matters)
CREATE INDEX idx_orders_user_date ON orders(user_id, created_at);

-- Partial index
CREATE INDEX idx_active_users ON users(email) WHERE active = true;

-- Covering index
CREATE INDEX idx_users_covering ON users(email) INCLUDE (name, avatar);
\`\`\`

### 4. Schema Optimization
- Normalize to reduce redundancy
- Denormalize read-heavy tables strategically
- Use appropriate data types
- Add constraints for data integrity

### 5. Connection Management
- Configure connection pool size
- Set appropriate timeouts
- Use read replicas for queries
- Implement query caching

## Performance Metrics to Track
- Query execution time
- Rows examined vs returned
- Index usage ratio
- Connection pool utilization
- Lock wait times`,
    allowedTools: ['Read', 'Edit', 'Bash', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },

  // -------------------------------------------------------------------------
  // dependency-update - Safely update project dependencies
  // -------------------------------------------------------------------------
  {
    name: 'dependency-update',
    description: 'Safely updates project dependencies with compatibility checks',
    content: `---
name: dependency-update
description: Safely updates project dependencies with compatibility checks
allowed-tools: Read, Edit, Bash, Grep, Glob
---

# Dependency Update Skill

You are updating project dependencies safely. This skill ensures updates don't break the project.

## Update Process

### 1. Audit Current State
\`\`\`bash
# Check for outdated packages
npm outdated

# Security audit
npm audit

# Check for breaking changes
npx npm-check-updates
\`\`\`

### 2. Categorize Updates

**Patch Updates** (x.x.PATCH): Bug fixes, safe
**Minor Updates** (x.MINOR.x): New features, usually safe
**Major Updates** (MAJOR.x.x): Breaking changes, careful review

### 3. Update Strategy

#### Safe Updates (Patch + Minor)
\`\`\`bash
# Update all safe updates
npm update

# Or specific package
npm update package-name
\`\`\`

#### Major Updates (One at a time)
1. Read changelog for breaking changes
2. Check migration guide
3. Update single package
4. Run tests
5. Fix breaking changes
6. Commit before next update

### 4. Pre-Update Checklist
- [ ] Current tests passing
- [ ] Clean git state
- [ ] Lock file committed
- [ ] Note current versions

### 5. Post-Update Verification
- [ ] All tests pass
- [ ] Build succeeds
- [ ] Application starts
- [ ] Critical paths work
- [ ] No new deprecation warnings

### 6. Handling Breaking Changes

\`\`\`typescript
// Check for API changes
import { newAPI } from 'package'; // May have changed

// Update usage patterns
// Old: package.oldMethod()
// New: package.newMethod()
\`\`\`

### 7. Rollback Plan
\`\`\`bash
# If update fails
git checkout -- package.json package-lock.json
npm install
\`\`\`

## Common Issues

- Peer dependency conflicts
- Type definition mismatches
- Deprecated API usage
- Build tool incompatibilities`,
    allowedTools: ['Read', 'Edit', 'Bash', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },

  // -------------------------------------------------------------------------
  // migration-planning - Plan and execute data/code migrations
  // -------------------------------------------------------------------------
  {
    name: 'migration-planning',
    description: 'Plans and executes database and code migrations safely',
    content: `---
name: migration-planning
description: Plans and executes database and code migrations safely
allowed-tools: Read, Edit, Write, Bash, Grep, Glob
---

# Migration Planning Skill

You are planning and executing migrations. This skill ensures safe, reversible data and code migrations.

## Migration Types

### 1. Database Schema Migrations
- Adding/removing columns
- Changing data types
- Creating/dropping tables
- Adding indexes and constraints

### 2. Data Migrations
- Transforming existing data
- Backfilling new columns
- Data normalization
- Archive/cleanup operations

### 3. Code Migrations
- API version upgrades
- Framework migrations
- Dependency updates
- Architecture changes

## Migration Planning Process

### 1. Impact Analysis
- What data is affected?
- How much data? (volume)
- Who uses this? (dependencies)
- What's the rollback plan?

### 2. Safety Checklist

**Schema Changes**:
- [ ] Adding column: Use nullable or default value
- [ ] Removing column: Verify no code references
- [ ] Renaming: Use dual-write strategy
- [ ] Type change: Handle data conversion

**Data Changes**:
- [ ] Backup before migration
- [ ] Batch large updates
- [ ] Handle NULL values
- [ ] Preserve audit trail

### 3. Zero-Downtime Patterns

**Adding Column**:
1. Add nullable column
2. Deploy code writing to new column
3. Backfill existing data
4. Deploy code reading new column
5. Make column NOT NULL (optional)

**Renaming Column**:
1. Add new column
2. Deploy dual-write code
3. Backfill new column
4. Deploy read from new column
5. Remove old column (separate migration)

### 4. Migration File Template

\`\`\`typescript
export async function up(db: Database): Promise<void> {
  // Forward migration
  await db.schema.alterTable('users', (table) => {
    table.string('new_field').nullable();
  });
}

export async function down(db: Database): Promise<void> {
  // Rollback migration - REQUIRED
  await db.schema.alterTable('users', (table) => {
    table.dropColumn('new_field');
  });
}
\`\`\`

### 5. Execution Checklist
- [ ] Test on staging with production-like data
- [ ] Time the migration on large datasets
- [ ] Verify rollback works
- [ ] Schedule maintenance window if needed
- [ ] Have rollback ready during deployment`,
    allowedTools: ['Read', 'Edit', 'Write', 'Bash', 'Grep', 'Glob'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },

  // -------------------------------------------------------------------------
  // architecture-review - Review and suggest architectural improvements
  // -------------------------------------------------------------------------
  {
    name: 'architecture-review',
    description: 'Reviews system architecture and suggests improvements',
    content: `---
name: architecture-review
description: Reviews system architecture and suggests improvements
allowed-tools: Read, Grep, Glob, Bash
---

# Architecture Review Skill

You are reviewing system architecture. This skill evaluates design decisions and suggests improvements.

## Review Dimensions

### 1. Separation of Concerns
- Clear boundaries between layers
- Single Responsibility Principle
- Appropriate abstraction levels
- Domain-driven organization

### 2. Dependency Management
- Dependency Inversion Principle
- Loose coupling between modules
- No circular dependencies
- Clear public APIs

### 3. Scalability
- Horizontal scaling capability
- Stateless design where possible
- Caching strategy
- Database partitioning readiness

### 4. Reliability
- Error handling strategy
- Retry and circuit breaker patterns
- Graceful degradation
- Health check endpoints

### 5. Maintainability
- Code organization clarity
- Documentation quality
- Test coverage
- Configuration management

### 6. Security Architecture
- Authentication strategy
- Authorization model
- Data encryption approach
- Secrets management

## Analysis Process

### 1. Map the System
- Identify main components
- Document data flows
- Note external dependencies
- Understand deployment topology

### 2. Evaluate Patterns
- Design patterns used
- Anti-patterns present
- Industry best practices
- Technology choices

### 3. Identify Issues
- Technical debt areas
- Scaling bottlenecks
- Single points of failure
- Overly complex areas

### 4. Recommend Improvements
- Prioritize by impact and effort
- Provide migration paths
- Consider team capabilities
- Balance idealism with pragmatism

## Output Format

\`\`\`markdown
## Architecture Review Report

### System Overview
[High-level description]

### Strengths
- [What's working well]

### Areas for Improvement
1. [Issue] - Impact: [H/M/L] - Effort: [H/M/L]
   Recommendation: [Specific suggestion]

### Technical Debt
- [Identified debt items]

### Recommendations
1. [Prioritized action items]

### Architecture Diagram
[ASCII or description of suggested changes]
\`\`\``,
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash'],
    scope: 'user',
    projectPath: null,
    version: '1.0.0',
  },
];
