import type { QueryClient } from '@tanstack/react-query';
import { API_URL, getToken } from '../lib/api';

type Listener = (e: { type: string; data: any }) => void;
const listeners = new Set<Listener>();
export const onEvent = (l: Listener) => { listeners.add(l); return () => { listeners.delete(l); }; };

/**
 * Uma conexao SSE por aba. Eventos nao recarregam a tela: invalidam so as consultas afetadas,
 * agrupadas num unico frame para rajadas nao causarem dezenas de re-renders.
 */
export function startRealtime(qc: QueryClient) {
  const token = getToken();
  if (!token) return () => undefined;
  let lastId = 0;
  let es: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const pending = new Set<string>();
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    for (const k of pending) void qc.invalidateQueries({ queryKey: [k] });
    pending.clear();
  };
  const touch = (...keys: string[]) => {
    keys.forEach((k) => pending.add(k));
    if (!scheduled) { scheduled = true; requestAnimationFrame(flush); }
  };
  const MAP: Record<string, string[]> = {
    'message.created': ['threads', 'thread', 'summary', 'scene'],
    'thread.updated': ['threads', 'thread', 'summary'],
    'approval.created': ['approvals', 'summary', 'thread', 'scene'],
    'approval.decided': ['approvals', 'summary', 'thread'],
    'incident.opened': ['incidents', 'summary', 'incident', 'scene'],
    'incident.updated': ['incidents', 'summary', 'incident'],
    'incident.resolved': ['incidents', 'summary', 'incident', 'scene'],
    'resource.updated': ['monitors', 'resources'],
    'cost.updated': ['costs', 'summary'],
  };
  const connect = () => {
    es = new EventSource(`${API_URL}/api/events?token=${encodeURIComponent(token)}${lastId ? `&last=${lastId}` : ''}`);
    for (const type of Object.keys(MAP)) {
      es.addEventListener(type, (ev) => {
        const e = JSON.parse((ev as MessageEvent).data);
        lastId = Math.max(lastId, e.id);
        touch(...MAP[type]);
        listeners.forEach((l) => l({ type, data: e.data }));
      });
    }
    es.onerror = () => {
      es?.close();
      retry = setTimeout(connect, 3000);
    };
  };
  connect();
  return () => { es?.close(); if (retry) clearTimeout(retry); };
}
