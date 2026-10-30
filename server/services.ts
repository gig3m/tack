import fs from 'node:fs';
import path from 'node:path';
import { all, get, run, tx, UPLOAD_DIR } from './db.ts';
import type { Actor } from './auth.ts';
import { publicUser } from './auth.ts';
import { emitBoard, emitUser, dropUser, nudgeHome, setAccessCheck } from './realtime.ts';
import {
  bad, forbidden, notFound, obj, str, optStr, optText, optInt, int, optBool, optIntArray, oneOf, optDate, optColor, now,
} from './util.ts';

// ---------- roles ----------

export type Role = 'admin' | 'member' | 'observer';
const RANK: Record<Role, number> = { observer: 1, member: 2, admin: 3 };
const ROLES = ['admin', 'member', 'observer'] as const;

interface BoardRow {
  id: number; name: string; description: string; color: string; visibility: 'private' | 'instance';
  archived: number; created_by: number | null; created_at: string;
}
interface ListRow { id: number; board_id: number; name: string; position: number; archived: number }
interface CardRow {
  id: number; board_id: number; list_id: number; title: string; description: string; position: number;
  due_at: string | null; due_complete: number; archived: number; created_by: number | null; created_at: string; updated_at: string;
}

export function roleOn(actor: Actor, boardId: number): Role | null {
  const b = get<{ visibility: string }>('SELECT visibility FROM boards WHERE id = ?', boardId);
  if (!b) return null;
  const m = get<{ role: Role }>('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?', boardId, actor.id);
  if (actor.is_admin) return 'admin';
  if (m) return m.role;
  return b.visibility === 'instance' ? 'observer' : null;
}

setAccessCheck((userId, boardId) => {
  const u = get<{ id: number; kind: 'human' | 'agent'; username: string; name: string; is_admin: number; disabled: number }>(
    `SELECT u.id, u.kind, u.username, u.name, u.is_admin, (u.disabled OR COALESCE(o.disabled, 0)) AS disabled
     FROM users u LEFT JOIN users o ON o.id = u.owner_id WHERE u.id = ?`, userId);
  return !!u && !u.disabled && !!roleOn({ id: u.id, kind: u.kind, username: u.username, name: u.name, is_admin: !!u.is_admin, via: 'session' }, boardId);
});

function requireRole(actor: Actor, boardId: number, min: Role): Role {
  const role = roleOn(actor, boardId);
  // Hide existence of boards the caller can't see.
  if (!role) throw notFound('Board not found');
  if (RANK[role] < RANK[min]) throw forbidden(`Requires the "${min}" role on this board (you are "${role}")`);
  return role;
}

function boardOf(table: 'lists' | 'cards' | 'labels', id: number): number {
  const r = get<{ board_id: number }>(`SELECT board_id FROM ${table} WHERE id = ?`, id);
  if (!r) throw notFound(`${table.slice(0, -1)} ${id} not found`);
  return r.board_id;
}

function cardRow(actor: Actor, cardId: number, min: Role): CardRow {
  const c = get<CardRow>('SELECT * FROM cards WHERE id = ?', cardId);
  if (!c) throw notFound(`Card ${cardId} not found`);
  try {
    requireRole(actor, c.board_id, min);
  } catch (e) {
    if ((e as { status?: number }).status === 404) throw notFound(`Card ${cardId} not found`);
    throw e;
  }
  return c;
}

// ---------- activity & notifications ----------

function log(actor: Actor, boardId: number, cardId: number | null, type: string, data: Record<string, unknown> = {}) {
  run('INSERT INTO activity (board_id, card_id, user_id, type, data) VALUES (?, ?, ?, ?, ?)', boardId, cardId, actor.id, type, JSON.stringify(data));
  emitBoard({ board_id: boardId, card_id: cardId, type, actor_id: actor.id });
}

function notify(actor: Actor, userId: number, boardId: number, cardId: number | null, type: string, text: string) {
  if (userId === actor.id) return;
  if (!roleOn({ ...actor, id: userId, is_admin: !!get<{ is_admin: number }>('SELECT is_admin FROM users WHERE id = ?', userId)?.is_admin }, boardId)) return;
  run('INSERT INTO notifications (user_id, actor_id, board_id, card_id, type, text) VALUES (?, ?, ?, ?, ?, ?)', userId, actor.id, boardId, cardId, type, text);
  emitUser(userId, 'notification', { type, card_id: cardId });
}

export function listActivity(actor: Actor, opts: { board_id?: number; card_id?: number; limit?: number; before?: number }) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  let boardId = opts.board_id;
  if (opts.card_id) boardId = cardRow(actor, opts.card_id, 'observer').board_id;
  if (!boardId) throw bad('board_id or card_id is required');
  requireRole(actor, boardId, 'observer');
  const rows = all<{ id: number; board_id: number; card_id: number | null; type: string; data: string; created_at: string; user_id: number | null; user_name: string | null; user_kind: string | null; card_title: string | null }>(
    `SELECT a.*, u.name AS user_name, u.kind AS user_kind, c.title AS card_title
     FROM activity a LEFT JOIN users u ON u.id = a.user_id LEFT JOIN cards c ON c.id = a.card_id
     WHERE a.board_id = ? ${opts.card_id ? 'AND a.card_id = ?' : ''} AND a.id < ?
     ORDER BY a.id DESC LIMIT ?`,
    ...(opts.card_id ? [boardId, opts.card_id] : [boardId]), opts.before ?? Number.MAX_SAFE_INTEGER, limit,
  );
  return rows.map((r) => ({ ...r, data: JSON.parse(r.data) }));
}

