import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { api, type Me, type Notification } from './api.ts';
import { Avatar, Link, navigate, timeAgo, useClickOutside, useEvents, usePath, BotIcon } from './lib.tsx';
import { AuthScreen } from './Auth.tsx';
import { Home } from './Home.tsx';
import { BoardView } from './Board.tsx';
import { Settings } from './Settings.tsx';
import { Admin } from './Admin.tsx';

interface Session { me: Me; refreshMe: () => void }
const SessionCtx = createContext<Session | null>(null);
export const useSession = () => useContext(SessionCtx)!;

export function App() {
  const [state, setState] = useState<{ needs_setup: boolean; user: Me | null } | null>(null);
  const load = useCallback(() => api.get<{ needs_setup: boolean; user: Me | null }>('/auth/state').then(setState), []);
  useEffect(() => { load(); }, [load]);
  const path = usePath();

  if (!state) return <div className="center muted">Loading…</div>;
  const invite = path.match(/^\/invite\/([\w-]+)/)?.[1];
  if (!state.user) {
    return <AuthScreen mode={state.needs_setup ? 'setup' : invite ? 'invite' : 'login'} invite={invite} onDone={() => { navigate('/', true); load(); }} />;
  }
  if (invite) navigate('/', true);
  return (
    <SessionCtx.Provider value={{ me: state.user, refreshMe: load }}>
      <Shell path={path} onLogout={() => api.post('/auth/logout').then(load)} />
    </SessionCtx.Provider>
  );
}

function Shell({ path, onLogout }: { path: string; onLogout: () => void }) {
  const { me } = useSession();
  const board = path.match(/^\/b\/(\d+)(?:\/c\/(\d+))?/);
  let page: React.ReactNode;
  if (board) page = <BoardView key={board[1]} boardId={Number(board[1])} cardId={board[2] ? Number(board[2]) : null} />;
  else if (path === '/settings') page = <Settings />;
  else if (path === '/admin' && me.is_admin) page = <Admin />;
  else page = <Home />;
  return (
    <div className="shell">
      <header className="topbar">
        <Link to="/" className="brand"><span className="logo" aria-hidden><i /><i /></span>Tack</Link>
        <nav>
          <Link to="/" className={!board && path === '/' ? 'active' : ''}>Boards</Link>
          {me.is_admin && <Link to="/admin" className={path === '/admin' ? 'active' : ''}>Admin</Link>}
        </nav>
        <div className="spacer" />
        <Notifications />
        <UserMenu onLogout={onLogout} />
      </header>
      <main>{page}</main>
    </div>
  );
}

function UserMenu({ onLogout }: { onLogout: () => void }) {
  const { me } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(useCallback(() => setOpen(false), []));
  return (
    <div className="dropdown" ref={ref}>
      <button className="icon-btn" onClick={() => setOpen(!open)} aria-label="Account"><Avatar user={me} /></button>
      {open && (
        <div className="menu right">
          <div className="menu-head"><strong>{me.name}</strong><span className="muted">@{me.username}</span></div>
          <button onClick={() => { setOpen(false); navigate('/settings'); }}>Settings, tokens &amp; agents</button>
          <button onClick={onLogout}>Sign out</button>
        </div>
      )}
    </div>
  );
}

function Notifications() {
  const [data, setData] = useState<{ unread: number; items: Notification[] }>({ unread: 0, items: [] });
  const [open, setOpen] = useState(false);
  const load = useCallback(() => api.get<typeof data>('/notifications').then(setData).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  useEvents(null, { notification: load });
  const ref = useClickOutside<HTMLDivElement>(useCallback(() => setOpen(false), []));
  const markAll = () => api.post('/notifications/read').then(load);
  return (
    <div className="dropdown" ref={ref}>
      <button className="icon-btn bell" onClick={() => setOpen(!open)} aria-label={`Notifications (${data.unread} unread)`}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" /></svg>
        {data.unread > 0 && <span className="badge">{data.unread > 99 ? '99+' : data.unread}</span>}
      </button>
      {open && (
        <div className="menu right notif-menu">
          <div className="menu-head row">
            <strong>Notifications</strong>
            <div className="spacer" />
            {data.unread > 0 && <button className="link" onClick={markAll}>Mark all read</button>}
          </div>
          {data.items.length === 0 && <div className="empty">Nothing yet.</div>}
          {data.items.map((n) => (
            <button
              key={n.id}
              className={`notif ${n.read ? '' : 'unread'}`}
              onClick={() => {
                api.post('/notifications/read', { ids: [n.id] }).then(load);
                setOpen(false);
                if (n.board_id) navigate(n.card_id ? `/b/${n.board_id}/c/${n.card_id}` : `/b/${n.board_id}`);
              }}
            >
              <span>
                <strong>{n.actor_kind === 'agent' && <BotIcon size={12} />} {n.actor_name ?? 'Someone'}</strong> {n.text}{n.card_title ? <> “{n.card_title}”</> : n.card_id === null && n.board_id === null && n.type !== 'added_to_board' ? ' a card you can no longer see' : ''}
                {n.board_name && <span className="muted"> · {n.board_name}</span>}
              </span>
              <span className="muted small">{timeAgo(n.created_at)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
