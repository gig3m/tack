import { useCallback, useEffect, useState } from 'react';
import { api, type Activity, type Board, type CardSummary, type Role, type User } from './api.ts';
import { Avatar, BotIcon, LABEL_COLORS, Markdown, navigate, timeAgo } from './lib.tsx';
import { describeActivity } from './activity.ts';
import { useSession } from './App.tsx';

type Tab = 'about' | 'members' | 'labels' | 'activity' | 'archived' | 'settings';

interface Props { board: Board; onClose: () => void; onChanged: () => void; onError: (m: string) => void }

export function BoardMenu({ board, onClose, onChanged, onError }: Props) {
  const [tab, setTab] = useState<Tab>('about');
  const isAdmin = board.my_role === 'admin';
  const tabs: [Tab, string][] = [['about', 'About'], ['members', 'Members'], ['labels', 'Labels'], ['activity', 'Activity'], ['archived', 'Archived']];
  if (isAdmin) tabs.push(['settings', 'Settings']);
  const run = (p: Promise<unknown>) => p.then(onChanged).catch((e: Error) => onError(e.message));
  return (
    <div className="drawer-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="drawer">
        <div className="drawer-head"><strong>{board.name}</strong><div className="spacer" /><button className="icon-btn" onClick={onClose} aria-label="Close">✕</button></div>
        <nav className="tabs">{tabs.map(([t, l]) => <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{l}</button>)}</nav>
        <div className="drawer-body">
          {tab === 'about' && <About board={board} />}
          {tab === 'members' && <Members board={board} run={run} />}
          {tab === 'labels' && <Labels board={board} run={run} />}
          {tab === 'activity' && <BoardActivity board={board} />}
          {tab === 'archived' && <Archived board={board} run={run} />}
          {tab === 'settings' && <BoardSettings board={board} run={run} onError={onError} />}
        </div>
      </aside>
    </div>
  );
}

function About({ board }: { board: Board }) {
  const mcpUrl = `${location.origin}/mcp`;
  return (
    <div className="stack">
      {board.description ? <Markdown text={board.description} /> : <p className="muted">No description.</p>}
      <p className="muted small">Your role: <strong>{board.my_role}</strong>. Board id <code>{board.id}</code> (for agents and the API).</p>
      <div className="hint">
        <strong><BotIcon size={14} /> Agents</strong>
        <p className="small">Agents connect over MCP at <code>{mcpUrl}</code> with a token from Settings, then act with whatever role you give them here.</p>
      </div>
    </div>
  );
}

