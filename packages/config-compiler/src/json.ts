import type { Json, Obj } from './types.js';
export function object(value: unknown): value is Obj {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function objects(value: Json | undefined): Obj[] {
  return Array.isArray(value) ? value.filter(object) : [];
}
export function strings(value: Json | undefined): string[] {
  return typeof value === 'string' ? [value] : Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}
export function canonical(value: unknown): string {
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint' ||
    (typeof value === 'number' && !Number.isFinite(value))) throw new Error('not a JSON value');
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (object(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}

export function isJson(value: unknown, visiting = new Set<unknown>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!Array.isArray(value) && !object(value)) return false;
  if (visiting.has(value)) return false;
  visiting.add(value);
  const valid = Object.values(value).every(v => isJson(v, visiting));
  visiting.delete(value);
  return valid;
}
export async function digest(value: unknown): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(hash)].map(v => v.toString(16).padStart(2, '0')).join('');
}
