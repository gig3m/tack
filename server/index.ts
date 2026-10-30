import express, { type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { UPLOAD_DIR } from './db.ts';
import * as auth from './auth.ts';
import type { Actor } from './auth.ts';
import * as svc from './services.ts';
import { subscribe } from './realtime.ts';
import { mcpHandler } from './mcp.ts';
import { HttpError, bad } from './util.ts';

const PORT = Number(process.env.PORT ?? 3000);
const STATIC_DIR = process.env.TACK_STATIC_DIR ?? path.resolve('dist');
const TRUST_PROXY = process.env.TACK_TRUST_PROXY ?? 'loopback, linklocal, uniquelocal';

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY);
app.all('/mcp', express.json({ limit: '10mb' }), mcpHandler);
app.use(express.json({ limit: '2mb' }));

const baseUrl = (req: Request) => process.env.TACK_PUBLIC_URL?.replace(/\/$/, '') ?? `${req.protocol}://${req.get('host')}`;
const secure = (req: Request) => req.secure || (process.env.TACK_PUBLIC_URL ?? '').startsWith('https://');

/** Cookie-authenticated writes must come from our own origin (CSRF guard). Token auth is exempt. */
function sameOrigin(req: Request) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return true;
  if (req.headers.authorization?.startsWith('Bearer ')) return true;
  const origin = req.headers.origin;
  if (!origin) return req.headers['sec-fetch-site'] === 'same-origin' || req.headers['sec-fetch-site'] === undefined;
  try {
    return new URL(origin).host === req.get('host') || origin === process.env.TACK_PUBLIC_URL?.replace(/\/$/, '');
  } catch {
    return false;
  }
}

type Handler = (actor: Actor, req: Request, res: Response) => unknown | Promise<unknown>;

/** Authenticated JSON route. Returning undefined means the handler wrote the response itself. */
const authed = (fn: Handler) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!sameOrigin(req)) throw new HttpError(403, 'Cross-origin request blocked');
    const actor = auth.authenticate(req);
    if (!actor) throw new HttpError(401, 'Not signed in');
    const out = await fn(actor, req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    next(e);
  }
};

const open = (fn: (req: Request, res: Response) => unknown | Promise<unknown>) => async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!sameOrigin(req)) throw new HttpError(403, 'Cross-origin request blocked');
    const out = await fn(req, res);
    if (out !== undefined && !res.headersSent) res.json(out);
  } catch (e) {
    next(e);
  }
};

const n = (v: string | string[] | undefined) => {
  const x = Number(Array.isArray(v) ? v[0] : v);
  if (!Number.isInteger(x)) throw bad('Bad id');
  return x;
};

const r = express.Router();

// ---------- auth ----------
r.get('/health', (_req, res) => { res.json({ ok: true }); });
r.get('/auth/state', open((req) => {
  const actor = auth.authenticate(req);
  return { needs_setup: auth.needsSetup(), user: actor ? auth.me(actor) : null };
}));
r.post('/auth/setup', open(async (req, res) => {
  const token = await auth.setup(req.body);
  res.setHeader('Set-Cookie', auth.sessionCookie(token, secure(req)));
  return { ok: true };
}));
r.post('/auth/login', open(async (req, res) => {
  const token = await auth.login(req.body, req.ip ?? '');
  res.setHeader('Set-Cookie', auth.sessionCookie(token, secure(req)));
  return { ok: true };
}));
r.post('/auth/logout', open((req, res) => {
  auth.destroySession(req);
  res.setHeader('Set-Cookie', auth.sessionCookie('', secure(req), 0));
  return { ok: true };
}));
r.get('/auth/invite/:token', open((req) => auth.inviteInfo(String(req.params.token))));
r.post('/auth/signup', open(async (req, res) => {
  const token = await auth.signup(req.body);
  res.setHeader('Set-Cookie', auth.sessionCookie(token, secure(req)));
  return { ok: true };
}));

// ---------- me ----------
r.get('/me', authed((a) => auth.me(a)));
r.patch('/me', authed((a, req) => auth.updateMe(a, req.body)));
r.get('/me/tokens', authed((a) => auth.listMyTokens(a)));
r.post('/me/tokens', authed((a, req) => auth.createToken(a, req.body)));
r.delete('/tokens/:id', authed((a, req) => auth.revokeToken(a, n(req.params.id))));
r.get('/notifications', authed((a, req) => svc.listNotifications(a, { unread_only: req.query.unread === '1' })));
r.post('/notifications/read', authed((a, req) => svc.markNotificationsRead(a, req.body)));
r.get('/users', authed((a) => auth.listUsers(a)));

