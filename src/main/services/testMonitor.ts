// ============================================================================
// TEST MONITOR SERVICE - Parse and track test results from Bash commands
// ============================================================================
//
// This service provides:
// - Detection of test commands (npm test, jest, vitest, pnpm test, yarn test)
// - Parsing of test output for pass/fail counts
// - Support for Jest, Vitest, and Mocha output formats
// - Structured test result emission for UI updates
//
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from './logger.js';
import { formatTimestamp } from '../../shared/dateUtils.js';
import { getMainWindow } from '../window.js';
import { getHookServer, type HookPayload } from './hookServer.js';

const logger = new Logger('TestMonitor');

// ============================================================================
// CONSTANTS
// ============================================================================

const MAX_TEST_RESULTS = 100;

// Test command patterns
const TEST_COMMAND_PATTERNS = [
  /\bnpm\s+(?:run\s+)?test\b/i,
  /\byarn\s+(?:run\s+)?test\b/i,
  /\bpnpm\s+(?:run\s+)?test\b/i,
  /\bbun\s+(?:run\s+)?test\b/i,
  /\bnpx\s+(?:jest|vitest|mocha)\b/i,
  /\bjest\b/i,
  /\bvitest\b/i,
  /\bmocha\b/i,
  /\bpytest\b/i,
  /\bcargo\s+test\b/i,
  /\bgo\s+test\b/i,
];

// ============================================================================
// TYPES
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
  framework: 'jest' | 'vitest' | 'mocha' | 'pytest' | 'go' | 'cargo' | 'unknown';
}

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

// ============================================================================
// TEST MONITOR SERVICE
// ============================================================================

class TestMonitorService extends EventEmitter {
  private testResults: TestResult[] = [];
  private isListening = false;
  private hookCleanup: (() => void) | null = null;

  constructor() {
    super();
    this.setMaxListeners(50);
  }

  // ============================================================================
  // LIFECYCLE
  // ============================================================================

  /**
   * Start listening for test commands from hook events
   */
  start(): void {
    if (this.isListening) {
      logger.warn('Test monitor already listening');
      return;
    }

    const hookServer = getHookServer();

    // Listen to PostToolUse events
    const handleHookProcessed = (data: {
      payload: HookPayload;
      response: unknown;
      durationMs: number;
    }) => {
      this.processHookEvent(data.payload, data.durationMs);
    };

    hookServer.on('hook:processed', handleHookProcessed);

    this.hookCleanup = () => {
      hookServer.off('hook:processed', handleHookProcessed);
    };

    this.isListening = true;
    logger.info('Test monitor started');
  }

  /**
   * Stop listening for test commands
   */
  stop(): void {
    if (this.hookCleanup) {
      this.hookCleanup();
      this.hookCleanup = null;
    }
    this.isListening = false;
    logger.info('Test monitor stopped');
  }

  /**
   * Get service status
   */
  getStatus(): { listening: boolean; resultCount: number } {
    return {
      listening: this.isListening,
      resultCount: this.testResults.length,
    };
  }

  // ============================================================================
  // EVENT PROCESSING
  // ============================================================================

  /**
   * Process a hook event and extract test results
   */
  private processHookEvent(payload: HookPayload, durationMs: number): void {
    // Only process PostToolUse events for Bash tool
    if (payload.hook_event_name !== 'PostToolUse') {
      return;
    }

    if (payload.tool_name !== 'Bash') {
      return;
    }

    const toolInput = payload.tool_input;
    if (!toolInput) {
      return;
    }

    const command = toolInput.command as string | undefined;
    if (!command) {
      return;
    }

    // Check if this is a test command
    if (!this.isTestCommand(command)) {
      return;
    }

    // Get the output from tool_response
    const toolResponse = payload.tool_response;
    const output = toolResponse?.content || '';

    // Parse the test results
    const result = this.parseTestOutput(
      command,
      output,
      payload.session_id || null,
      payload.working_directory || null,
      durationMs
    );

    // Add to results buffer
    this.addTestResult(result);

    // Emit event for real-time updates
    this.emit('test:completed', result);
    this.notifyRenderer('test-monitor:result', result);

    logger.info(`Test result recorded: ${result.passedTests}/${result.totalTests} passed (${result.framework})`);
  }

