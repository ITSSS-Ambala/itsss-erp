import { isAbsolute, relative, resolve } from 'node:path';
import { validPasswordHash } from './password.ts';
export type LoginAccount = { email: string; name: string; passwordHash: string };
export function getHostingerConfig() {
  const fail = (message: string): never => { throw new Error(`CONFIG: ${message}`); };
  let origin: URL;
  try { origin = new URL(process.env.ERP_PUBLIC_URL || 'https://crm.itsss.co.in'); }
  catch { return fail('Set ERP_PUBLIC_URL to the application origin.'); }
  if (origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) fail('ERP_PUBLIC_URL must be an origin without a path or credentials.');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
  if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && loopback)) fail('ERP_PUBLIC_URL must use HTTPS. HTTP is allowed only on loopback for local development.');
  const configuredDirectory = process.env.ERP_DATA_DIR;
  if (!configuredDirectory && process.env.NODE_ENV === 'production') fail('Set ERP_DATA_DIR to an absolute private persistent directory outside the application deployment directory.');
  const dataDirectory = configuredDirectory || resolve('.erp-data');
  if (!isAbsolute(dataDirectory)) fail('ERP_DATA_DIR must be an absolute path.');
  if (dataDirectory.split(/[\\/]/).some(part => ['public_html', 'hbuilds'].includes(part.toLowerCase()))) fail('ERP_DATA_DIR must be outside public_html and hbuilds.');
  const fromApplication = relative(process.cwd(), dataDirectory);
  if (!loopback && (!fromApplication || (!fromApplication.startsWith('..') && !isAbsolute(fromApplication)))) fail('ERP_DATA_DIR must be outside the application directory so deployments do not erase records or files.');
  const vaultKey = process.env.ERP_VAULT_KEY || '';
  const keyBytes = Buffer.from(vaultKey, 'base64');
  if (keyBytes.length !== 32 || keyBytes.toString('base64') !== vaultKey) fail('Set ERP_VAULT_KEY to a base64-encoded 32-byte key.');
  const ownerEmail = (process.env.ERP_ADMIN_EMAIL || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail) || ownerEmail.length > 254) fail('Set ERP_ADMIN_EMAIL to the administrator email address.');
  const ownerHash = process.env.ERP_ADMIN_PASSWORD_HASH || '';
  if (!validPasswordHash(ownerHash)) fail('Set ERP_ADMIN_PASSWORD_HASH using npm run auth:hash.');
  const owner: LoginAccount = { email: ownerEmail, name: process.env.ERP_ADMIN_NAME?.trim() || 'Administrator', passwordHash: ownerHash };
  let additional: unknown = [];
  try { additional = JSON.parse(process.env.ERP_AUTH_USERS || '[]'); }
  catch { fail('ERP_AUTH_USERS must be a JSON array of email, name and passwordHash objects.'); }
  if (!Array.isArray(additional) || additional.length > 100) fail('ERP_AUTH_USERS must contain at most 100 accounts.');
  const accounts = [owner];
  for (const raw of additional as unknown[]) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('Invalid account in ERP_AUTH_USERS.');
    const row = raw as Record<string, unknown>;
    const email = typeof row.email === 'string' ? row.email.trim().toLowerCase() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || typeof row.passwordHash !== 'string' || !validPasswordHash(row.passwordHash)) fail('Invalid email or password hash in ERP_AUTH_USERS.');
    if (accounts.some(account => account.email === email)) fail('ERP_AUTH_USERS contains a duplicate email.');
    accounts.push({ email, name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 200) : email, passwordHash: row.passwordHash as string });
  }
  const sessionHours = Number(process.env.ERP_SESSION_HOURS || 12);
  if (!Number.isInteger(sessionHours) || sessionHours < 1 || sessionHours > 168) fail('ERP_SESSION_HOURS must be an integer from 1 to 168.');
  return { origin: origin.origin, secure: origin.protocol === 'https:', dataDirectory: resolve(dataDirectory), vaultKey, ownerEmail, accounts, sessionSeconds: sessionHours * 3600 };
}
