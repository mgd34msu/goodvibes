// ============================================================================
// TEST MONITOR SERVICE - Re-export from modular structure
// ============================================================================
//
// This file maintains backward compatibility by re-exporting all functions
// from the modular testMonitor/ directory.
//
// ============================================================================

export {
  getTestMonitor,
  startTestMonitor,
  stopTestMonitor,
  TestMonitorService,
  type TestResult,
  type TestFramework,
  type TestSuite,
  type FailedTest,
  type CoverageInfo,
  type TestStats,
} from './testMonitor/index.js';