  /**
   * Check if a command is a test command
   */
  private isTestCommand(command: string): boolean {
    return TEST_COMMAND_PATTERNS.some(pattern => pattern.test(command));
  }

  // ============================================================================
  // TEST OUTPUT PARSING
  // ============================================================================

  /**
   * Parse test output and extract structured results
   */
  private parseTestOutput(
    command: string,
    output: string,
    sessionId: string | null,
    projectPath: string | null,
    durationMs: number
  ): TestResult {
    const framework = this.detectFramework(command, output);

    let parsed: Partial<TestResult> = {};

    switch (framework) {
      case 'jest':
        parsed = this.parseJestOutput(output);
        break;
      case 'vitest':
        parsed = this.parseVitestOutput(output);
        break;
      case 'mocha':
        parsed = this.parseMochaOutput(output);
        break;
      case 'pytest':
        parsed = this.parsePytestOutput(output);
        break;
      case 'go':
        parsed = this.parseGoTestOutput(output);
        break;
      case 'cargo':
        parsed = this.parseCargoTestOutput(output);
        break;
      default:
        parsed = this.parseGenericTestOutput(output);
    }

    const result: TestResult = {
      id: this.generateId(),
      sessionId,
      projectPath,
      command,
      timestamp: formatTimestamp(),
      durationMs,
      status: this.determineStatus(parsed),
      totalTests: parsed.totalTests || 0,
      passedTests: parsed.passedTests || 0,
      failedTests: parsed.failedTests || 0,
      skippedTests: parsed.skippedTests || 0,
      pendingTests: parsed.pendingTests || 0,
      suites: parsed.suites || [],
      failedTestDetails: parsed.failedTestDetails || [],
      coverage: parsed.coverage || null,
      rawOutput: this.truncateOutput(output),
      framework,
    };

    return result;
  }

  /**
   * Detect the test framework from command and output
   */
  private detectFramework(command: string, output: string): TestResult['framework'] {
    const lowerCommand = command.toLowerCase();
    const lowerOutput = output.toLowerCase();

    if (lowerCommand.includes('vitest') || lowerOutput.includes('vitest')) {
      return 'vitest';
    }
    if (lowerCommand.includes('jest') || lowerOutput.includes('jest')) {
      return 'jest';
    }
    if (lowerCommand.includes('mocha') || lowerOutput.includes('mocha')) {
      return 'mocha';
    }
    if (lowerCommand.includes('pytest') || lowerOutput.includes('pytest')) {
      return 'pytest';
    }
    if (lowerCommand.includes('go test') || lowerOutput.includes('--- pass') || lowerOutput.includes('--- fail')) {
      return 'go';
    }
    if (lowerCommand.includes('cargo test') || lowerOutput.includes('running') && lowerOutput.includes('test result')) {
      return 'cargo';
    }

    return 'unknown';
  }

