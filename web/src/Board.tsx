import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DragDropContext, Droppable, Draggable, type DropResult } from '@hello-pangea/dnd';
import { api, ApiError, type Board, type CardSummary, type List, type Member } from './api.ts';
import { Avatar, dueState, formatDue, navigate, useClickOutside, useEvents, useToast } from './lib.tsx';
import { CardModal } from './CardModal.tsx';
import { BoardMenu } from './BoardMenu.tsx';

interface Filters { text: string; label: number | null; member: number | null; due: '' | 'overdue' | 'soon' | 'none' }
const NO_FILTERS: Filters = { text: '', label: null, member: null, due: '' };

export function BoardView({ boardId, cardId }: { boardId: number; cardId: number | null }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState('');
  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [menu, setMenu] = useState(false);
  const [cardVersion, setCardVersion] = useState(0);
  const [toast, setToast] = useToast();
  const dragging = useRef(false);
  const pending = useRef(false);

  const load = useCallback(() => {
    if (dragging.current) { pending.current = true; return; }
    api.get<Board>(`/boards/${boardId}`).then((b) => { setBoard(b); setError(''); }).catch((e: ApiError) => setError(e.message));
  }, [boardId]);
  useEffect(() => { load(); }, [load]);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEvents(boardId, {
    board: (e: { card_id?: number | null; type: string }) => {
      if (e.type === 'board.deleted') { navigate('/'); return; }
      clearTimeout(timer.current);
      timer.current = setTimeout(load, 120);
      if (cardId && (e.card_id === cardId || !e.card_id)) setCardVersion((v) => v + 1);
    },
    revoked: () => setError('You no longer have access to this board.'),
  });

  useEffect(() => { if (board) document.title = `${board.name} · Tack`; return () => { document.title = 'Tack'; }; }, [board?.name]);

  const canEdit = board ? board.my_role !== 'observer' : false;
  const filtering = filters.text !== '' || filters.label !== null || filters.member !== null || filters.due !== '';

  const visible = useMemo(() => {
    if (!board) return [];
    const q = filters.text.toLowerCase();
    const match = (c: CardSummary) => {
      if (q && !c.title.toLowerCase().includes(q)) return false;
      if (filters.label !== null && !c.label_ids.includes(filters.label)) return false;
      if (filters.member !== null && !c.assignee_ids.includes(filters.member)) return false;
      if (filters.due === 'none' && c.due_at) return false;
      if (filters.due === 'overdue' && dueState(c.due_at, c.due_complete) !== 'overdue') return false;
      if (filters.due === 'soon' && !['soon', 'overdue'].includes(dueState(c.due_at, c.due_complete) ?? '')) return false;
      return true;
    };
    return board.lists.map((l) => ({ ...l, cards: l.cards.filter(match) }));
  }, [board, filters]);

  if (error && !board) return <div className="page"><p className="error">{error}</p></div>;
  if (!board) return <div className="center muted">Loading…</div>;

  const fail = (e: unknown) => { setToast((e as Error).message); load(); };

  function onDragEnd(r: DropResult) {
    dragging.current = false;
    const flush = () => { if (pending.current) { pending.current = false; load(); } };
    if (!r.destination || !board) return flush();
    const { source: from, destination: to } = r;
    if (from.droppableId === to.droppableId && from.index === to.index) return flush();
    if (r.type === 'list') {
      const lists = [...board.lists];
      const [moved] = lists.splice(from.index, 1);
      lists.splice(to.index, 0, moved);
      setBoard({ ...board, lists });
      api.patch(`/lists/${moved.id}`, { position: to.index }).catch(fail).finally(flush);
      return;
    }
    const lists = board.lists.map((l) => ({ ...l, cards: [...l.cards] }));
    const src = lists.find((l) => `list-${l.id}` === from.droppableId)!;
    const dst = lists.find((l) => `list-${l.id}` === to.droppableId)!;
    const [card] = src.cards.splice(from.index, 1);
    dst.cards.splice(to.index, 0, { ...card, list_id: dst.id });
    setBoard({ ...board, lists });
    api.patch(`/cards/${card.id}`, { list_id: dst.id, position: to.index }).catch(fail).finally(flush);
  }

  const members = new Map(board.members.map((m) => [m.id, m]));
  const labels = new Map(board.labels.map((l) => [l.id, l]));

  return (
    <div className="board" style={{ '--board': board.color } as React.CSSProperties}>
      <div className="board-head">
        <h1>{board.name}</h1>
        {board.archived && <span className="pill warn">Archived</span>}
        <span className="pill">{board.visibility === 'instance' ? 'Everyone can view' : 'Private'}</span>
        <div className="member-stack">
          {board.members.slice(0, 8).map((m) => <Avatar key={m.id} user={m} size={26} />)}
          {board.members.length > 8 && <span className="more">+{board.members.length - 8}</span>}
        </div>
        <div className="spacer" />
        <FilterBar board={board} filters={filters} setFilters={setFilters} />
        <button onClick={() => setMenu(true)}>Menu</button>
      </div>
      {error && <p className="error banner">{error}</p>}
      <DragDropContext onDragStart={() => { dragging.current = true; }} onDragEnd={onDragEnd}>
        <Droppable droppableId="board" type="list" direction="horizontal">
          {(p) => (
            <div className="lists" ref={p.innerRef} {...p.droppableProps}>
              {visible.map((list, i) => (
                <Draggable key={list.id} draggableId={`l-${list.id}`} index={i} isDragDisabled={!canEdit || filtering}>
                  {(d) => (
                    <section className="list" ref={d.innerRef} {...d.draggableProps}>
                      <ListHeader list={list} canEdit={canEdit} dragHandle={d.dragHandleProps} onError={fail} />
                      <Droppable droppableId={`list-${list.id}`} type="card">
                        {(dp, snap) => (
                          <div className={`cards ${snap.isDraggingOver ? 'over' : ''}`} ref={dp.innerRef} {...dp.droppableProps}>
                            {list.cards.map((c, j) => (
                              <Draggable key={c.id} draggableId={`c-${c.id}`} index={j} isDragDisabled={!canEdit || filtering}>
                                {(cd, cs) => (
                                  <div ref={cd.innerRef} {...cd.draggableProps} {...cd.dragHandleProps} className={`card-tile ${cs.isDragging ? 'dragging' : ''}`}
                                    onClick={() => navigate(`/b/${board.id}/c/${c.id}`)}
                                    onKeyDown={(e) => { if (e.key === 'Enter') navigate(`/b/${board.id}/c/${c.id}`); }}>
                                    <CardFace card={c} members={members} labels={labels} />
                                  </div>
                                )}
                              </Draggable>
                            ))}
                            {dp.placeholder}
                          </div>
                        )}
                      </Droppable>
                      {canEdit && <AddCard listId={list.id} onError={fail} />}
                    </section>
                  )}
                </Draggable>
              ))}
              {p.placeholder}
              {canEdit && <AddList boardId={board.id} onError={fail} />}
            </div>
          )}
        </Droppable>
      </DragDropContext>
      {cardId && <CardModal key={cardId} cardId={cardId} board={board} version={cardVersion} onClose={() => navigate(`/b/${board.id}`)} onError={setToast} />}
      {menu && <BoardMenu board={board} onClose={() => setMenu(false)} onChanged={load} onError={setToast} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  );
}

function CardFace({ card, members, labels }: { card: CardSummary; members: Map<number, Member>; labels: Map<number, { name: string; color: string }> }) {
  const due = dueState(card.due_at, card.due_complete);
  return (
    <>
      {card.label_ids.length > 0 && (
        <div className="card-labels">
          {card.label_ids.map((id) => labels.get(id)).filter(Boolean).map((l, i) => <span key={i} className="label-chip" style={{ background: l!.color }} title={l!.name}>{l!.name}</span>)}
        </div>
      )}
      <div className="card-title">{card.title}</div>
      <div className="card-meta">
        {card.due_at && <span className={`due ${due}`} title="Due">◷ {formatDue(card.due_at)}</span>}
        {card.has_description && <span title="Has description">≡</span>}
        {card.comment_count > 0 && <span title="Comments">💬 {card.comment_count}</span>}
        {card.attachment_count > 0 && <span title="Attachments">📎 {card.attachment_count}</span>}
        {card.checklist.total > 0 && <span className={card.checklist.done === card.checklist.total ? 'done-check' : ''} title="Checklist">☑ {card.checklist.done}/{card.checklist.total}</span>}
        <span className="spacer" />
        {card.assignee_ids.map((id) => members.get(id)).filter(Boolean).map((m) => <Avatar key={m!.id} user={m!} size={22} />)}
      </div>
    </>
  );
}

function ListHeader({ list, canEdit, dragHandle, onError }: { list: List; canEdit: boolean; dragHandle: object | null | undefined; onError: (e: unknown) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(list.name);
  useEffect(() => setName(list.name), [list.name]);
  const save = () => {
    setEditing(false);
    if (name.trim() && name !== list.name) api.patch(`/lists/${list.id}`, { name }).catch(onError);
    else setName(list.name);
  };
  return (
    <header className="list-head" {...(dragHandle ?? {})}>
      {editing ? (
        <input autoFocus value={name} onChange={(e) => setName(e.target.value)} onBlur={save} onKeyDown={(e) => { if (e.key === 'Enter') save(); if (e.key === 'Escape') { setName(list.name); setEditing(false); } }} maxLength={120} />
      ) : (
        <h2 onClick={() => canEdit && setEditing(true)}>{list.name}</h2>
      )}
      <span className="count">{list.cards.length}</span>
      {canEdit && <ListMenu list={list} onError={onError} onRename={() => setEditing(true)} />}
    </header>
  );
}

function ListMenu({ list, onError, onRename }: { list: List; onError: (e: unknown) => void; onRename: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useClickOutside<HTMLDivElement>(useCallback(() => setOpen(false), []));
  const archiveCards = () => Promise.all(list.cards.map((c) => api.patch(`/cards/${c.id}`, { archived: true })));
  return (
    <div className="dropdown" ref={ref}>
      <button className="icon-btn subtle" aria-label="List actions" onClick={() => setOpen(!open)}>⋯</button>
      {open && (
        <div className="menu right">
          <button onClick={() => { setOpen(false); onRename(); }}>Rename list</button>
          <button onClick={() => { setOpen(false); archiveCards().catch(onError); }}>Archive all cards in this list</button>
          <button onClick={() => { setOpen(false); api.patch(`/lists/${list.id}`, { archived: true }).catch(onError); }}>Archive this list</button>
        </div>
      )}
    </div>
  );
}

function AddCard({ listId, onError }: { listId: number; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const submit = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!title.trim()) return;
    try { await api.post('/cards', { list_id: listId, title }); setTitle(''); } catch (err) { onError(err); }
  };
  if (!open) return <button className="add-card" onClick={() => setOpen(true)}>+ Add a card</button>;
  return (
    <form className="add-form" onSubmit={submit}>
      <textarea autoFocus value={title} placeholder="Card title" maxLength={500} onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } if (e.key === 'Escape') setOpen(false); }} />
      <div className="row"><button className="primary">Add card</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function AddList({ boardId, onError }: { boardId: number; onError: (e: unknown) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    try { await api.post(`/boards/${boardId}/lists`, { name }); setName(''); } catch (err) { onError(err); }
  };
  if (!open) return <button className="add-list" onClick={() => setOpen(true)}>+ Add a list</button>;
  return (
    <form className="list add-form" onSubmit={submit}>
      <input autoFocus value={name} placeholder="List name" maxLength={120} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      <div className="row"><button className="primary">Add list</button><button type="button" onClick={() => setOpen(false)}>Cancel</button></div>
    </form>
  );
}

function FilterBar({ board, filters, setFilters }: { board: Board; filters: Filters; setFilters: (f: Filters) => void }) {
  const active = filters !== NO_FILTERS && (filters.text || filters.label !== null || filters.member !== null || filters.due);
  return (
    <div className="filters">
      <input type="search" placeholder="Filter cards…" value={filters.text} onChange={(e) => setFilters({ ...filters, text: e.target.value })} />
      <select value={filters.label ?? ''} onChange={(e) => setFilters({ ...filters, label: e.target.value ? Number(e.target.value) : null })} aria-label="Label filter">
        <option value="">Any label</option>
        {board.labels.map((l) => <option key={l.id} value={l.id}>{l.name || l.color}</option>)}
      </select>
      <select value={filters.member ?? ''} onChange={(e) => setFilters({ ...filters, member: e.target.value ? Number(e.target.value) : null })} aria-label="Member filter">
        <option value="">Anyone</option>
        {board.members.map((m) => <option key={m.id} value={m.id}>{m.name}{m.kind === 'agent' ? ' (agent)' : ''}</option>)}
      </select>
      <select value={filters.due} onChange={(e) => setFilters({ ...filters, due: e.target.value as Filters['due'] })} aria-label="Due filter">
        <option value="">Any due date</option>
        <option value="overdue">Overdue</option>
        <option value="soon">Due within a day</option>
        <option value="none">No due date</option>
      </select>
      {active && <button className="link" onClick={() => setFilters(NO_FILTERS)}>Clear</button>}
    </div>
  );
}
