// ============================================================================
// DATABASE - Message Operations
// ============================================================================

import { getDatabase } from './connection.js';
import type { SessionMessage } from '../../shared/types/index.js';
import { mapRowToMessage, type MessageRow } from './mappers.js';

// ============================================================================
// MESSAGE OPERATIONS
// ============================================================================

export function storeMessages(sessionId: string, messages: Partial<SessionMessage>[]): void {
  const database = getDatabase();

  // Delete existing messages
  database.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);

  // Insert new messages
  const insert = database.prepare(`
    INSERT INTO messages (session_id, message_index, role, content, timestamp, token_count, tool_name, tool_input, tool_result)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = database.transaction((msgs: Partial<SessionMessage>[]) => {
    msgs.forEach((msg, index) => {
      insert.run(
        sessionId,
        index,
        msg.role ?? 'unknown',
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        msg.timestamp ?? null,
        msg.tokenCount ?? 0,
        msg.toolName ?? null,
        msg.toolInput ?? null,
        msg.toolResult ?? null
      );
    });
  });

  insertMany(messages);
}

export function getSessionMessages(sessionId: string): SessionMessage[] {
  const database = getDatabase();
  const rows = database.prepare('SELECT * FROM messages WHERE session_id = ? ORDER BY message_index ASC').all(sessionId) as MessageRow[];
  return rows.map(mapRowToMessage);
}
