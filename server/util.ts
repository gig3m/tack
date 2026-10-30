export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export const bad = (msg: string) => new HttpError(400, msg);
export const notFound = (what = 'Not found') => new HttpError(404, what);
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg);

type Obj = Record<string, unknown>;

export function obj(v: unknown): Obj {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Obj;
  if (v === undefined || v === null) return {};
  throw bad('Expected a JSON object');
}

export function str(o: Obj, key: string, opts: { max?: number; min?: number } = {}): string {
  const v = o[key];
  if (typeof v !== 'string') throw bad(`"${key}" must be a string`);
  const s = v.trim();
  if (s.length < (opts.min ?? 1)) throw bad(`"${key}" is required`);
  if (s.length > (opts.max ?? 500)) throw bad(`"${key}" is too long (max ${opts.max ?? 500})`);
  return s;
}

export function optStr(o: Obj, key: string, opts: { max?: number; min?: number } = {}): string | undefined {
  if (o[key] === undefined) return undefined;
  return str(o, key, { min: 0, ...opts });
}

/** Long free text (markdown). Not trimmed beyond trailing whitespace. */
export function optText(o: Obj, key: string, max = 100_000): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (v === null) return '';
  if (typeof v !== 'string') throw bad(`"${key}" must be a string`);
  if (v.length > max) throw bad(`"${key}" is too long (max ${max})`);
  return v.replace(/\s+$/, '');
}

export function optInt(o: Obj, key: string): number | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw bad(`"${key}" must be an integer`);
  return n;
}

export function int(o: Obj, key: string): number {
  const n = optInt(o, key);
  if (n === undefined) throw bad(`"${key}" is required`);
  return n;
}

export function optBool(o: Obj, key: string): boolean | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'boolean') throw bad(`"${key}" must be a boolean`);
  return v;
}

export function optIntArray(o: Obj, key: string): number[] | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || !v.every((x) => Number.isInteger(x))) throw bad(`"${key}" must be an array of integers`);
  return [...new Set(v as number[])];
}

export function oneOf<T extends string>(o: Obj, key: string, values: readonly T[]): T | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !values.includes(v as T)) throw bad(`"${key}" must be one of: ${values.join(', ')}`);
  return v as T;
}

/** ISO date/datetime or null (to clear). */
export function optDate(o: Obj, key: string): string | null | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw bad(`"${key}" must be an ISO 8601 date or null`);
  return new Date(v).toISOString();
}

export function optColor(o: Obj, key: string): string | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(v)) throw bad(`"${key}" must be a hex color like #2f6feb`);
  return v.toLowerCase();
}

export const now = () => new Date().toISOString();

const PALETTE = ['#2f6feb', '#8250df', '#bf3989', '#cf222e', '#bc4c00', '#9a6700', '#1a7f37', '#0a7ea4', '#57606a'];
export const randomColor = () => PALETTE[Math.floor(Math.random() * PALETTE.length)];