export function listNotifications(actor: Actor, opts: { unread_only?: boolean; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const items = all(
    `SELECT n.id, n.type, n.text, n.read, n.created_at, COALESCE(c.board_id, n.board_id) AS board_id, n.card_id, b.name AS board_name, c.title AS card_title, u.name AS actor_name, u.kind AS actor_kind
     FROM notifications n LEFT JOIN cards c ON c.id = n.card_id LEFT JOIN boards b ON b.id = COALESCE(c.board_id, n.board_id) LEFT JOIN users u ON u.id = n.actor_id
     WHERE n.user_id = ? ${opts.unread_only ? 'AND n.read = 0' : ''} ORDER BY n.id DESC LIMIT ?`,
    actor.id, limit,
  );
  const unread = get<{ n: number }>('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read = 0', actor.id)!.n;
  const access = new Map<number, boolean>();
  const visible = (id: number | null) => id === null || (access.get(id) ?? access.set(id, !!roleOn(actor, id)).get(id)!);
  return { unread, items: (items as { board_id: number | null; board_name: string | null; card_title: string | null }[]).map((n) => visible(n.board_id) ? n : { ...n, board_name: null, card_title: null, board_id: null, card_id: null }) };
}

export function markNotificationsRead(actor: Actor, body: unknown) {
  const ids = optIntArray(obj(body), 'ids');
  if (ids?.length) {
    for (const id of ids) run('UPDATE notifications SET read = 1 WHERE id = ? AND user_id = ?', id, actor.id);
  } else {
    run('UPDATE notifications SET read = 1 WHERE user_id = ?', actor.id);
  }
  emitUser(actor.id, 'notification', { type: 'read' });
  return { ok: true };
}

// ---------- ordering ----------

/** Place `id` at `index` among its siblings and renumber positions. */
function place(table: 'lists' | 'cards' | 'checklists' | 'checklist_items', scopeCol: string, scopeId: number, id: number, index: number | undefined) {
  const archivedFilter = table === 'lists' || table === 'cards' ? 'AND archived = 0' : '';
  const ids = all<{ id: number }>(`SELECT id FROM ${table} WHERE ${scopeCol} = ? AND id != ? ${archivedFilter} ORDER BY position, id`, scopeId, id).map((r) => r.id);
  const at = index === undefined ? ids.length : Math.max(0, Math.min(index, ids.length));
  ids.splice(at, 0, id);
  ids.forEach((rid, i) => run(`UPDATE ${table} SET position = ? WHERE id = ?`, i + 1, rid));
}

// ---------- boards ----------

const DEFAULT_LABELS = ['#1a7f37', '#9a6700', '#bc4c00', '#cf222e', '#8250df', '#2f6feb'];

export function listBoards(actor: Actor, opts: { include_archived?: boolean } = {}) {
  const rows = all<BoardRow & { role: Role | null; card_count: number }>(
    `SELECT b.*, m.role,
       (SELECT COUNT(*) FROM cards c WHERE c.board_id = b.id AND c.archived = 0) AS card_count
     FROM boards b LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = ?
     WHERE (m.role IS NOT NULL OR b.visibility = 'instance' OR ?) ${opts.include_archived ? '' : 'AND b.archived = 0'}
     ORDER BY b.archived, b.name COLLATE NOCASE`,
    actor.id, Number(actor.is_admin),
  );
  return rows.map((b) => ({
    id: b.id, name: b.name, description: b.description, color: b.color, visibility: b.visibility,
    archived: !!b.archived, my_role: actor.is_admin ? 'admin' : (b.role ?? 'observer'), is_member: !!b.role, card_count: b.card_count,
  }));
}

export function createBoard(actor: Actor, body: unknown) {
  const o = obj(body);
  const name = str(o, 'name', { max: 120 });
  const description = optText(o, 'description', 10_000) ?? '';
  const color = optColor(o, 'color') ?? '#2f6feb';
  const visibility = oneOf(o, 'visibility', ['private', 'instance'] as const) ?? 'private';
  const lists = Array.isArray(o.lists) ? (o.lists as unknown[]).map((l) => String(l).trim()).filter(Boolean).slice(0, 50) : ['To do', 'Doing', 'Done'];
  const id = tx(() => {
    const { id } = run('INSERT INTO boards (name, description, color, visibility, created_by) VALUES (?, ?, ?, ?, ?)', name, description, color, visibility, actor.id);
    run("INSERT INTO board_members (board_id, user_id, role) VALUES (?, ?, 'admin')", id, actor.id);
    lists.forEach((l, i) => run('INSERT INTO lists (board_id, name, position) VALUES (?, ?, ?)', id, l.slice(0, 120), i + 1));
    for (const c of DEFAULT_LABELS) run("INSERT INTO labels (board_id, name, color) VALUES (?, '', ?)", id, c);
    log(actor, id, null, 'board.created', { name });
    return id;
  });
  return getBoard(actor, id);
}

export function getBoard(actor: Actor, boardId: number) {
  const role = requireRole(actor, boardId, 'observer');
  const b = get<BoardRow>('SELECT * FROM boards WHERE id = ?', boardId)!;
  const members = all<{ id: number; kind: 'human' | 'agent'; username: string; name: string; color: string; role: Role }>(
    `SELECT u.id, u.kind, u.username, u.name, u.color, m.role FROM board_members m JOIN users u ON u.id = m.user_id
     WHERE m.board_id = ? AND u.disabled = 0 ORDER BY u.kind, u.name COLLATE NOCASE`, boardId,
  );
  const labels = all<{ id: number; name: string; color: string }>('SELECT id, name, color FROM labels WHERE board_id = ? ORDER BY id', boardId);
  const lists = all<ListRow>('SELECT * FROM lists WHERE board_id = ? AND archived = 0 ORDER BY position, id', boardId);
  const cards = cardSummaries('c.board_id = ? AND c.archived = 0', [boardId]);
  return {
    id: b.id, name: b.name, description: b.description, color: b.color, visibility: b.visibility, archived: !!b.archived,
    my_role: role, members, labels,
    lists: lists.map((l) => ({ id: l.id, name: l.name, position: l.position, cards: cards.filter((c) => c.list_id === l.id) })),
  };
}

function cardSummaries(where: string, params: (number | string)[], extraJoin = '', limit = 10_000) {
  const rows = all<CardRow & { comment_count: number; attachment_count: number; check_total: number; check_done: number; label_ids: string | null; assignee_ids: string | null; list_name: string; board_name: string }>(
    `SELECT c.*, l.name AS list_name, b.name AS board_name,
       (SELECT COUNT(*) FROM comments x WHERE x.card_id = c.id) AS comment_count,
       (SELECT COUNT(*) FROM attachments x WHERE x.card_id = c.id) AS attachment_count,
       (SELECT COUNT(*) FROM checklist_items i JOIN checklists k ON k.id = i.checklist_id WHERE k.card_id = c.id) AS check_total,
       (SELECT COUNT(*) FROM checklist_items i JOIN checklists k ON k.id = i.checklist_id WHERE k.card_id = c.id AND i.done = 1) AS check_done,
       (SELECT group_concat(label_id) FROM card_labels x WHERE x.card_id = c.id) AS label_ids,
       (SELECT group_concat(user_id) FROM card_assignees x WHERE x.card_id = c.id) AS assignee_ids
     FROM cards c JOIN lists l ON l.id = c.list_id JOIN boards b ON b.id = c.board_id ${extraJoin}
     WHERE ${where} ORDER BY c.board_id, l.position, c.position, c.id LIMIT ${limit}`,
    ...params,
  );
  return rows.map((c) => ({
    id: c.id, board_id: c.board_id, board_name: c.board_name, list_id: c.list_id, list_name: c.list_name, title: c.title,
    has_description: c.description.trim().length > 0, position: c.position,
    due_at: c.due_at, due_complete: !!c.due_complete, archived: !!c.archived,
    label_ids: c.label_ids ? c.label_ids.split(',').map(Number) : [],
    assignee_ids: c.assignee_ids ? c.assignee_ids.split(',').map(Number) : [],
    comment_count: c.comment_count, attachment_count: c.attachment_count,
    checklist: { done: c.check_done, total: c.check_total },
    updated_at: c.updated_at,
  }));
}

export function updateBoard(actor: Actor, boardId: number, body: unknown) {
  requireRole(actor, boardId, 'admin');
  const o = obj(body);
  const b = get<BoardRow>('SELECT * FROM boards WHERE id = ?', boardId)!;
  const name = optStr(o, 'name', { max: 120, min: 1 }) ?? b.name;
  const description = optText(o, 'description', 10_000) ?? b.description;
  const color = optColor(o, 'color') ?? b.color;
  const visibility = oneOf(o, 'visibility', ['private', 'instance'] as const) ?? b.visibility;
  const archived = optBool(o, 'archived');
  run('UPDATE boards SET name = ?, description = ?, color = ?, visibility = ?, archived = ? WHERE id = ?',
    name, description, color, visibility, archived === undefined ? b.archived : Number(archived), boardId);
  log(actor, boardId, null, archived === undefined ? 'board.updated' : archived ? 'board.archived' : 'board.restored', { name });
  if (b.visibility === 'instance' && visibility === 'private') nudgeHome();
  return getBoard(actor, boardId);
}

export function deleteBoard(actor: Actor, boardId: number) {
  requireRole(actor, boardId, 'admin');
  const files = all<{ stored_name: string }>('SELECT a.stored_name FROM attachments a JOIN cards c ON c.id = a.card_id WHERE c.board_id = ?', boardId);
  run('DELETE FROM boards WHERE id = ?', boardId);
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f.stored_name), { force: true }, () => {});
  emitBoard({ board_id: boardId, type: 'board.deleted', actor_id: actor.id });
  return { ok: true };
}

