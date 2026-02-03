// ============================================================================
// TEST OUTPUT PARSER - Parse test output from various frameworks
// ============================================================================

import type { TestResult, TestFramework, CoverageInfo } from './types.js';

// ============================================================================
// FRAMEWORK DETECTION
// ============================================================================

/**
 * Detect the test framework from command and output
 */
export function detectFramework(command: string, output: string): TestFramework {
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

// ============================================================================
// JEST PARSER
// ============================================================================

/**
 * Parse Jest output
 */
export function parseJestOutput(output: string): Partial<TestResult> {
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
      error: extractErrorMessage(output, match[0]),
      stack: null,
      file: null,
      line: null,
    });
  }

  // Parse coverage
  result.coverage = parseCoverageTable(output);

  return result;
}

// ============================================================================
// VITEST PARSER
// ============================================================================

/**
 * Parse Vitest output
 */
export function parseVitestOutput(output: string): Partial<TestResult> {
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
  result.coverage = parseCoverageTable(output);

  return result;
}

// ============================================================================
// MOCHA PARSER
// ============================================================================

/**
 * Parse Mocha output
 */
export function parseMochaOutput(output: string): Partial<TestResult> {
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
      error: extractErrorMessage(output, match[0]),
      stack: null,
      file: null,
      line: null,
    });
  }

  return result;
}

// ============================================================================
// PYTEST PARSER
// ============================================================================

/**
 * Parse pytest output
 */
export function parsePytestOutput(output: string): Partial<TestResult> {
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

// ============================================================================
// GO TEST PARSER
// ============================================================================

/**
 * Parse Go test output
 */
export function parseGoTestOutput(output: string): Partial<TestResult> {
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

// ============================================================================
// CARGO TEST PARSER
// ============================================================================

/**
 * Parse Cargo test output
 */
export function parseCargoTestOutput(output: string): Partial<TestResult> {
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

// ============================================================================
// GENERIC PARSER
// ============================================================================

/**
 * Parse generic test output (fallback)
 */
export function parseGenericTestOutput(output: string): Partial<TestResult> {
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

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Parse coverage table from output
 */
export function parseCoverageTable(output: string): CoverageInfo | null {
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
export function extractErrorMessage(output: string, marker: string): string {
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
 * Determine overall status from parsed result
 */
export function determineStatus(parsed: Partial<TestResult>): TestResult['status'] {
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
