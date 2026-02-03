// ============================================================================
// TEST MONITOR SERVICE - Main exports
// ============================================================================

import { TestMonitorService } from './service.js';

// Re-export types
export type {
  TestResult,
  TestFramework,
  TestSuite,
  FailedTest,
  CoverageInfo,
  TestStats,
} from './types.js';

// Re-export the service class
export { TestMonitorService };

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
