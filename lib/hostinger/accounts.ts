import { resolveRole } from '../access.ts';
import type { Store } from '../schema.ts';
import { getHostingerConfig, type LoginAccount } from './config.ts';
import { runtimeDatabase } from './database.ts';

export type ManagedAccount = LoginAccount & { userId?: string };

export function loginAccount(email: string): ManagedAccount | undefined {
  const normalized = email.trim().toLowerCase();
  const configured = getHostingerConfig().accounts.find(account => account.email === normalized);
  const database = runtimeDatabase();
  const workspace = database.prepare('SELECT data FROM erp_workspace WHERE id = ?').get('main');
  // Environment accounts can sign in before the owner initializes the workspace.
  if (!workspace) return configured;
  const store = JSON.parse(String(workspace.data)) as Store;
  const member = (store.users || []).find(row => String(row.email || '').trim().toLowerCase() === normalized && !row.deletedAt && !row.archivedAt);
  if (!member || member.status !== 'Active' || resolveRole(member.role, store) === 'Unassigned') return undefined;
  const saved = database.prepare('SELECT password_hash, configuration_hash FROM auth_passwords WHERE member_id = ?').get(member.id);
  // Rotating an environment hash remains an emergency recovery mechanism.
  const useSaved = saved && (!saved.configuration_hash || saved.configuration_hash === configured?.passwordHash);
  const passwordHash = useSaved ? String(saved.password_hash) : configured?.passwordHash;
  if (!passwordHash) return undefined;
  return { email: normalized, name: String(member.name || configured?.name || normalized), passwordHash, userId: member.identityId || undefined };
}