// ---------- members ----------

function resolveUser(o: Record<string, unknown>) {
  const id = optInt(o, 'user_id');
  const u = id !== undefined
    ? get<{ id: number; name: string; disabled: number }>('SELECT id, name, disabled FROM users WHERE id = ?', id)
    : get<{ id: number; name: string; disabled: number }>('SELECT id, name, disabled FROM users WHERE username = ?', str(o, 'username', { max: 32 }));
  if (!u || u.disabled) throw notFound('User not found');
  return u;
}

function adminCount(boardId: number) {
  return get<{ n: number }>("SELECT COUNT(*) AS n FROM board_members WHERE board_id = ? AND role = 'admin'", boardId)!.n;
}

export function addMember(actor: Actor, boardId: number, body: unknown) {
  requireRole(actor, boardId, 'admin');
  const o = obj(body);
  const u = resolveUser(o);
  const role = oneOf(o, 'role', ROLES) ?? 'member';
  const cur = get<{ role: Role }>('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?', boardId, u.id);
  if (cur?.role === 'admin' && role !== 'admin' && adminCount(boardId) <= 1) throw bad('A board needs at least one admin');
  run('INSERT INTO board_members (board_id, user_id, role) VALUES (?, ?, ?) ON CONFLICT (board_id, user_id) DO UPDATE SET role = excluded.role', boardId, u.id, role);
  log(actor, boardId, null, 'member.added', { user_id: u.id, name: u.name, role });
  notify(actor, u.id, boardId, null, 'added_to_board', `added you to the board as ${role}`);
  return getBoard(actor, boardId).members;
}

export function updateMember(actor: Actor, boardId: number, userId: number, body: unknown) {
  requireRole(actor, boardId, 'admin');
  const role = oneOf(obj(body), 'role', ROLES);
  if (!role) throw bad('"role" is required');
  const cur = get<{ role: Role }>('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?', boardId, userId);
  if (!cur) throw notFound('Not a member of this board');
  if (cur.role === 'admin' && role !== 'admin' && adminCount(boardId) <= 1) throw bad('A board needs at least one admin');
  run('UPDATE board_members SET role = ? WHERE board_id = ? AND user_id = ?', role, boardId, userId);
  log(actor, boardId, null, 'member.role', { user_id: userId, role });
  return getBoard(actor, boardId).members;
}

