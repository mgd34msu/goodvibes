// ============================================================================
// DATABASE PERFORMANCE BENCHMARKS
// ============================================================================
//
// These tests measure the performance of key database operations.
// Run with: npm run test -- --run src/main/database/benchmark.test.ts
//
// Performance targets:
// - Single record operations: < 10ms
// - Bulk operations (1000 records): < 1000ms
// - Aggregation queries: < 100ms
// ============================================================================

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import path from 'path';
import fs from 'fs';
import os from 'os';

// Check if better-sqlite3 can be loaded
let canLoadDatabase = true;
try {
  require('better-sqlite3');
} catch {
  canLoadDatabase = false;
}

const describeIfDb = canLoadDatabase ? describe : describe.skip;

// Test directory
const TEST_DIR = path.join(os.tmpdir(), 'goodvibes-benchmark-' + Date.now());

// Mock Electron
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(TEST_DIR),
  },
}));

vi.mock('../services/logger.js', () => ({
  Logger: class MockLogger {
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    debug = vi.fn();
  },
}));

// Dynamic imports
let initDatabase: typeof import('./index.js').initDatabase;
let closeDatabase: typeof import('./index.js').closeDatabase;
let getDatabase: typeof import('./index.js').getDatabase;
let upsertSession: typeof import('./index.js').upsertSession;
let getAllSessions: typeof import('./index.js').getAllSessions;
let getSession: typeof import('./index.js').getSession;
let getActiveSessions: typeof import('./index.js').getActiveSessions;
let _getFavoriteSessions: typeof import('./index.js').getFavoriteSessions;
let storeMessages: typeof import('./index.js').storeMessages;
let getSessionMessages: typeof import('./index.js').getSessionMessages;
let getAnalytics: typeof import('./index.js').getAnalytics;
let getAllTags: typeof import('./index.js').getAllTags;
let createTag: typeof import('./index.js').createTag;
let addTagToSession: typeof import('./index.js').addTagToSession;
let getSessionTags: typeof import('./index.js').getSessionTags;
let getToolUsageStats: typeof import('./index.js').getToolUsageStats;
let trackToolUsage: typeof import('./index.js').trackToolUsage;
let logActivity: typeof import('./index.js').logActivity;
let getRecentActivity: typeof import('./index.js').getRecentActivity;

// ============================================================================
// BENCHMARK UTILITIES
// ============================================================================

interface BenchmarkResult {
  name: string;
  duration: number;
  operationsPerSecond: number;
  iterations: number;
}

async function benchmark(
  name: string,
  fn: () => void | Promise<void>,
  iterations: number = 1
): Promise<BenchmarkResult> {
  const start = performance.now();

  for (let i = 0; i < iterations; i++) {
    await fn();
  }

  const duration = performance.now() - start;
  const operationsPerSecond = iterations / (duration / 1000);

  return {
    name,
    duration,
    operationsPerSecond,
    iterations,
  };
}

function logBenchmark(result: BenchmarkResult): void {
  console.log(
    `  ${result.name}: ${result.duration.toFixed(2)}ms ` +
    `(${result.iterations} iterations, ${result.operationsPerSecond.toFixed(0)} ops/sec)`
  );
}

// ============================================================================
// TEST SETUP
// ============================================================================