// ---------- agents ----------
r.get('/agents', authed((a) => auth.listAgents(a)));
r.post('/agents', authed((a, req) => auth.createAgent(a, req.body)));
r.patch('/agents/:id', authed((a, req) => auth.updateAgent(a, n(req.params.id), req.body)));
r.delete('/agents/:id', authed((a, req) => auth.deleteAgent(a, n(req.params.id))));

// ---------- admin ----------
r.get('/admin/users', authed((a) => auth.adminListUsers(a)));
r.patch('/admin/users/:id', authed((a, req) => auth.adminUpdateUser(a, n(req.params.id), req.body)));
r.get('/admin/invites', authed((a) => auth.listInvites(a)));
r.post('/admin/invites', authed((a, req) => auth.createInvite(a, req.body, baseUrl(req))));
r.delete('/admin/invites/:id', authed((a, req) => auth.revokeInvite(a, String(req.params.id))));

// ---------- events ----------
r.get('/events', authed((a, req, res) => {
  const board = req.query.board ? n(String(req.query.board)) : null;
  if (board !== null && !svc.roleOn(a, board)) throw new HttpError(404, 'Board not found');
  subscribe(res, a.id, board);
  return undefined;
}));

// ---------- boards ----------
r.get('/boards', authed((a, req) => svc.listBoards(a, { include_archived: req.query.archived === '1' })));
r.post('/boards', authed((a, req) => svc.createBoard(a, req.body)));
r.get('/boards/:id', authed((a, req) => svc.getBoard(a, n(req.params.id))));
r.patch('/boards/:id', authed((a, req) => svc.updateBoard(a, n(req.params.id), req.body)));
r.delete('/boards/:id', authed((a, req) => svc.deleteBoard(a, n(req.params.id))));
r.get('/boards/:id/archived', authed((a, req) => svc.listArchived(a, n(req.params.id))));
r.get('/boards/:id/activity', authed((a, req) => svc.listActivity(a, { board_id: n(req.params.id), before: req.query.before ? n(String(req.query.before)) : undefined })));
r.post('/boards/:id/members', authed((a, req) => svc.addMember(a, n(req.params.id), req.body)));
r.patch('/boards/:id/members/:uid', authed((a, req) => svc.updateMember(a, n(req.params.id), n(req.params.uid), req.body)));
r.delete('/boards/:id/members/:uid', authed((a, req) => svc.removeMember(a, n(req.params.id), n(req.params.uid))));
r.post('/boards/:id/lists', authed((a, req) => svc.createList(a, n(req.params.id), req.body)));
r.post('/boards/:id/labels', authed((a, req) => svc.createLabel(a, n(req.params.id), req.body)));

// ---------- lists / labels ----------
r.patch('/lists/:id', authed((a, req) => svc.updateList(a, n(req.params.id), req.body)));
r.delete('/lists/:id', authed((a, req) => svc.deleteList(a, n(req.params.id))));
r.patch('/labels/:id', authed((a, req) => svc.updateLabel(a, n(req.params.id), req.body)));
r.delete('/labels/:id', authed((a, req) => svc.deleteLabel(a, n(req.params.id))));

