import { runtimeDatabase } from './database.ts';
import { inboxNotifications } from '../notifications.ts';
import type { AccessUser } from '../access.ts';
import type { Store } from '../schema.ts';

export function notificationReadDates(memberId?: string): Record<string, string> {
  if (!memberId) return {};
  const rows = runtimeDatabase().prepare('SELECT notification_id, read_at FROM notification_reads WHERE member_id = ?').all(memberId);
  return Object.fromEntries(rows.map(row => [String(row.notification_id), String(row.read_at)]));
}

export function markNotificationsRead(store: Store, user: AccessUser, ids: unknown, now = new Date()) {
  if (!user.memberId) throw new Error('FORBIDDEN: An active workspace membership is required.');
  const visible = new Set(inboxNotifications(store, user).map(row => row.id));
  const targets = ids === undefined ? [...visible] : ids;
  if (!Array.isArray(targets) || targets.some(id => typeof id !== 'string' || !visible.has(id))) throw new Error('FORBIDDEN: You can only mark notifications in your own inbox.');
  const database = runtimeDatabase(), statement = database.prepare('INSERT INTO notification_reads (member_id, notification_id, read_at) VALUES (?, ?, ?) ON CONFLICT (member_id, notification_id) DO NOTHING');
  database.exec('BEGIN IMMEDIATE');
  try {
    for (const id of new Set(targets)) statement.run(user.memberId, id, now.toISOString());
    database.exec('COMMIT');
  } catch (error) { database.exec('ROLLBACK'); throw error; }
}
