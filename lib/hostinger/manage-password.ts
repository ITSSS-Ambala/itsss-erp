import { createHash, randomUUID } from 'node:crypto';
import { permit, resolveRole, type AccessUser } from '../access.ts';
import type { Store } from '../schema.ts';
import { sealVault } from '../vault.ts';
import { loginAccount } from './accounts.ts';
import { getHostingerConfig } from './config.ts';
import { runtimeDatabase } from './database.ts';
import { hashPassword, verifyPassword } from './password.ts';

type PasswordChange = { memberId: string; password: string; mode: 'reset' | 'change'; currentPassword?: string };
type PasswordActor = { device?: string; ip?: string };

export async function managePassword(store: Store, revision: number, user: AccessUser, change: PasswordChange, actor: PasswordActor = {}) {
  if (!['reset', 'change'].includes(change.mode)) throw new Error('Choose a password action.');
  if (change.mode === 'reset' && !permit(user.role, 'users', 'edit', store)) throw new Error('FORBIDDEN: Only administrators can set user passwords.');
  if (change.mode === 'change' && change.memberId !== user.memberId) throw new Error('FORBIDDEN: You can only change your own password.');
  const target = (store.users || []).find(row => row.id === change.memberId && !row.deletedAt && !row.archivedAt);
  if (!target || target.status !== 'Active' || resolveRole(target.role, store) === 'Unassigned') throw new Error('Choose an active user with an active role before setting a password.');
  const email = String(target.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Save a valid email address for this user first.');
  const configuredMinimum = Number(store.settings?.[0]?.passwordMinLength);
  const minimum = Number.isInteger(configuredMinimum) ? Math.max(12, configuredMinimum) : 12;
  if (typeof change.password !== 'string' || change.password.length < minimum || Buffer.byteLength(change.password) > 256) throw new Error(`Use a password of at least ${minimum} characters and at most 256 bytes.`);

  const database = runtimeDatabase();
  const attemptKey = createHash('sha256').update(`password-change:${target.id}`).digest('hex');
  if (change.mode === 'change') {
    const now = Date.now();
    database.prepare('DELETE FROM auth_attempts WHERE started_at < ?').run(now - 15 * 60_000);
    database.prepare('INSERT INTO auth_attempts (account_key, started_at, attempts) VALUES (?, ?, 1) ON CONFLICT(account_key) DO UPDATE SET attempts = attempts + 1').run(attemptKey, now);
    const attempts = database.prepare('SELECT attempts FROM auth_attempts WHERE account_key = ?').get(attemptKey)!;
    if (Number(attempts.attempts) > 10) throw new Error('RATE_LIMIT: Too many password attempts. Try again in 15 minutes.');
    const account = loginAccount(email);
    if (!account || typeof change.currentPassword !== 'string' || !await verifyPassword(change.currentPassword, account.passwordHash)) throw new Error('Current password is incorrect.');
  }
  const passwordHash = await hashPassword(change.password);
  const configurationHash = getHostingerConfig().accounts.find(account => account.email === email)?.passwordHash || null;
  const next = structuredClone(store);
  const now = new Date().toISOString();
  // Audit the action only; credentials never enter records, responses or backups.
  next.auditLogs = [...(next.auditLogs || []), { id: `AUD-${randomUUID()}`, name: change.mode === 'reset' ? 'User password set' : 'User password changed', actor: user.displayName, actorId: user.userId, action: change.mode === 'reset' ? 'resetPassword' : 'changePassword', module: 'users', recordId: target.id, date: now, device: actor.device || 'Web browser', ip: actor.ip || 'Unavailable', oldValue: '', newValue: JSON.stringify({ passwordChanged: true }) }];
  const encrypted = await sealVault(next, getHostingerConfig().vaultKey);
  database.exec('BEGIN IMMEDIATE');
  try {
    const updated = database.prepare('UPDATE erp_workspace SET data = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?').run(JSON.stringify(encrypted), now, 'main', revision);
    if (Number(updated.changes) !== 1) throw new Error('CONFLICT: Another update arrived. Refresh and try again.');
    database.prepare('INSERT INTO auth_passwords (member_id, password_hash, configuration_hash) VALUES (?, ?, ?) ON CONFLICT(member_id) DO UPDATE SET password_hash = excluded.password_hash, configuration_hash = excluded.configuration_hash').run(target.id, passwordHash, configurationHash);
    database.prepare('DELETE FROM auth_sessions WHERE email = ?').run(email);
    database.prepare('DELETE FROM auth_attempts WHERE account_key IN (?, ?)').run(attemptKey, createHash('sha256').update(email).digest('hex'));
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
  return { revision: revision + 1, signInAgain: target.id === user.memberId };
}
