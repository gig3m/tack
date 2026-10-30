export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, credentials: 'same-origin', headers: {} };
  if (body instanceof FormData) init.body = body;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    (init.headers as Record<string, string>)['Content-Type'] = 'application/json';
  }
  const res = await fetch('/api' + url, init);
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? res.statusText);
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body: unknown = {}) => request<T>('POST', url, body),
  patch: <T>(url: string, body: unknown) => request<T>('PATCH', url, body),
  put: <T>(url: string) => request<T>('PUT', url, {}),
  del: <T>(url: string) => request<T>('DELETE', url),
};

export type Role = 'admin' | 'member' | 'observer';

export interface User {
  id: number;
  kind: 'human' | 'agent';
  username: string;
  name: string;
  color: string;
}
export interface Me extends User {
  email: string | null;
  is_admin: boolean;
}
export interface Member extends User { role: Role }
export interface Label { id: number; name: string; color: string }
export interface CardSummary {
  id: number;
  board_id: number;
  list_id: number;
  title: string;
  has_description: boolean;
  due_at: string | null;
  due_complete: boolean;
  label_ids: number[];
  assignee_ids: number[];
  comment_count: number;
  attachment_count: number;
  checklist: { done: number; total: number };
}
export interface List { id: number; name: string; cards: CardSummary[] }
export interface Board {
  id: number;
  name: string;
  description: string;
  color: string;
  visibility: 'private' | 'instance';
  archived: boolean;
  my_role: Role;
  members: Member[];
  labels: Label[];
  lists: List[];
}
export interface BoardSummary {
  id: number;
  name: string;
  description: string;
  color: string;
  visibility: 'private' | 'instance';
  archived: boolean;
  my_role: Role;
  is_member: boolean;
  card_count: number;
}
export interface Comment {
  id: number;
  body: string;
  created_at: string;
  updated_at: string | null;
  user_id: number | null;
  user_name: string | null;
  user_kind: 'human' | 'agent' | null;
  user_color: string | null;
}
export interface Attachment { id: number; filename: string; mime: string; size: number; created_at: string; user_id: number | null; user_name: string | null; url: string }
export interface ChecklistItem { id: number; text: string; done: boolean }
export interface Checklist { id: number; title: string; items: ChecklistItem[] }
export interface CardDetail {
  id: number;
  board_id: number;
  list_id: number;
  list_name: string;
  title: string;
  description: string;
  due_at: string | null;
  due_complete: boolean;
  archived: boolean;
  created_at: string;
  created_by: string | null;
  my_role: Role;
  labels: Label[];
  assignees: User[];
  checklists: Checklist[];
  comments: Comment[];
  attachments: Attachment[];
}
export interface Activity {
  id: number;
  card_id: number | null;
  card_title: string | null;
  type: string;
  data: Record<string, unknown>;
  created_at: string;
  user_name: string | null;
  user_kind: 'human' | 'agent' | null;
}
export interface Notification {
  id: number;
  type: string;
  text: string;
  read: number;
  created_at: string;
  board_id: number | null;
  card_id: number | null;
  board_name: string | null;
  card_title: string | null;
  actor_name: string | null;
  actor_kind: 'human' | 'agent' | null;
}
export interface Token { id: number; name: string; prefix: string; created_at: string; last_used_at: string | null }
export interface Agent extends User { owner_id: number | null; owner_name: string | null; disabled: boolean; tokens: Token[] }
