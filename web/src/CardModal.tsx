import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Activity, type Board, type CardDetail, type Checklist } from './api.ts';
import { Avatar, Markdown, BotIcon, dueState, formatBytes, formatDue, navigate, timeAgo, toLocalInput, useClickOutside } from './lib.tsx';
import { useSession } from './App.tsx';
import { describeActivity } from './activity.ts';

interface Props { cardId: number; board: Board; version: number; onClose: () => void; onError: (m: string) => void }

export function CardModal({ cardId, board, version, onClose, onError }: Props) {
  const [card, setCard] = useState<CardDetail | null>(null);
  const [activity, setActivity] = useState<Activity[]>([]);
  const [missing, setMissing] = useState(false);
  const load = useCallback(() => {
    api.get<CardDetail>(`/cards/${cardId}`).then(setCard).catch(() => setMissing(true));
    api.get<Activity[]>(`/cards/${cardId}/activity`).then(setActivity).catch(() => {});
  }, [cardId]);
  useEffect(() => { load(); }, [load, version]);
  useEffect(() => { if (card && card.board_id !== board.id) navigate(`/b/${card.board_id}/c/${card.id}`, true); }, [card, board.id]);
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape' && !(e.target as HTMLElement).closest('textarea, select, input:not([type=checkbox])')) onClose(); };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);

  const canEdit = card ? card.my_role !== 'observer' : false;
  const act = (p: Promise<unknown>) => p.then(load).catch((e: Error) => onError(e.message));
  const patch = (body: Record<string, unknown>) => act(api.patch(`/cards/${cardId}`, body));

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card-modal" role="dialog" aria-modal="true">
        <button className="icon-btn close" onClick={onClose} aria-label="Close">✕</button>
        {missing ? <p className="muted">This card no longer exists or you can't see it.</p> : !card ? <p className="muted">Loading…</p> : (
          <>
            {card.archived && <div className="banner warn">This card is archived.</div>}
            <TitleEditor card={card} canEdit={canEdit} onSave={(title) => patch({ title })} />
            <p className="muted small">
              in list <ListPicker card={card} board={board} canEdit={canEdit} onMove={(list_id) => patch({ list_id })} />
              {card.created_by && <> · created by {card.created_by} {timeAgo(card.created_at)}</>}
            </p>
            <div className="card-grid">
              <div className="card-main">
                <div className="chips">
                  {card.assignees.length > 0 && (
                    <div className="chip-group"><span className="chip-label">Assignees</span>
                      <div className="row">{card.assignees.map((u) => <Avatar key={u.id} user={u} size={28} />)}</div></div>
                  )}
                  {card.labels.length > 0 && (
                    <div className="chip-group"><span className="chip-label">Labels</span>
                      <div className="row wrap">{card.labels.map((l) => <span key={l.id} className="label-chip big" style={{ background: l.color }}>{l.name || ' '}</span>)}</div></div>
                  )}
                  {card.due_at && (
                    <div className="chip-group"><span className="chip-label">Due</span>
                      <label className={`due-chip ${dueState(card.due_at, card.due_complete)}`}>
                        <input type="checkbox" checked={card.due_complete} disabled={!canEdit} onChange={(e) => patch({ due_complete: e.target.checked })} />
                        {formatDue(card.due_at)} {card.due_complete ? '· done' : dueState(card.due_at, false) === 'overdue' ? '· overdue' : ''}
                      </label></div>
                  )}
                </div>
                <Description card={card} canEdit={canEdit} onSave={(description) => patch({ description })} />
                {card.checklists.map((k) => <ChecklistView key={k.id} list={k} canEdit={canEdit} act={act} />)}
                <Attachments card={card} canEdit={canEdit} act={act} onUploaded={load} onError={onError} />
                <Comments card={card} canEdit={canEdit} act={act} />
                <section>
                  <h3>Activity</h3>
                  <ul className="activity">
                    {activity.map((a) => (
                      <li key={a.id}><strong>{a.user_kind === 'agent' && <BotIcon size={12} />} {a.user_name ?? 'Someone'}</strong> {describeActivity(a, false)} <span className="muted small">{timeAgo(a.created_at)}</span></li>
                    ))}
                  </ul>
                </section>
              </div>
              {canEdit && (
                <aside className="card-side">
                  <span className="chip-label">Add to card</span>
                  <MemberPicker card={card} board={board} act={act} />
                  <LabelPicker card={card} board={board} act={act} />
                  <DuePicker card={card} onSave={(due_at) => patch({ due_at })} />
                  <button onClick={() => act(api.post(`/cards/${card.id}/checklists`, { title: 'Checklist' }))}>☑ Checklist</button>
                  <span className="chip-label">Actions</span>
                  <MoveToBoard card={card} board={board} onMoved={(to) => navigate(`/b/${to}/c/${card.id}`, true)} onError={onError} />
                  {card.archived ? (
                    <>
                      <button onClick={() => patch({ archived: false })}>Restore</button>
                      <DeleteCard cardId={card.id} onDeleted={onClose} onError={onError} />
                    </>
                  ) : (
                    <button onClick={() => patch({ archived: true })}>Archive</button>
                  )}
                </aside>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function TitleEditor({ card, canEdit, onSave }: { card: CardDetail; canEdit: boolean; onSave: (t: string) => void }) {
  const [title, setTitle] = useState(card.title);
  useEffect(() => setTitle(card.title), [card.title]);
  if (!canEdit) return <h2 className="card-title-big">{card.title}</h2>;
  const save = () => { if (title.trim() && title !== card.title) onSave(title); else setTitle(card.title); };
  return (
    <textarea className="card-title-big" value={title} rows={1} maxLength={500} onChange={(e) => setTitle(e.target.value)} onBlur={save}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); } }} aria-label="Card title" />
  );
}

