// ============================================================================
// TEST MONITOR SERVICE - Parse and track test results from Bash commands
// ============================================================================

import { EventEmitter } from 'events';
import { Logger } from '../logger.js';
import { formatTimestamp } from '../../../shared/dateUtils.js';
import { getMainWindow } from '../../window.js';
import { getHookServer, type HookPayload } from '../hookServer.js';
import type { TestResult, TestStats } from './types.js';
import {
  detectFramework,
  parseJestOutput,
  parseVitestOutput,
  parseMochaOutput,
  parsePytestOutput,
  parseGoTestOutput,
  parseCargoTestOutput,
  parseGenericTestOutput,
  determineStatus,
} from './parser.js';

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
// TEST MONITOR SERVICE
// ============================================================================

export class TestMonitorService extends EventEmitter {
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
    const framework = detectFramework(command, output);

    let parsed: Partial<TestResult> = {};

    switch (framework) {
      case 'jest':
        parsed = parseJestOutput(output);
        break;
      case 'vitest':
        parsed = parseVitestOutput(output);
        break;
      case 'mocha':
        parsed = parseMochaOutput(output);
        break;
      case 'pytest':
        parsed = parsePytestOutput(output);
        break;
      case 'go':
        parsed = parseGoTestOutput(output);
        break;
      case 'cargo':
        parsed = parseCargoTestOutput(output);
        break;
      default:
        parsed = parseGenericTestOutput(output);
    }

    const result: TestResult = {
      id: this.generateId(),
      sessionId,
      projectPath,
      command,
      timestamp: formatTimestamp(),
      durationMs,
      status: determineStatus(parsed),
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
