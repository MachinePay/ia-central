const rtf = new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' });

export function timeAgo(d: string | Date | null | undefined): string {
  if (!d) return '—';
  const s = (new Date(d).getTime() - Date.now()) / 1000;
  const a = Math.abs(s);
  if (a < 45) return 'agora';
  if (a < 3600) return rtf.format(Math.round(s / 60), 'minute');
  if (a < 86400) return rtf.format(Math.round(s / 3600), 'hour');
  if (a < 86400 * 7) return rtf.format(Math.round(s / 86400), 'day');
  return new Date(d).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

export const dateTime = (d: string | Date | null | undefined) =>
  d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

export const usd = (n: number | string | null | undefined, digits = 2) =>
  `US$ ${Number(n ?? 0).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;

export const ms = (n: number | null | undefined) => (n == null ? '—' : n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`);

export const phone = (p: string | null | undefined) => {
  if (!p) return '';
  const m = p.match(/^55(\d{2})(\d{4,5})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : p;
};

export const incidentCode = (id: number) => `#I-${String(id).padStart(3, '0')}`;

export const AGENTS = {
  LEO: { name: 'Léo', role: 'Roteador', color: '#9FB4B6' },
  JOAO: { name: 'João', role: 'Comercial', color: '#5CC8D7' },
  CLARA: { name: 'Clara', role: 'Suporte', color: '#43B884' },
  GABRIEL: { name: 'Gabriel (IA)', role: 'Fundador', color: '#F2B33D' },
  HUMAN: { name: 'Equipe', role: 'Pessoa', color: '#F08A6C' },
} as const;
export type AgentKey = keyof typeof AGENTS;
