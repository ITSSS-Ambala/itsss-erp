import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { getHostingerConfig } from './config.ts';
let connection: DatabaseSync | undefined;
let connectionPath = '';
export function runtimeDatabase(): DatabaseSync {
  const { dataDirectory } = getHostingerConfig();
  const filename = join(dataDirectory, 'workspace.sqlite');
  if (connection && connectionPath === filename) return connection;
  connection?.close();
  mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
  connection = new DatabaseSync(filename);
  connectionPath = filename;
  connection.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = FULL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS erp_workspace (
      id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_sessions (
      token_hash TEXT PRIMARY KEY NOT NULL, email TEXT NOT NULL,
      credential_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS auth_attempts (
      account_key TEXT PRIMARY KEY NOT NULL, started_at INTEGER NOT NULL,
      attempts INTEGER NOT NULL
    );
  `);
  return connection;
}
export function closeRuntimeDatabase() {
  connection?.close(); connection = undefined; connectionPath = '';
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
