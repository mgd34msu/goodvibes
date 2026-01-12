# Contributing to GoodVibes

Thank you for your interest in contributing to GoodVibes! This document provides guidelines and information for contributors.

## Getting Started

1. Fork the repository
2. Clone your fork locally
3. Install dependencies with `npm install`
4. Run the development server with `npm run dev`

## Development Workflow

### Running the App

```bash
# Development mode with hot reload
npm run dev

# Build for production
npm run build

# Preview production build
npm run preview
```

### Code Quality

Before submitting a pull request, ensure your code passes all checks:

```bash
# Run linting
npm run lint

# Fix auto-fixable lint issues
npm run lint:fix

# Run type checking
npm run typecheck

# Run tests
npm test
```

### Testing

```bash
# Run all tests
npm test

# Run tests with UI
npm run test:ui

# Run tests with coverage
npm run test:coverage

# Run end-to-end tests
npm run test:e2e
```

## Code Style

This project uses Prettier and ESLint to maintain consistent code style. Configuration files:

- `.prettierrc` - Prettier formatting rules
- `.editorconfig` - Editor-agnostic formatting
- `eslint.config.js` - ESLint rules

### Key Style Guidelines

- Use TypeScript for all new code
- Use single quotes for strings
- Use 2-space indentation
- Include trailing commas in multi-line arrays/objects
- Maximum line width of 100 characters
- Use meaningful variable and function names
- Add JSDoc comments for public APIs

## Project Structure

```
src/
  main/           # Electron main process
    database/     # SQLite database operations
    ipc/          # IPC handlers
    services/     # Business logic services
  preload/        # Preload scripts
  renderer/       # React frontend
    components/   # React components
    hooks/        # Custom React hooks
    stores/       # Zustand state stores
  shared/         # Shared utilities and types
```

## Pull Request Guidelines

1. Create a feature branch from `main`
2. Make your changes with clear, focused commits
3. Write or update tests as needed
4. Ensure all checks pass locally
5. Submit a pull request with a clear description

### Commit Messages

Use clear, descriptive commit messages:

- `feat: add new feature` - New features
- `fix: resolve bug` - Bug fixes
- `docs: update documentation` - Documentation changes
- `refactor: improve code structure` - Code refactoring
- `test: add tests` - Test additions or updates
- `chore: update dependencies` - Maintenance tasks

## Reporting Issues

When reporting issues, please include:

- A clear description of the problem
- Steps to reproduce the issue
- Expected vs actual behavior
- Your operating system and version
- Node.js and npm versions

## Questions?

If you have questions, feel free to open an issue for discussion.