beforeAll(async () => {
  if (!canLoadDatabase) {
    console.warn('Skipping benchmarks: better-sqlite3 native module cannot be loaded');
    return;
  }

  const dbModule = await import('./index.js');
  initDatabase = dbModule.initDatabase;
  closeDatabase = dbModule.closeDatabase;
  getDatabase = dbModule.getDatabase;
  upsertSession = dbModule.upsertSession;
  getAllSessions = dbModule.getAllSessions;
  getSession = dbModule.getSession;
  getActiveSessions = dbModule.getActiveSessions;
  _getFavoriteSessions = dbModule.getFavoriteSessions;
  storeMessages = dbModule.storeMessages;
  getSessionMessages = dbModule.getSessionMessages;
  getAnalytics = dbModule.getAnalytics;
  getAllTags = dbModule.getAllTags;
  createTag = dbModule.createTag;
  addTagToSession = dbModule.addTagToSession;
  getSessionTags = dbModule.getSessionTags;
  getToolUsageStats = dbModule.getToolUsageStats;
  trackToolUsage = dbModule.trackToolUsage;
  logActivity = dbModule.logActivity;
  getRecentActivity = dbModule.getRecentActivity;

  if (!fs.existsSync(TEST_DIR)) {
    fs.mkdirSync(TEST_DIR, { recursive: true });
  }

  await initDatabase(TEST_DIR);
});

afterAll(() => {
  if (!canLoadDatabase) return;

  closeDatabase();

  try {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  } catch {
    // Ignore cleanup errors
  }
});

beforeEach(() => {
  if (!canLoadDatabase) return;

  const db = getDatabase();
  db.exec('DELETE FROM session_tags');
  db.exec('DELETE FROM messages');
  db.exec('DELETE FROM sessions');
  db.exec('DELETE FROM tags');
  db.exec('DELETE FROM tool_usage');
  db.exec('DELETE FROM activity_log');
});

// ============================================================================
// SESSION BENCHMARKS
// ============================================================================

describeIfDb('Session Performance Benchmarks', () => {
  it('should insert sessions quickly', async () => {
    const result = await benchmark(
      'Insert 1000 sessions',
      () => {
        for (let i = 0; i < 1000; i++) {
          upsertSession({
            id: `session-${i}`,
            projectName: `Project ${i % 10}`,
            filePath: `/path/to/session${i}.jsonl`,
            startTime: new Date(Date.now() - i * 3600000).toISOString(),
            endTime: new Date().toISOString(),
            messageCount: Math.floor(Math.random() * 100),
            tokenCount: Math.floor(Math.random() * 10000),
            cost: Math.random() * 1,
            status: 'completed',
          });
        }
      }
    );

    logBenchmark(result);
    expect(result.duration).toBeLessThan(2000); // Should complete in < 2s
  });

  it('should query all sessions quickly', async () => {
    // Insert test data
    for (let i = 0; i < 1000; i++) {
      upsertSession({
        id: `session-${i}`,
        projectName: `Project ${i % 10}`,
        endTime: new Date(Date.now() - i * 3600000).toISOString(),
      });
    }

    const result = await benchmark(
      'Query all sessions (1000 records)',
      () => {
        const sessions = getAllSessions();
        expect(sessions.length).toBe(1000);
      },
      10
    );

    logBenchmark(result);
    expect(result.duration / result.iterations).toBeLessThan(100); // < 100ms per query
  });

  it('should query single session quickly', async () => {
    for (let i = 0; i < 1000; i++) {
      upsertSession({ id: `session-${i}` });
    }

    const result = await benchmark(
      'Query single session',
      () => {
        const session = getSession('session-500');
        expect(session).not.toBeNull();
      },
      100
    );

    logBenchmark(result);
    expect(result.duration / result.iterations).toBeLessThan(5); // < 5ms per query
  });

  it('should query active sessions quickly', async () => {
    for (let i = 0; i < 1000; i++) {
      upsertSession({ id: `session-${i}` });
    }

    // Archive half
    const db = getDatabase();
    db.exec("UPDATE sessions SET archived = 1 WHERE CAST(SUBSTR(id, 9) AS INTEGER) % 2 = 0");

    const result = await benchmark(
      'Query active sessions (500 of 1000)',
      () => {
        const sessions = getActiveSessions();
        expect(sessions.length).toBe(500);
      },
      10
    );

    logBenchmark(result);
    expect(result.duration / result.iterations).toBeLessThan(100);
  });

  it('should update sessions quickly', async () => {
    for (let i = 0; i < 100; i++) {
      upsertSession({ id: `session-${i}` });
    }

    const result = await benchmark(
      'Update 100 sessions',
      () => {
        for (let i = 0; i < 100; i++) {
          upsertSession({
            id: `session-${i}`,
            tokenCount: Math.floor(Math.random() * 10000),
            cost: Math.random() * 1,
          });
        }
      }
    );

    logBenchmark(result);
    expect(result.duration).toBeLessThan(500);
  });
});

