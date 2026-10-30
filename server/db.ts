import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.TACK_DATA_DIR ?? path.resolve('data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

export const db = new DatabaseSync(process.env.TACK_DB ?? path.join(DATA_DIR, 'tack.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    kind TEXT NOT NULL DEFAULT 'human' CHECK (kind IN ('human','agent')),
    email TEXT UNIQUE COLLATE NOCASE,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    name TEXT NOT NULL,
    password_hash TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    owner_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    color TEXT NOT NULL,
    disabled INTEGER NOT NULL DEFAULT 0,
    disabled_by_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL
  );
  CREATE TABLE api_tokens (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    prefix TEXT NOT NULL,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_used_at TEXT
  );
  CREATE TABLE invites (
    token_hash TEXT PRIMARY KEY,
    email TEXT,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    expires_at TEXT NOT NULL,
    used_at TEXT
  );
  CREATE TABLE boards (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '#2f6feb',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private','instance')),
    archived INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE board_members (
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('admin','member','observer')),
    PRIMARY KEY (board_id, user_id)
  );
  CREATE TABLE lists (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    position REAL NOT NULL,
    archived INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX lists_board ON lists(board_id, position);
  CREATE TABLE cards (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    position REAL NOT NULL,
    due_at TEXT,
    due_complete INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX cards_list ON cards(list_id, position);
  CREATE INDEX cards_board ON cards(board_id);
  CREATE TABLE labels (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL
  );
  CREATE TABLE card_labels (
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    label_id INTEGER NOT NULL REFERENCES labels(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, label_id)
  );
  CREATE TABLE card_assignees (
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    PRIMARY KEY (card_id, user_id)
  );
  CREATE TABLE checklists (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    position REAL NOT NULL
  );
  CREATE TABLE checklist_items (
    id INTEGER PRIMARY KEY,
    checklist_id INTEGER NOT NULL REFERENCES checklists(id) ON DELETE CASCADE,
    text TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    position REAL NOT NULL
  );
  CREATE TABLE comments (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT
  );
  CREATE INDEX comments_card ON comments(card_id);
  CREATE TABLE attachments (
    id INTEGER PRIMARY KEY,
    card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    filename TEXT NOT NULL,
    mime TEXT NOT NULL,
    size INTEGER NOT NULL,
    stored_name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE activity (
    id INTEGER PRIMARY KEY,
    board_id INTEGER NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    card_id INTEGER REFERENCES cards(id) ON DELETE SET NULL,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    type TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX activity_board ON activity(board_id, id);
  CREATE INDEX activity_card ON activity(card_id, id);
  CREATE TABLE notifications (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    board_id INTEGER REFERENCES boards(id) ON DELETE CASCADE,
    card_id INTEGER REFERENCES cards(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    text TEXT NOT NULL,
    read INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX notifications_user ON notifications(user_id, read, id);
  `,
];

function migrate() {
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    tx(() => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

let depth = 0;
/** Run fn in a transaction; nested calls join the outer one. */
export function tx<T>(fn: () => T): T {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    depth--;
  }
}

type Param = string | number | bigint | null | Uint8Array;

export function get<T>(sql: string, ...params: Param[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}
export function all<T>(sql: string, ...params: Param[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}
export function run(sql: string, ...params: Param[]): { id: number; changes: number } {
  const r = db.prepare(sql).run(...params);
  return { id: Number(r.lastInsertRowid), changes: Number(r.changes) };
}

migrate();