// ---------- cards ----------
r.post('/cards/search', authed((a, req) => svc.searchCards(a, req.body)));
r.post('/cards', authed((a, req) => svc.createCard(a, req.body)));
r.get('/cards/:id', authed((a, req) => svc.getCard(a, n(req.params.id))));
r.patch('/cards/:id', authed((a, req) => svc.updateCard(a, n(req.params.id), req.body)));
r.put('/cards/:id/assignees/:uid', authed((a, req) => svc.toggleAssignee(a, n(req.params.id), n(req.params.uid), true)));
r.delete('/cards/:id/assignees/:uid', authed((a, req) => svc.toggleAssignee(a, n(req.params.id), n(req.params.uid), false)));
r.put('/cards/:id/labels/:lid', authed((a, req) => svc.toggleCardLabel(a, n(req.params.id), n(req.params.lid), true)));
r.delete('/cards/:id/labels/:lid', authed((a, req) => svc.toggleCardLabel(a, n(req.params.id), n(req.params.lid), false)));
r.post('/cards/:id/move', authed((a, req) => svc.moveCardToBoard(a, n(req.params.id), req.body)));
r.delete('/cards/:id', authed((a, req) => svc.deleteCard(a, n(req.params.id))));
r.get('/cards/:id/activity', authed((a, req) => svc.listActivity(a, { card_id: n(req.params.id) })));
r.post('/cards/:id/comments', authed((a, req) => svc.addComment(a, n(req.params.id), req.body)));
r.post('/cards/:id/checklists', authed((a, req) => svc.createChecklist(a, n(req.params.id), req.body)));
r.patch('/comments/:id', authed((a, req) => svc.updateComment(a, n(req.params.id), req.body)));
r.delete('/comments/:id', authed((a, req) => svc.deleteComment(a, n(req.params.id))));
r.patch('/checklists/:id', authed((a, req) => svc.updateChecklist(a, n(req.params.id), req.body)));
r.delete('/checklists/:id', authed((a, req) => svc.deleteChecklist(a, n(req.params.id))));
r.post('/checklists/:id/items', authed((a, req) => svc.addChecklistItem(a, n(req.params.id), req.body)));
r.patch('/checklist-items/:id', authed((a, req) => svc.updateChecklistItem(a, n(req.params.id), req.body)));
r.delete('/checklist-items/:id', authed((a, req) => svc.deleteChecklistItem(a, n(req.params.id))));

// ---------- attachments ----------
const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (_req, _file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}`),
  }),
  limits: { fileSize: svc.MAX_UPLOAD_BYTES, files: 10 },
});
r.post('/cards/:id/attachments', authed(async (a, req, res) => {
  // Check access before accepting bytes.
  svc.assertCardRole(a, n(req.params.id), 'member');
  await new Promise<void>((resolve, reject) => upload.array('files', 10)(req, res, (err) => (err ? reject(err) : resolve())));
  const files = (req.files as Express.Multer.File[] | undefined) ?? [];
  if (!files.length) throw bad('No files uploaded (field name "files")');
  const saved = [];
  try {
    for (const f of files) saved.push(svc.addAttachment(a, n(req.params.id), f));
  } catch (e) {
    // Files not yet recorded would otherwise be orphaned on disk.
    for (const f of files.slice(saved.length + 1)) fs.rm(f.path, { force: true }, () => {});
    throw e;
  }
  return saved;
}));
const INLINE = /^(image\/(png|jpeg|gif|webp|avif)|application\/pdf|text\/plain)$/;
r.get('/attachments/:id', authed((a, req, res) => {
  const f = svc.attachmentFile(a, n(req.params.id));
  if (!fs.existsSync(f.path)) throw new HttpError(404, 'File missing from storage');
  const inline = INLINE.test(f.mime) && req.query.download === undefined;
  res.setHeader('Content-Type', inline ? f.mime : 'application/octet-stream');
  res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.filename)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.sendFile(f.path, { dotfiles: 'allow' });
  return undefined;
}));
r.delete('/attachments/:id', authed((a, req) => svc.deleteAttachment(a, n(req.params.id))));

app.use('/api', r);

// ---------- static SPA ----------
if (fs.existsSync(STATIC_DIR)) {
  app.use(express.static(STATIC_DIR, { index: false, maxAge: '1h' }));
  app.get(/^(?!\/(api|mcp)\b).*/, (_req, res) => { res.sendFile(path.join(STATIC_DIR, 'index.html')); });
}

app.use('/api', (_req, res) => { res.status(404).json({ error: 'Not found' }); });

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const e = err as { type?: string; code?: string; message?: string; status?: number };
  if (e.type === 'entity.parse.failed') { res.status(400).json({ error: 'Invalid JSON body' }); return; }
  if (e.type === 'entity.too.large') { res.status(413).json({ error: 'Request body too large' }); return; }
  if (e.code === 'LIMIT_FILE_SIZE') { res.status(413).json({ error: `File too large (max ${svc.MAX_UPLOAD_BYTES / 1048576} MB)` }); return; }
  if (e.code?.startsWith('LIMIT_')) { res.status(400).json({ error: e.message }); return; }
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, () => console.log(`tack listening on :${PORT}`));
const shutdown = () => { server.close(() => process.exit(0)); server.closeAllConnections(); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
