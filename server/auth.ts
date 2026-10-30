import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { Request } from 'express';
import { get, run, all, tx } from './db.ts';
import { HttpError, bad, forbidden, notFound, obj, str, optStr, optBool, now, randomColor } from './util.ts';
import { dropUser } from './realtime.ts';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export interface Actor {
  id: number;
  kind: 'human' | 'agent';
  username: string;
  name: string;
  is_admin: boolean;
  via: 'session' | 'token';
}

interface UserRow {
  id: number;
  kind: 'human' | 'agent';
  email: string | null;
  username: string;
  name: string;
  password_hash: string | null;
  is_admin: number;
  owner_id: number | null;
  color: string;
  disabled: number;
  disabled_by_admin: number;
  created_at: string;
}

export const SESSION_COOKIE = 'tack_session';
const SESSION_DAYS = 30;

export const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export async function hashPassword(pw: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored) return false;
  const [scheme, salt, hash] = stored.split('$');
  if (scheme !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(pw, Buffer.from(salt, 'base64'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

function toActor(u: UserRow, via: Actor['via']): Actor {
  return { id: u.id, kind: u.kind, username: u.username, name: u.name, is_admin: !!u.is_admin, via };
}

export function publicUser(u: Pick<UserRow, 'id' | 'kind' | 'username' | 'name' | 'color'> & Partial<UserRow>) {
  return { id: u.id, kind: u.kind, username: u.username, name: u.name, color: u.color };
}

/** Resolve the caller from a Bearer token or session cookie. */
export function authenticate(req: Request): Actor | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    const row = get<UserRow & { token_id: number }>(
      `SELECT u.*, t.id AS token_id FROM api_tokens t JOIN users u ON u.id = t.user_id
       WHERE t.token_hash = ? AND u.disabled = 0
         AND NOT EXISTS (SELECT 1 FROM users o WHERE o.id = u.owner_id AND o.disabled = 1)`,
      sha256(token),
    );
    if (!row) return null;
    run('UPDATE api_tokens SET last_used_at = ? WHERE id = ?', now(), row.token_id);
    return toActor(row, 'token');
  }
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (!cookie) return null;
  const row = get<UserRow & { expires_at: string }>(
    `SELECT u.*, s.expires_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND u.disabled = 0 AND u.kind = 'human'`,
    sha256(cookie),
  );
  if (!row || row.expires_at < now()) return null;
  return toActor(row, 'session');
}

function parseCookies(header?: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of header?.split(';') ?? []) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token: string, secure: boolean, maxAgeDays = SESSION_DAYS) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeDays * 86400}${secure ? '; Secure' : ''}`;
}

function createSession(userId: number): string {
  const token = randomToken();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  run('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)', sha256(token), userId, expires);
  run('DELETE FROM sessions WHERE expires_at < ?', now());
  return token;
}

export function destroySession(req: Request) {
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  if (cookie) run('DELETE FROM sessions WHERE token_hash = ?', sha256(cookie));
}

// ---------- validation ----------

const USERNAME_RE = /^[a-z0-9][a-z0-9_.-]{1,31}$/i;

function username(o: Record<string, unknown>) {
  const u = str(o, 'username', { max: 32 });
  if (!USERNAME_RE.test(u)) throw bad('Username must be 2–32 characters: letters, digits, _ . -');
  if (get('SELECT 1 FROM users WHERE username = ?', u)) throw bad('That username is taken');
  return u;
}

function email(o: Record<string, unknown>) {
  const e = str(o, 'email', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(e)) throw bad('Invalid email');
  return e;
}

function password(o: Record<string, unknown>, key = 'password') {
  const v = o[key];
  if (typeof v !== 'string' || v.length < 8) throw bad('Password must be at least 8 characters');
  if (v.length > 200) throw bad('Password is too long');
  return v;
}

// ---------- setup / login / signup ----------

export const needsSetup = () => !get('SELECT 1 FROM users WHERE kind = ? LIMIT 1', 'human');

export async function setup(body: unknown) {
  const o = obj(body);
  if (!needsSetup()) throw forbidden('Setup is already complete');
  const fields = { email: email(o), username: username(o), name: str(o, 'name', { max: 80 }), pw: await hashPassword(password(o)) };
  return tx(() => {
    if (!needsSetup()) throw forbidden('Setup is already complete');
    const { id } = run(
      `INSERT INTO users (kind, email, username, name, password_hash, is_admin, color) VALUES ('human', ?, ?, ?, ?, 1, ?)`,
      fields.email, fields.username, fields.name, fields.pw, randomColor(),
    );
    return createSession(id);
  });
}

const failures = new Map<string, { count: number; until: number }>();

export async function login(body: unknown, ip: string) {
  const o = obj(body);
  const ident = str(o, 'login', { max: 254 });
  const pw = typeof o.password === 'string' ? o.password : '';
  const key = `${ip}|${ident.toLowerCase()}`;
  const f = failures.get(key);
  if (f && f.count >= 10 && f.until > Date.now()) throw new HttpError(429, 'Too many attempts; try again in a few minutes');
  // Count the attempt before awaiting, so concurrent guesses can't all read the same count.
  const cur = f && f.until > Date.now() ? f : { count: 0, until: 0 };
  failures.set(key, { count: cur.count + 1, until: Date.now() + 15 * 60_000 });
  const u = get<UserRow>(`SELECT * FROM users WHERE (email = ? OR username = ?) AND kind = 'human' AND disabled = 0`, ident, ident);
  if (!u || !(await verifyPassword(pw, u.password_hash))) throw new HttpError(401, 'Invalid login or password');
  failures.delete(key);
  return createSession(u.id);
}

interface InviteRow { token_hash: string; email: string | null; is_admin: number; expires_at: string; used_at: string | null }

function findInvite(token: string) {
  const inv = get<InviteRow>('SELECT * FROM invites WHERE token_hash = ?', sha256(token));
  if (!inv || inv.used_at || inv.expires_at < now()) throw notFound('This invite link is invalid or has expired');
  return inv;
}

export function inviteInfo(token: string) {
  const inv = findInvite(token);
  return { email: inv.email };
}

export async function signup(body: unknown) {
  const o = obj(body);
  const inv = findInvite(str(o, 'invite', { max: 200 }));
  const fields = { email: email(o), username: username(o), name: str(o, 'name', { max: 80 }), pw: await hashPassword(password(o)) };
  if (inv.email && inv.email.toLowerCase() !== fields.email) throw bad('This invite is for a different email address');
  if (get('SELECT 1 FROM users WHERE email = ?', fields.email)) throw bad('An account with that email already exists');
  return tx(() => {
    const fresh = get<InviteRow>('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL', inv.token_hash);
    if (!fresh) throw notFound('This invite link is invalid or has expired');
    run('UPDATE invites SET used_at = ? WHERE token_hash = ?', now(), inv.token_hash);
    const { id } = run(
      `INSERT INTO users (kind, email, username, name, password_hash, is_admin, color) VALUES ('human', ?, ?, ?, ?, ?, ?)`,
      fields.email, fields.username, fields.name, fields.pw, inv.is_admin, randomColor(),
    );
    return createSession(id);
  });
}

// ---------- profile ----------

export function me(actor: Actor) {
  const u = get<UserRow>('SELECT * FROM users WHERE id = ?', actor.id)!;
  return { ...publicUser(u), email: u.email, is_admin: !!u.is_admin, via: actor.via, owner_id: u.owner_id };
}

export async function updateMe(actor: Actor, body: unknown) {
  const o = obj(body);
  requireHumanSession(actor);
  const u = get<UserRow>('SELECT * FROM users WHERE id = ?', actor.id)!;
  const name = optStr(o, 'name', { max: 80, min: 1 });
  const newEmail = o.email !== undefined ? email(o) : undefined;
  if (newEmail && newEmail !== u.email && get('SELECT 1 FROM users WHERE email = ?', newEmail)) throw bad('That email is in use');
  let pwHash: string | undefined;
  if (o.new_password !== undefined) {
    if (!(await verifyPassword(typeof o.current_password === 'string' ? o.current_password : '', u.password_hash))) {
      throw bad('Current password is incorrect');
    }
    pwHash = await hashPassword(password(o, 'new_password'));
  }
  run(
    'UPDATE users SET name = COALESCE(?, name), email = COALESCE(?, email), password_hash = COALESCE(?, password_hash) WHERE id = ?',
    name ?? null, newEmail ?? null, pwHash ?? null, actor.id,
  );
  return me(actor);
}

// ---------- guards ----------

export function requireHumanSession(actor: Actor) {
  if (actor.kind !== 'human' || actor.via !== 'session') throw forbidden('This action requires signing in through the web app');
}

export function requireInstanceAdmin(actor: Actor) {
  requireHumanSession(actor);
  if (!actor.is_admin) throw forbidden('Instance admin only');
}

// ---------- directory ----------

export function listUsers(_actor: Actor) {
  return all<UserRow>(`SELECT * FROM users WHERE disabled = 0 ORDER BY kind, name COLLATE NOCASE`).map(publicUser);
}

// ---------- admin: users & invites ----------

export function adminListUsers(actor: Actor) {
  requireInstanceAdmin(actor);
  return all<UserRow & { owner_name: string | null }>(
    `SELECT u.*, o.name AS owner_name FROM users u LEFT JOIN users o ON o.id = u.owner_id ORDER BY u.kind, u.name COLLATE NOCASE`,
  ).map((u) => ({ ...publicUser(u), email: u.email, is_admin: !!u.is_admin, disabled: !!u.disabled, owner_name: u.owner_name, created_at: u.created_at }));
}

export function adminUpdateUser(actor: Actor, userId: number, body: unknown) {
  requireInstanceAdmin(actor);
  const o = obj(body);
  const u = get<UserRow>('SELECT * FROM users WHERE id = ?', userId);
  if (!u) throw notFound('User not found');
  const isAdmin = optBool(o, 'is_admin');
  const disabled = optBool(o, 'disabled');
  if (u.id === actor.id && (isAdmin === false || disabled === true)) throw bad('You cannot demote or disable yourself');
  if (isAdmin !== undefined && u.kind === 'agent') throw bad('Agents cannot be instance admins');
  run('UPDATE users SET is_admin = COALESCE(?, is_admin), disabled = COALESCE(?, disabled), disabled_by_admin = COALESCE(?, disabled_by_admin) WHERE id = ?',
    isAdmin === undefined ? null : Number(isAdmin), disabled === undefined ? null : Number(disabled), disabled === undefined ? null : Number(disabled), userId);
  if (disabled) {
    run('DELETE FROM sessions WHERE user_id = ?', userId);
    dropUser(userId);
    for (const { id } of all<{ id: number }>('SELECT id FROM users WHERE owner_id = ?', userId)) dropUser(id);
  }
  return { ok: true };
}

export function createInvite(actor: Actor, body: unknown, baseUrl: string) {
  requireInstanceAdmin(actor);
  const o = obj(body);
  const inviteEmail = o.email ? email(o) : null;
  const token = randomToken(24);
  const days = 7;
  run('INSERT INTO invites (token_hash, email, is_admin, created_by, expires_at) VALUES (?, ?, ?, ?, ?)',
    sha256(token), inviteEmail, Number(optBool(o, 'is_admin') ?? false), actor.id, new Date(Date.now() + days * 86400_000).toISOString());
  return { url: `${baseUrl}/invite/${token}`, email: inviteEmail, expires_in_days: days };
}

export function listInvites(actor: Actor) {
  requireInstanceAdmin(actor);
  return all<InviteRow & { created_by_name: string | null }>(
    `SELECT i.*, u.name AS created_by_name FROM invites i LEFT JOIN users u ON u.id = i.created_by
     WHERE i.used_at IS NULL AND i.expires_at > ? ORDER BY i.expires_at DESC`, now(),
  ).map((i) => ({ id: i.token_hash.slice(0, 16), email: i.email, is_admin: !!i.is_admin, expires_at: i.expires_at, created_by_name: i.created_by_name }));
}

export function revokeInvite(actor: Actor, id: string) {
  requireInstanceAdmin(actor);
  if (!/^[0-9a-f]{16}$/.test(id)) throw bad('Bad invite id');
  run("DELETE FROM invites WHERE substr(token_hash, 1, 16) = ? AND used_at IS NULL", id);
  return { ok: true };
}

// ---------- agents ----------

function agentFor(actor: Actor, agentId: number) {
  const a = get<UserRow>("SELECT * FROM users WHERE id = ? AND kind = 'agent'", agentId);
  if (!a || (a.owner_id !== actor.id && !actor.is_admin)) throw notFound('Agent not found');
  return a;
}

export function listAgents(actor: Actor) {
  requireHumanSession(actor);
  const rows = actor.is_admin
    ? all<UserRow & { owner_name: string | null }>(`SELECT a.*, o.name AS owner_name FROM users a LEFT JOIN users o ON o.id = a.owner_id WHERE a.kind = 'agent' ORDER BY a.name`)
    : all<UserRow & { owner_name: string | null }>(`SELECT a.*, o.name AS owner_name FROM users a LEFT JOIN users o ON o.id = a.owner_id WHERE a.kind = 'agent' AND a.owner_id = ? ORDER BY a.name`, actor.id);
  return rows.map((a) => ({ ...publicUser(a), owner_id: a.owner_id, owner_name: a.owner_name, disabled: !!a.disabled, tokens: listTokensFor(a.id) }));
}

export function createAgent(actor: Actor, body: unknown) {
  requireHumanSession(actor);
  const o = obj(body);
  const uname = username(o);
  const name = str(o, 'name', { max: 80 });
  const { id } = run(`INSERT INTO users (kind, username, name, owner_id, color) VALUES ('agent', ?, ?, ?, ?)`, uname, name, actor.id, randomColor());
  return { ...publicUser(get<UserRow>('SELECT * FROM users WHERE id = ?', id)!), owner_id: actor.id };
}

export function updateAgent(actor: Actor, agentId: number, body: unknown) {
  requireHumanSession(actor);
  const a = agentFor(actor, agentId);
  const o = obj(body);
  const name = optStr(o, 'name', { max: 80, min: 1 });
  const disabled = optBool(o, 'disabled');
  if (disabled === false && a.disabled_by_admin && !actor.is_admin) throw forbidden('An instance admin disabled this agent; ask them to re-enable it');
  // Admin disable sets the flag; owner disable leaves it alone; enabling (only reachable by admins once set) clears it.
  const byAdmin = disabled === undefined ? null : disabled ? (actor.is_admin ? 1 : null) : 0;
  run('UPDATE users SET name = COALESCE(?, name), disabled = COALESCE(?, disabled), disabled_by_admin = COALESCE(?, disabled_by_admin) WHERE id = ?', name ?? null, disabled === undefined ? null : Number(disabled), byAdmin, a.id);
  if (disabled) dropUser(a.id);
  return { ok: true };
}

export function deleteAgent(actor: Actor, agentId: number) {
  requireHumanSession(actor);
  const a = agentFor(actor, agentId);
  run('DELETE FROM users WHERE id = ?', a.id);
  dropUser(a.id);
  return { ok: true };
}

// ---------- API tokens ----------

function listTokensFor(userId: number) {
  return all<{ id: number; name: string; prefix: string; created_at: string; last_used_at: string | null }>(
    'SELECT id, name, prefix, created_at, last_used_at FROM api_tokens WHERE user_id = ? ORDER BY id DESC', userId,
  );
}

export function listMyTokens(actor: Actor) {
  requireHumanSession(actor);
  return listTokensFor(actor.id);
}

/** Mint a token for yourself (personal, acts as you) or for an agent you own. */
export function createToken(actor: Actor, body: unknown) {
  requireHumanSession(actor);
  const o = obj(body);
  const name = str(o, 'name', { max: 80 });
  const target = o.agent_id === undefined || o.agent_id === null ? actor.id : agentFor(actor, Number(o.agent_id)).id;
  const token = `tack_${randomToken(30)}`;
  const { id } = run('INSERT INTO api_tokens (user_id, name, token_hash, prefix, created_by) VALUES (?, ?, ?, ?, ?)',
    target, name, sha256(token), token.slice(0, 10), actor.id);
  return { id, name, token, user_id: target };
}

export function revokeToken(actor: Actor, tokenId: number) {
  requireHumanSession(actor);
  const t = get<{ user_id: number }>('SELECT user_id FROM api_tokens WHERE id = ?', tokenId);
  if (!t) throw notFound('Token not found');
  if (t.user_id !== actor.id) agentFor(actor, t.user_id);
  run('DELETE FROM api_tokens WHERE id = ?', tokenId);
  return { ok: true };
}
