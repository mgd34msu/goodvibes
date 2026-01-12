// ============================================================================
// NOTIFICATION DATABASE OPERATIONS
// ============================================================================

import { getDatabase } from './connection.js';
import type { AppNotification, NotificationType } from '../../shared/types/index.js';

/**
 * Database row type for notifications table
 */
interface NotificationRow {
  id: number;
  type: NotificationType;
  title: string;
  message: string | null;
  priority: string;
  read: number;
  dismissed: number;
  session_id: string | null;
  created_at: string;
}

export function createNotification(
  type: NotificationType,
  title: string,
  message?: string,
  priority?: string,
  sessionId?: string
): number {
  const database = getDatabase();
  const result = database.prepare(`
    INSERT INTO notifications (type, title, message, priority, session_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(type, title, message ?? null, priority ?? 'normal', sessionId ?? null);
  return result.lastInsertRowid as number;
}

export function getNotifications(includeRead: boolean = false, limit: number = 50): AppNotification[] {
  const database = getDatabase();
  const sql = includeRead
    ? 'SELECT * FROM notifications WHERE dismissed = 0 ORDER BY created_at DESC LIMIT ?'
    : 'SELECT * FROM notifications WHERE read = 0 AND dismissed = 0 ORDER BY created_at DESC LIMIT ?';
  const rows = database.prepare(sql).all(limit) as NotificationRow[];
  return rows.map(mapRowToNotification);
}

export function getUnreadNotificationCount(): number {
  const database = getDatabase();
  const result = database.prepare('SELECT COUNT(*) as count FROM notifications WHERE read = 0 AND dismissed = 0').get() as { count: number };
  return result?.count ?? 0;
}

export function markNotificationRead(id: number): void {
  const database = getDatabase();
  database.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
}

export function markAllNotificationsRead(): void {
  const database = getDatabase();
  database.prepare('UPDATE notifications SET read = 1 WHERE read = 0').run();
}

export function dismissNotification(id: number): void {
  const database = getDatabase();
  database.prepare('UPDATE notifications SET dismissed = 1 WHERE id = ?').run(id);
}

export function dismissAllNotifications(): void {
  const database = getDatabase();
  database.prepare('UPDATE notifications SET dismissed = 1').run();
}

export function deleteOldNotifications(daysOld: number = 30): void {
  const database = getDatabase();
  database.prepare('DELETE FROM notifications WHERE created_at < datetime("now", "-" || ? || " days")').run(daysOld);
}

function mapRowToNotification(row: NotificationRow): AppNotification {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    message: row.message,
    priority: row.priority,
    read: Boolean(row.read),
    dismissed: Boolean(row.dismissed),
    sessionId: row.session_id,
    createdAt: row.created_at,
  };
}