  /**
   * Parse Jest output
   */
  private parseJestOutput(output: string): Partial<TestResult> {
    const result: Partial<TestResult> = {
      suites: [],
      failedTestDetails: [],
    };

    // Parse test counts
    // Jest format: "Tests:       5 passed, 2 failed, 7 total"
    const testsMatch = output.match(/Tests:\s+(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(?:(\d+)\s+pending,?\s*)?(?:(\d+)\s+todo,?\s*)?(\d+)\s+total/i);
    if (testsMatch) {
      result.passedTests = parseInt(testsMatch[1] || '0', 10);
      result.failedTests = parseInt(testsMatch[2] || '0', 10);
      result.skippedTests = parseInt(testsMatch[3] || '0', 10);
      result.pendingTests = parseInt(testsMatch[4] || '0', 10);
      result.totalTests = parseInt(testsMatch[6] || '0', 10);
    }

    // Parse suite counts
    // Jest format: "Test Suites: 2 passed, 1 failed, 3 total"
    const suitesMatch = output.match(/Test Suites:\s+(?:(\d+)\s+passed,?\s*)?(?:(\d+)\s+failed,?\s*)?(?:(\d+)\s+skipped,?\s*)?(\d+)\s+total/i);
    if (suitesMatch) {
      const suitePassed = parseInt(suitesMatch[1] || '0', 10);
      const suiteFailed = parseInt(suitesMatch[2] || '0', 10);
      if (suitePassed > 0 || suiteFailed > 0) {
        result.suites = [{
          name: 'All Suites',
          tests: result.totalTests || 0,
          passed: result.passedTests || 0,
          failed: result.failedTests || 0,
          skipped: result.skippedTests || 0,
          duration: 0,
        }];
      }
    }

    // Parse failed test details
    // Jest format: "● Suite Name › Test Name"
    const failedTestPattern = /●\s+(.+?)\s+›\s+(.+?)(?:\n|$)/g;
    let match;
    while ((match = failedTestPattern.exec(output)) !== null) {
      result.failedTestDetails = result.failedTestDetails || [];
      result.failedTestDetails.push({
        suite: match[1].trim(),
        name: match[2].trim(),
        error: this.extractErrorMessage(output, match[0]),
        stack: null,
        file: null,
        line: null,
      });
    }

    // Parse coverage
    result.coverage = this.parseCoverageTable(output);

    return result;
  }

  /**
   * Parse Vitest output
   */
  private parseVitestOutput(output: string): Partial<TestResult> {
    const result: Partial<TestResult> = {
      suites: [],
      failedTestDetails: [],
    };

    // Vitest format: "✓ 15 tests passed"
    const passedMatch = output.match(/[✓✔]\s*(\d+)\s+tests?\s+passed/i);
    if (passedMatch) {
      result.passedTests = parseInt(passedMatch[1], 10);
    }

    // Vitest format: "✗ 3 tests failed"
    const failedMatch = output.match(/[✗✘×]\s*(\d+)\s+tests?\s+failed/i);
    if (failedMatch) {
      result.failedTests = parseInt(failedMatch[1], 10);
    }

    // Vitest format: "⊘ 2 tests skipped"
    const skippedMatch = output.match(/[⊘○]\s*(\d+)\s+tests?\s+skipped/i);
    if (skippedMatch) {
      result.skippedTests = parseInt(skippedMatch[1], 10);
    }

    // Alternative format: "Tests  5 passed (5)"
    const altTestsMatch = output.match(/Tests\s+(\d+)\s+passed/i);
    if (altTestsMatch && !result.passedTests) {
      result.passedTests = parseInt(altTestsMatch[1], 10);
    }

    // Alternative format: "Tests  2 failed | 3 passed (5)"
    const altFailedMatch = output.match(/Tests\s+(\d+)\s+failed/i);
    if (altFailedMatch && !result.failedTests) {
      result.failedTests = parseInt(altFailedMatch[1], 10);
    }

    result.totalTests = (result.passedTests || 0) + (result.failedTests || 0) + (result.skippedTests || 0);

    // Parse failed test details from Vitest output
    // Format: "FAIL  src/test.spec.ts > Suite > Test name"
    const failPattern = /FAIL\s+(.+?)\s+>\s+(.+?)\s+>\s+(.+?)(?:\n|$)/g;
    let match;
    while ((match = failPattern.exec(output)) !== null) {
      result.failedTestDetails = result.failedTestDetails || [];
      result.failedTestDetails.push({
        suite: match[2].trim(),
        name: match[3].trim(),
        error: '',
        stack: null,
        file: match[1].trim(),
        line: null,
      });
    }

    // Parse coverage
    result.coverage = this.parseCoverageTable(output);

    return result;
  }

  /**
   * Parse Mocha output
   */
  private parseMochaOutput(output: string): Partial<TestResult> {
    const result: Partial<TestResult> = {
      suites: [],
      failedTestDetails: [],
    };

    // Mocha format: "12 passing"
    const passingMatch = output.match(/(\d+)\s+passing/i);
    if (passingMatch) {
      result.passedTests = parseInt(passingMatch[1], 10);
    }

    // Mocha format: "3 failing"
    const failingMatch = output.match(/(\d+)\s+failing/i);
    if (failingMatch) {
      result.failedTests = parseInt(failingMatch[1], 10);
    }

    // Mocha format: "2 pending"
    const pendingMatch = output.match(/(\d+)\s+pending/i);
    if (pendingMatch) {
      result.pendingTests = parseInt(pendingMatch[1], 10);
    }

    // Mocha format: "1 skipped"
    const skippedMatch = output.match(/(\d+)\s+skipped/i);
    if (skippedMatch) {
      result.skippedTests = parseInt(skippedMatch[1], 10);
    }

    result.totalTests = (result.passedTests || 0) + (result.failedTests || 0) +
                        (result.pendingTests || 0) + (result.skippedTests || 0);

    // Parse failed test details
    // Mocha format: "1) Suite Name test description:"
    const failPattern = /(\d+)\)\s+(.+?):\s*\n/g;
    let match;
    while ((match = failPattern.exec(output)) !== null) {
      const fullName = match[2].trim();
      const parts = fullName.split(' ');
      result.failedTestDetails = result.failedTestDetails || [];
      result.failedTestDetails.push({
        suite: parts.slice(0, -1).join(' ') || 'Root',
        name: parts[parts.length - 1] || fullName,
        error: this.extractErrorMessage(output, match[0]),
        stack: null,
        file: null,
        line: null,
      });
    }

    return result;
  }

