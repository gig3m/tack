/**
 * MCP server over Streamable HTTP (stateless, JSON responses).
 * Each request authenticates with `Authorization: Bearer <token>`; the token's user (human or agent)
 * is the actor, so agents are bound by the same board roles as people.
 */
import fs from 'node:fs';
import type { Request, Response } from 'express';
import { authenticate, me, listUsers, type Actor } from './auth.ts';
import * as svc from './services.ts';
import { HttpError } from './util.ts';

const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const SERVER_INFO = { name: 'tack', title: 'Tack kanban', version: '0.1.0' };

const INSTRUCTIONS = `Tack is a kanban board. Boards contain ordered lists; lists contain ordered cards.
Cards have markdown descriptions, labels, assignees, due dates, checklists, comments and attachments.
You act as your own account; your board role decides what you may do (observer: read; member: edit; admin: manage board & members).
Typical loop: whoami → list_notifications / search_cards {assignee:"me"} → get_card → work → add_comment / update_card / move_card.
Positions are 0-based indexes within the destination list. Dates are ISO 8601. Mention people in comments with @username.`;

type Json = Record<string, unknown>;
interface Tool {
  name: string;
  description: string;
  inputSchema: Json;
  annotations?: Json;
  run: (actor: Actor, a: Json) => unknown;
}