export function removeMember(actor: Actor, boardId: number, userId: number) {
  // Anyone may leave; admins may remove others.
  requireRole(actor, boardId, userId === actor.id ? 'observer' : 'admin');
  const cur = get<{ role: Role }>('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?', boardId, userId);
  if (!cur) throw notFound('Not a member of this board');
  if (cur.role === 'admin' && adminCount(boardId) <= 1) throw bad('A board needs at least one admin');
  tx(() => {
    run('DELETE FROM board_members WHERE board_id = ? AND user_id = ?', boardId, userId);
    run('DELETE FROM card_assignees WHERE user_id = ? AND card_id IN (SELECT id FROM cards WHERE board_id = ?)', userId, boardId);
    log(actor, boardId, null, 'member.removed', { user_id: userId });
  });
  dropUser(userId, boardId);
  emitUser(userId, 'boards', {});
  return { ok: true };
}

// ---------- lists ----------

export function createList(actor: Actor, boardId: number, body: unknown) {
  requireRole(actor, boardId, 'member');
  const o = obj(body);
  const name = str(o, 'name', { max: 120 });
  return tx(() => {
    const { id } = run('INSERT INTO lists (board_id, name, position) VALUES (?, ?, 1e9)', boardId, name);
    place('lists', 'board_id', boardId, id, optInt(o, 'position'));
    log(actor, boardId, null, 'list.created', { list_id: id, name });
    return get<ListRow>('SELECT * FROM lists WHERE id = ?', id)!;
  });
}

export function updateList(actor: Actor, listId: number, body: unknown) {
  const boardId = boardOf('lists', listId);
  requireRole(actor, boardId, 'member');
  const o = obj(body);
  const l = get<ListRow>('SELECT * FROM lists WHERE id = ?', listId)!;
  return tx(() => {
    const name = optStr(o, 'name', { max: 120, min: 1 });
    if (name !== undefined && name !== l.name) {
      run('UPDATE lists SET name = ? WHERE id = ?', name, listId);
      log(actor, boardId, null, 'list.renamed', { list_id: listId, from: l.name, name });
    }
    const archived = optBool(o, 'archived');
    if (archived !== undefined && archived !== !!l.archived) {
      run('UPDATE lists SET archived = ? WHERE id = ?', Number(archived), listId);
      if (!archived) place('lists', 'board_id', boardId, listId, undefined);
      log(actor, boardId, null, archived ? 'list.archived' : 'list.restored', { list_id: listId, name: l.name });
    }
    const pos = optInt(o, 'position');
    if (pos !== undefined) {
      place('lists', 'board_id', boardId, listId, pos);
      log(actor, boardId, null, 'list.moved', { list_id: listId, name: l.name });
    }
    return get<ListRow>('SELECT * FROM lists WHERE id = ?', listId)!;
  });
}

export function deleteList(actor: Actor, listId: number) {
  const boardId = boardOf('lists', listId);
  requireRole(actor, boardId, 'admin');
  const l = get<ListRow>('SELECT * FROM lists WHERE id = ?', listId)!;
  const files = all<{ stored_name: string }>('SELECT a.stored_name FROM attachments a JOIN cards c ON c.id = a.card_id WHERE c.list_id = ?', listId);
  run('DELETE FROM lists WHERE id = ?', listId);
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f.stored_name), { force: true }, () => {});
  log(actor, boardId, null, 'list.deleted', { name: l.name });
  return { ok: true };
}

export function listArchived(actor: Actor, boardId: number) {
  requireRole(actor, boardId, 'observer');
  return {
    lists: all<ListRow>('SELECT * FROM lists WHERE board_id = ? AND archived = 1 ORDER BY name', boardId),
    cards: cardSummaries('c.board_id = ? AND c.archived = 1', [boardId]),
  };
}

// ---------- labels ----------

export function createLabel(actor: Actor, boardId: number, body: unknown) {
  requireRole(actor, boardId, 'member');
  const o = obj(body);
  const name = optStr(o, 'name', { max: 60 }) ?? '';
  const color = optColor(o, 'color') ?? '#57606a';
  const { id } = run('INSERT INTO labels (board_id, name, color) VALUES (?, ?, ?)', boardId, name, color);
  log(actor, boardId, null, 'label.created', { label_id: id, name, color });
  return { id, name, color };
}

export function updateLabel(actor: Actor, labelId: number, body: unknown) {
  const boardId = boardOf('labels', labelId);
  requireRole(actor, boardId, 'member');
  const o = obj(body);
  run('UPDATE labels SET name = COALESCE(?, name), color = COALESCE(?, color) WHERE id = ?', optStr(o, 'name', { max: 60 }) ?? null, optColor(o, 'color') ?? null, labelId);
  log(actor, boardId, null, 'label.updated', { label_id: labelId });
  return get('SELECT id, name, color FROM labels WHERE id = ?', labelId);
}

export function deleteLabel(actor: Actor, labelId: number) {
  const boardId = boardOf('labels', labelId);
  requireRole(actor, boardId, 'member');
  run('DELETE FROM labels WHERE id = ?', labelId);
  log(actor, boardId, null, 'label.deleted', { label_id: labelId });
  return { ok: true };
}

// ---------- cards ----------

function validLabelIds(boardId: number, ids: number[]) {
  for (const id of ids) if (!get('SELECT 1 FROM labels WHERE id = ? AND board_id = ?', id, boardId)) throw bad(`Label ${id} is not on this board`);
  return ids;
}

function validAssignees(actor: Actor, boardId: number, ids: number[]) {
  for (const id of ids) {
    const u = get<{ is_admin: number; kind: 'human' | 'agent'; disabled: number }>('SELECT is_admin, kind, disabled FROM users WHERE id = ?', id);
    const role = u && !u.disabled ? roleOn({ ...actor, id, is_admin: !!u.is_admin, kind: u.kind }, boardId) : null;
    if (!role || role === 'observer') throw bad(`User ${id} must be a member of this board to be assigned`);
  }
  return ids;
}