function ListPicker({ card, board, canEdit, onMove }: { card: CardDetail; board: Board; canEdit: boolean; onMove: (id: number) => void }) {
  if (!canEdit) return <strong>{card.list_name}</strong>;
  return (
    <select className="inline-select" value={card.list_id} onChange={(e) => onMove(Number(e.target.value))}>
      {!board.lists.some((l) => l.id === card.list_id) && <option value={card.list_id}>{card.list_name}</option>}
      {board.lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select>
  );
}

function MarkdownEditor({ value, onSave, onCancel, placeholder, saveLabel = 'Save', autoFocus = true }: { value: string; onSave: (v: string) => void | Promise<unknown>; onCancel?: () => void; placeholder?: string; saveLabel?: string; autoFocus?: boolean }) {
  const [text, setText] = useState(value);
  const [preview, setPreview] = useState(false);
  const submit = async () => { await onSave(text); };
  return (
    <div className="md-editor">
      <div className="tabs">
        <button type="button" className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>Write</button>
        <button type="button" className={preview ? 'on' : ''} onClick={() => setPreview(true)}>Preview</button>
        <span className="muted small spacer-left">Markdown supported</span>
      </div>
      {preview ? <Markdown text={text || '_Nothing to preview_'} className="preview" /> : (
        <textarea autoFocus={autoFocus} value={text} placeholder={placeholder} onChange={(e) => setText(e.target.value)} rows={Math.min(20, Math.max(4, text.split('\n').length + 1))}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit(); if (e.key === 'Escape') onCancel?.(); }} />
      )}
      <div className="row">
        <button className="primary" type="button" onClick={submit}>{saveLabel}</button>
        {onCancel && <button type="button" onClick={onCancel}>Cancel</button>}
        <span className="muted small">⌘/Ctrl+Enter</span>
      </div>
    </div>
  );
}

