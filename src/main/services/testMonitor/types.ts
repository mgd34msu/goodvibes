// ============================================================================
// TEST MONITOR TYPES
// ============================================================================

/**
 * Represents a parsed test result
 */
export interface TestResult {
  id: string;
  sessionId: string | null;
  projectPath: string | null;
  command: string;
  timestamp: string;
  durationMs: number;
  status: 'passed' | 'failed' | 'error' | 'unknown';
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  pendingTests: number;
  suites: TestSuite[];
  failedTestDetails: FailedTest[];
  coverage: CoverageInfo | null;
  rawOutput: string;
  framework: TestFramework;
}

/**
 * Supported test frameworks
 */
export type TestFramework = 'jest' | 'vitest' | 'mocha' | 'pytest' | 'go' | 'cargo' | 'unknown';

/**
 * A test suite
 */
export interface TestSuite {
  name: string;
  tests: number;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
}

/**
 * Details of a failed test
 */
export interface FailedTest {
  name: string;
  suite: string;
  error: string;
  stack: string | null;
  file: string | null;
  line: number | null;
}

/**
 * Code coverage information
 */
export interface CoverageInfo {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
  uncoveredFiles: string[];
}

/**
 * Test statistics
 */
export interface TestStats {
  totalRuns: number;
  totalPassed: number;
  totalFailed: number;
  totalSkipped: number;
  successRate: number;
  avgDuration: number;
  byFramework: Record<string, number>;
  recentResults: TestResult[];
}