  /**
   * Parse pytest output
   */
  private parsePytestOutput(output: string): Partial<TestResult> {
    const result: Partial<TestResult> = {
      suites: [],
      failedTestDetails: [],
    };

    // pytest format: "5 passed, 2 failed, 1 skipped"
    const summaryMatch = output.match(/=+\s*(?:(\d+)\s+passed)?(?:,?\s*(\d+)\s+failed)?(?:,?\s*(\d+)\s+skipped)?(?:,?\s*(\d+)\s+error)?/i);
    if (summaryMatch) {
      result.passedTests = parseInt(summaryMatch[1] || '0', 10);
      result.failedTests = parseInt(summaryMatch[2] || '0', 10);
      result.skippedTests = parseInt(summaryMatch[3] || '0', 10);
    }

    // Alternative format at the end: "1 passed in 0.12s"
    const altMatch = output.match(/(\d+)\s+passed/i);
    if (altMatch && !result.passedTests) {
      result.passedTests = parseInt(altMatch[1], 10);
    }

    const altFailMatch = output.match(/(\d+)\s+failed/i);
    if (altFailMatch && !result.failedTests) {
      result.failedTests = parseInt(altFailMatch[1], 10);
    }

    result.totalTests = (result.passedTests || 0) + (result.failedTests || 0) + (result.skippedTests || 0);

    // Parse failed test details
    // pytest format: "FAILED test_file.py::test_name - AssertionError"
    const failPattern = /FAILED\s+(.+?)::(.+?)\s+-\s+(.+?)(?:\n|$)/g;
    let match;
    while ((match = failPattern.exec(output)) !== null) {
      result.failedTestDetails = result.failedTestDetails || [];
      result.failedTestDetails.push({
        suite: match[1].trim(),
        name: match[2].trim(),
        error: match[3].trim(),
        stack: null,
        file: match[1].trim(),
        line: null,
      });
    }

    return result;
  }

  /**
   * Parse Go test output
   */
  private parseGoTestOutput(output: string): Partial<TestResult> {
    const result: Partial<TestResult> = {
      suites: [],
      failedTestDetails: [],
    };

    // Count --- PASS and --- FAIL lines
    const passMatches = output.match(/---\s+PASS/g);
    const failMatches = output.match(/---\s+FAIL/g);
    const skipMatches = output.match(/---\s+SKIP/g);

    result.passedTests = passMatches?.length || 0;
    result.failedTests = failMatches?.length || 0;
    result.skippedTests = skipMatches?.length || 0;
    result.totalTests = result.passedTests + result.failedTests + result.skippedTests;

    // Alternative: Parse summary line "ok package 0.123s"
    const _okMatches = output.match(/^ok\s+.+/gm);
    const _failSummaryMatches = output.match(/^FAIL\s+.+/gm);

    if (!result.totalTests) {
      // Count test functions run
      const runMatches = output.match(/=== RUN\s+/g);
      result.totalTests = runMatches?.length || 0;
    }

    // Parse failed test details
    // Format: "--- FAIL: TestName (0.00s)"
    const failPattern = /---\s+FAIL:\s+(\w+)/g;
    let match;
    while ((match = failPattern.exec(output)) !== null) {
      result.failedTestDetails = result.failedTestDetails || [];
      result.failedTestDetails.push({
        suite: 'Go Tests',
        name: match[1].trim(),
        error: '',
        stack: null,
        file: null,
        line: null,
      });
    }

    return result;
  }