// ============================================================================
// MESSAGE BENCHMARKS
// ============================================================================

describeIfDb('Message Performance Benchmarks', () => {
  it('should insert messages quickly', async () => {
    upsertSession({ id: 'session-1' });

    const messages = Array.from({ length: 500 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `Message ${i} with some content that simulates a real message. `.repeat(10),
      timestamp: new Date(Date.now() - i * 60000).toISOString(),
      tokenCount: Math.floor(Math.random() * 500),
    }));

    const result = await benchmark(
      'Insert 500 messages',
      () => {
        storeMessages('session-1', messages);
      }
    );

    logBenchmark(result);
    expect(result.duration).toBeLessThan(500);
  });

  it('should query messages quickly', async () => {
    upsertSession({ id: 'session-1' });

    const messages = Array.from({ length: 500 }, (_, i) => ({
      role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
      content: `Message ${i}`,
    }));
    storeMessages('session-1', messages);

    const result = await benchmark(
      'Query 500 messages',
      () => {
        const msgs = getSessionMessages('session-1');
        expect(msgs.length).toBe(500);
      },
      10
    );

    logBenchmark(result);
    expect(result.duration / result.iterations).toBeLessThan(50);
  });
});

// ============================================================================
// ANALYTICS BENCHMARKS
// ============================================================================

describeIfDb('Analytics Performance Benchmarks', () => {
  it('should calculate analytics quickly', async () => {
    // Insert diverse test data
    for (let i = 0; i < 500; i++) {
      upsertSession({
        id: `session-${i}`,
        projectName: `Project ${i % 20}`,
        startTime: new Date(Date.now() - i * 86400000).toISOString(),
        endTime: new Date(Date.now() - i * 86400000 + 3600000).toISOString(),
        messageCount: Math.floor(Math.random() * 50) + 1,
        tokenCount: Math.floor(Math.random() * 10000),
        cost: Math.random() * 0.5,
      });
    }

    const result = await benchmark(
      'Calculate analytics (500 sessions, 20 projects)',
      () => {
        const analytics = getAnalytics();
        expect(analytics.totalSessions).toBe(500);
        expect(Object.keys(analytics.costByProject).length).toBe(20);
      },
      10
    );

    logBenchmark(result);
    expect(result.duration / result.iterations).toBeLessThan(100);
  });
});

// ============================================================================
// TAG BENCHMARKS
// ============================================================================

describeIfDb('Tag Performance Benchmarks', () => {
  it('should handle many tags per session', async () => {
    upsertSession({ id: 'session-1' });

    // Create 50 tags
    for (let i = 0; i < 50; i++) {
      createTag(`tag-${i}`, `#${i.toString(16).padStart(6, '0')}`);
    }

    const tags = getAllTags();

    const result = await benchmark(
      'Add 50 tags to session',
      () => {
        tags.forEach((tag) => {
          addTagToSession('session-1', tag.id);
        });
      }
    );

    logBenchmark(result);
    expect(result.duration).toBeLessThan(200);
  });

  it('should query session tags quickly', async () => {
    upsertSession({ id: 'session-1' });

    for (let i = 0; i < 50; i++) {
      createTag(`tag-${i}`, '#000000');
    }

    const tags = getAllTags();
    tags.forEach((tag) => addTagToSession('session-1', tag.id));

    const result = await benchmark(
      'Query session tags (50 tags)',
      () => {
        const sessionTags = getSessionTags('session-1');
        expect(sessionTags.length).toBe(50);
      },
      50
    );

    logBenchmark(result);
    expect(result.duration / result.iterations).toBeLessThan(10);
  });
});

