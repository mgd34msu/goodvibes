// ============================================================================
// MEMORY VIEW - SHARED TYPES
// ============================================================================

export interface ClaudeMdFile {
  path: string;
  name: string;
  scope: 'user' | 'project' | 'local';
  content: string;
  exists: boolean;
  lastModified?: string;
}

export interface MemoryTemplate {
  id: string;
  name: string;
  description: string;
  content: string;
  variables: string[];
  /** Which CLAUDE.md scope this template is best suited for */
  scope: 'user' | 'project' | 'local';
}

// ============================================================================
// CLAUDE.MD TEMPLATES
// Based on best practices from claude-md-best-practices.md
// ============================================================================

export const DEFAULT_TEMPLATES: MemoryTemplate[] = [
  // ============================================================================
  // USER-LEVEL TEMPLATES (~/.claude/CLAUDE.md)
  // Personal preferences that apply across ALL projects
  // ============================================================================
  {
    id: 'user-preferences',
    name: 'Personal Preferences',
    description: 'Code style, workflow preferences, and personal shortcuts',
    scope: 'user',
    content: `# Personal Preferences

## Code Style
- Prefer functional approaches over class-based when reasonable
- Use descriptive variable names, avoid abbreviations
- 2-space indentation for JS/TS, 4-space for Python

## Workflow
- Commit messages: conventional commits format (feat:, fix:, docs:, etc.)
- Always run tests before suggesting PR is ready
- Prefer small, focused commits over large changes

## Communication
- Be concise in explanations
- Show code examples rather than lengthy descriptions
- Ask clarifying questions when requirements are ambiguous
`,
    variables: [],
  },
  {
    id: 'user-tooling',
    name: 'Tooling Shortcuts',
    description: 'Shell commands and tools you use across projects',
    scope: 'user',
    content: `# Tooling Shortcuts

## Package Managers
- Use pnpm when available, fall back to npm
- \`pnpm i\` for install, \`pnpm add -D\` for dev dependencies

## Git Shortcuts
- \`git add -p\` for interactive staging
- \`git commit --amend --no-edit\` for quick fixes to last commit
- \`git push -u origin HEAD\` for new branches

## Editor
- Format on save is enabled
- Use project-specific formatter configs when present
`,
    variables: [],
  },

  // ============================================================================
  // PROJECT-LEVEL TEMPLATES (./CLAUDE.md)
  // Project-specific context shared with the team via git
  // ============================================================================
  {
    id: 'project-minimal',
    name: 'Minimal Project',
    description: 'Essential commands and structure - start here',
    scope: 'project',
    content: `# {{project_name}}

{{description}}

## Commands
\`\`\`bash
{{package_manager}} install    # Install dependencies
{{package_manager}} run dev    # Start development server
{{package_manager}} run test   # Run tests
{{package_manager}} run build  # Build for production
\`\`\`

## Architecture
- \`/src\` - Source code
- \`/tests\` - Test files

## Conventions
- Follow existing patterns in the codebase
- Run linter before committing
`,
    variables: ['project_name', 'description', 'package_manager'],
  },
  {
    id: 'project-full',
    name: 'Full Project Context',
    description: 'Comprehensive project setup with architecture and gotchas',
    scope: 'project',
    content: `# {{project_name}}

{{description}}

## Commands
\`\`\`bash
{{package_manager}} install       # Install dependencies
{{package_manager}} run dev       # Start development server
{{package_manager}} run test      # Run tests
{{package_manager}} run lint      # Lint code
{{package_manager}} run typecheck # Type checking
{{package_manager}} run build     # Build for production
\`\`\`

## Architecture
- \`/src/{{main_dir}}\` - {{main_description}}
- \`/src/{{secondary_dir}}\` - {{secondary_description}}

## Conventions
- {{convention_1}}
- {{convention_2}}

## Gotchas
- {{gotcha_1}}

## Off-Limits
- Never modify files in \`/generated\` directly
- Don't edit \`.env\` files without asking
`,
    variables: [
      'project_name',
      'description',
      'package_manager',
      'main_dir',
      'main_description',
      'secondary_dir',
      'secondary_description',
      'convention_1',
      'convention_2',
      'gotcha_1',
    ],
  },
  {
    id: 'project-monorepo',
    name: 'Monorepo Project',
    description: 'Multi-package workspace with shared dependencies',
    scope: 'project',
    content: `# {{project_name}}

{{description}}

## Workspace Commands
\`\`\`bash
# Run in specific package
pnpm --filter {{main_package}} dev
pnpm --filter {{main_package}} test

# Run across all packages
pnpm run build
pnpm run test

# Add dependency to package
pnpm --filter {{main_package}} add <package>
\`\`\`

## Structure
- \`/packages/{{main_package}}\` - {{main_description}}
- \`/packages/shared\` - Shared utilities and types

## Conventions
- Each package has its own package.json
- Shared types go in the shared package
- Import from packages using workspace protocol

## Important
- Build shared packages before dependent packages
- Keep packages loosely coupled
`,
    variables: ['project_name', 'description', 'main_package', 'main_description'],
  },
  {
    id: 'project-api',
    name: 'API/Backend Project',
    description: 'REST/GraphQL API with database and auth',
    scope: 'project',
    content: `# {{project_name}}

{{description}}

## Commands
\`\`\`bash
{{package_manager}} run dev      # Start dev server
{{package_manager}} run test     # Run tests
{{package_manager}} run db:push  # Push schema changes
{{package_manager}} run db:studio # Open database GUI
\`\`\`

## API Conventions
- RESTful endpoints: GET/POST/PUT/DELETE
- Validate all input with Zod schemas
- Return consistent error format: \`{ error: { code, message } }\`

## Database
- Migrations in \`/prisma/migrations\` (or equivalent)
- Never edit deployed migrations
- Use transactions for related operations

## Auth
- JWT tokens for API authentication
- Rate limiting on auth endpoints

## Gotchas
- {{gotcha}}
`,
    variables: ['project_name', 'description', 'package_manager', 'gotcha'],
  },
  {
    id: 'project-frontend',
    name: 'Frontend/React Project',
    description: 'React/Next.js app with component patterns',
    scope: 'project',
    content: `# {{project_name}}

{{description}}

## Commands
\`\`\`bash
{{package_manager}} run dev    # Start dev server (localhost:3000)
{{package_manager}} run build  # Production build
{{package_manager}} run test   # Run tests
{{package_manager}} run lint   # ESLint check
\`\`\`

## Component Patterns
- Components: PascalCase (\`Button.tsx\`)
- Hooks: camelCase with \`use\` prefix (\`useAuth.ts\`)
- Keep components under 200 lines
- Extract hooks for complex state logic

## State Management
- Server state: React Query / SWR
- Client state: Zustand / useState
- Avoid prop drilling beyond 2 levels

## Styling
- {{styling_approach}}

## Gotchas
- {{gotcha}}
`,
    variables: ['project_name', 'description', 'package_manager', 'styling_approach', 'gotcha'],
  },
  {
    id: 'project-git-workflow',
    name: 'Git Workflow Addendum',
    description: 'Branch naming and commit conventions to add to project CLAUDE.md',
    scope: 'project',
    content: `## Git Workflow

### Branch Naming
- \`feature/description\` - New features
- \`fix/description\` - Bug fixes
- \`refactor/description\` - Code improvements
- \`docs/description\` - Documentation

### Commit Messages
Use conventional commits:
\`\`\`
feat: add user authentication
fix: prevent duplicate form submissions
docs: update API documentation
refactor: extract validation logic
\`\`\`

### PR Process
1. Create branch from main
2. Make atomic commits
3. Open PR with description
4. Squash and merge when approved
`,
    variables: [],
  },

  // ============================================================================
  // LOCAL-LEVEL TEMPLATES (./CLAUDE.local.md)
  // Personal overrides that are NOT committed to git
  // ============================================================================
  {
    id: 'local-dev-env',
    name: 'Local Dev Environment',
    description: 'Personal dev URLs, credentials, and local overrides',
    scope: 'local',
    content: `# Local Development Overrides

## Dev URLs
- Local API: http://localhost:{{api_port}}
- Local App: http://localhost:{{app_port}}

## Test Credentials
- Test user: {{test_email}}
- Test password: {{test_password}}

## Local Overrides
- Using {{local_override}} for local development
`,
    variables: ['api_port', 'app_port', 'test_email', 'test_password', 'local_override'],
  },
  {
    id: 'local-worktree',
    name: 'Git Worktree Context',
    description: 'Context specific to this worktree/branch',
    scope: 'local',
    content: `# Worktree: {{branch_name}}

## Current Focus
{{current_focus}}

## Temporary Notes
- {{note_1}}

## Testing This Branch
\`\`\`bash
{{test_command}}
\`\`\`
`,
    variables: ['branch_name', 'current_focus', 'note_1', 'test_command'],
  },
  {
    id: 'local-experimental',
    name: 'Experimental Instructions',
    description: 'Test new instructions before proposing to team',
    scope: 'local',
    content: `# Experimental Instructions

## Testing These Rules
The following are experimental - testing before adding to project CLAUDE.md:

{{experimental_rules}}

## Notes
- Added: {{date}}
- Reason: {{reason}}
`,
    variables: ['experimental_rules', 'date', 'reason'],
  },
];
