import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const PORT = 3900 + Math.floor(Math.random() * 90);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = path.resolve('test/.data-' + PORT);
let server: ChildProcess;

before(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  server = spawn(process.execPath, ['server/index.ts'], { env: { ...process.env, PORT: String(PORT), TACK_DATA_DIR: DATA, TACK_STATIC_DIR: '/nonexistent' }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>((resolve) => server.stdout!.on('data', (d) => String(d).includes('listening') && resolve()));
});

after(() => {
  server.kill();
  fs.rmSync(DATA, { recursive: true, force: true });
});

class Client {
  cookie = '';
  token = '';
  async req(method: string, url: string, body?: unknown, expect = 200) {
    const headers: Record<string, string> = { 'content-type': 'application/json', origin: BASE };
    if (this.cookie) headers.cookie = this.cookie;
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(BASE + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const set = res.headers.get('set-cookie');
    if (set) this.cookie = set.split(';')[0];
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    assert.equal(res.status, expect, `${method} ${url} → ${res.status} ${text}`);
    return json;
  }
  get = (u: string, e?: number) => this.req('GET', u, undefined, e);
  post = (u: string, b?: unknown, e?: number) => this.req('POST', u, b ?? {}, e);
  patch = (u: string, b: unknown, e?: number) => this.req('PATCH', u, b, e);
  del = (u: string, e?: number) => this.req('DELETE', u, undefined, e);
}

async function mcp(token: string, method: string, params: unknown = {}, id = 1) {
  const res = await fetch(BASE + '/mcp', {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  assert.equal(res.status, 200);
  return res.json();
}
async function tool(token: string, name: string, args: Record<string, unknown> = {}) {
  const r = await mcp(token, 'tools/call', { name, arguments: args });
  const text = r.result.content[0].text;
  return { isError: !!r.result.isError, text, data: r.result.isError ? null : safeJson(text) };
}
const safeJson = (t: string) => { try { return JSON.parse(t); } catch { return t; } };

const alice = new Client();
const bob = new Client();
let boardId = 0;
let agentToken = '';
let agentId = 0;

test('first-run setup creates an admin, then locks', async () => {
  assert.equal((await alice.get('/api/auth/state')).needs_setup, true);
  await alice.post('/api/auth/setup', { email: 'alice@example.com', username: 'alice', name: 'Alice', password: 'correct horse' });
  const me = await alice.get('/api/me');
  assert.equal(me.is_admin, true);
  await new Client().post('/api/auth/setup', { email: 'x@example.com', username: 'x1', name: 'X', password: 'xxxxxxxx' }, 403);
});

test('cross-origin cookie writes are rejected', async () => {
  const res = await fetch(BASE + '/api/boards', { method: 'POST', headers: { 'content-type': 'application/json', cookie: alice.cookie, origin: 'https://evil.example' }, body: '{"name":"x"}' });
  assert.equal(res.status, 403);
});

test('invites let a second user sign up', async () => {
  const inv = await alice.post('/api/admin/invites', { email: 'bob@example.com' });
  const token = inv.url.split('/invite/')[1];
  await bob.post('/api/auth/signup', { invite: token, email: 'bob@example.com', username: 'bob', name: 'Bob', password: 'hunter2hunter2' });
  assert.equal((await bob.get('/api/me')).username, 'bob');
  await new Client().post('/api/auth/signup', { invite: token, email: 'bob@example.com', username: 'bob2', name: 'B', password: 'hunter2hunter2' }, 404);
  await bob.get('/api/admin/users', 403);
});

test('login and bad password', async () => {
  const c = new Client();
  await c.post('/api/auth/login', { login: 'bob', password: 'nope' }, 401);
  await c.post('/api/auth/login', { login: 'bob@example.com', password: 'hunter2hunter2' });
  assert.equal((await c.get('/api/me')).username, 'bob');
});

test('boards, lists, cards, ordering and roles', async () => {
  const board = await alice.post('/api/boards', { name: 'Launch' });
  boardId = board.id;
  assert.deepEqual(board.lists.map((l: { name: string }) => l.name), ['To do', 'Doing', 'Done']);
  await bob.get(`/api/boards/${boardId}`, 404);

  await alice.post(`/api/boards/${boardId}/members`, { username: 'bob', role: 'observer' });
  const asBob = await bob.get(`/api/boards/${boardId}`);
  assert.equal(asBob.my_role, 'observer');
  const todo = board.lists[0].id;
  await bob.post('/api/cards', { list_id: todo, title: 'nope' }, 403);

  await alice.patch(`/api/boards/${boardId}/members/${(await bob.get('/api/me')).id}`, { role: 'member' });
  const a = await bob.post('/api/cards', { list_id: todo, title: 'A' });
  const b = await bob.post('/api/cards', { list_id: todo, title: 'B' });
  const c = await alice.post('/api/cards', { list_id: todo, title: 'C', position: 0 });
  let full = await alice.get(`/api/boards/${boardId}`);
  assert.deepEqual(full.lists[0].cards.map((x: { title: string }) => x.title), ['C', 'A', 'B']);

  const doing = board.lists[1].id;
  await alice.patch(`/api/cards/${b.id}`, { list_id: doing, position: 0 });
  await alice.patch(`/api/cards/${a.id}`, { position: 0 });
  full = await alice.get(`/api/boards/${boardId}`);
  assert.deepEqual(full.lists[0].cards.map((x: { title: string }) => x.title), ['A', 'C']);
  assert.deepEqual(full.lists[1].cards.map((x: { title: string }) => x.title), ['B']);

  // last admin can't be demoted
  await alice.patch(`/api/boards/${boardId}/members/${(await alice.get('/api/me')).id}`, { role: 'member' }, 400);
  void c;
});

test('card details: labels, assignees, checklists, comments, mentions, attachments', async () => {
  const board = await alice.get(`/api/boards/${boardId}`);
  const card = board.lists[0].cards[0];
  const bobId = (await bob.get('/api/me')).id;
  const updated = await alice.patch(`/api/cards/${card.id}`, {
    description: '# Plan\n\n- ship it', due_at: '2030-01-01T12:00:00Z', label_ids: [board.labels[0].id], assignee_ids: [bobId],
  });
  assert.equal(updated.assignees[0].username, 'bob');
  assert.equal(updated.labels.length, 1);
  await alice.patch(`/api/cards/${card.id}`, { label_ids: [99999] }, 400);

  const cl = await alice.post(`/api/cards/${card.id}/checklists`, { title: 'Steps', items: ['one', 'two'] });
  const detail = await alice.get(`/api/cards/${card.id}`);
  const item = detail.checklists[0].items[0];
  await bob.patch(`/api/checklist-items/${item.id}`, { done: true });
  assert.equal((await alice.get(`/api/boards/${boardId}`)).lists[0].cards[0].checklist.done, 1);
  void cl;

  await alice.post(`/api/cards/${card.id}/comments`, { body: 'Hey @bob, take a look' });
  const notes = await bob.get('/api/notifications');
  assert.ok(notes.unread >= 2, 'bob notified for assignment + mention');
  assert.ok(notes.items.some((x: { type: string }) => x.type === 'mentioned'));

  const form = new FormData();
  form.append('files', new Blob(['hello file']), 'hello.txt');
  const up = await fetch(`${BASE}/api/cards/${card.id}/attachments`, { method: 'POST', body: form, headers: { cookie: alice.cookie, origin: BASE } });
  assert.equal(up.status, 200);
  const [att] = await up.json();
  const dl = await fetch(BASE + att.url, { headers: { cookie: bob.cookie } });
  assert.equal(await dl.text(), 'hello file');

  const act = await alice.get(`/api/cards/${card.id}/activity`);
  assert.ok(act.some((x: { type: string }) => x.type === 'attachment.added'));
});

test('agents: accounts with tokens, bound by board roles', async () => {
  const agent = await alice.post('/api/agents', { username: 'builder-bot', name: 'Builder Bot' });
  agentId = agent.id;
  const t = await alice.post('/api/me/tokens', { name: 'ci', agent_id: agent.id });
  agentToken = t.token;
  await bob.post('/api/me/tokens', { name: 'steal', agent_id: agent.id }, 404);

  const init = await mcp(agentToken, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
  assert.equal(init.result.protocolVersion, '2025-06-18');
  const list = await mcp(agentToken, 'tools/list');
  assert.ok(list.result.tools.length > 20);

  const who = await tool(agentToken, 'whoami');
  assert.equal(who.data.kind, 'agent');
  assert.equal((await tool(agentToken, 'list_boards')).data.length, 0);
  assert.equal((await tool(agentToken, 'get_board', { board_id: boardId })).isError, true);

  await alice.post(`/api/boards/${boardId}/members`, { user_id: agentId, role: 'member' });
  const board = (await tool(agentToken, 'get_board', { board_id: boardId })).data;
  const created = await tool(agentToken, 'create_card', { list_id: board.lists[0].id, title: 'Agent task', description: 'Do **things**' });
  assert.equal(created.isError, false, created.text);
  const assigned = await tool(agentToken, 'assign_card', { card_id: created.data.id });
  assert.equal(assigned.data.assignees[0].username, 'builder-bot');
  const mine = await tool(agentToken, 'search_cards', { assignee: 'me' });
  assert.equal(mine.data.length, 1);
  await tool(agentToken, 'add_comment', { card_id: created.data.id, body: 'Started. cc @alice' });
  assert.ok((await alice.get('/api/notifications')).items.some((x: { actor_name: string }) => x.actor_name === 'Builder Bot'));
  const moved = await tool(agentToken, 'move_card', { card_id: created.data.id, list_id: board.lists[2].id, position: 0 });
  assert.equal(moved.data.list_name, 'Done');
  const att = await tool(agentToken, 'attach_text', { card_id: created.data.id, filename: 'report.md', content: '# Report' });
  const read = await tool(agentToken, 'read_attachment', { attachment_id: att.data.id });
  assert.equal(read.text, '# Report');

  await alice.patch(`/api/boards/${boardId}/members/${agentId}`, { role: 'observer' });
  const denied = await tool(agentToken, 'update_card', { card_id: created.data.id, title: 'x' });
  assert.equal(denied.isError, true);
  assert.match(denied.text, /member/);

  // Agents can't use the web session API to mint tokens or manage agents.
  const res = await fetch(BASE + '/api/me/tokens', { method: 'POST', headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' }, body: '{"name":"x"}' });
  assert.equal(res.status, 403);
});

test('personal tokens act as the human', async () => {
  const t = await bob.post('/api/me/tokens', { name: 'laptop' });
  const who = await tool(t.token, 'whoami');
  assert.equal(who.data.username, 'bob');
  assert.equal((await tool(t.token, 'list_boards')).data.length, 1);
  await bob.del(`/api/tokens/${t.id}`);
  const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(res.status, 401);
});

test('disabling an agent revokes access', async () => {
  await alice.patch(`/api/agents/${agentId}`, { disabled: true });
  const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${agentToken}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(res.status, 401);
});

test('SSE stream delivers board events', async () => {
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/events?board=${boardId}`, { headers: { cookie: bob.cookie }, signal: ctrl.signal });
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const board = await alice.get(`/api/boards/${boardId}`);
  await alice.post('/api/cards', { list_id: board.lists[0].id, title: 'live' });
  let buf = '';
  while (!buf.includes('event: board')) buf += new TextDecoder().decode((await reader.read()).value);
  assert.match(buf, /card\.created/);
  ctrl.abort();
});

test('private boards are invisible; instance boards are readable', async () => {
  const priv = await bob.post('/api/boards', { name: 'Bob private' });
  const c = new Client();
  const inv = await alice.post('/api/admin/invites', {});
  await c.post('/api/auth/signup', { invite: inv.url.split('/invite/')[1], email: 'carol@example.com', username: 'carol', name: 'Carol', password: 'carolcarol' });
  await c.get(`/api/boards/${priv.id}`, 404);
  await bob.patch(`/api/boards/${priv.id}`, { visibility: 'instance' });
  assert.equal((await c.get(`/api/boards/${priv.id}`)).my_role, 'observer');
  const s = await c.post('/api/cards/search', { query: 'live' });
  assert.equal(s.length, 0, 'search excludes boards carol cannot see');
});

test('review regressions: roles, agents, assignees, MCP body size', async () => {
  const aliceId = (await alice.get('/api/me')).id;
  const bobId = (await bob.get('/api/me')).id;
  const board = await alice.post('/api/boards', { name: 'Regressions' });

  // addMember can't demote the last admin
  await alice.post(`/api/boards/${board.id}/members`, { user_id: aliceId, role: 'observer' }, 400);

  // assignee/label add+remove are independent (no stale full-set overwrite)
  await alice.post(`/api/boards/${board.id}/members`, { user_id: bobId, role: 'member' });
  const card = await alice.post('/api/cards', { list_id: board.lists[0].id, title: 'race' });
  await Promise.all([alice.req('PUT', `/api/cards/${card.id}/assignees/${aliceId}`, {}), alice.req('PUT', `/api/cards/${card.id}/assignees/${bobId}`, {})]);
  assert.equal((await alice.get(`/api/cards/${card.id}`)).assignees.length, 2);
  await alice.del(`/api/cards/${card.id}/assignees/${bobId}`);
  assert.deepEqual((await alice.get(`/api/cards/${card.id}`)).assignees.map((u: { id: number }) => u.id), [aliceId]);

  // cards can't go into archived lists
  await alice.patch(`/api/lists/${board.lists[2].id}`, { archived: true });
  await alice.post('/api/cards', { list_id: board.lists[2].id, title: 'hidden' }, 400);
  await alice.patch(`/api/cards/${card.id}`, { list_id: board.lists[2].id }, 400);

  // bob's agent: stops when bob is disabled; bob can't re-enable an admin-disabled agent
  const agent = await bob.post('/api/agents', { username: 'bob-bot', name: 'Bob Bot' });
  const tok = (await bob.post('/api/me/tokens', { name: 't', agent_id: agent.id })).token;
  await alice.post(`/api/boards/${board.id}/members`, { user_id: agent.id, role: 'member' });
  assert.equal((await tool(tok, 'whoami')).data.username, 'bob-bot');

  // MCP accepts bodies over the 2 MB REST limit
  const big = 'x'.repeat(3 * 1024 * 1024);
  const att = await tool(tok, 'attach_text', { card_id: card.id, filename: 'big.txt', content: big });
  assert.equal(att.isError, false, att.text);

  await alice.patch(`/api/agents/${agent.id}`, { disabled: true });
  await bob.patch(`/api/agents/${agent.id}`, { disabled: false }, 403);
  await alice.patch(`/api/agents/${agent.id}`, { disabled: false });
  assert.equal((await tool(tok, 'whoami')).data.username, 'bob-bot');

  await alice.patch(`/api/admin/users/${bobId}`, { disabled: true });
  const res = await fetch(BASE + '/mcp', { method: 'POST', headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0","id":1,"method":"ping"}' });
  assert.equal(res.status, 401, 'agent of a disabled owner is locked out');
  await alice.patch(`/api/admin/users/${bobId}`, { disabled: false });
});

test('review regressions: notifications hide boards you left; moved card history stays put', async () => {
  const carol = new Client();
  await carol.post('/api/auth/login', { login: 'carol', password: 'carolcarol' });
  const carolId = (await carol.get('/api/me')).id;
  const secret = await alice.post('/api/boards', { name: 'Secret board' });
  await alice.post(`/api/boards/${secret.id}/members`, { user_id: carolId, role: 'member' });
  const card = await alice.post('/api/cards', { list_id: secret.lists[0].id, title: 'Secret plans', assignee_ids: [carolId] });
  await alice.del(`/api/boards/${secret.id}/members/${carolId}`);
  const n = await carol.get('/api/notifications');
  assert.ok(!JSON.stringify(n).includes('Secret'), 'no titles from boards carol left');

  const other = await alice.post('/api/boards', { name: 'Other' });
  await alice.post(`/api/cards/${card.id}/comments`, { body: 'confidential note' });
  await alice.post(`/api/cards/${card.id}/move`, { list_id: other.lists[0].id });
  const otherActivity = await alice.get(`/api/boards/${other.id}/activity`);
  assert.ok(!JSON.stringify(otherActivity).includes('confidential'), 'history did not follow the card');
});

test('adversarial regressions', async () => {
  await bob.post('/api/auth/login', { login: 'bob', password: 'hunter2hunter2' });
  const bobId = (await bob.get('/api/me')).id;

  // C1: owner can't launder an admin disable by disabling then enabling
  const agent = await bob.post('/api/agents', { username: 'bob-bot-2', name: 'Bob Bot 2' });
  await alice.patch(`/api/agents/${agent.id}`, { disabled: true });
  await bob.patch(`/api/agents/${agent.id}`, { disabled: true });
  await bob.patch(`/api/agents/${agent.id}`, { disabled: false }, 403);

  // C2: notification for a card later moved to a board bob can't see shows no title
  const a = await alice.post('/api/boards', { name: 'Shared A' });
  const b = await alice.post('/api/boards', { name: 'Private B' });
  await alice.post(`/api/boards/${a.id}/members`, { user_id: bobId, role: 'member' });
  const card = await alice.post('/api/cards', { list_id: a.lists[0].id, title: 'innocent', assignee_ids: [bobId] });
  await alice.post(`/api/cards/${card.id}/move`, { list_id: b.lists[0].id });
  await alice.patch(`/api/cards/${card.id}`, { title: 'TOPSECRET rename' });
  assert.ok(!JSON.stringify(await bob.get('/api/notifications')).includes('TOPSECRET'));

  // C4: observers can't edit or delete their old comments
  const c2 = await alice.post('/api/cards', { list_id: a.lists[0].id, title: 'commented' });
  const comment = await bob.post(`/api/cards/${c2.id}/comments`, { body: 'mine' });
  await alice.patch(`/api/boards/${a.id}/members/${bobId}`, { role: 'observer' });
  await bob.patch(`/api/comments/${comment.id}`, { body: 'edited' }, 403);
  await bob.del(`/api/comments/${comment.id}`, 403);

  // C6: MCP move_card within the same list defaults to last
  const t = (await alice.post('/api/me/tokens', { name: 'mv' })).token;
  const list = a.lists[1].id;
  const x = await alice.post('/api/cards', { list_id: list, title: 'X' });
  await alice.post('/api/cards', { list_id: list, title: 'Y' });
  await tool(t, 'move_card', { card_id: x.id, list_id: list });
  const order = (await alice.get(`/api/boards/${a.id}`)).lists[1].cards.map((c: { title: string }) => c.title);
  assert.deepEqual(order, ['Y', 'X']);

  // C3/C5: streams stop receiving a board's events once it goes private
  const carol = new Client();
  await carol.post('/api/auth/login', { login: 'carol', password: 'carolcarol' });
  await alice.patch(`/api/boards/${a.id}`, { visibility: 'instance' });
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/events?board=${a.id}`, { headers: { cookie: carol.cookie }, signal: ctrl.signal });
  const home = await fetch(`${BASE}/api/events`, { headers: { cookie: carol.cookie }, signal: ctrl.signal });
  await alice.patch(`/api/boards/${a.id}`, { visibility: 'private' });
  await alice.post('/api/cards', { list_id: a.lists[0].id, title: 'after private' });
  const read = async (r: Response) => {
    const reader = r.body!.getReader();
    let buf = '';
    const deadline = Date.now() + 400;
    while (Date.now() < deadline) {
      const chunk = await Promise.race([reader.read(), new Promise<null>((ok) => setTimeout(() => ok(null), 100))]);
      if (chunk === null) continue;
      if (chunk.done) break;
      buf += new TextDecoder().decode(chunk.value);
    }
    return buf;
  };
  const boardStream = await read(res);
  assert.match(boardStream, /event: revoked/);
  assert.doesNotMatch(boardStream, /card\.created/);
  assert.doesNotMatch(await read(home), new RegExp(`"board_id":${a.id}\\b`));
  ctrl.abort();
});

test('round 2 regressions: disabling an owner closes their agent streams', async () => {
  await bob.post('/api/auth/login', { login: 'bob', password: 'hunter2hunter2' });
  const bobId = (await bob.get('/api/me')).id;
  const agent = await bob.post('/api/agents', { username: 'bob-bot-3', name: 'Bob Bot 3' });
  const tok = (await bob.post('/api/me/tokens', { name: 't', agent_id: agent.id })).token;
  const board = await alice.post('/api/boards', { name: 'Stream' });
  await alice.post(`/api/boards/${board.id}/members`, { user_id: agent.id, role: 'member' });
  const ctrl = new AbortController();
  const res = await fetch(`${BASE}/api/events?board=${board.id}`, { headers: { authorization: `Bearer ${tok}` }, signal: ctrl.signal });
  assert.equal(res.status, 200);
  await alice.patch(`/api/admin/users/${bobId}`, { disabled: true });
  const reader = res.body!.getReader();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += new TextDecoder().decode(value);
  }
  assert.match(buf, /event: revoked/, 'stream closed');
  await alice.patch(`/api/admin/users/${bobId}`, { disabled: false });
  ctrl.abort();
});

test('round 4 regressions: concurrent bad logins all count toward the limit', async () => {
  const tries = Array.from({ length: 12 }, () =>
    fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json', origin: BASE }, body: JSON.stringify({ login: 'alice', password: 'wrong password' }) }).then((r) => r.status),
  );
  const statuses = await Promise.all(tries);
  assert.equal(statuses.filter((s) => s === 401).length, 10, statuses.join(','));
  assert.equal(statuses.filter((s) => s === 429).length, 2, statuses.join(','));
});
