import { createHash, randomBytes } from 'node:crypto';
import { getHostingerConfig, type LoginAccount } from './config.ts';
import { runtimeDatabase } from './database.ts';
import { verifyPassword } from './password.ts';
export type ApplicationUser = { userId: string; displayName: string; email: string; fullName: string | null };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const identityFor = (account: LoginAccount): ApplicationUser => ({ userId: `hostinger:${digest(account.email)}`, displayName: account.name, email: account.email, fullName: account.name });
export async function login(email: string, password: string) {
  const config = getHostingerConfig();
  const normalized = email.trim().toLowerCase();
  const account = config.accounts.find(candidate => candidate.email === normalized);
  const key = digest(account ? normalized : 'unknown-account');
  const database = runtimeDatabase();
  const now = Date.now();
  database.prepare('DELETE FROM auth_attempts WHERE started_at < ?').run(now - 15 * 60_000);
  database.prepare(`INSERT INTO auth_attempts (account_key, started_at, attempts) VALUES (?, ?, 1)
    ON CONFLICT(account_key) DO UPDATE SET attempts = attempts + 1`).run(key, now);
  const attempts = database.prepare('SELECT attempts FROM auth_attempts WHERE account_key = ?').get(key)!;
  if (Number(attempts.attempts) > 10) throw new Error('RATE_LIMIT: Too many sign-in attempts. Try again in 15 minutes.');
  const correct = await verifyPassword(password, (account || config.accounts[0]).passwordHash);
  if (!account || !correct) return null;
  database.prepare('DELETE FROM auth_attempts WHERE account_key = ?').run(key);
  database.prepare('DELETE FROM auth_sessions WHERE expires_at <= ?').run(now);
  const token = randomBytes(32).toString('base64url');
  database.prepare('INSERT INTO auth_sessions (token_hash, email, credential_hash, expires_at) VALUES (?, ?, ?, ?)').run(digest(token), account.email, digest(account.passwordHash), now + config.sessionSeconds * 1000);
  return { token, user: identityFor(account), maxAge: config.sessionSeconds };
}
export function sessionIdentity(token: string | undefined): ApplicationUser | null {
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const config = getHostingerConfig();
  const row = runtimeDatabase().prepare('SELECT email, credential_hash, expires_at FROM auth_sessions WHERE token_hash = ?').get(digest(token));
  if (!row || Number(row.expires_at) <= Date.now()) return null;
  const account = config.accounts.find(candidate => candidate.email === row.email);
  if (!account || digest(account.passwordHash) !== row.credential_hash) return null;
  return identityFor(account);
}
export function revokeSession(token: string | undefined) {
  if (token && /^[A-Za-z0-9_-]{43}$/.test(token)) runtimeDatabase().prepare('DELETE FROM auth_sessions WHERE token_hash = ?').run(digest(token));
}
export function sessionCookieName() { return getHostingerConfig().secure ? '__Host-itsss_session' : 'itsss_session'; }
export function safeReturnPath(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  try {
    const url = new URL(value, 'https://app.local');
    if (url.origin !== 'https://app.local' || /^\/(login|api\/auth|signin-with-chatgpt|signout-with-chatgpt)(\/|$)/.test(url.pathname)) return '/';
    return url.pathname + url.search + url.hash;
  } catch { return '/'; }
}