const id = (description: string) => ({ type: 'integer', description });
const s = (description: string) => ({ type: 'string', description });
const b = (description: string) => ({ type: 'boolean', description });
const ids = (description: string) => ({ type: 'array', items: { type: 'integer' }, description });
const schema = (properties: Json, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const RO = { readOnlyHint: true };

/** Board payload with label/assignee names inlined so agents don't need to join ids. */
function readableBoard(actor: Actor, boardId: number) {
  const board = svc.getBoard(actor, boardId);
  const labels = new Map(board.labels.map((l) => [l.id, l]));
  const people = new Map(board.members.map((m) => [m.id, m.username]));
  return {
    ...board,
    lists: board.lists.map((l) => ({
      id: l.id, name: l.name,
      cards: l.cards.map((c) => ({
        id: c.id, title: c.title, due_at: c.due_at, due_complete: c.due_complete,
        labels: c.label_ids.map((x) => labels.get(x)?.name || labels.get(x)?.color),
        assignees: c.assignee_ids.map((x) => people.get(x) ?? x),
        checklist: c.checklist.total ? `${c.checklist.done}/${c.checklist.total}` : undefined,
        comments: c.comment_count || undefined, attachments: c.attachment_count || undefined,
      })),
    })),
  };
}

const TOOLS: Tool[] = [
  {
    name: 'whoami', description: 'Your account (id, username, kind) and unread notification count.', inputSchema: schema({}), annotations: RO,
    run: (actor) => ({ ...me(actor), unread_notifications: svc.listNotifications(actor, { unread_only: true, limit: 1 }).unread }),
  },
  {
    name: 'list_boards', description: 'Boards you can see, with your role on each.', annotations: RO,
    inputSchema: schema({ include_archived: b('Include archived boards') }),
    run: (actor, a) => svc.listBoards(actor, { include_archived: !!a.include_archived }),
  },
  {
    name: 'get_board', description: 'A board with its members, labels, lists and (non-archived) cards in order.', annotations: RO,
    inputSchema: schema({ board_id: id('Board id') }, ['board_id']),
    run: (actor, a) => readableBoard(actor, Number(a.board_id)),
  },
  {
    name: 'create_board', description: 'Create a board. You become its admin. Default lists: To do, Doing, Done.',
    inputSchema: schema({
      name: s('Board name'), description: s('Markdown description'),
      lists: { type: 'array', items: { type: 'string' }, description: 'Initial list names' },
      visibility: { type: 'string', enum: ['private', 'instance'], description: 'private = members only; instance = every user can view' },
    }, ['name']),
    run: (actor, a) => svc.createBoard(actor, a),
  },
  {
    name: 'update_board', description: 'Rename, describe, recolor, change visibility or archive a board (board admin).',
    inputSchema: schema({ board_id: id('Board id'), name: s('Name'), description: s('Markdown'), color: s('Hex color'), visibility: { type: 'string', enum: ['private', 'instance'] }, archived: b('Archive or restore') }, ['board_id']),
    run: (actor, a) => { const { board_id, ...rest } = a; svc.updateBoard(actor, Number(board_id), rest); return { ok: true }; },
  },
  {
    name: 'list_users', description: 'Everyone on this instance (people and agents), for adding members or assigning cards.', annotations: RO,
    inputSchema: schema({}), run: (actor) => listUsers(actor),
  },
  {
    name: 'add_board_member', description: 'Add a person or agent to a board, or change their role (board admin).',
    inputSchema: schema({ board_id: id('Board id'), username: s('Username'), user_id: id('User id (alternative to username)'), role: { type: 'string', enum: ['admin', 'member', 'observer'] } }, ['board_id']),
    run: (actor, a) => { const { board_id, ...rest } = a; return svc.addMember(actor, Number(board_id), rest); },
  },
  {
    name: 'remove_board_member', description: 'Remove a member from a board (board admin), or leave it yourself.',
    inputSchema: schema({ board_id: id('Board id'), user_id: id('User id') }, ['board_id', 'user_id']),
    run: (actor, a) => svc.removeMember(actor, Number(a.board_id), Number(a.user_id)),
  },
  {
    name: 'create_list', description: 'Add a list (column) to a board.',
    inputSchema: schema({ board_id: id('Board id'), name: s('List name'), position: id('0-based index; default last') }, ['board_id', 'name']),
    run: (actor, a) => { const { board_id, ...rest } = a; return svc.createList(actor, Number(board_id), rest); },
  },
  {
    name: 'update_list', description: 'Rename, reorder or archive a list.',
    inputSchema: schema({ list_id: id('List id'), name: s('New name'), position: id('0-based index'), archived: b('Archive or restore') }, ['list_id']),
    run: (actor, a) => { const { list_id, ...rest } = a; return svc.updateList(actor, Number(list_id), rest); },
  },
  {
    name: 'search_cards', description: 'Find cards across boards you can see. All filters are optional and combine with AND.', annotations: RO,
    inputSchema: schema({
      query: s('Text to match in title or description'), board_id: id('Limit to a board'), list_id: id('Limit to a list'),
      assignee: { type: 'string', enum: ['me'], description: '"me" for cards assigned to you' }, assignee_id: id('Cards assigned to this user'),
      label_id: id('Cards with this label'), due_before: s('ISO date: open cards due on or before'), include_archived: b('Include archived cards'),
      limit: id('Max results (default 50, max 200)'),
    }),
    run: (actor, a) => svc.searchCards(actor, a),
  },
  {
    name: 'get_card', description: 'Full card: description (markdown), labels, assignees, checklists, comments (newest first), attachments.', annotations: RO,
    inputSchema: schema({ card_id: id('Card id') }, ['card_id']),
    run: (actor, a) => svc.getCard(actor, Number(a.card_id)),
  },
  {
    name: 'create_card', description: 'Create a card in a list.',
    inputSchema: schema({
      list_id: id('List id'), title: s('Title'), description: s('Markdown description'), due_at: s('ISO 8601 due date'),
      position: id('0-based index in the list; default last'), label_ids: ids('Label ids from get_board'), assignee_ids: ids('User ids (must be board members or admins)'),
    }, ['list_id', 'title']),
    run: (actor, a) => svc.createCard(actor, a),
  },
  {
    name: 'update_card', description: 'Edit card fields. label_ids/assignee_ids replace the full set. Use move_card to change lists.',
    inputSchema: schema({
      card_id: id('Card id'), title: s('Title'), description: s('Markdown description (replaces existing)'),
      due_at: { type: ['string', 'null'], description: 'ISO 8601 due date, or null to clear' }, due_complete: b('Mark due date complete'),
      archived: b('Archive or restore'), label_ids: ids('Full set of label ids'), assignee_ids: ids('Full set of assignee user ids'),
    }, ['card_id']),
    run: (actor, a) => { const { card_id, ...rest } = a; return svc.updateCard(actor, Number(card_id), rest); },
  },
  {
    name: 'move_card', description: 'Move a card to a list (on the same or another board) at an optional 0-based position.',
    inputSchema: schema({ card_id: id('Card id'), list_id: id('Destination list id'), position: id('0-based index; default last') }, ['card_id', 'list_id']),
    run: (actor, a) => svc.moveCardToBoard(actor, Number(a.card_id), a),
  },
  {
    name: 'assign_card', description: 'Assign or unassign a user (default: yourself) on a card.',
    inputSchema: schema({ card_id: id('Card id'), user_id: id('User id; omit for yourself'), remove: b('Unassign instead') }, ['card_id']),
    run: (actor, a) => svc.toggleAssignee(actor, Number(a.card_id), a.user_id === undefined ? actor.id : Number(a.user_id), !a.remove),
  },
  {
    name: 'label_card', description: 'Add or remove one label on a card.',
    inputSchema: schema({ card_id: id('Card id'), label_id: id('Label id'), remove: b('Remove instead') }, ['card_id', 'label_id']),
    run: (actor, a) => svc.toggleCardLabel(actor, Number(a.card_id), Number(a.label_id), !a.remove),
  },
  {
    name: 'create_label', description: 'Create a label on a board.',
    inputSchema: schema({ board_id: id('Board id'), name: s('Label name'), color: s('Hex color like #cf222e') }, ['board_id']),
    run: (actor, a) => { const { board_id, ...rest } = a; return svc.createLabel(actor, Number(board_id), rest); },
  },
  {
    name: 'delete_card', description: 'Permanently delete a card. Prefer update_card {archived:true} unless asked to delete.', annotations: { destructiveHint: true },
    inputSchema: schema({ card_id: id('Card id') }, ['card_id']),
    run: (actor, a) => svc.deleteCard(actor, Number(a.card_id)),
  },
  {
    name: 'add_comment', description: 'Comment on a card (markdown). @username mentions notify people.',
    inputSchema: schema({ card_id: id('Card id'), body: s('Markdown comment') }, ['card_id', 'body']),
    run: (actor, a) => svc.addComment(actor, Number(a.card_id), a),
  },
  {
    name: 'add_checklist', description: 'Add a checklist to a card, optionally with items.',
    inputSchema: schema({ card_id: id('Card id'), title: s('Checklist title'), items: { type: 'array', items: { type: 'string' }, description: 'Item texts' } }, ['card_id']),
    run: (actor, a) => { const { card_id, ...rest } = a; return svc.createChecklist(actor, Number(card_id), rest); },
  },
  {
    name: 'add_checklist_item', description: 'Add an item to a checklist.',
    inputSchema: schema({ checklist_id: id('Checklist id'), text: s('Item text'), position: id('0-based index') }, ['checklist_id', 'text']),
    run: (actor, a) => { const { checklist_id, ...rest } = a; return svc.addChecklistItem(actor, Number(checklist_id), rest); },
  },
  {
    name: 'update_checklist_item', description: 'Check/uncheck, rename or reorder a checklist item.',
    inputSchema: schema({ item_id: id('Checklist item id'), done: b('Checked'), text: s('New text'), position: id('0-based index') }, ['item_id']),
    run: (actor, a) => { const { item_id, ...rest } = a; return svc.updateChecklistItem(actor, Number(item_id), rest); },
  },
  {
    name: 'attach_text', description: 'Attach a text file (notes, logs, a patch, markdown report) to a card.',
    inputSchema: schema({ card_id: id('Card id'), filename: s('File name, e.g. report.md'), content: s('File contents'), mime: s('MIME type (default text/plain)') }, ['card_id', 'filename', 'content']),
    run: (actor, a) => svc.addTextAttachment(actor, Number(a.card_id), String(a.filename), String(a.content), typeof a.mime === 'string' ? a.mime : 'text/plain'),
  },
  {
    name: 'read_attachment', description: 'Read an attachment: text files return their contents, images return the image, other files return metadata.', annotations: RO,
    inputSchema: schema({ attachment_id: id('Attachment id') }, ['attachment_id']),
    run: (actor, a) => {
      const f = svc.attachmentFile(actor, Number(a.attachment_id));
      const meta = { id: f.id, filename: f.filename, mime: f.mime, size: f.size };
      const texty = /^text\/|json|xml|yaml|csv|javascript|markdown|x-sh|x-diff|x-patch/.test(f.mime) || /\.(md|txt|log|csv|json|ya?ml|diff|patch|[jt]sx?|py|rs|go|sh)$/i.test(f.filename);
      if (texty && f.size <= 512 * 1024) return { content: [{ type: 'text', text: fs.readFileSync(f.path, 'utf8') }] };
      if (f.mime.startsWith('image/') && f.size <= 5 * 1024 * 1024) {
        return { content: [{ type: 'text', text: JSON.stringify(meta) }, { type: 'image', data: fs.readFileSync(f.path).toString('base64'), mimeType: f.mime }] };
      }
      return { ...meta, note: 'Binary or too large to inline.' };
    },
  },
  {
    name: 'get_activity', description: 'Recent activity on a board or card, newest first.', annotations: RO,
    inputSchema: schema({ board_id: id('Board id'), card_id: id('Card id'), limit: id('Max entries (default 50)') }),
    run: (actor, a) => svc.listActivity(actor, { board_id: a.board_id as number | undefined, card_id: a.card_id as number | undefined, limit: a.limit as number | undefined }),
  },
  {
    name: 'list_notifications', description: 'Your notifications: assignments, @mentions, comments on your cards, board invites.', annotations: RO,
    inputSchema: schema({ unread_only: b('Only unread'), limit: id('Max (default 50)') }),
    run: (actor, a) => svc.listNotifications(actor, { unread_only: !!a.unread_only, limit: a.limit as number | undefined }),
  },
  {
    name: 'mark_notifications_read', description: 'Mark notifications read (all, or the given ids).',
    inputSchema: schema({ ids: ids('Notification ids; omit for all') }),
    run: (actor, a) => svc.markNotificationsRead(actor, a),
  },
];

const byName = new Map(TOOLS.map((t) => [t.name, t]));

interface RpcMessage { jsonrpc?: string; id?: string | number | null; method?: string; params?: Json }

function callTool(actor: Actor, params: Json) {
  const tool = byName.get(String(params.name));
  if (!tool) return { content: [{ type: 'text', text: `Unknown tool: ${String(params.name)}` }], isError: true };
  try {
    const out = tool.run(actor, (params.arguments as Json) ?? {});
    if (out && typeof out === 'object' && 'content' in out && Array.isArray((out as Json).content)) return out;
    return { content: [{ type: 'text', text: JSON.stringify(out ?? { ok: true }) }] };
  } catch (e) {
    const msg = e instanceof HttpError ? e.message : `Internal error: ${(e as Error).message}`;
    if (!(e instanceof HttpError)) console.error(e);
    return { content: [{ type: 'text', text: msg }], isError: true };
  }
}

function handle(actor: Actor, m: RpcMessage): Json | null {
  const reply = (result: unknown) => ({ jsonrpc: '2.0', id: m.id ?? null, result });
  const error = (code: number, message: string) => ({ jsonrpc: '2.0', id: m.id ?? null, error: { code, message } });
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return error(-32600, 'Invalid request');
  const isNotification = m.id === undefined;
  switch (m.method) {
    case 'initialize': {
      const requested = String(m.params?.protocolVersion ?? '');
      return reply({
        protocolVersion: VERSIONS.includes(requested) ? requested : VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping': return reply({});
    case 'tools/list': return reply({ tools: TOOLS.map(({ run: _run, ...t }) => t) });
    case 'tools/call': return reply(callTool(actor, m.params ?? {}));
    case 'resources/list': return reply({ resources: [] });
    case 'prompts/list': return reply({ prompts: [] });
    default:
      if (isNotification) return null;
      return error(-32601, `Method not found: ${m.method}`);
  }
}

export function mcpHandler(req: Request, res: Response) {
  if (req.method !== 'POST') {
    res.status(405).set('Allow', 'POST').json({ error: 'This MCP server is stateless; use POST' });
    return;
  }
  const actor = authenticate(req);
  if (!actor || actor.via !== 'token') {
    res.status(401).set('WWW-Authenticate', 'Bearer realm="tack"')
      .json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Send an API token: Authorization: Bearer tack_…' } });
    return;
  }
  const body = req.body as RpcMessage | RpcMessage[];
  const batch = Array.isArray(body);
  const replies = (batch ? body : [body]).map((m) => handle(actor, m ?? {})).filter((r): r is Json => r !== null);
  if (!replies.length) {
    res.status(202).end();
    return;
  }
  res.json(batch ? replies : replies[0]);
}

export const toolNames = () => TOOLS.map((t) => t.name);
