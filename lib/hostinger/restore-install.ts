import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, openSync, fsyncSync, closeSync } from 'node:fs';
import { join } from 'node:path';

const items = ['workspace.sqlite', 'workspace.sqlite-wal', 'workspace.sqlite-shm', 'files'];
type Journal = { stage: string; original: string[]; committed: boolean; includesConfiguration?: boolean };
function writeJournal(filename: string, journal: Journal) {
  writeFileSync(`${filename}.tmp`, JSON.stringify(journal), { mode: 0o600 });
  const handle = openSync(`${filename}.tmp`, 'r+');
  try { fsyncSync(handle); } finally { closeSync(handle); }
  renameSync(`${filename}.tmp`, filename);
}
/** Roll back an interrupted multi-file restore before SQLite or storage is opened. */
export function recoverPendingRestore(dataDirectory: string) {
  const filename = join(dataDirectory, '.restore-journal.json');
  if (!existsSync(filename)) return;
  const journal = JSON.parse(readFileSync(filename, 'utf8')) as Journal;
  const touched = [...items, ...(journal.includesConfiguration ? ['recovery-config.json'] : [])];
  if (!/^\.restore-[a-f0-9-]{36}$/.test(journal.stage) || !Array.isArray(journal.original) || journal.original.some(item => !touched.includes(item)) || typeof journal.committed !== 'boolean' || journal.includesConfiguration !== undefined && typeof journal.includesConfiguration !== 'boolean') throw new Error('Invalid restore recovery journal.');
  if (!journal.committed) for (const item of touched) {
    const destination = join(dataDirectory, item), old = join(dataDirectory, 'backups', journal.stage, 'previous', item);
    if (existsSync(old)) { rmSync(destination, { recursive: item === 'files', force: true }); renameSync(old, destination); }
    else if (!journal.original.includes(item)) rmSync(destination, { recursive: item === 'files', force: true });
  }
  rmSync(filename);
}
/** Synchronous installation prevents other requests observing a partial swap. */
export function installRecoveredData(dataDirectory: string, stage: string, closeDatabase: () => void, includesConfiguration = false) {
  if (!/^\.restore-[a-f0-9-]{36}$/.test(stage)) throw new Error('Invalid restore staging directory.');
  closeDatabase();
  recoverPendingRestore(dataDirectory);
  const directory = join(dataDirectory, 'backups', stage), previous = join(directory, 'previous'), filename = join(dataDirectory, '.restore-journal.json');
  mkdirSync(previous, { recursive: true, mode: 0o700 });
  const touched = [...items, ...(includesConfiguration ? ['recovery-config.json'] : [])];
  const journal: Journal = { stage, original: touched.filter(item => existsSync(join(dataDirectory, item))), committed: false, includesConfiguration };
  writeJournal(filename, journal);
  try {
    for (const item of journal.original) renameSync(join(dataDirectory, item), join(previous, item));
    renameSync(join(directory, 'prepared.sqlite'), join(dataDirectory, 'workspace.sqlite'));
    renameSync(join(directory, 'contents', 'files'), join(dataDirectory, 'files'));
    if (includesConfiguration) renameSync(join(directory, 'recovery-config.json'), join(dataDirectory, 'recovery-config.json'));
    journal.committed = true; writeJournal(filename, journal);
    rmSync(filename);
  } catch (error) { recoverPendingRestore(dataDirectory); throw error; }
}
