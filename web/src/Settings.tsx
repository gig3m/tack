import { useCallback, useEffect, useState } from 'react';
import { api, type Agent, type Token } from './api.ts';
import { Avatar, timeAgo } from './lib.tsx';
import { useSession } from './App.tsx';

export function Settings() {
  return (
    <div className="page narrow">
      <h1>Settings</h1>
      <Profile />
      <Connect />
      <Agents />
      <PersonalTokens />
    </div>
  );
}

function Profile() {
  const { me, refreshMe } = useSession();
  const [form, setForm] = useState({ name: me.name, email: me.email ?? '', current_password: '', new_password: '' });
  const [msg, setMsg] = useState('');
  async function save(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, string> = { name: form.name, email: form.email };
    if (form.new_password) Object.assign(body, { current_password: form.current_password, new_password: form.new_password });
    try {
      await api.patch('/me', body);
      setMsg('Saved.');
      setForm({ ...form, current_password: '', new_password: '' });
      refreshMe();
    } catch (err) { setMsg((err as Error).message); }
  }
  return (
    <section className="panel">
      <h2>Profile</h2>
      <form className="grid2" onSubmit={save}>
        <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={80} /></label>
        <label>Email<input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required /></label>
        <label>Current password<input type="password" value={form.current_password} onChange={(e) => setForm({ ...form, current_password: e.target.value })} autoComplete="current-password" /></label>
        <label>New password<input type="password" value={form.new_password} minLength={8} onChange={(e) => setForm({ ...form, new_password: e.target.value })} autoComplete="new-password" /></label>
        <div className="row"><button className="primary">Save</button><span className="muted small">@{me.username}{me.is_admin ? ' · instance admin' : ''}</span>{msg && <span className="small">{msg}</span>}</div>
      </form>
    </section>
  );
}

function Connect() {
  const url = `${location.origin}/mcp`;
  return (
    <section className="panel">
      <h2>Connect an agent (MCP)</h2>
      <p className="small">Tack speaks MCP over Streamable HTTP. Create an agent below (or a personal token to let a tool act as you), then point your client at:</p>
      <pre className="code">{url}</pre>
      <p className="small">Claude Code:</p>
      <pre className="code">{`claude mcp add --transport http tack ${url} \\\n  --header "Authorization: Bearer tack_…"`}</pre>
      <p className="small">Any MCP client config:</p>
      <pre className="code">{JSON.stringify({ mcpServers: { tack: { type: 'http', url, headers: { Authorization: 'Bearer tack_…' } } } }, null, 2)}</pre>
      <p className="small muted">The same tokens work for the REST API under <code>/api</code> with <code>Authorization: Bearer</code>.</p>
    </section>
  );
}

function NewToken({ token, onDone }: { token: string; onDone: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="new-token">
      <p className="small"><strong>Copy this token now.</strong> It won't be shown again.</p>
      <div className="row"><code className="grow token">{token}</code>
        <button onClick={() => navigator.clipboard.writeText(token).then(() => setCopied(true))}>{copied ? 'Copied' : 'Copy'}</button>
        <button onClick={onDone}>Done</button>
      </div>
    </div>
  );
}

function TokenList({ tokens, onRevoke }: { tokens: Token[]; onRevoke: (id: number) => void }) {
  if (!tokens.length) return <p className="muted small">No tokens.</p>;
  return (
    <ul className="tokens">
      {tokens.map((t) => (
        <li key={t.id}>
          <span className="grow"><strong>{t.name}</strong> <code className="muted">{t.prefix}…</code></span>
          <span className="muted small">created {timeAgo(t.created_at)} · {t.last_used_at ? `used ${timeAgo(t.last_used_at)}` : 'never used'}</span>
          <button className="link danger" onClick={() => onRevoke(t.id)}>Revoke</button>
        </li>
      ))}
    </ul>
  );
}

function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [form, setForm] = useState({ name: '', username: '' });
  const [fresh, setFresh] = useState<{ agent: number; token: string } | null>(null);
  const [error, setError] = useState('');
  const { me } = useSession();
  const load = useCallback(() => api.get<Agent[]>('/agents').then(setAgents), []);
  useEffect(() => { load(); }, [load]);
  const run = (p: Promise<unknown>) => p.then(load).then(() => setError('')).catch((e: Error) => setError(e.message));

  return (
    <section className="panel">
      <h2>Agents</h2>
      <p className="small">An agent is its own member: it has a name and avatar, shows up in activity, can be assigned cards and @mentioned, and gets a role on each board you add it to.</p>
      <form className="row" onSubmit={(e) => {
        e.preventDefault();
        run(api.post('/agents', form).then(() => setForm({ name: '', username: '' })));
      }}>
        <input placeholder="Display name (e.g. Release Bot)" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value, username: form.username || '' })} required maxLength={80} className="grow" />
        <input placeholder="username" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required pattern="[A-Za-z0-9][A-Za-z0-9_.\-]{1,31}" />
        <button className="primary">Create agent</button>
      </form>
      {error && <p className="error">{error}</p>}
      <ul className="agents">
        {agents.map((a) => (
          <li key={a.id} className={a.disabled ? 'disabled' : ''}>
            <div className="row">
              <Avatar user={a} size={32} />
              <div className="grow"><strong>{a.name}</strong> <span className="muted small">@{a.username}{a.owner_id !== me.id && a.owner_name ? ` · owned by ${a.owner_name}` : ''}{a.disabled ? ' · disabled' : ''}</span></div>
              <button onClick={() => api.post<{ token: string }>('/me/tokens', { name: `token ${a.tokens.length + 1}`, agent_id: a.id }).then((t) => { setFresh({ agent: a.id, token: t.token }); load(); })}>New token</button>
              <button onClick={() => run(api.patch(`/agents/${a.id}`, { disabled: !a.disabled }))}>{a.disabled ? 'Enable' : 'Disable'}</button>
              <DeleteAgent onDelete={() => run(api.del(`/agents/${a.id}`))} />
            </div>
            {fresh?.agent === a.id && <NewToken token={fresh.token} onDone={() => setFresh(null)} />}
            <TokenList tokens={a.tokens} onRevoke={(id) => run(api.del(`/tokens/${id}`))} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function DeleteAgent({ onDelete }: { onDelete: () => void }) {
  const [sure, setSure] = useState(false);
  return sure ? <button className="danger solid" onClick={onDelete} onBlur={() => setSure(false)}>Confirm delete</button> : <button className="danger" onClick={() => setSure(true)}>Delete</button>;
}

function PersonalTokens() {
  const [tokens, setTokens] = useState<Token[]>([]);
  const [name, setName] = useState('');
  const [fresh, setFresh] = useState<string | null>(null);
  const load = useCallback(() => api.get<Token[]>('/me/tokens').then(setTokens), []);
  useEffect(() => { load(); }, [load]);
  return (
    <section className="panel">
      <h2>Personal tokens</h2>
      <p className="small">A personal token acts as <strong>you</strong>, with your roles. Use it for scripts or an assistant you want working on your behalf. For an agent with its own identity, create an agent above.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); api.post<{ token: string }>('/me/tokens', { name }).then((t) => { setFresh(t.token); setName(''); load(); }); }}>
        <input className="grow" placeholder="Token name (e.g. laptop assistant)" value={name} onChange={(e) => setName(e.target.value)} required maxLength={80} />
        <button className="primary">Create token</button>
      </form>
      {fresh && <NewToken token={fresh} onDone={() => setFresh(null)} />}
      <TokenList tokens={tokens} onRevoke={(id) => api.del(`/tokens/${id}`).then(load)} />
    </section>
  );
}
