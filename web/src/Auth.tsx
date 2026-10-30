import { useEffect, useState } from 'react';
import { api } from './api.ts';

type Mode = 'setup' | 'login' | 'invite';

export function AuthScreen({ mode, invite, onDone }: { mode: Mode; invite?: string; onDone: () => void }) {
  const [form, setForm] = useState({ login: '', email: '', username: '', name: '', password: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [inviteOk, setInviteOk] = useState<boolean | null>(null);

  useEffect(() => {
    if (mode !== 'invite' || !invite) return;
    api.get<{ email: string | null }>(`/auth/invite/${invite}`)
      .then((r) => { setInviteOk(true); if (r.email) setForm((f) => ({ ...f, email: r.email! })); })
      .catch((e) => { setInviteOk(false); setError(e.message); });
  }, [mode, invite]);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      if (mode === 'login') await api.post('/auth/login', { login: form.login, password: form.password });
      else if (mode === 'setup') await api.post('/auth/setup', form);
      else await api.post('/auth/signup', { ...form, invite });
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const title = mode === 'setup' ? 'Set up Tack' : mode === 'invite' ? 'Join Tack' : 'Sign in';
  return (
    <div className="auth">
      <form className="auth-card" onSubmit={submit}>
        <div className="brand big"><span className="logo" aria-hidden><i /><i /></span>Tack</div>
        <h1>{title}</h1>
        {mode === 'setup' && <p className="muted">Create the first account. It becomes the instance admin.</p>}
        {mode === 'invite' && inviteOk === false ? (
          <p className="error">{error}</p>
        ) : (
          <>
            {mode === 'login' ? (
              <label>Email or username<input autoFocus value={form.login} onChange={set('login')} autoComplete="username" required /></label>
            ) : (
              <>
                <label>Name<input autoFocus value={form.name} onChange={set('name')} required maxLength={80} /></label>
                <label>Username<input value={form.username} onChange={set('username')} required pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{1,31}" title="2–32 letters, digits, _ . -" autoComplete="username" /></label>
                <label>Email<input type="email" value={form.email} onChange={set('email')} required autoComplete="email" /></label>
              </>
            )}
            <label>Password<input type="password" value={form.password} onChange={set('password')} required minLength={mode === 'login' ? 1 : 8} autoComplete={mode === 'login' ? 'current-password' : 'new-password'} /></label>
            {error && <p className="error">{error}</p>}
            <button className="primary" disabled={busy}>{busy ? '…' : mode === 'login' ? 'Sign in' : 'Create account'}</button>
            {mode === 'login' && <p className="muted small">New here? Ask an admin for an invite link.</p>}
          </>
        )}
      </form>
    </div>
  );
}
