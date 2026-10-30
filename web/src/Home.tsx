import { useCallback, useEffect, useState } from 'react';
import { api, type Board, type BoardSummary } from './api.ts';
import { Link, navigate, useEvents, LABEL_COLORS } from './lib.tsx';

export function Home() {
  const [boards, setBoards] = useState<BoardSummary[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const load = useCallback(() => api.get<BoardSummary[]>(`/boards${showArchived ? '?archived=1' : ''}`).then(setBoards), [showArchived]);
  useEffect(() => { load(); }, [load]);
  useEvents(null, { boards: load });

  const mine = boards?.filter((b) => b.is_member && !b.archived) ?? [];
  const shared = boards?.filter((b) => !b.is_member && !b.archived) ?? [];
  const archived = boards?.filter((b) => b.archived) ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <h1>Boards</h1>
        <div className="spacer" />
        <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived</label>
        <button className="primary" onClick={() => setCreating(true)}>New board</button>
      </div>
      {creating && <NewBoard onClose={() => setCreating(false)} />}
      {boards === null ? <p className="muted">Loading…</p> : (
        <>
          <BoardGrid boards={mine} empty="You're not on any boards yet. Create one to get started." />
          {shared.length > 0 && <><h2>Visible to everyone</h2><BoardGrid boards={shared} /></>}
          {showArchived && archived.length > 0 && <><h2>Archived</h2><BoardGrid boards={archived} /></>}
        </>
      )}
    </div>
  );
}

function BoardGrid({ boards, empty }: { boards: BoardSummary[]; empty?: string }) {
  if (!boards.length) return empty ? <p className="muted">{empty}</p> : null;
  return (
    <div className="board-grid">
      {boards.map((b) => (
        <Link key={b.id} to={`/b/${b.id}`} className="board-tile">
          <span className="tile-bar" style={{ background: b.color }} />
          <strong>{b.name}</strong>
          <span className="muted small">{b.card_count} card{b.card_count === 1 ? '' : 's'} · {b.my_role}{b.visibility === 'instance' ? ' · public' : ''}</span>
        </Link>
      ))}
    </div>
  );
}

function NewBoard({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [color, setColor] = useState(LABEL_COLORS[5]);
  const [visibility, setVisibility] = useState<'private' | 'instance'>('private');
  const [error, setError] = useState('');
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    try {
      const b = await api.post<Board>('/boards', { name, color, visibility });
      navigate(`/b/${b.id}`);
    } catch (err) {
      setError((err as Error).message);
    }
  }
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal small" onSubmit={submit}>
        <h2>New board</h2>
        <label>Name<input autoFocus value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} /></label>
        <div className="field">
          <span>Color</span>
          <div className="swatches">
            {LABEL_COLORS.map((c) => <button type="button" key={c} className={`swatch ${c === color ? 'on' : ''}`} style={{ background: c }} onClick={() => setColor(c)} aria-label={c} />)}
          </div>
        </div>
        <label>Visibility
          <select value={visibility} onChange={(e) => setVisibility(e.target.value as 'private' | 'instance')}>
            <option value="private">Private — members only</option>
            <option value="instance">Everyone on this instance can view</option>
          </select>
        </label>
        {error && <p className="error">{error}</p>}
        <div className="row end">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary">Create</button>
        </div>
      </form>
    </div>
  );
}
