"use client";

import { useEffect, useRef, useState } from 'react';
import { KeyRound, X } from 'lucide-react';

type Props = {
  member: { id: string; name: string; email: string };
  mode: 'reset' | 'change';
  revision: number;
  minimumLength: number;
  close: () => void;
  saved: () => Promise<void>;
  refresh: () => Promise<void>;
};

export default function PasswordDialog({ member, mode, revision, minimumLength, close, saved, refresh }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const changing = mode === 'change';

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.querySelector<HTMLInputElement>('input')?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) { setError('Passwords do not match.'); return; }
    if (password.length < minimumLength || new TextEncoder().encode(password).length > 256) { setError(`Use a password of at least ${minimumLength} characters and at most 256 bytes.`); return; }
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/auth/password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ memberId: member.id, mode, password, currentPassword: changing ? currentPassword : undefined, revision }) });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 409) await refresh();
        throw new Error(result.error || 'Unable to save the password.');
      }
      setPassword(''); setConfirmation(''); setCurrentPassword('');
      // Reload to discard authenticated client state after revoking its session.
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      if (result.signInAgain) { window.location.assign('/login?return_to=/'); return; }
      await saved();
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Unable to save the password.'); }
    finally { setBusy(false); }
  }

  return <div className="modal-scrim" onMouseDown={event => { if (event.target === event.currentTarget && !busy) close(); }}>
    <div ref={dialog} className="record-modal password-modal" role="dialog" aria-modal="true" aria-labelledby="password-dialog-title" onKeyDown={event => {
      if (event.key === 'Escape') { event.stopPropagation(); if (!busy) close(); }
      if (event.key !== 'Tab') return;
      const controls = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') || []);
      const first = controls[0], last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }}>
      <div className="modal-header"><div><div className="eyebrow">ACCOUNT SECURITY</div><h2 id="password-dialog-title">{changing ? 'Change your password' : 'Set user password'}</h2><p>{member.name} · {member.email}</p></div><button type="button" className="icon-button" aria-label="Close password dialog" disabled={busy} onClick={close}><X size={18}/></button></div>
      <form onSubmit={submit}>
        <div className="modal-body">
          {error && <div className="form-errors" role="alert">{error}</div>}
          <div className="form-grid">
            {changing && <label className="form-field wide"><span>Current password</span><input name="currentPassword" type={show ? 'text' : 'password'} autoComplete="current-password" value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} required disabled={busy}/></label>}
            <label className="form-field wide"><span>New password</span><input name="newPassword" type={show ? 'text' : 'password'} autoComplete="new-password" minLength={minimumLength} value={password} onChange={event => setPassword(event.target.value)} required disabled={busy}/></label>
            <label className="form-field wide"><span>Confirm new password</span><input name="confirmPassword" type={show ? 'text' : 'password'} autoComplete="new-password" minLength={minimumLength} value={confirmation} onChange={event => setConfirmation(event.target.value)} required disabled={busy}/></label>
            <label className="checkbox-field"><input type="checkbox" checked={show} onChange={event => setShow(event.target.checked)} disabled={busy}/>Show passwords</label>
          </div>
          <p className="password-help">Use at least {minimumLength} characters. The user will need to sign in again after the password is saved.</p>
        </div>
        <div className="modal-footer"><span className="form-note"><KeyRound size={14}/>Login password</span><div><button type="button" className="button" disabled={busy} onClick={close}>Cancel</button><button type="submit" className="button primary" disabled={busy}>{busy ? 'Saving…' : changing ? 'Change password' : 'Save password'}</button></div></div>
      </form>
    </div>
  </div>;
}
