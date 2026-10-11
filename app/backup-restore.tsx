'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DatabaseBackup, Download, RefreshCw, Upload, X } from 'lucide-react';
import type { RecoveryBackup } from '../lib/hostinger/recovery';
import './backup-restore.css';

const fileSize = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
export default function BackupRestore({ revision }: { revision: number }) {
  const router = useRouter();
  const [backups, setBackups] = useState<RecoveryBackup[]>([]), [password, setPassword] = useState(''), [confirmPassword, setConfirmPassword] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const [file, setFile] = useState<File | null>(null), [restorePassword, setRestorePassword] = useState(''), [confirmation, setConfirmation] = useState('');
  async function refresh() {
    try { const response = await fetch('/api/recovery', { cache: 'no-store' }), data = await response.json(); if (!response.ok) throw new Error(data.error); setBackups(data.backups); }
    catch (failure) { setError(failure instanceof Error ? failure.message : 'Backups could not load.'); }
  }
  useEffect(() => {
    const controller = new AbortController();
    void fetch('/api/recovery', { cache: 'no-store', signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.error); return data; })
      .then(data => { if (!controller.signal.aborted) setBackups(data.backups); })
      .catch(failure => { if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : 'Backups could not load.'); });
    return () => controller.abort();
  }, []);
  async function create(event: React.FormEvent) {
    event.preventDefault(); setError(''); setMessage('');
    if (password !== confirmPassword) { setError('Backup passwords do not match.'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/recovery', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', password }) }), data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Backup could not be created.');
      setBackups(data.backups); setPassword(''); setConfirmPassword('');
      setMessage(`Recovery backup saved. ${data.backup.application === 'none' ? 'App files were unavailable; keep your deployment source separately. ' : ''}Download a copy and keep its password separately.`);
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Backup could not be created.'); }
    finally { setBusy(false); }
  }
  async function restore(event: React.FormEvent) {
    event.preventDefault(); if (!file || confirmation !== 'RESTORE') return;
    setBusy(true); setError(''); setMessage('');
    try {
      const response = await fetch('/api/recovery', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'X-Recovery-Password': encodeURIComponent(restorePassword), 'X-Restore-Confirmed': confirmation, 'X-Workspace-Revision': String(revision) }, body: file }), data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Recovery could not complete.');
      setRestorePassword(''); setMessage('Recovery complete. Sign in again with a restored account.'); router.replace('/login');
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Recovery could not complete.'); }
    finally { setBusy(false); }
  }
  return <section className="records-card recovery-card">
    <div className="card-heading"><h3><DatabaseBackup size={18} />Full backup & restore</h3></div>
    <div className="recovery-body">
      <p>Save the database, records, users, passwords, notifications, uploaded files, recovery configuration and available app files in one password protected archive. Backups stay in private storage at <code>ERP_DATA_DIR/backups</code>.</p>
      <form onSubmit={create} className="recovery-form">
        <label className="form-field"><span>Backup password</span><input type="password" autoComplete="new-password" minLength={12} maxLength={256} required disabled={busy} value={password} onChange={event => setPassword(event.target.value)} placeholder="At least 12 characters" /></label>
        <label className="form-field"><span>Confirm backup password</span><input type="password" autoComplete="new-password" minLength={12} maxLength={256} required disabled={busy} value={confirmPassword} onChange={event => setConfirmPassword(event.target.value)} /></label>
        <button type="submit" className="button primary" disabled={busy}><DatabaseBackup size={16} />{busy ? 'Working…' : 'Create full backup'}</button>
      </form>
      <div className="recovery-actions"><label className="button"><Upload size={16} />Restore from file<input className="hidden" type="file" accept=".itsss-backup" disabled={busy} onChange={event => { const selected = event.target.files?.[0]; event.target.value = ''; if (!selected) return; if (selected.size > 2 * 1024 ** 3) { setError('Choose a recovery archive smaller than 2 GB.'); return; } setFile(selected); setRestorePassword(''); setConfirmation(''); setError(''); }} /></label><button type="button" className="button" disabled={busy} onClick={() => { setError(''); void refresh(); }}><RefreshCw size={15} />Refresh backups</button></div>
      <p>Keep a downloaded copy on another device or drive, and keep its password separately. If the app cannot start, use the recovery command included with the app.</p>
      {error && <p role="alert" className="form-errors">{error}</p>}{message && <p role="status">{message}</p>}
      <ul className="recovery-backups">{backups.map(backup => <li key={backup.id}><span><strong>{backup.safety ? 'Before restore safety backup' : 'Full recovery backup'}</strong><small>{new Date(backup.createdAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} · {fileSize(backup.size)}</small></span><a className="button small" href={`/api/recovery?download=${encodeURIComponent(backup.id)}`}><Download size={15} />Download</a></li>)}</ul>
      {!backups.length && <p>No full recovery backups saved yet.</p>}
    </div>
    {file && <div className="modal-scrim"><form className="confirm-dialog recovery-dialog" onSubmit={restore} role="dialog" aria-modal="true" aria-labelledby="restore-recovery-title"><button type="button" className="icon-button recovery-close" aria-label="Cancel restore" disabled={busy} onClick={() => setFile(null)}><X size={18} /></button><DatabaseBackup size={28} /><h2 id="restore-recovery-title">Restore all app data?</h2><p><strong>{file.name}</strong> ({fileSize(file.size)})</p><p>This replaces records, users, passwords, notification history and uploaded files with the backup. Everyone will be signed out. A safety backup of the current data is saved first using the password below. App files can be recovered using the offline command.</p><label className="form-field"><span>Password for this backup</span><input type="password" autoComplete="off" required minLength={12} disabled={busy} value={restorePassword} onChange={event => setRestorePassword(event.target.value)} /></label><label className="form-field"><span>Type RESTORE to confirm</span><input autoComplete="off" required disabled={busy} value={confirmation} onChange={event => setConfirmation(event.target.value)} /></label>{error && <p role="alert" className="form-errors">{error}</p>}<div><button type="button" className="button" disabled={busy} onClick={() => setFile(null)}>Cancel</button><button type="submit" className="button danger" disabled={busy || confirmation !== 'RESTORE'}>{busy ? 'Restoring…' : 'Restore all data'}</button></div></form></div>}
  </section>;
}
