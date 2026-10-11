import { type DatabaseSync } from 'node:sqlite';

/** Preserve the original vault-sealed workspace and commit cleanup in one revision-checked transaction. */
export function saveWorkspaceMigration(database: DatabaseSync, encryptedData: string, revision: number, migration: string): number {
  const date = new Date().toISOString();
  database.exec('BEGIN IMMEDIATE');
  try {
    database.prepare(`INSERT OR IGNORE INTO erp_workspace_migrations (workspace_id, migration, revision, data, created_at)
      SELECT id, ?, revision, data, ? FROM erp_workspace WHERE id = ? AND revision = ?`)
      .run(migration, date, 'main', revision);
    const result = database.prepare('UPDATE erp_workspace SET data = ?, revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?')
      .run(encryptedData, date, 'main', revision);
    if (Number(result.changes) !== 1) throw new Error('CONFLICT: Another update arrived. Refresh and try again.');
    database.exec('COMMIT');
    return revision + 1;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