function Members({ board, run }: { board: Board; run: (p: Promise<unknown>) => void }) {
  const { me } = useSession();
  const [users, setUsers] = useState<User[]>([]);
  const [pick, setPick] = useState('');
  const [role, setRole] = useState<Role>('member');
  const isAdmin = board.my_role === 'admin';
  useEffect(() => { if (isAdmin) api.get<User[]>('/users').then(setUsers); }, [isAdmin]);
  const inBoard = new Set(board.members.map((m) => m.id));
  const candidates = users.filter((u) => !inBoard.has(u.id));
  return (
    <div className="stack">
      {isAdmin && (
        <form className="row" onSubmit={(e) => { e.preventDefault(); if (pick) { run(api.post(`/boards/${board.id}/members`, { user_id: Number(pick), role })); setPick(''); } }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)} className="grow" aria-label="Person or agent">
            <option value="">Add a person or agent…</option>
            {candidates.map((u) => <option key={u.id} value={u.id}>{u.name} (@{u.username}){u.kind === 'agent' ? ' — agent' : ''}</option>)}
          </select>
          <select value={role} onChange={(e) => setRole(e.target.value as Role)} aria-label="Role">
            <option value="member">Member</option><option value="observer">Observer</option><option value="admin">Admin</option>
          </select>
          <button className="primary" disabled={!pick}>Add</button>
        </form>
      )}
      <p className="muted small">Admins manage the board and members. Members edit cards and lists. Observers can only view.</p>
      <ul className="people">
        {board.members.map((m) => (
          <li key={m.id}>
            <Avatar user={m} />
            <div className="grow"><strong>{m.name}</strong> <span className="muted small">@{m.username}{m.kind === 'agent' ? ' · agent' : ''}</span></div>
            {isAdmin ? (
              <select value={m.role} onChange={(e) => run(api.patch(`/boards/${board.id}/members/${m.id}`, { role: e.target.value }))} aria-label={`Role for ${m.name}`}>
                <option value="admin">Admin</option><option value="member">Member</option><option value="observer">Observer</option>
              </select>
            ) : <span className="pill">{m.role}</span>}
            {(isAdmin || m.id === me.id) && (
              <button className="link danger" onClick={() => run(api.del(`/boards/${board.id}/members/${m.id}`).then(() => { if (m.id === me.id) navigate('/'); }))}>
                {m.id === me.id ? 'Leave' : 'Remove'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Labels({ board, run }: { board: Board; run: (p: Promise<unknown>) => void }) {
  const canEdit = board.my_role !== 'observer';
  return (
    <div className="stack">
      {board.labels.map((l) => <LabelRow key={`${l.id}-${l.name}-${l.color}`} label={l} canEdit={canEdit} run={run} />)}
      {canEdit && <button onClick={() => run(api.post(`/boards/${board.id}/labels`, { name: 'New label', color: LABEL_COLORS[board.labels.length % LABEL_COLORS.length] }))}>+ Add label</button>}
    </div>
  );
}

function LabelRow({ label, canEdit, run }: { label: { id: number; name: string; color: string }; canEdit: boolean; run: (p: Promise<unknown>) => void }) {
  const [name, setName] = useState(label.name);
  if (!canEdit) return <span className="label-chip big" style={{ background: label.color }}>{label.name || ' '}</span>;
  return (
    <div className="label-row">
      <span className="label-chip big" style={{ background: label.color }}>{name || ' '}</span>
      <input value={name} placeholder="Label name" maxLength={60} onChange={(e) => setName(e.target.value)} onBlur={() => name !== label.name && run(api.patch(`/labels/${label.id}`, { name }))} />
      <div className="swatches">
        {LABEL_COLORS.map((c) => <button key={c} type="button" className={`swatch sm ${c === label.color ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => run(api.patch(`/labels/${label.id}`, { color: c }))} />)}
      </div>
      <button className="icon-btn subtle" aria-label="Delete label" onClick={() => run(api.del(`/labels/${label.id}`))}>✕</button>
    </div>
  );
}

function BoardActivity({ board }: { board: Board }) {
  const [items, setItems] = useState<Activity[]>([]);
  const [more, setMore] = useState(true);
  const load = useCallback((before?: number) => api.get<Activity[]>(`/boards/${board.id}/activity${before ? `?before=${before}` : ''}`).then((r) => {
    setItems((cur) => (before ? [...cur, ...r] : r));
    setMore(r.length === 50);
  }), [board.id]);
  useEffect(() => { load(); }, [load, board]);
  return (
    <div>
      <ul className="activity">
        {items.map((a) => (
          <li key={a.id}>
            <strong>{a.user_kind === 'agent' && <BotIcon size={12} />} {a.user_name ?? 'Someone'}</strong>{' '}
            {a.card_id ? <a href={`/b/${board.id}/c/${a.card_id}`} onClick={(e) => { e.preventDefault(); navigate(`/b/${board.id}/c/${a.card_id}`); }}>{describeActivity(a, true)}</a> : describeActivity(a, true)}{' '}
            <span className="muted small">{timeAgo(a.created_at)}</span>
          </li>
        ))}
      </ul>
      {more && items.length > 0 && <button onClick={() => load(items[items.length - 1].id)}>Load more</button>}
    </div>
  );
}

function Archived({ board, run }: { board: Board; run: (p: Promise<unknown>) => void }) {
  const [data, setData] = useState<{ lists: { id: number; name: string }[]; cards: (CardSummary & { list_name: string })[] } | null>(null);
  const load = useCallback(() => api.get<typeof data>(`/boards/${board.id}/archived`).then(setData), [board.id]);
  useEffect(() => { load(); }, [load, board]);
  const canEdit = board.my_role !== 'observer';
  if (!data) return <p className="muted">Loading…</p>;
  return (
    <div className="stack">
      <h3>Lists</h3>
      {data.lists.length === 0 && <p className="muted small">No archived lists.</p>}
      {data.lists.map((l) => (
        <div key={l.id} className="row"><span className="grow">{l.name}</span>
          {canEdit && <button onClick={() => run(api.patch(`/lists/${l.id}`, { archived: false }).then(load))}>Restore</button>}
          {board.my_role === 'admin' && <button className="danger" onClick={() => run(api.del(`/lists/${l.id}`).then(load))}>Delete</button>}
        </div>
      ))}
      <h3>Cards</h3>
      {data.cards.length === 0 && <p className="muted small">No archived cards.</p>}
      {data.cards.map((c) => (
        <div key={c.id} className="row">
          <a className="grow" href={`/b/${board.id}/c/${c.id}`} onClick={(e) => { e.preventDefault(); navigate(`/b/${board.id}/c/${c.id}`); }}>{c.title}</a>
          <span className="muted small">{c.list_name}</span>
          {canEdit && <button onClick={() => run(api.patch(`/cards/${c.id}`, { archived: false }).then(load))}>Restore</button>}
        </div>
      ))}
    </div>
  );
}

function BoardSettings({ board, run, onError }: { board: Board; run: (p: Promise<unknown>) => void; onError: (m: string) => void }) {
  const [form, setForm] = useState({ name: board.name, description: board.description, color: board.color, visibility: board.visibility });
  const [confirm, setConfirm] = useState('');
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); run(api.patch(`/boards/${board.id}`, form)); }}>
      <label>Name<input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} required maxLength={120} /></label>
      <label>Description (markdown)<textarea rows={5} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /></label>
      <div className="field"><span>Color</span>
        <div className="swatches">{LABEL_COLORS.map((c) => <button type="button" key={c} className={`swatch ${c === form.color ? 'on' : ''}`} style={{ background: c }} onClick={() => setForm({ ...form, color: c })} aria-label={c} />)}</div>
      </div>
      <label>Visibility
        <select value={form.visibility} onChange={(e) => setForm({ ...form, visibility: e.target.value as 'private' | 'instance' })}>
          <option value="private">Private — members only</option>
          <option value="instance">Everyone on this instance can view</option>
        </select>
      </label>
      <button className="primary">Save</button>
      <hr />
      <button type="button" onClick={() => run(api.patch(`/boards/${board.id}`, { archived: !board.archived }))}>{board.archived ? 'Restore board' : 'Archive board'}</button>
      <div className="danger-zone">
        <p className="small">Delete this board, its cards, comments and files permanently. Type the board name to confirm.</p>
        <input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={board.name} />
        <button type="button" className="danger solid" disabled={confirm !== board.name}
          onClick={() => api.del(`/boards/${board.id}`).then(() => navigate('/')).catch((e: Error) => onError(e.message))}>Delete board</button>
      </div>
    </form>
  );
}