function Description({ card, canEdit, onSave }: { card: CardDetail; canEdit: boolean; onSave: (d: string) => Promise<unknown> }) {
  const [editing, setEditing] = useState(false);
  return (
    <section>
      <div className="section-head"><h3>Description</h3>{canEdit && !editing && card.description && <button className="link" onClick={() => setEditing(true)}>Edit</button>}</div>
      {editing ? (
        <MarkdownEditor value={card.description} onSave={async (d) => { await onSave(d); setEditing(false); }} onCancel={() => setEditing(false)} placeholder="Add a more detailed description…" />
      ) : card.description ? (
        <Markdown text={card.description} />
      ) : canEdit ? (
        <button className="placeholder" onClick={() => setEditing(true)}>Add a more detailed description…</button>
      ) : <p className="muted">No description.</p>}
    </section>
  );
}

function ChecklistView({ list, canEdit, act }: { list: Checklist; canEdit: boolean; act: (p: Promise<unknown>) => Promise<unknown> }) {
  const [adding, setAdding] = useState(false);
  const [text, setText] = useState('');
  const [hideDone, setHideDone] = useState(false);
  const done = list.items.filter((i) => i.done).length;
  const pct = list.items.length ? Math.round((done / list.items.length) * 100) : 0;
  const add = (e: React.FormEvent) => { e.preventDefault(); if (text.trim()) { act(api.post(`/checklists/${list.id}/items`, { text })); setText(''); } };
  return (
    <section className="checklist">
      <div className="section-head">
        <h3>☑ {list.title}</h3>
        <div className="spacer" />
        {done > 0 && <button className="link" onClick={() => setHideDone(!hideDone)}>{hideDone ? 'Show checked' : 'Hide checked'}</button>}
        {canEdit && <button className="link danger" onClick={() => act(api.del(`/checklists/${list.id}`))}>Delete</button>}
      </div>
      <div className="progress"><span>{pct}%</span><div><i style={{ width: `${pct}%` }} /></div></div>
      <ul>
        {list.items.filter((i) => !hideDone || !i.done).map((i) => (
          <li key={i.id} className={i.done ? 'done' : ''}>
            <label><input type="checkbox" checked={i.done} disabled={!canEdit} onChange={(e) => act(api.patch(`/checklist-items/${i.id}`, { done: e.target.checked }))} /> <span>{i.text}</span></label>
            {canEdit && <button className="icon-btn subtle" aria-label="Delete item" onClick={() => act(api.del(`/checklist-items/${i.id}`))}>✕</button>}
          </li>
        ))}
      </ul>
      {canEdit && (adding ? (
        <form className="add-form" onSubmit={add}>
          <input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Add an item" maxLength={1000} onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} />
          <div className="row"><button className="primary">Add</button><button type="button" onClick={() => setAdding(false)}>Done</button></div>
        </form>
      ) : <button onClick={() => setAdding(true)}>Add an item</button>)}
    </section>
  );
}