function setAssignees(actor: Actor, card: CardRow, ids: number[]) {
  const cur = all<{ user_id: number }>('SELECT user_id FROM card_assignees WHERE card_id = ?', card.id).map((r) => r.user_id);
  validAssignees(actor, card.board_id, ids.filter((id) => !cur.includes(id)));
  for (const id of cur.filter((x) => !ids.includes(x))) {
    run('DELETE FROM card_assignees WHERE card_id = ? AND user_id = ?', card.id, id);
    log(actor, card.board_id, card.id, 'card.unassigned', { user_id: id, name: userName(id) });
  }
  for (const id of ids.filter((x) => !cur.includes(x))) {
    run('INSERT INTO card_assignees (card_id, user_id) VALUES (?, ?)', card.id, id);
    log(actor, card.board_id, card.id, 'card.assigned', { user_id: id, name: userName(id) });
    notify(actor, id, card.board_id, card.id, 'assigned', 'assigned you to');
  }
}

function setLabels(actor: Actor, card: CardRow, ids: number[]) {
  validLabelIds(card.board_id, ids);
  const cur = all<{ label_id: number }>('SELECT label_id FROM card_labels WHERE card_id = ?', card.id).map((r) => r.label_id);
  for (const id of cur.filter((x) => !ids.includes(x))) run('DELETE FROM card_labels WHERE card_id = ? AND label_id = ?', card.id, id);
  for (const id of ids.filter((x) => !cur.includes(x))) run('INSERT INTO card_labels (card_id, label_id) VALUES (?, ?)', card.id, id);
  if (cur.length !== ids.length || cur.some((x) => !ids.includes(x))) log(actor, card.board_id, card.id, 'card.labels', { label_ids: ids });
}

const userName = (id: number) => get<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name ?? 'someone';

export function createCard(actor: Actor, body: unknown) {
  const o = obj(body);
  const listId = int(o, 'list_id');
  const boardId = boardOf('lists', listId);
  requireRole(actor, boardId, 'member');
  assertOpenList(listId);
  const title = str(o, 'title', { max: 500 });
  const description = optText(o, 'description') ?? '';
  const due = optDate(o, 'due_at') ?? null;
  const id = tx(() => {
    const { id } = run('INSERT INTO cards (board_id, list_id, title, description, position, due_at, created_by) VALUES (?, ?, ?, ?, 1e9, ?, ?)',
      boardId, listId, title, description, due, actor.id);
    place('cards', 'list_id', listId, id, optInt(o, 'position'));
    const card = get<CardRow>('SELECT * FROM cards WHERE id = ?', id)!;
    log(actor, boardId, id, 'card.created', { title, list: listName(listId) });
    const labels = optIntArray(o, 'label_ids');
    if (labels) setLabels(actor, card, labels);
    const assignees = optIntArray(o, 'assignee_ids');
    if (assignees) setAssignees(actor, card, assignees);
    return id;
  });
  return getCard(actor, id);
}

function assertOpenList(listId: number) {
  const l = get<{ archived: number; board_archived: number }>('SELECT l.archived, b.archived AS board_archived FROM lists l JOIN boards b ON b.id = l.board_id WHERE l.id = ?', listId);
  if (l?.archived || l?.board_archived) throw bad('That list or board is archived');
}

/** Throws unless the caller has at least `min` on the card's board. */
export function assertCardRole(actor: Actor, cardId: number, min: Role) {
  cardRow(actor, cardId, min);
}

const listName = (id: number) => get<{ name: string }>('SELECT name FROM lists WHERE id = ?', id)?.name ?? '';

export function getCard(actor: Actor, cardId: number) {
  const c = cardRow(actor, cardId, 'observer');
  const labels = all('SELECT l.id, l.name, l.color FROM card_labels x JOIN labels l ON l.id = x.label_id WHERE x.card_id = ? ORDER BY l.id', cardId);
  const assignees = all<{ id: number; kind: 'human' | 'agent'; username: string; name: string; color: string }>(
    'SELECT u.id, u.kind, u.username, u.name, u.color FROM card_assignees x JOIN users u ON u.id = x.user_id WHERE x.card_id = ?', cardId,
  ).map(publicUser);
  const checklists = all<{ id: number; title: string; position: number }>('SELECT id, title, position FROM checklists WHERE card_id = ? ORDER BY position, id', cardId)
    .map((k) => ({ ...k, items: all<{ id: number; text: string; done: number; position: number }>('SELECT id, text, done, position FROM checklist_items WHERE checklist_id = ? ORDER BY position, id', k.id).map((i) => ({ ...i, done: !!i.done })) }));
  const comments = all<{ id: number; body: string; created_at: string; updated_at: string | null; user_id: number | null; user_name: string | null; user_kind: string | null; user_color: string | null; user_username: string | null }>(
    `SELECT m.id, m.body, m.created_at, m.updated_at, m.user_id, u.name AS user_name, u.kind AS user_kind, u.color AS user_color, u.username AS user_username
     FROM comments m LEFT JOIN users u ON u.id = m.user_id WHERE m.card_id = ? ORDER BY m.id DESC`, cardId,
  );
  const attachments = all<{ id: number }>('SELECT a.id, a.filename, a.mime, a.size, a.created_at, a.user_id, u.name AS user_name FROM attachments a LEFT JOIN users u ON u.id = a.user_id WHERE a.card_id = ? ORDER BY a.id DESC', cardId)
    .map((a) => ({ ...a, url: `/api/attachments/${a.id}` }));
  const creator = c.created_by ? userName(c.created_by) : null;
  return {
    id: c.id, board_id: c.board_id, list_id: c.list_id, list_name: listName(c.list_id), title: c.title, description: c.description,
    due_at: c.due_at, due_complete: !!c.due_complete, archived: !!c.archived, created_at: c.created_at, updated_at: c.updated_at,
    created_by: creator, my_role: roleOn(actor, c.board_id), labels, assignees, checklists, comments, attachments,
  };
}

