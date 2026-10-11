import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { getHostingerConfig } from './config.ts';
import { recoverPendingRestore } from './restore-install.ts';
// Startup scripts and Next.js bundles may load separate copies of this module.
// Share the handle so restore closes every reader before replacing the database.
type DatabaseState = { connection?: DatabaseSync; path: string };
const processState = globalThis as typeof globalThis & { __itsssRuntimeDatabase?: DatabaseState };
const state = processState.__itsssRuntimeDatabase ||= { path: '' };
export function runtimeDatabase(): DatabaseSync {
  const { dataDirectory } = getHostingerConfig();
  const filename = join(dataDirectory, 'workspace.sqlite');
  if (state.connection && state.path === filename) return state.connection;
  closeRuntimeDatabase();
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  recoverPendingRestore(dataDirectory);
  const connection = new DatabaseSync(filename);
  try { initializeDatabase(connection); }
  catch (error) { connection.close(); throw error; }
  state.connection = connection; state.path = filename;
  return connection;
}
export function initializeDatabase(database: DatabaseSync) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS erp_workspace (
      id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS erp_workspace_migrations (
      workspace_id TEXT NOT NULL, migration TEXT NOT NULL, revision INTEGER NOT NULL,
      data TEXT NOT NULL, created_at TEXT NOT NULL,
      PRIMARY KEY (workspace_id, migration, revision)
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL,
      credential_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_passwords (
      member_id TEXT PRIMARY KEY NOT NULL, password_hash TEXT NOT NULL,
      configuration_hash TEXT
    );
    CREATE TABLE IF NOT EXISTS auth_attempts (
      account_key TEXT PRIMARY KEY NOT NULL, started_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notification_reads (
      member_id TEXT NOT NULL, notification_id TEXT NOT NULL, read_at TEXT NOT NULL,
      PRIMARY KEY (member_id, notification_id)
    );
    CREATE TABLE IF NOT EXISTS notification_clears (
      member_id TEXT NOT NULL, notification_id TEXT NOT NULL, cleared_at TEXT NOT NULL,
      PRIMARY KEY (member_id, notification_id)
    );
  `);
}
export function closeRuntimeDatabase() {
  state.connection?.close(); state.connection = undefined; state.path = '';
}
class WorkspaceStatement {
  private query: string;
  private parameters: SQLInputValue[];
  constructor(query: string, parameters: SQLInputValue[] = []) { this.query = query; this.parameters = parameters; }
  bind(...parameters: SQLInputValue[]) { return new WorkspaceStatement(this.query, parameters); }
  async first<T>(): Promise<T | null> {
    const row = runtimeDatabase().prepare(this.query).get(...this.parameters);
    return row ? { ...row } as T : null;
  }
  async run() {
    const result = runtimeDatabase().prepare(this.query).run(...this.parameters);
    return { meta: { changes: Number(result.changes) } };
  }
}
export const workspaceDatabase = { prepare: (query: string) => new WorkspaceStatement(query) };
