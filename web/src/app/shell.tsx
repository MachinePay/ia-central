import { useQuery } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Bell, Bot, CalendarDays, CheckCheck, Home, LogOut, Mail, MessagesSquare, Moon, Search, Settings, ShieldCheck, Sun, Wallet } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { api, setToken } from '../lib/api';
import { timeAgo } from '../lib/format';
import { useToasts } from '../lib/toast';
import { cx } from '../ui';
import { CommandPalette } from './palette';

export const AREAS = [
  { to: '/', label: 'Início', key: 'home', icon: Home },
  { to: '/conversas', label: 'Conversas', key: 'conv', icon: MessagesSquare },
  { to: '/aprovacoes', label: 'Aprovações', key: 'appr', icon: CheckCheck },
  { to: '/agentes', label: 'IAs', key: 'agents', icon: Bot },
  { to: '/email', label: 'E-mail', key: 'mail', icon: Mail },
  { to: '/agenda', label: 'Agenda', key: 'agenda', icon: CalendarDays },
  { to: '/sentinela', label: 'Sentinela', key: 'sent', icon: ShieldCheck },
  { to: '/custos', label: 'Custos', key: 'cost', icon: Wallet },
] as const;

export function useSummary() {
  return useQuery({ queryKey: ['summary'], queryFn: () => api('/api/summary'), staleTime: 30_000, refetchInterval: 60_000 });
}

/** Tema: segue o sistema ate a pessoa escolher; a escolha fica salva neste navegador. */
function useTheme(): ['light' | 'dark', () => void] {
  const sys = () => (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try { const t = localStorage.getItem('cc.theme2'); if (t === 'light' || t === 'dark') return t; } catch { /* ok */ }
    return 'dark'; // padrao: escuro neon (o claro continua no botao)
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.dispatchEvent(new Event('cc-theme'));
  }, [theme]);
  return [theme, () => setTheme((t) => {
    const n = t === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem('cc.theme2', n); } catch { /* ok */ }
    return n;
  })];
}

export function Shell() {
  const summary = useSummary();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [theme, toggleTheme] = useTheme();
  const path = useRouterState({ select: (s) => s.location.pathname });
  const toasts = useToasts();
  const s = summary.data;
  const counts: Record<string, { n: number; tone?: 'warn' | 'crit' }> = {
    conv: { n: (s?.needsYou.unanswered.length ?? 0) + (s?.needsYou.takeovers ?? 0) },
    appr: { n: s?.needsYou.approvals.length ?? 0 },
    sent: { n: s?.needsYou.incidents.length ?? 0, tone: s?.needsYou.incidents.some((i: any) => i.severity === 'CRITICAL') ? 'crit' : 'warn' },
  };
  const alerts = (s?.needsYou.approvals.length ?? 0) + (s?.needsYou.incidents.filter((i: any) => i.status === 'OPEN').length ?? 0) + (s?.needsYou.unanswered.length ?? 0);

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((e.target as HTMLElement)?.tagName ?? '') || (e.target as HTMLElement)?.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setPaletteOpen((o) => !o); }
      else if (e.key === '/' && !typing && path !== '/') { e.preventDefault(); setPaletteOpen(true); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [path]);
  // contador no titulo da aba
  useEffect(() => {
    document.title = alerts ? `(${alerts}) Centro de Comando` : 'Centro de Comando';
  }, [alerts]);

  const home = path === '/';
  return (
    <div className="app-bg relative h-full overflow-hidden">
      <header className="glass absolute top-3 right-3 left-3 z-20 flex h-[60px] items-center gap-3 pr-2.5 pl-4">
        <Link to="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-[-.01em] whitespace-nowrap" aria-label="SelfMachine, início">
          <svg width="26" height="26" viewBox="0 0 26 26" aria-hidden="true"><rect x="1" y="1" width="24" height="24" rx="7" fill="currentColor" /><rect x="7" y="7" width="12" height="4" rx="2" fill="var(--bg)" /><rect x="7" y="15" width="7" height="4" rx="2" fill="var(--cyan)" /></svg>
          <span className="hidden md:inline">SelfMachine</span>
        </Link>
        <nav className="flex flex-1 justify-start gap-0.5 overflow-x-auto [scrollbar-width:none] md:justify-center" aria-label="Principal">
          {AREAS.map((a) => {
            const active = a.to === '/' ? home : path.startsWith(a.to);
            const c = counts[a.key];
            return (
              <Link key={a.to} to={a.to} preload="intent" className="cc-link" aria-current={active ? 'page' : undefined}>
                {a.label}{c && c.n > 0 && <span className={cx('cc-count', c.tone)}>{c.n}</span>}
              </Link>
            );
          })}
        </nav>
        <div className="flex items-center gap-1.5">
          <button className="cc-pill" onClick={() => setPaletteOpen(true)} aria-label="Buscar">
            <Search size={16} /><span className="hidden lg:inline">Buscar</span><kbd className="hidden rounded-[5px] border border-line px-1.5 text-[12px] lg:inline">Ctrl K</kbd>
          </button>
          <AlertsBell count={alerts} needs={s?.needsYou} />
          <button className="cc-round" onClick={toggleTheme} aria-label={theme === 'dark' ? 'Tema claro' : 'Tema escuro'} title={theme === 'dark' ? 'Tema claro' : 'Tema escuro'}>
            {theme === 'dark' ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <AccountMenu />
        </div>
      </header>
      <main className={cx('absolute inset-0 min-w-0 overflow-hidden', !home && 'pt-[84px]')}><Outlet /></main>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} toggleTheme={toggleTheme} />
      <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col items-center gap-2">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={cx('glass rounded-full! px-4 py-2.5', t.tone === 'crit' && 'border-crit/60! text-crit')}>{t.text}</div>
        ))}
      </div>
    </div>
  );
}

