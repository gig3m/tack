import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { Avatar } from './lib.tsx';
import { useSession } from './App.tsx';

interface AdminUser { id: number; kind: 'human' | 'agent'; username: string; name: string; color: string; email: string | null; is_admin: boolean; disabled: boolean; owner_name: string | null; created_at: string }
interface Invite { id: string; email: string | null; is_admin: boolean; expires_at: string; created_by_name: string | null }

export function Admin() {
  const { me } = useSession();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [form, setForm] = useState({ email: '', is_admin: false });
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    api.get<AdminUser[]>('/admin/users').then(setUsers);
    api.get<Invite[]>('/admin/invites').then(setInvites);
  }, []);
  useEffect(() => { load(); }, [load]);
  const run = (p: Promise<unknown>) => p.then(load).then(() => setError('')).catch((e: Error) => setError(e.message));

  return (
    <div className="page narrow">
      <h1>Admin</h1>
      {error && <p className="error">{error}</p>}
      <section className="panel">
        <h2>Invite someone</h2>
        <form className="row" onSubmit={(e) => {
          e.preventDefault();
          api.post<{ url: string }>('/admin/invites', { email: form.email || undefined, is_admin: form.is_admin }).then((r) => { setLink(r.url); setForm({ email: '', is_admin: false }); load(); }).catch((e: Error) => setError(e.message));
        }}>
          <input className="grow" type="email" placeholder="Email (optional — locks the invite to it)" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
          <label className="check"><input type="checkbox" checked={form.is_admin} onChange={(e) => setForm({ ...form, is_admin: e.target.checked })} /> Instance admin</label>
          <button className="primary">Create invite link</button>
        </form>
        {link && (
          <div className="new-token">
            <p className="small">Send this link to the person. It works once and expires in 7 days. Tack doesn't send email.</p>
            <div className="row"><code className="grow token">{link}</code><button onClick={() => navigator.clipboard.writeText(link)}>Copy</button></div>
          </div>
        )}
        {invites.length > 0 && (
          <ul className="tokens">
            {invites.map((i) => (
              <li key={i.id}>
                <span className="grow">{i.email ?? 'Anyone with the link'}{i.is_admin ? ' · admin' : ''}</span>
                <span className="muted small">expires {new Date(i.expires_at).toLocaleDateString()}</span>
                <button className="link danger" onClick={() => run(api.del(`/admin/invites/${i.id}`))}>Revoke</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="panel">
        <h2>Users &amp; agents</h2>
        <table className="table">
          <thead><tr><th>User</th><th>Email / owner</th><th>Admin</th><th>Status</th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} className={u.disabled ? 'disabled' : ''}>
                <td><div className="row"><Avatar user={u} /> <span><strong>{u.name}</strong><br /><span className="muted small">@{u.username}{u.kind === 'agent' ? ' · agent' : ''}</span></span></div></td>
                <td className="small">{u.kind === 'agent' ? `owned by ${u.owner_name ?? '—'}` : u.email}</td>
                <td>{u.kind === 'human' && <input type="checkbox" checked={u.is_admin} disabled={u.id === me.id} onChange={(e) => run(api.patch(`/admin/users/${u.id}`, { is_admin: e.target.checked }))} aria-label="Instance admin" />}</td>
                <td>{u.id !== me.id && <button onClick={() => run(api.patch(`/admin/users/${u.id}`, { disabled: !u.disabled }))}>{u.disabled ? 'Enable' : 'Disable'}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </div>
  );
}
