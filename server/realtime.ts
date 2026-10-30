import type { Response } from 'express';

/** Server-sent events hub. Clients subscribe to their user channel and optionally one board. */
interface Client {
  res: Response;
  userId: number;
  boardId: number | null;
}

const clients = new Set<Client>();

/** Can this user still see this board? Registered by the service layer (avoids an import cycle). */
let canSee: (userId: number, boardId: number) => boolean = () => false;
export function setAccessCheck(fn: typeof canSee) {
  canSee = fn;
}

export function subscribe(res: Response, userId: number, boardId: number | null) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  const client = { res, userId, boardId };
  clients.add(client);
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  res.on('close', () => {
    clearInterval(ping);
    clients.delete(client);
  });
}

function send(c: Client, event: string, data: unknown) {
  c.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export interface BoardEvent {
  board_id: number;
  card_id?: number | null;
  type: string;
  actor_id: number;
}

/** Boards whose membership changed: listeners should refetch. */
export function emitBoard(e: BoardEvent) {
  const deleted = e.type === 'board.deleted';
  for (const c of clients) {
    if (c.boardId === e.board_id) {
      if (deleted || canSee(c.userId, e.board_id)) send(c, 'board', e);
      else close(c, e.board_id);
    } else if (c.boardId === null) {
      if (deleted) send(c, 'boards', {});
      else if (canSee(c.userId, e.board_id)) send(c, 'boards', { board_id: e.board_id });
    }
  }
}

/** Ask every home page to refetch its board list (no board id disclosed). */
export function nudgeHome() {
  for (const c of clients) if (c.boardId === null) send(c, 'boards', {});
}

function close(c: Client, boardId: number | null) {
  send(c, 'revoked', { board_id: boardId });
  c.res.end();
  clients.delete(c);
}

export function emitUser(userId: number, event: string, data: unknown) {
  for (const c of clients) if (c.userId === userId) send(c, event, data);
}

/** Force-close streams for a user who lost access (disabled, removed). */
export function dropUser(userId: number, boardId?: number) {
  for (const c of clients) {
    if (c.userId === userId && (boardId === undefined || c.boardId === boardId)) close(c, boardId ?? null);
  }
}
