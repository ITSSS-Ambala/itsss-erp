'use client';
import { useState, type FormEvent } from 'react';
import './login.css';

export default function LoginForm({ returnTo }: { returnTo: string }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true); setError('');
    try {
      const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: form.get('email'), password: form.get('password'), returnTo }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Unable to sign in.');
      window.location.assign(data.returnTo || '/');
    } catch (caught) { setError(caught instanceof Error ? caught.message : 'Unable to sign in.'); setBusy(false); }
  }
  return <main className="login-shell"><section className="login-card">
    <img src="/favicon.svg" width="42" height="42" alt="ITSSS" />
    <p className="login-eyebrow">ITSSS BUSINESS HUB</p><h1>Welcome back.</h1><p className="login-description">Sign in to manage your customers, projects and team.</p>
    <form onSubmit={submit}>
      <label htmlFor="login-email">Email address</label><input id="login-email" name="email" type="email" autoComplete="username" maxLength={254} required disabled={busy} />
      <label htmlFor="login-password">Password</label><input id="login-password" name="password" type="password" autoComplete="current-password" required disabled={busy} />
      {error && <p className="login-error" role="alert">{error}</p>}
      <button type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form><p className="login-help">Need access? Contact your workspace administrator.</p>
  </section></main>;
}