export function updateCard(actor: Actor, cardId: number, body: unknown) {
  const c = cardRow(actor, cardId, 'member');
  const o = obj(body);
  tx(() => {
    const title = optStr(o, 'title', { max: 500, min: 1 });
    if (title !== undefined && title !== c.title) {
      run('UPDATE cards SET title = ? WHERE id = ?', title, cardId);
      log(actor, c.board_id, cardId, 'card.renamed', { from: c.title, title });
    }
    const description = optText(o, 'description');
    if (description !== undefined && description !== c.description) {
      run('UPDATE cards SET description = ? WHERE id = ?', description, cardId);
      log(actor, c.board_id, cardId, 'card.description', {});
      mentions(actor, c, description, c.description, 'description');
    }
    const due = optDate(o, 'due_at');
    if (due !== undefined && due !== c.due_at) {
      run('UPDATE cards SET due_at = ? WHERE id = ?', due, cardId);
      log(actor, c.board_id, cardId, 'card.due', { due_at: due });
    }
    const dueComplete = optBool(o, 'due_complete');
    if (dueComplete !== undefined && dueComplete !== !!c.due_complete) {
      run('UPDATE cards SET due_complete = ? WHERE id = ?', Number(dueComplete), cardId);
      log(actor, c.board_id, cardId, dueComplete ? 'card.due_done' : 'card.due_undone', {});
    }
    const listId = optInt(o, 'list_id');
    const pos = optInt(o, 'position');
    if (listId !== undefined && listId !== c.list_id) {
      if (boardOf('lists', listId) !== c.board_id) throw bad('Cards can only move to lists on the same board (use move_card)');
      assertOpenList(listId);
      run('UPDATE cards SET list_id = ? WHERE id = ?', listId, cardId);
      place('cards', 'list_id', listId, cardId, pos);
      place('cards', 'list_id', c.list_id, -1, undefined);
      log(actor, c.board_id, cardId, 'card.moved', { from: listName(c.list_id), to: listName(listId) });
    } else if (pos !== undefined) {
      place('cards', 'list_id', c.list_id, cardId, pos);
    }
    const archived = optBool(o, 'archived');
    if (archived !== undefined && archived !== !!c.archived) {
      run('UPDATE cards SET archived = ? WHERE id = ?', Number(archived), cardId);
      if (!archived) place('cards', 'list_id', listId ?? c.list_id, cardId, undefined);
      log(actor, c.board_id, cardId, archived ? 'card.archived' : 'card.restored', { title: c.title });
    }
    const labels = optIntArray(o, 'label_ids');
    if (labels) setLabels(actor, c, labels);
    const assignees = optIntArray(o, 'assignee_ids');
    if (assignees) setAssignees(actor, c, assignees);
    run('UPDATE cards SET updated_at = ? WHERE id = ?', now(), cardId);
  });
  return getCard(actor, cardId);
}

export function toggleCardLabel(actor: Actor, cardId: number, labelId: number, on: boolean) {
  const c = cardRow(actor, cardId, 'member');
  const cur = all<{ label_id: number }>('SELECT label_id FROM card_labels WHERE card_id = ?', cardId).map((r) => r.label_id);
  setLabels(actor, c, on ? [...new Set([...cur, labelId])] : cur.filter((x) => x !== labelId));
  return getCard(actor, cardId);
}

export function toggleAssignee(actor: Actor, cardId: number, userId: number, on: boolean) {
  const c = cardRow(actor, cardId, 'member');
  const cur = all<{ user_id: number }>('SELECT user_id FROM card_assignees WHERE card_id = ?', cardId).map((r) => r.user_id);
  tx(() => setAssignees(actor, c, on ? [...new Set([...cur, userId])] : cur.filter((x) => x !== userId)));
  return getCard(actor, cardId);
}

export function moveCardToBoard(actor: Actor, cardId: number, body: unknown) {
  const c = cardRow(actor, cardId, 'member');
  const o = obj(body);
  const listId = int(o, 'list_id');
  const target = boardOf('lists', listId);
  if (target === c.board_id) return updateCard(actor, cardId, { list_id: listId, position: o.position ?? Number.MAX_SAFE_INTEGER });
  requireRole(actor, target, 'member');
  assertOpenList(listId);
  tx(() => {
    // Labels are board-scoped; assignees must be members of the target board.
    run('DELETE FROM card_labels WHERE card_id = ?', cardId);
    for (const { user_id } of all<{ user_id: number }>('SELECT user_id FROM card_assignees WHERE card_id = ?', cardId)) {
      if (!get('SELECT 1 FROM board_members WHERE board_id = ? AND user_id = ? AND role != ?', target, user_id, 'observer')) {
        run('DELETE FROM card_assignees WHERE card_id = ? AND user_id = ?', cardId, user_id);
      }
    }
    run('UPDATE cards SET board_id = ?, list_id = ?, updated_at = ? WHERE id = ?', target, listId, now(), cardId);
    run('UPDATE activity SET card_id = NULL WHERE card_id = ?', cardId);
    place('cards', 'list_id', listId, cardId, optInt(o, 'position'));
    place('cards', 'list_id', c.list_id, -1, undefined);
    log(actor, c.board_id, null, 'card.moved_out', { title: c.title });
    log(actor, target, cardId, 'card.moved_in', { title: c.title });
  });
  return getCard(actor, cardId);
}

export function deleteCard(actor: Actor, cardId: number) {
  const c = cardRow(actor, cardId, 'member');
  const files = all<{ stored_name: string }>('SELECT stored_name FROM attachments WHERE card_id = ?', cardId);
  tx(() => {
    run('DELETE FROM cards WHERE id = ?', cardId);
    place('cards', 'list_id', c.list_id, -1, undefined);
    log(actor, c.board_id, null, 'card.deleted', { title: c.title });
  });
  for (const f of files) fs.rm(path.join(UPLOAD_DIR, f.stored_name), { force: true }, () => {});
  return { ok: true };
}

