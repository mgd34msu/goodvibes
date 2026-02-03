// ============================================================================
// PTY STREAM ANALYZER SERVICE - Re-export from modular structure
// ============================================================================
//
// This file maintains backward compatibility by re-exporting all functions
// from the modular ptyStreamAnalyzer/ directory.
//
// ============================================================================

export {
  getPTYStreamAnalyzer,
  shutdownPTYStreamAnalyzer,
  PTYStreamAnalyzerService,
  type StreamEvent,
  type StreamEventType,
  type ToolCall,
  type StreamMetrics,
  type PatternDefinition,
} from './ptyStreamAnalyzer/index.js';

// Internal utilities - import directly from './ptyStreamAnalyzer/patterns.js' if needed
export { isToolName, STREAM_PATTERNS } from './ptyStreamAnalyzer/patterns.js';