/** Sininho: tudo o que precisa de voce (aprovacoes, incidentes, conversas sem resposta). */
function AlertsBell({ count, needs }: { count: number; needs: any }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', h); document.addEventListener('keydown', k);
    return () => { document.removeEventListener('mousedown', h); document.removeEventListener('keydown', k); };
  }, [open]);
  const go = (to: string) => { setOpen(false); navigate({ to: to as any }); };
  const approvals: any[] = needs?.approvals ?? [];
  const incidents: any[] = (needs?.incidents ?? []).filter((i: any) => i.status === 'OPEN');
  const unanswered: any[] = needs?.unanswered ?? [];
  return (
    <div ref={ref} className="relative">
      <button className="cc-round" onClick={() => setOpen((o) => !o)} aria-label={`Alertas${count ? `: ${count}` : ''}`} aria-expanded={open} aria-haspopup="dialog">
        <Bell size={18} className={count ? 'text-warn' : undefined} />
        {count > 0 && <span className={cx('cc-count absolute -top-1 -right-1', incidents.some((i) => i.severity === 'CRITICAL') ? 'crit' : 'warn')}>{count > 99 ? '99+' : count}</span>}
      </button>
      {open && (
        <div className="glass absolute top-[48px] right-0 z-30 max-h-[70vh] bg-surface! w-[min(380px,calc(100vw-24px))] overflow-y-auto p-2" role="dialog" aria-label="Alertas">
          <p className="px-2 pt-1 pb-2 text-[13px] font-semibold">Precisa de você</p>
          {count === 0 && <p className="px-2 pb-3 text-[13px] text-text-2">Tudo em dia. Nada esperando você.</p>}
          {incidents.map((i) => (
            <AlertRow key={`i${i.id}`} tone={i.severity === 'CRITICAL' ? 'crit' : 'warn'} title={i.title ?? `Incidente #${i.id}`} sub={`Sentinela · ${timeAgo(i.opened_at ?? i.created_at)}`} onClick={() => go('/sentinela')} />
          ))}
          {approvals.map((a) => (
            <AlertRow key={`a${a.id}`} tone="warn" title={`Aprovação #${a.code}`} sub={`${a.contact ?? ''} · ${timeAgo(a.created_at)}`} onClick={() => go('/aprovacoes')} />
          ))}
          {unanswered.map((u) => (
            <AlertRow key={`u${u.id}`} tone="ok" title={u.contact ?? 'Conversa sem resposta'} sub={`Sem resposta · ${timeAgo(u.last_inbound_at)}`} onClick={() => go(`/conversas/${u.id}`)} />
          ))}
        </div>
      )}
    </div>
  );
}
function AlertRow({ tone, title, sub, onClick }: { tone: 'ok' | 'warn' | 'crit'; title: string; sub: string; onClick: () => void }) {
  return (
    <button onClick={onClick} className="grid w-full cursor-pointer grid-cols-[10px_1fr] items-center gap-3 rounded-[10px] px-2 py-2 text-left hover:bg-[var(--hover)]">
      <span className="h-2 w-2 rounded-full" style={{ background: `var(--${tone === 'ok' ? 'cyan' : tone})` }} />
      <span className="min-w-0"><strong className="block truncate text-[13.5px] font-semibold">{title}</strong><small className="block truncate text-[12.5px] text-text-2">{sub}</small></span>
    </button>
  );
}

/** Um acesso so a plataforma: engrenagem (configuracoes) e sair, sem "conta de alguem". */
function AccountMenu() {
  const navigate = useNavigate();
  const path = useRouterState({ select: (s) => s.location.pathname });
  return (
    <>
      <button className={cx('cc-round', path.startsWith('/configuracoes') && 'border-0! bg-[var(--text)]! text-[var(--bg)]!')} onClick={() => navigate({ to: '/configuracoes' })} aria-label="Configurações" title="Configurações"><Settings size={18} /></button>
      <button className="cc-round" onClick={() => { if (confirm('Sair do painel?')) { setToken(null); location.reload(); } }} aria-label="Sair" title="Sair"><LogOut size={18} /></button>
    </>
  );
}
