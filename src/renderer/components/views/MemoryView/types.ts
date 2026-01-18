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
}

export const DEFAULT_TEMPLATES: MemoryTemplate[] = [
  // ============================================================================
  // 1. PROJECT SETUP - Basic project context
  // ============================================================================
  {
    id: 'project-setup',
    name: 'Project Setup',
    description: 'Basic project context with tech stack and key commands',
    content: `# {{project_name}}

## Tech Stack
- Language: {{language}}
- Framework: {{framework}}
- Package Manager: {{package_manager}}

## Common Commands
\`\`\`bash
# Install dependencies
{{install_command}}

# Run development server
{{dev_command}}

# Run tests
{{test_command}}

# Build for production
{{build_command}}
\`\`\`

## Project Structure
- \`src/\` - Source code
- \`tests/\` - Test files
- \`docs/\` - Documentation

## Code Style
- Use existing patterns in the codebase
- Run linter before committing
- Keep functions small and focused
`,
    variables: ['project_name', 'language', 'framework', 'package_manager', 'install_command', 'dev_command', 'test_command', 'build_command'],
  },

  // ============================================================================
  // 2. TYPESCRIPT/NODE - TypeScript patterns and npm scripts
  // ============================================================================
  {
    id: 'typescript-node',
    name: 'TypeScript/Node',
    description: 'TypeScript patterns, npm scripts, and Node.js conventions',
    content: `# TypeScript/Node Project

## Commands
\`\`\`bash
npm install          # Install dependencies
npm run dev          # Start dev server
npm run build        # Compile TypeScript
npm run test         # Run tests
npm run lint         # Lint code
npm run typecheck    # Check types without emitting
\`\`\`

## TypeScript Conventions
- Use strict mode (strict: true in tsconfig)
- Prefer \`interface\` over \`type\` for object shapes
- Use \`unknown\` instead of \`any\`, validate before use
- Export types alongside implementations
- Use barrel exports (index.ts) for public APIs

## Error Handling
\`\`\`typescript
// Use typed errors
class AppError extends Error {
  constructor(message: string, public code: string) {
    super(message);
  }
}

// Always handle promise rejections
try {
  await operation();
} catch (error) {
  if (error instanceof AppError) {
    // Handle known error
  }
  throw error; // Re-throw unknown errors
}
\`\`\`

## File Organization
- One export per file for components/classes
- Colocate tests with source files (*.test.ts)
- Group by feature, not by type
`,
    variables: [],
  },

  // ============================================================================
  // 3. REACT/NEXT.JS - React patterns and component conventions
  // ============================================================================
  {
    id: 'react-nextjs',
    name: 'React/Next.js',
    description: 'React patterns, component conventions, and Next.js specifics',
    content: `# React/Next.js Project

## Commands
\`\`\`bash
npm run dev          # Start dev server (localhost:3000)
npm run build        # Production build
npm run start        # Start production server
npm run lint         # ESLint check
\`\`\`

## Component Patterns
\`\`\`tsx
// Use function components with TypeScript
interface ButtonProps {
  variant: 'primary' | 'secondary';
  children: React.ReactNode;
  onClick?: () => void;
}

export function Button({ variant, children, onClick }: ButtonProps) {
  return (
    <button className={styles[variant]} onClick={onClick}>
      {children}
    </button>
  );
}
\`\`\`

## Conventions
- Components: PascalCase (Button.tsx)
- Hooks: camelCase with use prefix (useAuth.ts)
- Utilities: camelCase (formatDate.ts)
- Keep components under 200 lines
- Extract hooks for complex state logic

## Next.js App Router
- Use Server Components by default
- Add 'use client' only when needed (interactivity, hooks)
- Colocate loading.tsx and error.tsx with page.tsx
- Use route groups (folder) for layouts

## State Management
- Server state: React Query or SWR
- Client state: useState/useReducer or Zustand
- Avoid prop drilling beyond 2 levels
`,
    variables: [],
  },

  // ============================================================================
  // 4. API DEVELOPMENT - REST/GraphQL patterns
  // ============================================================================
  {
    id: 'api-development',
    name: 'API Development',
    description: 'REST/GraphQL patterns, validation, and error handling',
    content: `# API Development

## RESTful Conventions
- GET /resources - List all
- GET /resources/:id - Get one
- POST /resources - Create
- PUT /resources/:id - Replace
- PATCH /resources/:id - Update
- DELETE /resources/:id - Remove

## Request Validation
\`\`\`typescript
// Always validate input at the boundary
import { z } from 'zod';

const CreateUserSchema = z.object({
  email: z.string().email(),
  name: z.string().min(1).max(100),
});

// Validate before processing
const result = CreateUserSchema.safeParse(req.body);
if (!result.success) {
  return res.status(400).json({ errors: result.error.flatten() });
}
\`\`\`

## Error Response Format
\`\`\`json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Human-readable message",
    "details": {}
  }
}
\`\`\`

## Status Codes
- 200: Success
- 201: Created
- 400: Bad Request (client error)
- 401: Unauthorized (not logged in)
- 403: Forbidden (no permission)
- 404: Not Found
- 500: Server Error

## API Guidelines
- Version APIs (/v1/resources)
- Use consistent naming (snake_case or camelCase)
- Include pagination for lists
- Log all requests and errors
`,
    variables: [],
  },

  // ============================================================================
  // 5. DATABASE - ORM patterns and migrations
  // ============================================================================
  {
    id: 'database',
    name: 'Database',
    description: 'ORM patterns, migration conventions, and query optimization',
    content: `# Database Patterns

## Commands
\`\`\`bash
# Prisma (adjust for your ORM)
npx prisma migrate dev      # Run migrations in dev
npx prisma migrate deploy   # Run migrations in prod
npx prisma generate         # Generate client
npx prisma studio           # Open database GUI
\`\`\`

## Migration Guidelines
- One migration per logical change
- Name migrations descriptively: add_user_email_index
- Never edit deployed migrations
- Test migrations on a copy of prod data
- Include rollback strategy

## Query Patterns
\`\`\`typescript
// Use transactions for related operations
await prisma.$transaction([
  prisma.user.update({ where: { id }, data: { balance: { decrement: amount } } }),
  prisma.transaction.create({ data: { userId: id, amount, type: 'debit' } }),
]);

// Select only needed fields
const users = await prisma.user.findMany({
  select: { id: true, name: true, email: true },
});

// Use pagination
const users = await prisma.user.findMany({
  skip: page * pageSize,
  take: pageSize,
});
\`\`\`

## Performance
- Add indexes for frequently queried columns
- Use connection pooling in production
- Avoid N+1 queries (use include/eager loading)
- Monitor slow query logs
`,
    variables: [],
  },

  // ============================================================================
  // 6. TESTING - Test patterns and coverage
  // ============================================================================
  {
    id: 'testing',
    name: 'Testing',
    description: 'Test patterns, coverage expectations, and testing best practices',
    content: `# Testing Guidelines

## Commands
\`\`\`bash
npm test                 # Run all tests
npm test -- --watch      # Watch mode
npm test -- --coverage   # With coverage report
npm test -- path/to/file # Run specific file
\`\`\`

## Test Structure
\`\`\`typescript
describe('UserService', () => {
  describe('createUser', () => {
    it('creates a user with valid data', async () => {
      const user = await userService.createUser({ email: 'test@example.com' });
      expect(user.id).toBeDefined();
      expect(user.email).toBe('test@example.com');
    });

    it('throws on duplicate email', async () => {
      await userService.createUser({ email: 'test@example.com' });
      await expect(
        userService.createUser({ email: 'test@example.com' })
      ).rejects.toThrow('Email already exists');
    });
  });
});
\`\`\`

## Testing Principles
- Test behavior, not implementation
- One assertion concept per test
- Use descriptive test names
- Avoid testing third-party code
- Mock external dependencies, not internal modules

## Coverage Targets
- Statements: 80%+
- Branches: 75%+
- Functions: 80%+
- Critical paths: 100%

## Test Types
- Unit: Isolated function/component tests
- Integration: Multiple units working together
- E2E: Full user flows (use sparingly)
`,
    variables: [],
  },

  // ============================================================================
  // 7. GIT WORKFLOW - Branch naming and commit conventions
  // ============================================================================
  {
    id: 'git-workflow',
    name: 'Git Workflow',
    description: 'Branch naming, commit conventions, and PR process',
    content: `# Git Workflow

## Branch Naming
\`\`\`
feature/add-user-auth      # New features
fix/login-redirect-loop    # Bug fixes
refactor/extract-api-client # Code improvements
docs/update-readme         # Documentation
chore/upgrade-deps         # Maintenance
\`\`\`

## Commit Messages
\`\`\`
<type>: <short description>

[optional body with more detail]

[optional footer with breaking changes or issue refs]
\`\`\`

Types: feat, fix, docs, style, refactor, test, chore

Examples:
\`\`\`
feat: add password reset functionality
fix: prevent duplicate form submissions
docs: update API authentication section
refactor: extract validation logic to utilities
\`\`\`

## Pull Request Process
1. Create branch from main
2. Make changes with atomic commits
3. Push and open PR with description
4. Address review feedback
5. Squash and merge when approved

## PR Description Template
\`\`\`markdown
## Summary
Brief description of changes

## Changes
- Added X
- Fixed Y
- Updated Z

## Testing
- [ ] Unit tests pass
- [ ] Manual testing done
\`\`\`

## Git Commands
\`\`\`bash
git checkout -b feature/name   # Create branch
git add -p                     # Stage interactively
git commit -m "type: message"  # Commit
git push -u origin HEAD        # Push new branch
\`\`\`
`,
    variables: [],
  },

  // ============================================================================
  // 8. SECURITY - Security checklist and auth patterns
  // ============================================================================
  {
    id: 'security',
    name: 'Security',
    description: 'Security checklist, authentication patterns, and common vulnerabilities',
    content: `# Security Guidelines

## Authentication
- Use established libraries (NextAuth, Passport, Auth0)
- Hash passwords with bcrypt (cost factor 12+)
- Use secure session management
- Implement proper logout (invalidate tokens)
- Add rate limiting to auth endpoints

## Input Validation
\`\`\`typescript
// Validate ALL user input
// Never trust client-side validation alone
const sanitized = validator.escape(userInput);
const validated = schema.parse(userInput);
\`\`\`

## Security Checklist
- [ ] HTTPS only in production
- [ ] CORS configured restrictively
- [ ] CSRF protection enabled
- [ ] SQL injection prevented (parameterized queries)
- [ ] XSS prevented (output encoding)
- [ ] Secrets in environment variables, never in code
- [ ] Dependencies regularly updated
- [ ] Error messages don't leak internals

## Headers (use helmet.js or equivalent)
\`\`\`
Content-Security-Policy: default-src 'self'
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
Strict-Transport-Security: max-age=31536000
\`\`\`

## Sensitive Data
- Never log passwords, tokens, or PII
- Encrypt data at rest and in transit
- Implement proper access controls
- Audit sensitive operations

## Dependency Security
\`\`\`bash
npm audit              # Check for vulnerabilities
npm audit fix          # Auto-fix where possible
\`\`\`
`,
    variables: [],
  },

  // ============================================================================
  // 9. PERFORMANCE - Performance guidelines and monitoring
  // ============================================================================
  {
    id: 'performance',
    name: 'Performance',
    description: 'Performance guidelines, optimization patterns, and monitoring',
    content: `# Performance Guidelines

## Frontend Performance
- Bundle size: Keep initial JS under 200KB gzipped
- Images: Use modern formats (WebP, AVIF), lazy load
- Fonts: Subset, preload critical fonts
- Code splitting: Dynamic imports for routes
- Caching: Leverage browser and CDN caching

## React Optimization
\`\`\`tsx
// Memoize expensive components
const ExpensiveList = React.memo(({ items }) => (
  <ul>{items.map(item => <li key={item.id}>{item.name}</li>)}</ul>
));

// Memoize expensive calculations
const sortedItems = useMemo(() =>
  items.sort((a, b) => b.score - a.score),
  [items]
);

// Debounce frequent updates
const debouncedSearch = useDebouncedCallback(search, 300);
\`\`\`

## Backend Performance
- Database: Add indexes, use connection pooling
- Caching: Redis for frequently accessed data
- N+1: Use eager loading or DataLoader
- Pagination: Always paginate large lists

## Monitoring
\`\`\`bash
# Lighthouse audit
npx lighthouse https://example.com --view

# Bundle analysis
npm run build && npx source-map-explorer dist/**/*.js
\`\`\`

## Performance Targets
- First Contentful Paint: < 1.8s
- Largest Contentful Paint: < 2.5s
- Time to Interactive: < 3.8s
- Cumulative Layout Shift: < 0.1
`,
    variables: [],
  },

  // ============================================================================
  // 10. DOCUMENTATION - Doc standards and JSDoc patterns
  // ============================================================================
  {
    id: 'documentation',
    name: 'Documentation',
    description: 'Documentation standards, JSDoc patterns, and README structure',
    content: `# Documentation Standards

## Code Documentation
\`\`\`typescript
/**
 * Calculates the total price including tax and discounts.
 *
 * @param items - Cart items to calculate
 * @param taxRate - Tax rate as decimal (e.g., 0.08 for 8%)
 * @param discountCode - Optional discount code to apply
 * @returns Total price in cents
 * @throws {InvalidDiscountError} If discount code is invalid
 *
 * @example
 * const total = calculateTotal(items, 0.08, 'SAVE10');
 */
function calculateTotal(
  items: CartItem[],
  taxRate: number,
  discountCode?: string
): number {
  // Implementation
}
\`\`\`

## When to Document
- Public APIs and exported functions
- Complex business logic
- Non-obvious algorithms
- Configuration options
- Database schema decisions

## README Structure
\`\`\`markdown
# Project Name

Brief description (1-2 sentences)

## Quick Start
\`\`\`bash
npm install && npm run dev
\`\`\`

## Documentation
- [Setup Guide](docs/setup.md)
- [API Reference](docs/api.md)
- [Contributing](CONTRIBUTING.md)
\`\`\`

## Self-Documenting Code
- Use descriptive variable/function names
- Extract magic numbers to named constants
- Keep functions small and focused
- Let types document structure
`,
    variables: [],
  },

  // ============================================================================
  // 11. MONOREPO - Workspace patterns and shared dependencies
  // ============================================================================
  {
    id: 'monorepo',
    name: 'Monorepo',
    description: 'Workspace patterns, shared dependencies, and monorepo tooling',
    content: `# Monorepo Structure

## Commands
\`\`\`bash
# Run in specific package
npm run dev -w packages/web
npm run build -w packages/api

# Run in all packages
npm run build --workspaces

# Add dependency to package
npm install lodash -w packages/shared

# Add shared dependency to root
npm install typescript -D
\`\`\`

## Structure
\`\`\`
/
├── package.json          # Root with workspaces config
├── packages/
│   ├── web/              # Frontend app
│   ├── api/              # Backend service
│   ├── shared/           # Shared utilities
│   └── ui/               # Component library
└── tools/                # Build/dev tooling
\`\`\`

## Package References
\`\`\`json
// packages/web/package.json
{
  "dependencies": {
    "@myorg/shared": "workspace:*",
    "@myorg/ui": "workspace:*"
  }
}
\`\`\`

## Conventions
- Each package has its own package.json
- Shared types in dedicated package
- Keep packages loosely coupled
- Version shared packages together
- Use TypeScript project references

## Build Order
- Build shared packages first
- Use turborepo or nx for caching
- Define dependencies in turbo.json/nx.json
`,
    variables: [],
  },

  // ============================================================================
  // 12. MICROSERVICES - Service patterns and communication
  // ============================================================================
  {
    id: 'microservices',
    name: 'Microservices',
    description: 'Service patterns, inter-service communication, and deployment',
    content: `# Microservices Architecture

## Service Structure
\`\`\`
/services
├── user-service/         # User management
├── order-service/        # Order processing
├── notification-service/ # Email/SMS/Push
└── gateway/              # API gateway
\`\`\`

## Communication Patterns
- Sync: REST/gRPC for real-time queries
- Async: Message queues for events (RabbitMQ, Kafka)
- Gateway: Single entry point, routes to services

## Service Template
\`\`\`
/user-service
├── src/
│   ├── api/              # HTTP handlers
│   ├── domain/           # Business logic
│   ├── infrastructure/   # DB, external clients
│   └── events/           # Event handlers
├── Dockerfile
└── package.json
\`\`\`

## Best Practices
- Each service owns its data (no shared DBs)
- Use correlation IDs for distributed tracing
- Implement health checks (/health endpoint)
- Design for failure (circuit breakers, retries)
- Keep services small and focused

## Docker Commands
\`\`\`bash
docker-compose up -d           # Start all services
docker-compose logs -f api     # Follow service logs
docker-compose down            # Stop all services
\`\`\`

## Environment Config
- Use environment variables for config
- Secrets via vault or cloud secrets manager
- Service discovery via DNS or registry
`,
    variables: [],
  },
];
