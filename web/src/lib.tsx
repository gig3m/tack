import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { User } from './api.ts';

// ---------- router ----------

const listeners = new Set<() => void>();
window.addEventListener('popstate', () => listeners.forEach((l) => l()));

export function navigate(to: string, replace = false) {
  if (to === location.pathname + location.search) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', to);
  listeners.forEach((l) => l());
}

export function usePath() {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => location.pathname,
  );
}

export function Link(props: { to: string; className?: string; children: React.ReactNode; title?: string }) {
  return (
    <a
      href={props.to}
      className={props.className}
      title={props.title}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        navigate(props.to);
      }}
    >
      {props.children}
    </a>
  );
}

// ---------- markdown ----------

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
});

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(text, { async: false }) as string;
    // Highlight @mentions outside of code.
    const withMentions = raw.replace(/(^|[\s>(])@([a-z0-9][a-z0-9_.-]{1,31})/gi, '$1<span class="mention">@$2</span>');
    return DOMPurify.sanitize(withMentions);
  }, [text]);
  return <div className={`md ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ---------- avatars ----------

export function Avatar({ user, size = 26 }: { user: Pick<User, 'name' | 'color' | 'kind'> & { username?: string }; size?: number }) {
  const initials = user.name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
  return (
    <span
      className={`avatar ${user.kind === 'agent' ? 'agent' : ''}`}
      style={{ width: size, height: size, background: user.color, fontSize: size * 0.4 }}
      title={`${user.name}${user.username ? ` (@${user.username})` : ''}${user.kind === 'agent' ? ' · agent' : ''}`}
    >
      {user.kind === 'agent' ? <BotIcon size={size * 0.6} /> : initials}
    </span>
  );
}

export function BotIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="4" y="8" width="16" height="12" rx="3" /><path d="M12 8V4" /><circle cx="12" cy="3" r="1" /><circle cx="9" cy="14" r="1" fill="currentColor" /><circle cx="15" cy="14" r="1" fill="currentColor" />
    </svg>
  );
}

// ---------- time ----------

export function timeAgo(iso: string) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function dueState(due: string | null, complete: boolean): 'done' | 'overdue' | 'soon' | 'later' | null {
  if (!due) return null;
  if (complete) return 'done';
  const ms = Date.parse(due) - Date.now();
  if (ms < 0) return 'overdue';
  if (ms < 86400_000) return 'soon';
  return 'later';
}

export function formatDue(iso: string) {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** ISO → value for <input type="datetime-local"> in local time. */
export function toLocalInput(iso: string | null) {
  if (!iso) return '';
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const formatBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// ---------- realtime ----------

// One EventSource per tab (HTTP/1.1 allows ~6 connections per host). It follows the board being viewed;
// user-level events (notifications) arrive on it regardless of board.
type Handlers = Record<string, (data: any) => void>;
const subscribers = new Set<{ current: Handlers }>();
const boardRefs = new Map<number, number>();
let source: EventSource | null = null;
let sourceBoard: number | null | undefined;

function reconnect() {
  const board = boardRefs.size ? [...boardRefs.keys()][boardRefs.size - 1] : null;
  if (source && board === sourceBoard) return;
  source?.close();
  sourceBoard = board;
  source = new EventSource(`/api/events${board ? `?board=${board}` : ''}`);
  for (const name of ['board', 'boards', 'notification', 'revoked']) {
    source.addEventListener(name, (e: MessageEvent) => {
      const data = JSON.parse(e.data);
      for (const s of subscribers) s.current[name]?.(data);
    });
  }
}

/** Subscribe to realtime events. Pass a board id to scope the shared stream to that board. */
export function useEvents(boardId: number | null, handlers: Handlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    subscribers.add(ref);
    if (boardId) boardRefs.set(boardId, (boardRefs.get(boardId) ?? 0) + 1);
    reconnect();
    return () => {
      subscribers.delete(ref);
      if (boardId) {
        const n = (boardRefs.get(boardId) ?? 1) - 1;
        if (n > 0) boardRefs.set(boardId, n); else boardRefs.delete(boardId);
      }
      if (!subscribers.size) { source?.close(); source = null; sourceBoard = undefined; } else reconnect();
    };
  }, [boardId]);
}

// ---------- misc hooks ----------

export function useClickOutside<T extends HTMLElement>(onOutside: () => void) {
  const ref = useRef<T>(null);
  useEffect(() => {
    const h = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) onOutside(); };
    document.addEventListener('mousedown', h);
    return () => document.removeEventListener('mousedown', h);
  }, [onOutside]);
  return ref;
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 4000);
    return () => clearTimeout(t);
  }, [msg]);
  return [msg, setMsg] as const;
}

export const LABEL_COLORS = ['#1a7f37', '#9a6700', '#bc4c00', '#cf222e', '#8250df', '#2f6feb', '#0a7ea4', '#bf3989', '#57606a'];