  /**
   * Parse Cargo test output
   */
  private parseCargoTestOutput(output: string): Partial<TestResult> {
    const result: Partial<TestResult> = {
      suites: [],
      failedTestDetails: [],
    };

    // Cargo format: "test result: ok. 5 passed; 0 failed; 2 ignored"
    const summaryMatch = output.match(/test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/i);
    if (summaryMatch) {
      result.passedTests = parseInt(summaryMatch[1], 10);
      result.failedTests = parseInt(summaryMatch[2], 10);
      result.skippedTests = parseInt(summaryMatch[3], 10);
    }

    result.totalTests = (result.passedTests || 0) + (result.failedTests || 0) + (result.skippedTests || 0);

    // Parse failed test details
    // Format: "test module::test_name ... FAILED"
    const failPattern = /test\s+(.+?)\s+\.\.\.\s+FAILED/g;
    let match;
    while ((match = failPattern.exec(output)) !== null) {
      const fullName = match[1].trim();
      const parts = fullName.split('::');
      result.failedTestDetails = result.failedTestDetails || [];
      result.failedTestDetails.push({
        suite: parts.slice(0, -1).join('::') || 'Root',
        name: parts[parts.length - 1],
        error: '',
        stack: null,
        file: null,
        line: null,
      });
    }

    return result;
  }

  /**
   * Parse generic test output (fallback)
   */
  private parseGenericTestOutput(output: string): Partial<TestResult> {
    const result: Partial<TestResult> = {
      suites: [],
      failedTestDetails: [],
    };

    // Try common patterns
    const passedPatterns = [
      /(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)?/gi,
      /pass(?:ed|ing)?:?\s*(\d+)/gi,
      /[✓✔]\s*(\d+)/g,
    ];

    const failedPatterns = [
      /(\d+)\s+(?:tests?\s+)?fail(?:ed|ing|ure)?/gi,
      /fail(?:ed|ing|ure)?:?\s*(\d+)/gi,
      /[✗✘×]\s*(\d+)/g,
    ];

    for (const pattern of passedPatterns) {
      const match = output.match(pattern);
      if (match) {
        const numMatch = match[0].match(/\d+/);
        if (numMatch) {
          result.passedTests = parseInt(numMatch[0], 10);
          break;
        }
      }
    }

    for (const pattern of failedPatterns) {
      const match = output.match(pattern);
      if (match) {
        const numMatch = match[0].match(/\d+/);
        if (numMatch) {
          result.failedTests = parseInt(numMatch[0], 10);
          break;
        }
      }
    }

    result.totalTests = (result.passedTests || 0) + (result.failedTests || 0);

    return result;
  }

  /**
   * Parse coverage table from output
   */
  private parseCoverageTable(output: string): CoverageInfo | null {
    // Look for coverage summary
    // Format: "Statements   : 85.5% ( 171/200 )"
    const stmtMatch = output.match(/Statements?\s*:?\s*([\d.]+)%/i);
    const branchMatch = output.match(/Branches?\s*:?\s*([\d.]+)%/i);
    const funcMatch = output.match(/Functions?\s*:?\s*([\d.]+)%/i);
    const lineMatch = output.match(/Lines?\s*:?\s*([\d.]+)%/i);

    if (stmtMatch || branchMatch || funcMatch || lineMatch) {
      return {
        statements: parseFloat(stmtMatch?.[1] || '0'),
        branches: parseFloat(branchMatch?.[1] || '0'),
        functions: parseFloat(funcMatch?.[1] || '0'),
        lines: parseFloat(lineMatch?.[1] || '0'),
        uncoveredFiles: [],
      };
    }

    // Alternative: Single coverage percentage
    // Format: "Coverage: 85%"
    const coverageMatch = output.match(/coverage:?\s*([\d.]+)%/i);
    if (coverageMatch) {
      const coverage = parseFloat(coverageMatch[1]);
      return {
        statements: coverage,
        branches: coverage,
        functions: coverage,
        lines: coverage,
        uncoveredFiles: [],
      };
    }

    return null;
  }