export function searchCards(actor: Actor, body: unknown) {
  const o = obj(body);
  const where: string[] = [];
  const params: (number | string)[] = [];
  const boardId = optInt(o, 'board_id');
  if (boardId !== undefined) {
    requireRole(actor, boardId, 'observer');
    where.push('c.board_id = ?');
    params.push(boardId);
  } else if (!actor.is_admin) {
    where.push("c.board_id IN (SELECT b.id FROM boards b LEFT JOIN board_members m ON m.board_id = b.id AND m.user_id = ? WHERE b.archived = 0 AND (m.role IS NOT NULL OR b.visibility = 'instance'))");
    params.push(actor.id);
  }
  const q = optStr(o, 'query', { max: 200 });
  if (q) {
    where.push("(c.title LIKE ? ESCAPE '\\' OR c.description LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, (m) => '\\' + m)}%`;
    params.push(like, like);
  }
  const listId = optInt(o, 'list_id');
  if (listId !== undefined) { where.push('c.list_id = ?'); params.push(listId); }
  const assignee = o.assignee === 'me' ? actor.id : optInt(o, 'assignee_id');
  if (assignee !== undefined) { where.push('EXISTS (SELECT 1 FROM card_assignees x WHERE x.card_id = c.id AND x.user_id = ?)'); params.push(assignee); }
  const label = optInt(o, 'label_id');
  if (label !== undefined) { where.push('EXISTS (SELECT 1 FROM card_labels x WHERE x.card_id = c.id AND x.label_id = ?)'); params.push(label); }
  const dueBefore = optDate(o, 'due_before');
  if (dueBefore) { where.push('c.due_at IS NOT NULL AND c.due_at <= ? AND c.due_complete = 0'); params.push(dueBefore); }
  if (!optBool(o, 'include_archived')) where.push('c.archived = 0');
  const limit = Math.min(Math.max(optInt(o, 'limit') ?? 50, 1), 200);
  return cardSummaries(where.length ? where.join(' AND ') : '1', params, '', limit);
}

// ---------- mentions ----------

function mentions(actor: Actor, card: CardRow, text: string, previous: string, where: 'comment' | 'description') {
  const found = (s: string) => new Set([...s.matchAll(/(?:^|[^\w@])@([a-z0-9][a-z0-9_.-]{1,31})/gi)].map((m) => m[1].toLowerCase().replace(/[.-]+$/, '')));
  const before = found(previous);
  for (const uname of found(text)) {
    if (before.has(uname)) continue;
    const u = get<{ id: number }>('SELECT id FROM users WHERE username = ? AND disabled = 0', uname);
    if (u) notify(actor, u.id, card.board_id, card.id, 'mentioned', where === 'comment' ? 'mentioned you in a comment on' : 'mentioned you in');
  }
}

// ---------- comments ----------

export function addComment(actor: Actor, cardId: number, body: unknown) {
  const c = cardRow(actor, cardId, 'member');
  const text = optText(obj(body), 'body', 20_000);
  if (!text?.trim()) throw bad('"body" is required');
  const id = tx(() => {
    const { id } = run('INSERT INTO comments (card_id, user_id, body) VALUES (?, ?, ?)', cardId, actor.id, text);
    log(actor, c.board_id, cardId, 'comment.added', { comment_id: id, excerpt: text.slice(0, 140) });
    mentions(actor, c, text, '', 'comment');
    for (const { user_id } of all<{ user_id: number }>('SELECT user_id FROM card_assignees WHERE card_id = ?', cardId)) {
      if (!new RegExp(`@${userNameOf(user_id)}\\b`, 'i').test(text)) notify(actor, user_id, c.board_id, cardId, 'comment', 'commented on');
    }
    return id;
  });
  return get('SELECT * FROM comments WHERE id = ?', id);
}

const userNameOf = (id: number) => (get<{ username: string }>('SELECT username FROM users WHERE id = ?', id)?.username ?? '').replace(/[.]/g, '\\.');

function commentRow(actor: Actor, commentId: number) {
  const m = get<{ id: number; card_id: number; user_id: number | null; body: string }>('SELECT * FROM comments WHERE id = ?', commentId);
  if (!m) throw notFound('Comment not found');
  const c = cardRow(actor, m.card_id, 'member');
  return { m, c };
}

export function updateComment(actor: Actor, commentId: number, body: unknown) {
  const { m, c } = commentRow(actor, commentId);
  if (m.user_id !== actor.id) throw forbidden('You can only edit your own comments');
  const text = optText(obj(body), 'body', 20_000);
  if (!text?.trim()) throw bad('"body" is required');
  run('UPDATE comments SET body = ?, updated_at = ? WHERE id = ?', text, now(), commentId);
  mentions(actor, c, text, m.body, 'comment');
  emitBoard({ board_id: c.board_id, card_id: c.id, type: 'comment.edited', actor_id: actor.id });
  return get('SELECT * FROM comments WHERE id = ?', commentId);
}

export function deleteComment(actor: Actor, commentId: number) {
  const { m, c } = commentRow(actor, commentId);
  if (m.user_id !== actor.id && roleOn(actor, c.board_id) !== 'admin') throw forbidden('You can only delete your own comments');
  run('DELETE FROM comments WHERE id = ?', commentId);
  log(actor, c.board_id, c.id, 'comment.deleted', {});
  return { ok: true };
}

// ---------- checklists ----------

function checklistRow(actor: Actor, checklistId: number, min: Role) {
  const k = get<{ id: number; card_id: number; title: string }>('SELECT * FROM checklists WHERE id = ?', checklistId);
  if (!k) throw notFound('Checklist not found');
  return { k, c: cardRow(actor, k.card_id, min) };
}

function itemRow(actor: Actor, itemId: number) {
  const i = get<{ id: number; checklist_id: number; text: string; done: number }>('SELECT * FROM checklist_items WHERE id = ?', itemId);
  if (!i) throw notFound('Checklist item not found');
  return { i, ...checklistRow(actor, i.checklist_id, 'member') };
}

export function createChecklist(actor: Actor, cardId: number, body: unknown) {
  const c = cardRow(actor, cardId, 'member');
  const o = obj(body);
  const title = optStr(o, 'title', { max: 200, min: 1 }) ?? 'Checklist';
  const items = Array.isArray(o.items) ? (o.items as unknown[]).map((x) => String(x).trim()).filter(Boolean).slice(0, 200) : [];
  return tx(() => {
    const { id } = run('INSERT INTO checklists (card_id, title, position) VALUES (?, ?, 1e9)', cardId, title);
    place('checklists', 'card_id', cardId, id, undefined);
    items.forEach((t, n) => run('INSERT INTO checklist_items (checklist_id, text, position) VALUES (?, ?, ?)', id, t.slice(0, 1000), n + 1));
    log(actor, c.board_id, cardId, 'checklist.created', { title });
    return { id, title };
  });
}

export function updateChecklist(actor: Actor, checklistId: number, body: unknown) {
  const { k, c } = checklistRow(actor, checklistId, 'member');
  const title = optStr(obj(body), 'title', { max: 200, min: 1 });
  if (title) run('UPDATE checklists SET title = ? WHERE id = ?', title, k.id);
  emitBoard({ board_id: c.board_id, card_id: c.id, type: 'checklist.updated', actor_id: actor.id });
  return { ok: true };
}

export function deleteChecklist(actor: Actor, checklistId: number) {
  const { k, c } = checklistRow(actor, checklistId, 'member');
  run('DELETE FROM checklists WHERE id = ?', k.id);
  log(actor, c.board_id, c.id, 'checklist.deleted', { title: k.title });
  return { ok: true };
}

export function addChecklistItem(actor: Actor, checklistId: number, body: unknown) {
  const { k, c } = checklistRow(actor, checklistId, 'member');
  const o = obj(body);
  const text = str(o, 'text', { max: 1000 });
  return tx(() => {
    const { id } = run('INSERT INTO checklist_items (checklist_id, text, position) VALUES (?, ?, 1e9)', k.id, text);
    place('checklist_items', 'checklist_id', k.id, id, optInt(o, 'position'));
    emitBoard({ board_id: c.board_id, card_id: c.id, type: 'checklist.item_added', actor_id: actor.id });
    return { id, text, done: false };
  });
}

export function updateChecklistItem(actor: Actor, itemId: number, body: unknown) {
  const { i, c } = itemRow(actor, itemId);
  const o = obj(body);
  tx(() => {
    const text = optStr(o, 'text', { max: 1000, min: 1 });
    if (text) run('UPDATE checklist_items SET text = ? WHERE id = ?', text, itemId);
    const done = optBool(o, 'done');
    if (done !== undefined && done !== !!i.done) {
      run('UPDATE checklist_items SET done = ? WHERE id = ?', Number(done), itemId);
      log(actor, c.board_id, c.id, done ? 'checklist.item_done' : 'checklist.item_undone', { text: text ?? i.text });
    }
    const pos = optInt(o, 'position');
    if (pos !== undefined) place('checklist_items', 'checklist_id', i.checklist_id, itemId, pos);
    emitBoard({ board_id: c.board_id, card_id: c.id, type: 'checklist.item_updated', actor_id: actor.id });
  });
  return get('SELECT id, text, done FROM checklist_items WHERE id = ?', itemId);
}

export function deleteChecklistItem(actor: Actor, itemId: number) {
  const { c } = itemRow(actor, itemId);
  run('DELETE FROM checklist_items WHERE id = ?', itemId);
  emitBoard({ board_id: c.board_id, card_id: c.id, type: 'checklist.item_deleted', actor_id: actor.id });
  return { ok: true };
}

// ---------- attachments ----------

export const MAX_UPLOAD_BYTES = Number(process.env.TACK_MAX_UPLOAD_MB ?? 25) * 1024 * 1024;

export function addAttachment(actor: Actor, cardId: number, file: { originalname: string; mimetype: string; size: number; filename: string }) {
  let c: CardRow;
  try {
    c = cardRow(actor, cardId, 'member');
  } catch (e) {
    fs.rm(path.join(UPLOAD_DIR, file.filename), { force: true }, () => {});
    throw e;
  }
  const name = file.originalname.replace(/[\r\n"\\/]/g, '_').slice(0, 255) || 'file';
  const { id } = run('INSERT INTO attachments (card_id, user_id, filename, mime, size, stored_name) VALUES (?, ?, ?, ?, ?, ?)',
    cardId, actor.id, name, file.mimetype || 'application/octet-stream', file.size, file.filename);
  log(actor, c.board_id, cardId, 'attachment.added', { attachment_id: id, filename: name });
  return { id, filename: name, mime: file.mimetype, size: file.size, url: `/api/attachments/${id}` };
}

/** Text attachment from content (used by agents over MCP). */
export function addTextAttachment(actor: Actor, cardId: number, filename: string, content: string, mime = 'text/plain') {
  cardRow(actor, cardId, 'member');
  if (Buffer.byteLength(content) > MAX_UPLOAD_BYTES) throw bad('Attachment is too large');
  const stored = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), content);
  return addAttachment(actor, cardId, { originalname: filename, mimetype: mime, size: Buffer.byteLength(content), filename: stored });
}

export function attachmentFile(actor: Actor, attachmentId: number) {
  const a = get<{ id: number; card_id: number; user_id: number | null; filename: string; mime: string; size: number; stored_name: string }>('SELECT * FROM attachments WHERE id = ?', attachmentId);
  if (!a) throw notFound('Attachment not found');
  cardRow(actor, a.card_id, 'observer');
  return { ...a, path: path.join(UPLOAD_DIR, a.stored_name) };
}

export function deleteAttachment(actor: Actor, attachmentId: number) {
  const a = attachmentFile(actor, attachmentId);
  const c = cardRow(actor, a.card_id, 'member');
  if (a.user_id !== actor.id && roleOn(actor, c.board_id) !== 'admin') throw forbidden('Only the uploader or a board admin can delete this attachment');
  run('DELETE FROM attachments WHERE id = ?', attachmentId);
  fs.rm(a.path, { force: true }, () => {});
  log(actor, c.board_id, c.id, 'attachment.deleted', { filename: a.filename });
  return { ok: true };
}
