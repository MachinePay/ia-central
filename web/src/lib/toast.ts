import { useSyncExternalStore } from 'react';

type T = { id: number; text: string; tone: 'ok' | 'crit' };
let items: T[] = [];
const subs = new Set<() => void>();
const emit = () => subs.forEach((s) => s());

export function toast(text: string, tone: 'ok' | 'crit' = 'ok') {
  const id = Date.now() + Math.random();
  items = [...items, { id, text, tone }];
  emit();
  setTimeout(() => { items = items.filter((i) => i.id !== id); emit(); }, tone === 'crit' ? 6000 : 3500);
}
export const toastError = (e: unknown) => toast((e as Error)?.message ?? 'Algo deu errado.', 'crit');

export function useToasts() {
  return useSyncExternalStore((cb) => { subs.add(cb); return () => subs.delete(cb); }, () => items);
}