function Attachments({ card, canEdit, act, onUploaded, onError }: { card: CardDetail; canEdit: boolean; act: (p: Promise<unknown>) => Promise<unknown>; onUploaded: () => void; onError: (m: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const { me } = useSession();
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    const form = new FormData();
    for (const f of files) form.append('files', f);
    setBusy(true);
    try { await api.post(`/cards/${card.id}/attachments`, form); onUploaded(); } catch (e) { onError((e as Error).message); } finally { setBusy(false); }
  };
  return (
    <section className={`attachments ${over ? 'over' : ''}`}
      onDragOver={(e) => { if (canEdit && e.dataTransfer.types.includes('Files')) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => { e.preventDefault(); setOver(false); if (canEdit) upload(e.dataTransfer.files); }}>
      <div className="section-head">
        <h3>📎 Attachments</h3>
        <div className="spacer" />
        {canEdit && <button onClick={() => input.current?.click()} disabled={busy}>{busy ? 'Uploading…' : 'Add'}</button>}
        <input ref={input} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ''; }} />
      </div>
      {card.attachments.length === 0 ? <p className="muted small">{canEdit ? 'Drop files here.' : 'None.'}</p> : (
        <ul className="files">
          {card.attachments.map((a) => (
            <li key={a.id}>
              {a.mime.startsWith('image/') ? <a href={a.url} target="_blank" rel="noreferrer"><img src={a.url} alt="" /></a> : <span className="file-ext">{a.filename.split('.').pop()?.slice(0, 4) || 'file'}</span>}
              <div>
                <a href={a.url} target="_blank" rel="noreferrer">{a.filename}</a>
                <div className="muted small">{formatBytes(a.size)} · {a.user_name ?? 'someone'} · {timeAgo(a.created_at)} · <a href={`${a.url}?download`}>download</a></div>
              </div>
              {canEdit && (a.user_id === me.id || card.my_role === 'admin') && <button className="icon-btn subtle" aria-label="Delete attachment" onClick={() => act(api.del(`/attachments/${a.id}`))}>✕</button>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Comments({ card, canEdit, act }: { card: CardDetail; canEdit: boolean; act: (p: Promise<unknown>) => Promise<unknown> }) {
  const { me } = useSession();
  const [draftKey, setDraftKey] = useState(0);
  const [editing, setEditing] = useState<number | null>(null);
  return (
    <section>
      <h3>Comments</h3>
      {canEdit && (
        <div className="comment-new">
          <Avatar user={me} />
          <MarkdownEditor key={draftKey} value="" autoFocus={false} placeholder="Write a comment… use @username to mention" saveLabel="Comment"
            onSave={async (body) => { if (body.trim()) { await act(api.post(`/cards/${card.id}/comments`, { body })); setDraftKey((k) => k + 1); } }} />
        </div>
      )}
      <ul className="comments">
        {card.comments.map((c) => (
          <li key={c.id}>
            <Avatar user={{ name: c.user_name ?? '?', color: c.user_color ?? '#888', kind: c.user_kind ?? 'human' }} />
            <div className="comment-body">
              <div><strong>{c.user_name ?? 'Deleted user'}</strong> {c.user_kind === 'agent' && <span className="pill tiny">agent</span>} <span className="muted small">{timeAgo(c.created_at)}{c.updated_at ? ' (edited)' : ''}</span></div>
              {editing === c.id ? (
                <MarkdownEditor value={c.body} onSave={async (body) => { await act(api.patch(`/comments/${c.id}`, { body })); setEditing(null); }} onCancel={() => setEditing(null)} />
              ) : <Markdown text={c.body} className="bubble" />}
              <div className="row small">
                {c.user_id === me.id && editing !== c.id && <button className="link" onClick={() => setEditing(c.id)}>Edit</button>}
                {(c.user_id === me.id || card.my_role === 'admin') && <button className="link danger" onClick={() => act(api.del(`/comments/${c.id}`))}>Delete</button>}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Popover({ label, children }: { label: React.ReactNode; children: (close: () => void) => React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useClickOutside<HTMLDivElement>(close);
  return (
    <div className="dropdown block" ref={ref}>
      <button onClick={() => setOpen(!open)}>{label}</button>
      {open && <div className="menu pop">{children(close)}</div>}
    </div>
  );
}

function MemberPicker({ card, board, act }: { card: CardDetail; board: Board; act: (p: Promise<unknown>) => Promise<unknown> }) {
  const assigned = new Set(card.assignees.map((a) => a.id));
  return (
    <Popover label="👤 Assignees">
      {() => (
        <>
          <div className="menu-head"><strong>Assign</strong></div>
          {board.members.filter((m) => m.role !== 'observer').map((m) => (
            <label key={m.id} className="pick">
              <input type="checkbox" checked={assigned.has(m.id)} onChange={(e) => act(e.target.checked ? api.put(`/cards/${card.id}/assignees/${m.id}`) : api.del(`/cards/${card.id}/assignees/${m.id}`))} />
              <Avatar user={m} size={22} /> {m.name}
            </label>
          ))}
        </>
      )}
    </Popover>
  );
}

function LabelPicker({ card, board, act }: { card: CardDetail; board: Board; act: (p: Promise<unknown>) => Promise<unknown> }) {
  const on = new Set(card.labels.map((l) => l.id));
  return (
    <Popover label="🏷 Labels">
      {() => (
        <>
          <div className="menu-head"><strong>Labels</strong><span className="muted small">Edit in board menu</span></div>
          {board.labels.map((l) => (
            <label key={l.id} className="pick">
              <input type="checkbox" checked={on.has(l.id)} onChange={(e) => act(e.target.checked ? api.put(`/cards/${card.id}/labels/${l.id}`) : api.del(`/cards/${card.id}/labels/${l.id}`))} />
              <span className="label-chip big grow" style={{ background: l.color }}>{l.name || ' '}</span>
            </label>
          ))}
        </>
      )}
    </Popover>
  );
}

function DuePicker({ card, onSave }: { card: CardDetail; onSave: (v: string | null) => void }) {
  return (
    <Popover label="◷ Due date">
      {(close) => <DueForm card={card} onSave={(v) => { onSave(v); close(); }} />}
    </Popover>
  );
}

function DueForm({ card, onSave }: { card: CardDetail; onSave: (v: string | null) => void }) {
  const [value, setValue] = useState(toLocalInput(card.due_at) || toLocalInput(new Date(Date.now() + 86400_000).toISOString()));
  return (
    <div className="stack">
      <input type="datetime-local" value={value} onChange={(e) => setValue(e.target.value)} />
      <div className="row">
        <button className="primary" onClick={() => onSave(value ? new Date(value).toISOString() : null)}>Save</button>
        {card.due_at && <button onClick={() => onSave(null)}>Remove</button>}
      </div>
    </div>
  );
}

function MoveToBoard(props: { card: CardDetail; board: Board; onMoved: (boardId: number) => void; onError: (m: string) => void }) {
  return <Popover label="➜ Move">{(close) => <MoveForm {...props} close={close} />}</Popover>;
}

function MoveForm({ card, board, onMoved, onError, close }: { card: CardDetail; board: Board; onMoved: (boardId: number) => void; onError: (m: string) => void; close: () => void }) {
  const [boards, setBoards] = useState<{ id: number; name: string; my_role: string }[]>([]);
  const [target, setTarget] = useState<number>(board.id);
  const [lists, setLists] = useState<{ id: number; name: string }[]>(board.lists);
  const [list, setList] = useState<number>(card.list_id);
  useEffect(() => { api.get<typeof boards>('/boards').then((b) => setBoards(b.filter((x) => x.my_role !== 'observer'))).catch(() => {}); }, []);
  return (
        <div className="stack">
          <label>Board
            <select value={target} onChange={async (e) => {
              const id = Number(e.target.value);
              setTarget(id);
              const b = id === board.id ? board : await api.get<Board>(`/boards/${id}`);
              setLists(b.lists);
              setList(b.lists[0]?.id ?? 0);
            }}>
              {(boards.length ? boards : [board]).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
            </select>
          </label>
          <label>List
            <select value={list} onChange={(e) => setList(Number(e.target.value))}>
              {lists.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
            </select>
          </label>
          <button className="primary" disabled={!list} onClick={() => api.post(`/cards/${card.id}/move`, { list_id: list }).then(() => { close(); if (target !== board.id) onMoved(target); }).catch((e: Error) => onError(e.message))}>Move</button>
        </div>
  );
}

function DeleteCard({ cardId, onDeleted, onError }: { cardId: number; onDeleted: () => void; onError: (m: string) => void }) {
  const [sure, setSure] = useState(false);
  if (!sure) return <button className="danger" onClick={() => setSure(true)}>Delete…</button>;
  return <button className="danger solid" onClick={() => api.del(`/cards/${cardId}`).then(onDeleted).catch((e: Error) => onError(e.message))}>Really delete</button>;
}