  /**
   * Extract error message from output near a match
   */
  private extractErrorMessage(output: string, marker: string): string {
    const idx = output.indexOf(marker);
    if (idx === -1) return '';

    // Get the next 500 characters and try to find the error
    const snippet = output.substring(idx, idx + 500);

    // Look for common error patterns
    const errorMatch = snippet.match(/(?:Error|AssertionError|TypeError|ReferenceError):\s*(.+?)(?:\n|$)/);
    if (errorMatch) {
      return errorMatch[1].trim();
    }

    const expectMatch = snippet.match(/expect\(.+?\)\.(.+?)(?:\n|$)/);
    if (expectMatch) {
      return `Expected ${expectMatch[1]}`;
    }

    return '';
  }

  /**
   * Determine overall status
   */
  private determineStatus(parsed: Partial<TestResult>): TestResult['status'] {
    if ((parsed.failedTests || 0) > 0) {
      return 'failed';
    }
    if ((parsed.passedTests || 0) > 0) {
      return 'passed';
    }
    if (parsed.totalTests === 0) {
      return 'unknown';
    }
    return 'error';
  }

  // ============================================================================
  // RESULT MANAGEMENT
  // ============================================================================

  /**
   * Add a test result to the buffer
   */
  private addTestResult(result: TestResult): void {
    this.testResults.unshift(result);

    if (this.testResults.length > MAX_TEST_RESULTS) {
      this.testResults = this.testResults.slice(0, MAX_TEST_RESULTS);
    }
  }

  /**
   * Get recent test results
   */
  getRecentResults(limit = 20, sessionId?: string): TestResult[] {
    let results = this.testResults;

    if (sessionId) {
      results = results.filter(r => r.sessionId === sessionId);
    }

    return results.slice(0, limit);
  }

  /**
   * Get test result by ID
   */
  getResult(id: string): TestResult | null {
    return this.testResults.find(r => r.id === id) || null;
  }

  /**
   * Get test statistics
   */
  getStats(sessionId?: string): TestStats {
    let results = this.testResults;
    if (sessionId) {
      results = results.filter(r => r.sessionId === sessionId);
    }

    let totalPassed = 0;
    let totalFailed = 0;
    let totalSkipped = 0;
    let totalDuration = 0;
    const byFramework: Record<string, number> = {};

    for (const result of results) {
      totalPassed += result.passedTests;
      totalFailed += result.failedTests;
      totalSkipped += result.skippedTests;
      totalDuration += result.durationMs;
      byFramework[result.framework] = (byFramework[result.framework] || 0) + 1;
    }

    const totalTests = totalPassed + totalFailed;
    const successRate = totalTests > 0 ? (totalPassed / totalTests) * 100 : 0;
    const avgDuration = results.length > 0 ? totalDuration / results.length : 0;

    return {
      totalRuns: results.length,
      totalPassed,
      totalFailed,
      totalSkipped,
      successRate,
      avgDuration,
      byFramework,
      recentResults: results.slice(0, 5),
    };
  }

  /**
   * Clear all test results
   */
  clear(): void {
    this.testResults = [];
    this.emit('results:cleared');
  }

  // ============================================================================
  // UTILITY METHODS
  // ============================================================================

  /**
   * Generate a unique ID
   */
  private generateId(): string {
    return `tr-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
  }

  /**
   * Truncate output to reasonable size
   */
  private truncateOutput(output: string): string {
    const maxLength = 50000;
    if (output.length <= maxLength) return output;
    return output.substring(0, maxLength) + '\n... (output truncated)';
  }

  /**
   * Notify the renderer process
   */
  private notifyRenderer(channel: string, data: unknown): void {
    const mainWindow = getMainWindow();
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send(channel, data);
    }
  }
}

// ============================================================================
// SINGLETON INSTANCE
// ============================================================================

let testMonitor: TestMonitorService | null = null;

export function getTestMonitor(): TestMonitorService {
  if (!testMonitor) {
    testMonitor = new TestMonitorService();
  }
  return testMonitor;
}

export function startTestMonitor(): void {
  const monitor = getTestMonitor();
  monitor.start();
}

export function stopTestMonitor(): void {
  if (testMonitor) {
    testMonitor.stop();
  }
}

export { TestMonitorService };