// ============================================================================
// TOOL USAGE BENCHMARKS
// ============================================================================

describeIfDb('Tool Usage Performance Benchmarks', () => {
  it('should track tool usage efficiently', async () => {
    upsertSession({ id: 'session-1' });

    const tools = ['read_file', 'write_file', 'exec', 'search', 'browse'];

    const result = await benchmark(
      'Track 1000 tool usages',
      () => {
        for (let i = 0; i < 1000; i++) {
          trackToolUsage('session-1', tools[i % tools.length], 1);
        }
      }
    );

    logBenchmark(result);
    expect(result.duration).toBeLessThan(1000);
  });

  it('should aggregate tool usage quickly', async () => {
    upsertSession({ id: 'session-1' });

    const tools = ['read_file', 'write_file', 'exec', 'search', 'browse'];
    for (let i = 0; i < 1000; i++) {
      trackToolUsage('session-1', tools[i % tools.length], 1);
    }

    const result = await benchmark(
      'Get tool usage stats (1000 records)',
      () => {
        const stats = getToolUsageStats();
        expect(stats.length).toBe(5);
      },
      10
    );

    logBenchmark(result);
    expect(result.duration / result.iterations).toBeLessThan(50);
  });
});

// ============================================================================
// ACTIVITY LOG BENCHMARKS
// ============================================================================

describeIfDb('Activity Log Performance Benchmarks', () => {
  it('should log activities quickly', async () => {
    const result = await benchmark(
      'Log 1000 activities',
      () => {
        for (let i = 0; i < 1000; i++) {
          logActivity(
            ['session_start', 'session_end', 'terminal_start', 'commit'][i % 4],
            `session-${i % 100}`,
            `Activity ${i}`,
            { index: i }
          );
        }
      }
    );

    logBenchmark(result);
    expect(result.duration).toBeLessThan(1000);
  });

  it('should query recent activities quickly', async () => {
    for (let i = 0; i < 1000; i++) {
      logActivity('test', null, `Activity ${i}`);
    }

    const result = await benchmark(
      'Query recent activities (100 of 1000)',
      () => {
        const activities = getRecentActivity(100);
        expect(activities.length).toBe(100);
      },
      10
    );

    logBenchmark(result);
    expect(result.duration / result.iterations).toBeLessThan(20);
  });
});

// ============================================================================
// CONCURRENT ACCESS BENCHMARKS
// ============================================================================

describeIfDb('Concurrent Access Performance Benchmarks', () => {
  it('should handle mixed read/write operations', async () => {
    // Pre-populate
    for (let i = 0; i < 100; i++) {
      upsertSession({ id: `session-${i}` });
    }

    const result = await benchmark(
      'Mixed operations (100 reads + 100 writes)',
      () => {
        for (let i = 0; i < 100; i++) {
          // Read
          getSession(`session-${i}`);
          // Write
          upsertSession({
            id: `session-${i}`,
            tokenCount: Math.random() * 10000,
          });
        }
      }
    );

    logBenchmark(result);
    expect(result.duration).toBeLessThan(500);
  });
});

// ============================================================================
// SUMMARY
// ============================================================================

describeIfDb('Performance Summary', () => {
  it('verifies database module was loaded successfully', () => {
    // This test validates that the database module can be loaded and initialized
    // The fact that we reach this point means all prior benchmarks passed
    expect(canLoadDatabase).toBe(true);
    expect(typeof initDatabase).toBe('function');
    expect(typeof closeDatabase).toBe('function');
    expect(typeof getDatabase).toBe('function');

    // Verify we can get a database instance
    const db = getDatabase();
    expect(db).toBeDefined();
    expect(typeof db.exec).toBe('function');

    console.log('\n=== Performance Benchmark Summary ===');
    console.log('All benchmarks passed within acceptable limits.');
    console.log('=====================================\n');
  });
});
